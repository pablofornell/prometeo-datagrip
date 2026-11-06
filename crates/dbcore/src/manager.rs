//! `ConnectionManager`: live pools per data source, dedicated console sessions and the
//! registry of running executions.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::conn::{build_opts, connect_one, is_memory, open_pool, Conn, ConnOpts, Live};
use crate::error::{DbError, Result};
use crate::exec::conn_scalar;
use crate::model::*;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExecutionId(pub String);

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::fmt::Display for ExecutionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// How to interrupt whatever a session is currently running.
pub(crate) enum CancelTarget {
    Pg(i32),
    My(u64),
    /// Raw `sqlite3*` as usize; `None` once the connection is closed.
    Lite(Arc<Mutex<Option<usize>>>),
}

pub(crate) enum ExecCmd {
    FetchMore { result_index: usize, count: usize, reply: oneshot::Sender<Result<FetchedRows>> },
    Close,
}

pub(crate) struct ExecCtl {
    pub token: CancellationToken,
    pub cmd: mpsc::UnboundedSender<ExecCmd>,
    /// true while a statement is executing, false while only waiting for fetch-more.
    pub running: AtomicBool,
}

pub(crate) struct Session {
    pub id: String,
    pub live: Arc<Live>,
    pub conn: Arc<tokio::sync::Mutex<Option<Conn>>>,
    pub cancel: CancelTarget,
    /// Heuristic: an explicit BEGIN/START TRANSACTION was executed and not yet ended.
    pub in_tx: AtomicBool,
    pub current: Mutex<Option<(String, Arc<ExecCtl>)>>,
}

impl Session {
    /// Ask the server to stop the statement currently running on this session.
    pub async fn cancel_running(&self) {
        match &self.cancel {
            CancelTarget::Pg(pid) => {
                let _ = self.live.pool.exec(&format!("select pg_cancel_backend({pid})")).await;
            }
            CancelTarget::My(id) => {
                let _ = self.live.pool.exec(&format!("KILL QUERY {id}")).await;
            }
            CancelTarget::Lite(h) => {
                let g = h.lock().unwrap();
                if let Some(ptr) = *g {
                    // SAFETY: the pointer is cleared (under this lock) before the connection
                    // is dropped, and sqlite3_interrupt is documented as thread-safe.
                    unsafe { libsqlite3_sys::sqlite3_interrupt(ptr as *mut libsqlite3_sys::sqlite3) };
                }
            }
        }
    }
}

pub struct ExecHandle {
    pub id: ExecutionId,
    pub events: mpsc::UnboundedReceiver<ExecEvent>,
}

#[derive(Default)]
pub(crate) struct Inner {
    pub sources: RwLock<HashMap<String, Arc<Live>>>,
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub execs: Mutex<HashMap<String, Arc<ExecCtl>>>,
    /// Ids of finished executions (bounded), to answer `fetch_more` with "result set is closed".
    pub closed_execs: Mutex<std::collections::VecDeque<String>>,
}

/// Cheap to clone; all clones share state.
#[derive(Clone, Default)]
pub struct ConnectionManager {
    pub(crate) inner: Arc<Inner>,
}

