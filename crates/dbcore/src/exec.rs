//! Statement execution.
//!
//! `execute` splits the script into statements and runs them one after another on a
//! dedicated session connection inside a spawned task. Events are pushed to an
//! unbounded channel ([`ExecEvent`]).
//!
//! # Paging (fetch-more)
//! Result sets are never re-run with `LIMIT/OFFSET`. The first `max_rows` rows of a
//! statement are sent in the `ResultSet` event; if more rows exist, the **row stream of
//! the last statement of the script is kept open inside the execution task** (the session
//! connection stays checked out) and `fetch_more` pulls the next N rows from it on
//! request. The stream is closed when the rows run out, on `cancel`, `close_execution`,
//! when a new `execute` starts on the same session, when the session is closed, or when no
//! `fetch_more` arrives for `ExecOptions::keep_open_secs` (default 120; `0` = never). A late
//! `fetch_more` then fails with "result set is closed".
//! Because one connection can have only one open stream, result sets of earlier
//! statements in a multi-statement script are truncated to `max_rows` (`has_more` is
//! false and a `Message` event says so). Additional result sets produced by a single
//! statement (e.g. MySQL `CALL`) are ignored.
//!
//! # Cancellation
//! PG: `pg_cancel_backend(pid)` from a side connection. MySQL: `KILL QUERY id`.
//! SQLite: `sqlite3_interrupt`. Closing a partially read result cancels the query,
//! except inside an explicit transaction (heuristic: `BEGIN`/`START TRANSACTION` seen on
//! the session) where the remaining rows are drained so the transaction is not aborted.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use sqlx::Either;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::conn::{Conn, Live, Pool};
use crate::error::{DbError, Result};
use crate::manager::*;
use crate::model::*;
use crate::quote::first_keyword;
use crate::split::{split_statements, Statement};
use crate::value::{describe_columns, DecodeOpts, RawRow, RowDecoder};

pub use crate::split::{statement_at, statement_at_utf16};

/// How many finished execution ids are remembered to report "result set is closed".
const CLOSED_EXECS_KEPT: usize = 512;

fn result_closed() -> DbError {
    DbError::InvalidArgument("result set is closed".into())
}

pub(crate) enum Item {
    Row(RawRow),
    Done(u64),
}

pub(crate) type ItemStream<'a> = BoxStream<'a, std::result::Result<Item, sqlx::Error>>;

/// Stream of rows (text protocol / unprepared) of a single statement on a connection.
pub(crate) fn open_stream<'a>(conn: &'a mut Conn, sql: &'a str) -> ItemStream<'a> {
    match conn {
        Conn::Pg(c) => sqlx::raw_sql(sql)
            .fetch_many(&mut *c)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::Pg(row)),
                })
            })
            .boxed(),
        Conn::My(c) => sqlx::raw_sql(sql)
            .fetch_many(&mut *c)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::My(row)),
                })
            })
            .boxed(),
        Conn::Lite(c) => sqlx::raw_sql(sql)
            .fetch_many(&mut *c)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::Lite(row)),
                })
            })
            .boxed(),
    }
}

/// First column of the first row of a one-off query, as text.
pub(crate) async fn conn_scalar(conn: &mut Conn, sql: &str) -> Result<Option<String>> {
    let mut stream = open_stream(conn, sql);
    while let Some(item) = stream.next().await {
        if let Item::Row(raw) = item? {
            let v = match &raw {
                RawRow::Pg(r) => crate::conn::pg_strings(r),
                RawRow::My(r) => crate::conn::my_strings(r),
                RawRow::Lite(r) => crate::conn::lite_strings(r),
            };
            return Ok(v.into_iter().next().flatten());
        }
    }
    Ok(None)
}

pub(crate) fn open_pool_stream<'a>(pool: &'a Pool, sql: &'a str) -> ItemStream<'a> {
    match pool {
        Pool::Pg(p) => sqlx::raw_sql(sql)
            .fetch_many(p)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::Pg(row)),
                })
            })
            .boxed(),
        Pool::My(p) => sqlx::raw_sql(sql)
            .fetch_many(p)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::My(row)),
                })
            })
            .boxed(),
        Pool::Lite(p) => sqlx::raw_sql(sql)
            .fetch_many(p)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::Lite(row)),
                })
            })
            .boxed(),
    }
}

