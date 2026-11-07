//! `ConnectionManager`: live pools per data source, dedicated console sessions and the
//! registry of running executions.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::conn::{build_opts, connect_one, is_memory, open_pool, Conn, ConnOpts, Live, Pool};
use crate::error::{ConnectionLost, DbError, Result};
use crate::exec::conn_scalar;
use crate::model::*;
use crate::tx::ServerVer;

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
#[derive(Clone)]
pub(crate) enum CancelTarget {
    /// The connection is gone: nothing to cancel.
    None,
    Pg(i32),
    My(u64),
    /// Raw `sqlite3*` as usize; `None` once the connection is closed.
    Lite(Arc<Mutex<Option<usize>>>),
}

pub(crate) enum ExecCmd {
    FetchMore {
        result_index: usize,
        count: usize,
        reply: oneshot::Sender<Result<FetchedRows>>,
    },
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
    cancel: Mutex<CancelTarget>,
    /// [`TxStatus`] as a number (see `tx.rs` for how it is determined per driver).
    pub tx: AtomicU8,
    /// MySQL: `@@autocommit` is on (statements outside a transaction commit themselves).
    pub autocommit_on: AtomicBool,
    /// MySQL: server version (`major * 10000 + minor * 100 + patch`) and flavour, read once when the connection
    /// opened; the tracker needs it to tell which `/*!NNNNN ... */` comments the server executes.
    pub server_version: AtomicU32,
    pub mariadb: AtomicBool,
    /// MySQL: `LOCK TABLES` is in effect (`UNLOCK TABLES` then commits implicitly).
    pub tables_locked: AtomicBool,
    /// Set when the connection died; the connection itself is gone from `conn` then.
    lost: Mutex<Option<Lost>>,
    pub current: Mutex<Option<(String, Arc<ExecCtl>)>>,
}

/// Why and how a session died.
#[derive(Clone)]
struct Lost {
    info: ConnectionLost,
    /// A transaction (active or failed) was open when the connection died: its work is gone and the
    /// session does not reconnect on its own.
    had_tx: bool,
}

/// A fresh dedicated connection plus what the session needs to know about it.
pub(crate) struct Opened {
    pub conn: Conn,
    pub cancel: CancelTarget,
    pub autocommit_on: bool,
    pub server_ver: ServerVer,
}

/// How to interrupt the statements of `conn` (backend pid / connection id / `sqlite3*`).
pub(crate) async fn cancel_target_of(conn: &mut Conn) -> Result<CancelTarget> {
    Ok(match conn {
        Conn::Pg(_) => {
            let pid = conn_scalar(conn, "select pg_backend_pid()::text").await?;
            CancelTarget::Pg(pid.and_then(|p| p.parse().ok()).unwrap_or(0))
        }
        Conn::My(_) => {
            let id = conn_scalar(conn, "select connection_id()").await?;
            CancelTarget::My(id.and_then(|p| p.parse().ok()).unwrap_or(0))
        }
        Conn::Lite(c) => {
            let mut h = c.lock_handle().await?;
            let ptr = h.as_raw_handle().as_ptr() as usize;
            CancelTarget::Lite(Arc::new(Mutex::new(Some(ptr))))
        }
    })
}