/// Connect once (fail fast, real error) and read the server version.
async fn probe(cfg: &DataSourceConfig, opts: &ConnOpts) -> Result<String> {
    let mut conn = connect_one(opts, cfg).await?;
    let q = match conn.driver() {
        Driver::Postgres => "show server_version",
        Driver::MySql => "select version()",
        Driver::Sqlite => "select sqlite_version()",
    };
    let v = conn_scalar(&mut conn, q).await;
    let driver = conn.driver();
    conn.close().await;
    let v = v?.unwrap_or_default();
    Ok(match driver {
        Driver::Postgres => format!("PostgreSQL {v}"),
        Driver::MySql if v.to_lowercase().contains("mariadb") => format!("MariaDB {v}"),
        Driver::MySql => format!("MySQL {v}"),
        Driver::Sqlite => format!("SQLite {v}"),
    })
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Try to connect with a throw-away pool and report server version / error.
    pub async fn test_connection(&self, cfg: &DataSourceConfig) -> TestResult {
        let t0 = Instant::now();
        let res: Result<String> = async {
            let opts = build_opts(cfg)?;
            probe(cfg, &opts).await
        }
        .await;
        let elapsed_ms = t0.elapsed().as_millis() as u64;
        match res {
            Ok(v) => TestResult { ok: true, message: format!("Succeeded. {v}"), server_version: Some(v), elapsed_ms },
            Err(e) => TestResult { ok: false, server_version: None, message: e.to_string(), elapsed_ms },
        }
    }

    /// Connect (idempotent). Use [`reconnect`](Self::reconnect) to apply a changed config.
    pub async fn connect(&self, cfg: &DataSourceConfig) -> Result<ConnectInfo> {
        if let Some(l) = self.inner.sources.read().unwrap().get(&cfg.id) {
            return Ok(ConnectInfo { server_version: l.server_version.clone() });
        }
        let opts = build_opts(cfg)?;
        let version = probe(cfg, &opts).await?;
        let pool = open_pool(cfg, &opts).await?;
        let keepalive = if is_memory(cfg) { Some(connect_one(&opts, cfg).await?) } else { None };
        let live = Arc::new(Live {
            cfg: cfg.clone(),
            pool,
            opts,
            server_version: version.clone(),
            pg_types: Mutex::new(HashMap::new()),
            pg_rels: Mutex::new(HashMap::new()),
            keepalive: Mutex::new(keepalive),
        });
        self.inner.sources.write().unwrap().insert(cfg.id.clone(), live);
        Ok(ConnectInfo { server_version: version })
    }

    pub async fn reconnect(&self, cfg: &DataSourceConfig) -> Result<ConnectInfo> {
        self.disconnect(&cfg.id).await;
        self.connect(cfg).await
    }

    /// Close the pool and every session of the data source.
    pub async fn disconnect(&self, ds_id: &str) {
        let sessions: Vec<String> = self
            .inner
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.live.cfg.id == ds_id)
            .map(|s| s.id.clone())
            .collect();
        for s in sessions {
            self.close_session(&SessionId(s)).await;
        }
        let live = self.inner.sources.write().unwrap().remove(ds_id);
        if let Some(l) = live {
            l.pool.close().await;
            let keepalive = l.keepalive.lock().unwrap().take();
            if let Some(c) = keepalive {
                c.close().await;
            }
        }
    }

    pub fn is_connected(&self, ds_id: &str) -> bool {
        self.inner.sources.read().unwrap().contains_key(ds_id)
    }

    pub(crate) fn live(&self, ds_id: &str) -> Result<Arc<Live>> {
        self.inner
            .sources
            .read()
            .unwrap()
            .get(ds_id)
            .cloned()
            .ok_or_else(|| DbError::NotConnected(ds_id.to_string()))
    }

    pub(crate) fn session(&self, id: &SessionId) -> Result<Arc<Session>> {
        self.inner.sessions.lock().unwrap().get(&id.0).cloned().ok_or_else(|| DbError::NoSession(id.0.clone()))
    }

    pub fn server_version(&self, ds_id: &str) -> Result<String> {
        Ok(self.live(ds_id)?.server_version.clone())
    }

    pub fn driver(&self, ds_id: &str) -> Result<Driver> {
        Ok(self.live(ds_id)?.driver())
    }

    /// Open a dedicated connection (keeps transaction state, `SET search_path`, `USE db`).
    pub async fn open_session(&self, ds_id: &str) -> Result<SessionId> {
        let live = self.live(ds_id)?;
        let mut conn = live.new_conn().await?;
        let cancel = match &mut conn {
            Conn::Pg(_) => {
                let pid = conn_scalar(&mut conn, "select pg_backend_pid()::text").await?;
                CancelTarget::Pg(pid.and_then(|p| p.parse().ok()).unwrap_or(0))
            }
            Conn::My(_) => {
                let id = conn_scalar(&mut conn, "select connection_id()").await?;
                CancelTarget::My(id.and_then(|p| p.parse().ok()).unwrap_or(0))
            }
            Conn::Lite(c) => {
                let mut h = c.lock_handle().await?;
                let ptr = h.as_raw_handle().as_ptr() as usize;
                CancelTarget::Lite(Arc::new(Mutex::new(Some(ptr))))
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(Session {
            id: id.clone(),
            live,
            conn: Arc::new(tokio::sync::Mutex::new(Some(conn))),
            cancel,
            in_tx: AtomicBool::new(false),
            current: Mutex::new(None),
        });
        self.inner.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(SessionId(id))
    }

    pub async fn close_session(&self, id: &SessionId) {
        let Some(sess) = self.inner.sessions.lock().unwrap().remove(&id.0) else { return };
        if let Some((_, ctl)) = sess.current.lock().unwrap().take() {
            ctl.token.cancel();
            let _ = ctl.cmd.send(ExecCmd::Close);
        }
        // waits for a running execution task to release the connection
        let conn = sess.conn.lock().await.take();
        if let CancelTarget::Lite(h) = &sess.cancel {
            *h.lock().unwrap() = None;
        }
        if let Some(c) = conn {
            c.close().await;
        }
    }

    /// Exclusive use of the session connection for a one-off operation (table read / edit). An open paging
    /// result of the session is released first (inside a transaction its rest is drained, like a new
    /// `execute` does); `Busy` while a statement is running.
    pub(crate) async fn lock_session_conn(&self, sess: &Arc<Session>) -> Result<tokio::sync::OwnedMutexGuard<Option<Conn>>> {
        {
            let cur = sess.current.lock().unwrap();
            if let Some((_, ctl)) = cur.as_ref() {
                if ctl.running.load(Ordering::Relaxed) {
                    return Err(DbError::Busy("The session is busy executing another statement".into()));
                }
                let _ = ctl.cmd.send(ExecCmd::Close);
            }
        }
        Ok(sess.conn.clone().lock_owned().await)
    }

    pub fn session_in_transaction(&self, id: &SessionId) -> Result<bool> {
        Ok(self.session(id)?.in_tx.load(Ordering::Relaxed))
    }
}