/// Run `sql` on the pool and hand every row (decoded) to `on_row` together with the columns
/// of the result set it belongs to. A call may return several result sets with different
/// columns (`select 1; select 1, 2`, MySQL `CALL`): the decoder is rebuilt whenever the
/// column set changes. Returns the columns of the first result set that produced a row.
pub(crate) async fn query_pool(
    live: &Live,
    sql: &str,
    bin_limit: usize,
    mut on_row: impl FnMut(&[ColumnMeta], Vec<Cell>) -> Result<()>,
) -> Result<Option<Vec<ColumnMeta>>> {
    let opts = DecodeOpts { bin_limit };
    let mut stream = open_pool_stream(&live.pool, sql);
    let mut dec: Option<(RowDecoder, Vec<ColumnMeta>)> = None;
    let mut first: Option<Vec<ColumnMeta>> = None;
    while let Some(item) = stream.next().await {
        if let Item::Row(raw) = item? {
            if !dec.as_ref().is_some_and(|d| d.0.fits(&raw)) {
                let built = RowDecoder::build(live, &raw, opts).await?;
                if first.is_none() {
                    first = Some(built.1.clone());
                }
                dec = Some(built);
            }
            if let Some(d) = dec.as_ref() {
                on_row(&d.1, d.0.decode(&raw))?;
            }
        }
    }
    Ok(first)
}

/// Same as [`query_pool`] on a dedicated connection (a console / editor session).
pub(crate) async fn query_conn(
    live: &Live,
    conn: &mut Conn,
    sql: &str,
    bin_limit: usize,
    mut on_row: impl FnMut(&[ColumnMeta], Vec<Cell>) -> Result<()>,
) -> Result<Option<Vec<ColumnMeta>>> {
    let opts = DecodeOpts { bin_limit };
    let mut stream = open_stream(conn, sql);
    let mut dec: Option<(RowDecoder, Vec<ColumnMeta>)> = None;
    let mut first: Option<Vec<ColumnMeta>> = None;
    while let Some(item) = stream.next().await {
        if let Item::Row(raw) = item? {
            if !dec.as_ref().is_some_and(|d| d.0.fits(&raw)) {
                let built = RowDecoder::build(live, &raw, opts).await?;
                if first.is_none() {
                    first = Some(built.1.clone());
                }
                dec = Some(built);
            }
            if let Some(d) = dec.as_ref() {
                on_row(&d.1, d.0.decode(&raw))?;
            }
        }
    }
    Ok(first)
}

// ------------------------------------------------------------------ pulling

#[derive(Default)]
struct StreamState {
    block_done: bool,
    rows_affected: u64,
    cancel_sent: bool,
    first_item: Option<Duration>,
}

enum Pull {
    Row(RawRow),
    End,
    Err(DbError),
}

struct Shared {
    token: CancellationToken,
    session: Arc<Session>,
    tx: mpsc::UnboundedSender<ExecEvent>,
    ctl: Arc<ExecCtl>,
}

impl Shared {
    fn send(&self, e: ExecEvent) {
        let _ = self.tx.send(e);
    }
}

struct Task {
    sh: Shared,
    cmd_rx: mpsc::UnboundedReceiver<ExecCmd>,
    opts: ExecOptions,
    exec: Duration,
    fetch: Duration,
    started: Instant,
    done_sent: bool,
}

impl Task {
    fn send_done(&mut self) {
        if !self.done_sent {
            self.done_sent = true;
            self.sh.send(ExecEvent::Done {
                elapsed_ms: self.started.elapsed().as_millis() as u64,
                execution_ms: self.exec.as_millis() as u64,
                fetching_ms: self.fetch.as_millis() as u64,
            });
        }
    }
}

async fn pull(stream: &mut ItemStream<'_>, sh: &Shared, st: &mut StreamState, t0: Instant) -> Pull {
    loop {
        let item = loop {
            tokio::select! {
                _ = sh.token.cancelled(), if !st.cancel_sent => {
                    st.cancel_sent = true;
                    sh.session.cancel_running().await;
                }
                it = stream.next() => break it,
            }
        };
        if st.first_item.is_none() {
            st.first_item = Some(t0.elapsed());
        }
        match item {
            None => return Pull::End,
            Some(Err(e)) => return Pull::Err(e.into()),
            Some(Ok(Item::Done(n))) => {
                st.block_done = true;
                st.rows_affected = n;
            }
            Some(Ok(Item::Row(r))) => {
                if !st.block_done {
                    return Pull::Row(r);
                }
                // rows of a further result block of the same statement: ignored
            }
        }
    }
}