/// Ask the server (through `pool`, another connection) to stop what `target` is running.
pub(crate) async fn interrupt(pool: &Pool, target: &CancelTarget) {
    match target {
        CancelTarget::None => {}
        CancelTarget::Pg(pid) => {
            let _ = pool.exec(&format!("select pg_cancel_backend({pid})")).await;
        }
        CancelTarget::My(id) => {
            let _ = pool.exec(&format!("KILL QUERY {id}")).await;
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

/// Open a connection for a session: its cancel handle (backend pid / connection id / `sqlite3*`) and, for
/// MySQL, `@@autocommit` and `@@version` (read once here, before any user statement: the tracker follows
/// autocommit from then on and needs the version to read `/*!NNNNN ... */` comments).
pub(crate) async fn open_conn(live: &Live) -> Result<Opened> {
    let mut conn = live.new_conn().await?;
    let cancel = cancel_target_of(&mut conn).await?;
    let autocommit_on = match &mut conn {
        Conn::My(_) => conn_scalar(&mut conn, "select @@autocommit")
            .await?
            .map(|v| v != "0")
            .unwrap_or(true),
        _ => true,
    };
    let server_ver = match &mut conn {
        Conn::My(_) => conn_scalar(&mut conn, "select @@version")
            .await?
            .map(|v| ServerVer::parse(&v))
            .unwrap_or(ServerVer::UNKNOWN),
        _ => ServerVer::UNKNOWN,
    };
    Ok(Opened {
        conn,
        cancel,
        autocommit_on,
        server_ver,
    })
}

impl Session {
    pub fn tx_status(&self) -> TxStatus {
        match self.tx.load(Ordering::Relaxed) {
            1 => TxStatus::Active,
            2 => TxStatus::Failed,
            _ => TxStatus::Idle,
        }
    }

    pub fn set_tx_status(&self, s: TxStatus) {
        self.tx.store(s as u8, Ordering::Relaxed);
    }

    /// Is there an open transaction (active or failed)?
    pub fn in_tx(&self) -> bool {
        self.tx_status().is_open()
    }

    pub fn cancel_target(&self) -> CancelTarget {
        self.cancel.lock().unwrap().clone()
    }

    pub fn is_lost(&self) -> bool {
        self.lost.lock().unwrap().is_some()
    }

    pub fn state(&self) -> SessionState {
        let lost = self.lost.lock().unwrap().clone();
        let tx_status = self.tx_status();
        SessionState {
            tx_status,
            in_transaction: tx_status.is_open(),
            connection_lost: lost.is_some(),
            transaction_lost: lost.is_some_and(|l| l.had_tx),
        }
    }

    /// If `e` says the connection is gone, mark the session dead: the transaction tracker goes to `Idle`
    /// (the server rolled the transaction back), there is nothing to cancel any more. Returns `None` when
    /// `e` is not a lost connection, else `Some(had_tx)`: a transaction was open and is gone now (false when
    /// the session was already dead). The caller drops the connection it holds.
    pub fn lose(&self, e: &DbError) -> Option<bool> {
        let DbError::ConnectionLost(info) = e else {
            return None;
        };
        let mut lost = self.lost.lock().unwrap();
        if lost.is_some() {
            return Some(false);
        }
        let had_tx = self.in_tx();
        *lost = Some(Lost {
            info: info.clone(),
            had_tx,
        });
        drop(lost);
        self.set_tx_status(TxStatus::Idle);
        self.tables_locked.store(false, Ordering::Relaxed);
        if let CancelTarget::Lite(h) = &self.cancel_target() {
            *h.lock().unwrap() = None;
        }
        *self.cancel.lock().unwrap() = CancelTarget::None;
        Some(had_tx)
    }

    /// A connection error of a session operation: tell it the driver, and mark the session dead when the
    /// connection is gone (dropping `guard`'s connection).
    pub fn fail(&self, guard: &mut Option<Conn>, e: DbError) -> DbError {
        let e = e.for_driver(self.live.driver());
        if self.lose(&e).is_some() {
            *guard = None;
        }
        e
    }

    /// Make sure the guarded connection exists. A session that lost its connection **without** a transaction
    /// open opens a new one (`Ok(true)`: settings like `search_path` / `USE db` are reset); one that died with a
    /// transaction open keeps returning that error until it is closed. A session that was closed is an error.
    pub async fn ensure_conn(&self, guard: &mut Option<Conn>) -> Result<bool> {
        if guard.is_some() {
            return Ok(false);
        }
        let Some(lost) = self.lost.lock().unwrap().clone() else {
            return Err(DbError::InvalidArgument("Session is closed".into()));
        };
        if lost.had_tx {
            return Err(DbError::ConnectionLost(lost.info));
        }
        match open_conn(&self.live).await {
            Ok(o) => {
                *guard = Some(o.conn);
                *self.cancel.lock().unwrap() = o.cancel;
                self.autocommit_on.store(o.autocommit_on, Ordering::Relaxed);
                self.server_version
                    .store(o.server_ver.num, Ordering::Relaxed);
                self.mariadb.store(o.server_ver.mariadb, Ordering::Relaxed);
                self.tables_locked.store(false, Ordering::Relaxed);
                self.set_tx_status(TxStatus::Idle);
                *self.lost.lock().unwrap() = None;
                Ok(true)
            }
            Err(e) => Err(DbError::ConnectionLost(ConnectionLost {
                driver: Some(self.live.driver()),
                server: None,
                cause: e.to_string(),
            })),
        }
    }

    /// Ask the server to stop the statement currently running on this session.
    pub async fn cancel_running(&self) {
        interrupt(&self.live.pool, &self.cancel_target()).await;
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

/// Connect once (fail fast, real error); reads the server version and whether the session is encrypted.
async fn probe(cfg: &DataSourceConfig, opts: &ConnOpts) -> Result<(String, Option<bool>)> {
    let mut conn = connect_one(opts, cfg).await?;
    let q = match conn.driver() {
        Driver::Postgres => "show server_version",
        Driver::MySql => "select version()",
        Driver::Sqlite => "select sqlite_version()",
    };
    let v = conn_scalar(&mut conn, q).await;
    let driver = conn.driver();
    // what the connection negotiated, not what was asked for (`sslmode=prefer` may end up unencrypted)
    let ssl_sql = match driver {
        Driver::Postgres => Some("select coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false)::text"),
        Driver::MySql => Some(
            "select if(coalesce((select variable_value from performance_schema.session_status where variable_name = 'Ssl_cipher'), '') = '', 'false', 'true')",
        ),
        Driver::Sqlite => None,
    };
    let ssl = match ssl_sql {
        Some(sql) => conn_scalar(&mut conn, sql)
            .await
            .ok()
            .flatten()
            .map(|t| t == "true"),
        None => None,
    };
    conn.close().await;
    let v = v?.unwrap_or_default();
    Ok((
        match driver {
            Driver::Postgres => format!("PostgreSQL {v}"),
            Driver::MySql if v.to_lowercase().contains("mariadb") => format!("MariaDB {v}"),
            Driver::MySql => format!("MySQL {v}"),
            Driver::Sqlite => format!("SQLite {v}"),
        },
        ssl,
    ))
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Try to connect with a throw-away pool and report server version / error.
    pub async fn test_connection(&self, cfg: &DataSourceConfig) -> TestResult {
        let t0 = Instant::now();
        let res: Result<(String, Option<bool>)> = async {
            let opts = build_opts(cfg)?;
            probe(cfg, &opts).await
        }
        .await;
        let elapsed_ms = t0.elapsed().as_millis() as u64;
        match res {
            Ok((v, ssl)) => TestResult {
                ok: true,
                message: format!("Succeeded. {v}"),
                server_version: Some(v),
                elapsed_ms,
                ssl,
            },
            Err(e) => TestResult {
                ok: false,
                server_version: None,
                message: e.to_string(),
                elapsed_ms,
                ssl: None,
            },
        }
    }

    /// Connect (idempotent). Use [`reconnect`](Self::reconnect) to apply a changed config.
    pub async fn connect(&self, cfg: &DataSourceConfig) -> Result<ConnectInfo> {
        if let Some(l) = self.inner.sources.read().unwrap().get(&cfg.id) {
            return Ok(ConnectInfo {
                server_version: l.server_version.clone(),
            });
        }
        let opts = build_opts(cfg)?;
        let (version, _) = probe(cfg, &opts).await?;
        let pool = open_pool(cfg, &opts).await?;
        let keepalive = if is_memory(cfg) {
            Some(connect_one(&opts, cfg).await?)
        } else {
            None
        };
        let live = Arc::new(Live {
            cfg: cfg.clone(),
            pool,
            opts,
            server_version: version.clone(),
            pg_types: Mutex::new(HashMap::new()),
            pg_rels: Mutex::new(HashMap::new()),
            keepalive: Mutex::new(keepalive),
        });
        self.inner
            .sources
            .write()
            .unwrap()
            .insert(cfg.id.clone(), live);
        Ok(ConnectInfo {
            server_version: version,
        })
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
        self.inner
            .sessions
            .lock()
            .unwrap()
            .get(&id.0)
            .cloned()
            .ok_or_else(|| DbError::NoSession(id.0.clone()))
    }

    pub fn server_version(&self, ds_id: &str) -> Result<String> {
        Ok(self.live(ds_id)?.server_version.clone())
    }

    pub fn driver(&self, ds_id: &str) -> Result<Driver> {
        Ok(self.live(ds_id)?.driver())
    }

    /// Open a dedicated connection (keeps transaction state, `SET search_path`, `USE db`).
    pub async fn open_session(&self, ds_id: &str) -> Result<SessionId> {
        self.open_session_with(ds_id, &[]).await
    }

    /// [`open_session`](Self::open_session) that first runs `init_sql` (one statement each, in order) on the
    /// new connection: the way to re-apply per-session settings (`SET search_path`, `USE db`,
    /// `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ...`) when a console is reopened or
    /// its data source reconnected. dbcore does not remember session settings itself. If a statement
    /// fails, the connection is closed and its error is returned (no session is left behind).
    pub async fn open_session_with(&self, ds_id: &str, init_sql: &[String]) -> Result<SessionId> {
        let live = self.live(ds_id)?;
        let Opened {
            conn,
            cancel,
            autocommit_on,
            server_ver,
        } = open_conn(&live).await?;
        let id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(Session {
            id: id.clone(),
            live,
            conn: Arc::new(tokio::sync::Mutex::new(Some(conn))),
            cancel: Mutex::new(cancel),
            tx: AtomicU8::new(TxStatus::Idle as u8),
            autocommit_on: AtomicBool::new(autocommit_on),
            server_version: AtomicU32::new(server_ver.num),
            mariadb: AtomicBool::new(server_ver.mariadb),
            tables_locked: AtomicBool::new(false),
            lost: Mutex::new(None),
            current: Mutex::new(None),
        });
        if !init_sql.is_empty() {
            let mut guard = session.conn.clone().lock_owned().await;
            let mut failed = None;
            if let Some(conn) = guard.as_mut() {
                for sql in init_sql.iter().filter(|s| !s.trim().is_empty()) {
                    if let Err(e) = crate::tx::run_tracked(&session, conn, sql).await {
                        failed = Some(e);
                        break;
                    }
                }
            }
            if let Some(e) = failed {
                let conn = guard.take();
                if let CancelTarget::Lite(h) = &session.cancel_target() {
                    *h.lock().unwrap() = None;
                }
                if let Some(c) = conn {
                    c.close().await;
                }
                return Err(e);
            }
        }
        self.inner
            .sessions
            .lock()
            .unwrap()
            .insert(id.clone(), session);
        Ok(SessionId(id))
    }

    /// Close the session. Always succeeds, also when its connection is already dead.
    pub async fn close_session(&self, id: &SessionId) {
        let Some(sess) = self.inner.sessions.lock().unwrap().remove(&id.0) else {
            return;
        };
        if let Some((_, ctl)) = sess.current.lock().unwrap().take() {
            ctl.token.cancel();
            let _ = ctl.cmd.send(ExecCmd::Close);
        }
        // waits for a running execution task to release the connection
        let conn = sess.conn.lock().await.take();
        if let CancelTarget::Lite(h) = &sess.cancel_target() {
            *h.lock().unwrap() = None;
        }
        if let Some(c) = conn {
            c.close().await;
        }
    }

    /// Exclusive use of the session connection for a one-off operation (table read / edit). An open paging
    /// result of the session is released first (inside a transaction its rest is drained, like a new
    /// `execute` does); `Busy` while a statement is running.
    pub(crate) async fn lock_session_conn(
        &self,
        sess: &Arc<Session>,
    ) -> Result<tokio::sync::OwnedMutexGuard<Option<Conn>>> {
        {
            let cur = sess.current.lock().unwrap();
            if let Some((_, ctl)) = cur.as_ref() {
                if ctl.running.load(Ordering::Relaxed) {
                    return Err(DbError::Busy(
                        "The session is busy executing another statement".into(),
                    ));
                }
                let _ = ctl.cmd.send(ExecCmd::Close);
            }
        }
        let mut guard = sess.conn.clone().lock_owned().await;
        sess.ensure_conn(&mut guard).await?;
        Ok(guard)
    }

    /// Is there an open transaction on the session (`Active` or `Failed`)? Same source as
    /// [`session_tx_status`](Self::session_tx_status).
    pub fn session_in_transaction(&self, id: &SessionId) -> Result<bool> {
        Ok(self.session(id)?.in_tx())
    }

    /// Transaction state of the session: `Idle`, `Active`, or `Failed` (PostgreSQL: the transaction was
    /// aborted by an error; `COMMIT` would roll back). Follows what the server does with the transaction
    /// (see `tx.rs`), not just the keywords the user typed: MySQL DDL ends a transaction implicitly. It is
    /// updated when a statement finishes, so it can lag while a paged result keeps the connection busy.
    /// A session whose connection died is `Idle` (the server rolled the transaction back); use
    /// [`session_state`](Self::session_state) to tell that apart from a healthy idle session.
    pub fn session_tx_status(&self, id: &SessionId) -> Result<TxStatus> {
        Ok(self.session(id)?.tx_status())
    }

    /// Transaction status plus whether the connection is lost (and whether a transaction died with it).
    /// `tx_status` / `in_transaction` equal [`session_tx_status`](Self::session_tx_status) /
    /// [`session_in_transaction`](Self::session_in_transaction).
    pub fn session_state(&self, id: &SessionId) -> Result<SessionState> {
        Ok(self.session(id)?.state())
    }
}