/// Stop reading a stream that still has rows: cancel the query on the server (unless that
/// would abort an open transaction) and consume what is left so the connection is reusable.
async fn abort_stream(mut stream: ItemStream<'_>, sh: &Shared) {
    let in_tx = sh.session.in_tx.load(Ordering::Relaxed);
    let user = sh.token.is_cancelled();
    let cancel = !in_tx || user;
    if cancel {
        sh.session.cancel_running().await;
    }
    if matches!(sh.session.cancel, CancelTarget::Lite(_)) {
        drop(stream);
        return;
    }
    while stream.next().await.is_some() {}
}

fn might_return_rows(sql: &str) -> bool {
    matches!(
        first_keyword(sql).as_str(),
        "SELECT" | "WITH" | "SHOW" | "EXPLAIN" | "VALUES" | "TABLE" | "DESCRIBE" | "DESC" | "PRAGMA" | "CALL" | "EXEC"
            | "EXECUTE" | "FETCH" | "LIST" | "ANALYZE"
    ) || sql.to_ascii_uppercase().contains("RETURNING")
}

fn track_tx(sess: &Session, sql: &str) {
    let kw = first_keyword(sql);
    match kw.as_str() {
        "BEGIN" | "START" => sess.in_tx.store(true, Ordering::Relaxed),
        "COMMIT" | "END" | "ABORT" => sess.in_tx.store(false, Ordering::Relaxed),
        "ROLLBACK" => {
            let up = sql.to_ascii_uppercase();
            if !up.contains(" TO ") && !up.contains("SAVEPOINT") {
                sess.in_tx.store(false, Ordering::Relaxed)
            }
        }
        _ => {}
    }
}

enum Flow {
    Next,
}

async fn run_statement(
    task: &mut Task,
    conn: &mut Conn,
    idx: usize,
    sql: &str,
    is_last: bool,
) -> Result<Flow> {
    let live = task.sh.session.live.clone();
    let max = task.opts.max_rows.max(1);
    let t0 = Instant::now();
    let mut stream = open_stream(conn, sql);
    let mut st = StreamState::default();
    let mut dec: Option<(RowDecoder, Vec<ColumnMeta>)> = None;
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut pending: Option<Vec<Cell>> = None;
    let mut has_more = false;

    loop {
        match pull(&mut stream, &task.sh, &mut st, t0).await {
            Pull::Row(raw) => {
                if dec.is_none() {
                    dec = Some(RowDecoder::build(&live, &raw, DecodeOpts::default()).await?);
                }
                let cells = dec.as_ref().map(|d| d.0.decode(&raw)).unwrap_or_default();
                if rows.len() < max {
                    rows.push(cells);
                } else {
                    pending = Some(cells);
                    has_more = true;
                    break;
                }
            }
            Pull::End => break,
            Pull::Err(e) => return Err(e),
        }
    }
    let total = t0.elapsed();
    let first = st.first_item.unwrap_or(total).min(total);
    task.exec += first;
    task.fetch += total - first;

    let Some((decoder, cols)) = dec else {
        drop(stream);
        if might_return_rows(sql) {
            let cols = describe_columns(&live, conn, sql).await;
            if !cols.is_empty() {
                task.sh.send(ExecEvent::ResultSet { index: idx, columns: cols, rows: Vec::new(), has_more: false });
                return Ok(Flow::Next);
            }
        }
        task.sh.send(ExecEvent::Update { index: idx, rows_affected: st.rows_affected });
        return Ok(Flow::Next);
    };

    if !has_more {
        drop(stream);
        task.sh.send(ExecEvent::ResultSet { index: idx, columns: cols, rows, has_more: false });
    } else if is_last && !task.sh.token.is_cancelled() {
        task.sh.send(ExecEvent::ResultSet { index: idx, columns: cols, rows, has_more: true });
        // idle first, then `Done`: a client that reacts to `Done` with a new execute must
        // never see the session as busy
        task.sh.ctl.running.store(false, Ordering::Relaxed);
        task.send_done();
        let exhausted = page_loop(task, &mut stream, &decoder, &mut st, pending, idx, t0).await;
        if !exhausted {
            abort_stream(stream, &task.sh).await;
        }
    } else {
        task.sh.send(ExecEvent::ResultSet { index: idx, columns: cols, rows, has_more: false });
        task.sh.send(ExecEvent::Message {
            index: Some(idx),
            text: format!(
                "Result {} was truncated to {} rows (only the last statement of a script can be paged)",
                idx + 1,
                max
            ),
        });
        abort_stream(stream, &task.sh).await;
    }
    Ok(Flow::Next)
}

/// Serve `fetch_more` requests for the open stream. Returns true if the stream was
/// exhausted, false if the result was closed early.
async fn page_loop(
    task: &mut Task,
    stream: &mut ItemStream<'_>,
    dec: &RowDecoder,
    st: &mut StreamState,
    mut pending: Option<Vec<Cell>>,
    idx: usize,
    t0: Instant,
) -> bool {
    // idle limit for the open result: every request restarts it
    let keep_open = (task.opts.keep_open_secs > 0).then(|| Duration::from_secs(task.opts.keep_open_secs));
    loop {
        let idle = async {
            match keep_open {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending::<()>().await,
            }
        };
        let cmd = tokio::select! {
            _ = task.sh.token.cancelled() => return false,
            c = task.cmd_rx.recv() => c,
            _ = idle => {
                // nobody is paging: free the server query (cancel, or drain inside a
                // transaction); later fetch_more calls get "result set is closed"
                task.sh.send(ExecEvent::Message {
                    index: Some(idx),
                    text: format!("Result {} was closed after {} s without fetching more rows", idx + 1, task.opts.keep_open_secs),
                });
                return false;
            }
        };
        match cmd {
            None | Some(ExecCmd::Close) => return false,
            Some(ExecCmd::FetchMore { result_index, count, reply }) => {
                if result_index != idx {
                    let _ = reply.send(Err(DbError::InvalidArgument(format!(
                        "result {result_index} is closed (only result {idx} can be paged)"
                    ))));
                    continue;
                }
                let count = count.max(1);
                let mut out: Vec<Vec<Cell>> = Vec::with_capacity(count.min(20_000));
                let mut exhausted = false;
                let mut err = None;
                if let Some(p) = pending.take() {
                    out.push(p);
                }
                while out.len() < count {
                    match pull(stream, &task.sh, st, t0).await {
                        Pull::Row(r) => out.push(dec.decode(&r)),
                        Pull::End => {
                            exhausted = true;
                            break;
                        }
                        Pull::Err(e) => {
                            err = Some(e);
                            exhausted = true;
                            break;
                        }
                    }
                }
                if !exhausted {
                    match pull(stream, &task.sh, st, t0).await {
                        Pull::Row(r) => pending = Some(dec.decode(&r)),
                        Pull::End => exhausted = true,
                        Pull::Err(e) => {
                            err = Some(e);
                            exhausted = true;
                        }
                    }
                }
                let _ = reply.send(match err {
                    Some(e) => Err(e),
                    None => Ok(FetchedRows { rows: out, has_more: !exhausted }),
                });
                if exhausted {
                    return true;
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn exec_task(
    mgr: ConnectionManager,
    sess: Arc<Session>,
    ctl: Arc<ExecCtl>,
    exec_id: String,
    stmts: Vec<Statement>,
    opts: ExecOptions,
    tx: mpsc::UnboundedSender<ExecEvent>,
    cmd_rx: mpsc::UnboundedReceiver<ExecCmd>,
) {
    let mut task = Task {
        sh: Shared { token: ctl.token.clone(), session: sess.clone(), tx, ctl: ctl.clone() },
        cmd_rx,
        opts,
        exec: Duration::ZERO,
        fetch: Duration::ZERO,
        started: Instant::now(),
        done_sent: false,
    };
    let mut guard = sess.conn.clone().lock_owned().await;
    match guard.as_mut() {
        None => {
            task.sh.send(ExecEvent::Error { index: 0, message: "Session is closed".into(), position: None });
        }
        Some(conn) => {
            let n = stmts.len();
            for (i, st) in stmts.iter().enumerate() {
                if task.sh.token.is_cancelled() {
                    break;
                }
                task.sh.send(ExecEvent::Statement { index: i, sql: st.text.clone(), range: st.range() });
                ctl.running.store(true, Ordering::Relaxed);
                match run_statement(&mut task, conn, i, &st.text, i + 1 == n).await {
                    Ok(Flow::Next) => track_tx(&sess, &st.text),
                    Err(e) => {
                        task.sh.send(ExecEvent::Error { index: i, message: e.to_string(), position: e.position() });
                        track_tx(&sess, &st.text);
                        if task.opts.stop_on_error {
                            break;
                        }
                    }
                }
            }
        }
    }
    // release everything first (connection, registry entries), announce `Done` last
    ctl.running.store(false, Ordering::Relaxed);
    drop(guard);
    mgr.inner.execs.lock().unwrap().remove(&exec_id);
    mgr.mark_closed(&exec_id);
    {
        let mut cur = sess.current.lock().unwrap();
        if cur.as_ref().map(|(id, _)| id == &exec_id).unwrap_or(false) {
            *cur = None;
        }
    }
    task.send_done();
}

impl ConnectionManager {
    /// Run `sql` (one or more statements) on the session. Returns immediately with a
    /// handle whose `events` channel yields [`ExecEvent`]s; the last event is always
    /// `Done`.
    pub async fn execute(&self, session: &SessionId, sql: &str, opts: ExecOptions) -> Result<ExecHandle> {
        let sess = self.session(session)?;
        let stmts = split_statements(sql, sess.live.driver());
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::unbounded_channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let ctl = Arc::new(ExecCtl {
            token: CancellationToken::new(),
            cmd: cmd_tx,
            running: std::sync::atomic::AtomicBool::new(true),
        });
        {
            let mut cur = sess.current.lock().unwrap();
            if let Some((_, prev)) = cur.as_ref() {
                if prev.running.load(Ordering::Relaxed) {
                    return Err(DbError::Busy("The session is busy executing another statement".into()));
                }
                // previous result is only being held open for paging: release it
                let _ = prev.cmd.send(ExecCmd::Close);
            }
            *cur = Some((id.clone(), ctl.clone()));
        }
        self.inner.execs.lock().unwrap().insert(id.clone(), ctl.clone());
        tokio::spawn(exec_task(self.clone(), sess, ctl, id.clone(), stmts, opts, tx, cmd_rx));
        Ok(ExecHandle { id: ExecutionId(id), events: rx })
    }

    fn exec_ctl(&self, id: &ExecutionId) -> Result<Arc<ExecCtl>> {
        self.inner.execs.lock().unwrap().get(&id.0).cloned().ok_or_else(|| {
            if self.inner.closed_execs.lock().unwrap().iter().any(|c| c == &id.0) {
                result_closed()
            } else {
                DbError::NoExecution(id.0.clone())
            }
        })
    }

    /// Remember a finished execution so a late `fetch_more` says "closed", not "unknown".
    pub(crate) fn mark_closed(&self, id: &str) {
        let mut closed = self.inner.closed_execs.lock().unwrap();
        if closed.len() >= CLOSED_EXECS_KEPT {
            closed.pop_front();
        }
        closed.push_back(id.to_string());
    }

    /// Pull the next `count` rows of a still-open result set (see module docs).
    pub async fn fetch_more(&self, exec: &ExecutionId, result_index: usize, count: usize) -> Result<FetchedRows> {
        let ctl = self.exec_ctl(exec)?;
        let (reply, rx) = oneshot::channel();
        ctl.cmd.send(ExecCmd::FetchMore { result_index, count, reply }).map_err(|_| result_closed())?;
        // the execution task drops the reply when it closes the result meanwhile
        rx.await.map_err(|_| result_closed())?
    }

    /// Like `exec_ctl`, but an execution that is already finished / closed is `Ok(None)`:
    /// cancelling or closing it again is not an error.
    fn exec_ctl_if_open(&self, id: &ExecutionId) -> Result<Option<Arc<ExecCtl>>> {
        match self.exec_ctl(id) {
            Ok(c) => Ok(Some(c)),
            Err(DbError::InvalidArgument(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Cancel the running statement (and close any open result) of an execution.
    pub fn cancel(&self, exec: &ExecutionId) -> Result<()> {
        if let Some(c) = self.exec_ctl_if_open(exec)? {
            c.token.cancel();
        }
        Ok(())
    }

    /// Release the open result set of an execution without cancelling a running statement.
    /// Closing a result that is already closed (e.g. by the idle timeout) is a no-op.
    pub fn close_execution(&self, exec: &ExecutionId) -> Result<()> {
        if let Some(c) = self.exec_ctl_if_open(exec)? {
            let _ = c.cmd.send(ExecCmd::Close);
        }
        Ok(())
    }

    /// Convenience for tests / scripts: run `sql` and collect every event until `Done`.
    pub async fn execute_collect(&self, session: &SessionId, sql: &str, opts: ExecOptions) -> Result<Vec<ExecEvent>> {
        let mut h = self.execute(session, sql, opts).await?;
        let mut out = Vec::new();
        while let Some(e) = h.events.recv().await {
            let done = matches!(e, ExecEvent::Done { .. });
            out.push(e);
            if done {
                break;
            }
        }
        Ok(out)
    }
}
