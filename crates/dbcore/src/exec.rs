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
//! SQLite: `sqlite3_interrupt`. Oracle: a flag the connection's worker thread checks between rows plus the break
//! marker of the vendored driver for a call that is busy on the server (the statement fails with `ORA-01013`). Closing a partially read result cancels the query,
//! except inside an open transaction (see [`crate::tx`]) where the remaining rows are drained so
//! the transaction is not aborted. A *user* cancel inside a transaction does cancel: PostgreSQL then
//! aborts the transaction (`57014` surfaces while the rest is drained, the session becomes `failed` and
//! `TxStatus` is sent, so a later `COMMIT` reports `committed: false`); MySQL only rolls the statement back
//! (error 1317), the transaction stays `active`.
//!
//! # Oracle
//! Oracle has no autocommit: with `ExecOptions::auto_commit` (the console's Auto mode) every statement that
//! succeeded is committed right after it. After PL/SQL blocks, `CALL` / `EXEC` and queries that call functions
//! the lines written with `DBMS_OUTPUT.PUT_LINE` are drained and sent as `Message` events (before the error of a
//! failed statement, if any).
//!
//! # Lost connection
//! When a statement fails because the connection is gone (see [`DbError::ConnectionLost`]) the `Error` event
//! has `connection_lost: true` and a message starting with `[08006]` (`[08S01]` on MySQL); the script stops;
//! the session is marked dead (`ConnectionManager::session_state`), its transaction status becomes `Idle` and,
//! if a transaction was open, `TxEnded { committed: false, tag: "CONNECTION LOST" }` and `TxStatus { idle }`
//! follow the error. The next `execute` on a dead session without a lost transaction opens a new connection
//! first (a `Message` says so; `SET`/`USE` settings are gone); with a lost transaction it fails with the same
//! error until the session is closed.
//!
//! # Transaction events
//! After every statement the session's [`TxStatus`] is updated from the server (see `tx.rs`);
//! `TxStatus` is sent when it changed and `TxEnded` when a `COMMIT`/`ROLLBACK` (or a MySQL implicit
//! commit) ended a transaction, both before `Done`.

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
use crate::tx;
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

pub(crate) type ItemStream<'a> = BoxStream<'a, Result<Item>>;

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
                .map_err(DbError::from)
            })
            .boxed(),
        Conn::My(c) => sqlx::raw_sql(sql)
            .fetch_many(&mut *c)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::My(row)),
                })
                .map_err(DbError::from)
            })
            .boxed(),
        Conn::Lite(c) => sqlx::raw_sql(sql)
            .fetch_many(&mut *c)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::Lite(row)),
                })
                .map_err(DbError::from)
            })
            .boxed(),
        Conn::Ora(c) => c.stream(sql),
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
                RawRow::Ora(r) => crate::oracle::row_strings(r),
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
                .map_err(DbError::from)
            })
            .boxed(),
        Pool::My(p) => sqlx::raw_sql(sql)
            .fetch_many(p)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::My(row)),
                })
                .map_err(DbError::from)
            })
            .boxed(),
        Pool::Lite(p) => sqlx::raw_sql(sql)
            .fetch_many(p)
            .map(|r| {
                r.map(|e| match e {
                    Either::Left(q) => Item::Done(q.rows_affected()),
                    Either::Right(row) => Item::Row(RawRow::Lite(row)),
                })
                .map_err(DbError::from)
            })
            .boxed(),
        Pool::Ora(p) => p.stream(sql),
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
    /// Error found while closing the stream of an earlier statement of the script (not reported on its own).
    abort_err: Option<DbError>,
}

impl Task {
    /// Update the session's transaction state after a statement and report what changed. `conn` is
    /// `None` while a result stream still occupies the connection (state from the statement text only).
    async fn tx_after(
        &mut self,
        conn: Option<&mut Conn>,
        idx: usize,
        sql: &str,
        outcome: tx::Outcome,
    ) {
        let u = tx::after_statement(&self.sh.session, conn, sql, outcome).await;
        if self.done_sent {
            return;
        }
        if let Some((committed, tag)) = u.ended {
            self.sh.send(ExecEvent::TxEnded {
                index: idx,
                committed,
                tag: tag.to_string(),
            });
        }
        if let Some(text) = u.note {
            self.sh.send(ExecEvent::Message {
                index: Some(idx),
                text,
            });
        }
        if u.changed {
            self.sh.send(ExecEvent::TxStatus { status: u.status });
        }
    }

    /// Oracle, after a statement: show what `DBMS_OUTPUT` collected and, in Auto mode (`auto_commit`), commit a
    /// statement that succeeded (the server has no autocommit). Returns the error of the commit.
    async fn oracle_after(
        &mut self,
        conn: &mut Conn,
        idx: usize,
        sql: &str,
        ok: bool,
    ) -> Option<DbError> {
        let Conn::Ora(c) = conn else { return None };
        if crate::oracle::may_print(sql) {
            if let Ok(lines) = c.drain_output().await {
                for text in lines {
                    self.sh.send(ExecEvent::Message {
                        index: Some(idx),
                        text,
                    });
                }
            }
        }
        if ok && self.opts.auto_commit && c.in_transaction() {
            return c.commit().await.err().map(|e| e.for_driver(Driver::Oracle));
        }
        None
    }

    /// A statement (or the cleanup after it) failed with `e`, already tagged with the driver. Sends the
    /// `Error` event when `report` (or the connection is lost); returns true if the connection is gone:
    /// the session is dead then, the script must stop and the caller drops the connection.
    async fn statement_failed(
        &mut self,
        conn: Option<&mut Conn>,
        idx: usize,
        sql: &str,
        e: &DbError,
        report: bool,
    ) -> bool {
        if report || e.is_connection_lost() {
            self.send_error(idx, sql, e);
        }
        if let Some(had_tx) = self.sh.session.lose(e) {
            self.lost_events(idx, had_tx);
            return true;
        }
        self.tx_after(conn, idx, sql, tx::Outcome::from_error(e))
            .await;
        false
    }

    fn send_error(&self, idx: usize, sql: &str, e: &DbError) {
        self.sh.send(ExecEvent::Error {
            index: idx,
            message: e.to_string(),
            position: e.position(),
            position_utf16: e.position().map(|p| utf16_position(sql, p)),
            connection_lost: e.is_connection_lost(),
        });
    }

    /// The connection died: the open transaction (if any) is gone.
    fn lost_events(&self, idx: usize, had_tx: bool) {
        if had_tx {
            self.sh.send(ExecEvent::TxEnded {
                index: idx,
                committed: false,
                tag: "CONNECTION LOST".to_string(),
            });
            self.sh.send(ExecEvent::TxStatus {
                status: TxStatus::Idle,
            });
        }
    }

    /// An error that surfaced after the statement's `Done` (paging, closing the stream): account for it and
    /// tell the UI directly, `tx_after` is silent then.
    fn stream_failed(&self, idx: usize, sql: &str, e: &DbError, report: bool) {
        let before = self.sh.session.tx_status();
        if let Some(had_tx) = self.sh.session.lose(e) {
            if report {
                self.send_error(idx, sql, e);
            }
            self.lost_events(idx, had_tx);
            return;
        }
        tx::note_stream_error(&self.sh.session, e);
        let after = self.sh.session.tx_status();
        if after != before {
            self.sh.send(ExecEvent::TxStatus { status: after });
        }
    }

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
            Some(Err(e)) => return Pull::Err(e.for_driver(sh.session.live.driver())),
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
/// would abort an open transaction) and consume what is left so the connection is reusable. Returns the
/// error the server ended the stream with: after a cancel inside a PostgreSQL transaction this is `57014`,
/// and it means the transaction is aborted.
async fn abort_stream(mut stream: ItemStream<'_>, sh: &Shared) -> Option<DbError> {
    let in_tx = sh.session.in_tx();
    let user = sh.token.is_cancelled();
    // Oracle: a cancel only stops the statement, the transaction survives
    let cancel = !in_tx || user || sh.session.live.driver() == Driver::Oracle;
    if cancel {
        sh.session.cancel_running().await;
    }
    if matches!(sh.session.cancel_target(), CancelTarget::Lite(_)) {
        drop(stream);
        return None;
    }
    let mut err = None;
    while let Some(item) = stream.next().await {
        if let Err(e) = item {
            err.get_or_insert(e.for_driver(sh.session.live.driver()));
        }
    }
    err
}

/// Convert a 1-based position in Unicode code points (what PostgreSQL reports) into a 1-based offset in
/// UTF-16 code units (what the editor counts) inside `text`.
pub(crate) fn utf16_position(text: &str, position: usize) -> usize {
    1 + text
        .chars()
        .take(position.saturating_sub(1))
        .map(char::len_utf16)
        .sum::<usize>()
}

fn might_return_rows(sql: &str) -> bool {
    matches!(
        first_keyword(sql).as_str(),
        "SELECT"
            | "WITH"
            | "SHOW"
            | "EXPLAIN"
            | "VALUES"
            | "TABLE"
            | "DESCRIBE"
            | "DESC"
            | "PRAGMA"
            | "CALL"
            | "EXEC"
            | "EXECUTE"
            | "FETCH"
            | "LIST"
            | "ANALYZE"
    ) || sql.to_ascii_uppercase().contains("RETURNING")
}

enum Flow {
    Next,
    /// The result of the last statement is still open for paging (the connection is busy).
    Paged,
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
                task.sh.send(ExecEvent::ResultSet {
                    index: idx,
                    columns: cols,
                    rows: Vec::new(),
                    has_more: false,
                });
                return Ok(Flow::Next);
            }
        }
        task.sh.send(ExecEvent::Update {
            index: idx,
            rows_affected: st.rows_affected,
        });
        return Ok(Flow::Next);
    };

    if !has_more {
        drop(stream);
        task.sh.send(ExecEvent::ResultSet {
            index: idx,
            columns: cols,
            rows,
            has_more: false,
        });
    } else if is_last && !task.sh.token.is_cancelled() {
        task.sh.send(ExecEvent::ResultSet {
            index: idx,
            columns: cols,
            rows,
            has_more: true,
        });
        // the connection is busy: the state can only be derived from the statement text for now
        task.tx_after(None, idx, sql, tx::Outcome::Ok).await;
        // idle first, then `Done`: a client that reacts to `Done` with a new execute must
        // never see the session as busy
        task.sh.ctl.running.store(false, Ordering::Relaxed);
        task.send_done();
        let exhausted =
            page_loop(task, &mut stream, &decoder, &mut st, pending, idx, sql, t0).await;
        if !exhausted {
            if let Some(e) = abort_stream(stream, &task.sh).await {
                task.stream_failed(idx, sql, &e, true);
            }
        } else {
            drop(stream);
        }
        // the stream is gone: ask the server (silently, `Done` was sent long ago)
        if !task.sh.session.is_lost() {
            tx::refresh(&task.sh.session, conn).await;
        }
        return Ok(Flow::Paged);
    } else {
        task.sh.send(ExecEvent::ResultSet {
            index: idx,
            columns: cols,
            rows,
            has_more: false,
        });
        task.sh.send(ExecEvent::Message {
            index: Some(idx),
            text: format!(
                "Result {} was truncated to {} rows (only the last statement of a script can be paged)",
                idx + 1,
                max
            ),
        });
        task.abort_err = abort_stream(stream, &task.sh).await;
    }
    Ok(Flow::Next)
}

/// Serve `fetch_more` requests for the open stream. Returns true if the stream was
/// exhausted, false if the result was closed early.
#[allow(clippy::too_many_arguments)]
async fn page_loop(
    task: &mut Task,
    stream: &mut ItemStream<'_>,
    dec: &RowDecoder,
    st: &mut StreamState,
    mut pending: Option<Vec<Cell>>,
    idx: usize,
    sql: &str,
    t0: Instant,
) -> bool {
    // idle limit for the open result: every request restarts it
    let keep_open =
        (task.opts.keep_open_secs > 0).then(|| Duration::from_secs(task.opts.keep_open_secs));
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
            Some(ExecCmd::FetchMore {
                result_index,
                count,
                reply,
            }) => {
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
                            task.stream_failed(idx, sql, &e, false);
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
                            task.stream_failed(idx, sql, &e, false);
                            err = Some(e);
                            exhausted = true;
                        }
                    }
                }
                let _ = reply.send(match err {
                    Some(e) => Err(e),
                    None => Ok(FetchedRows {
                        rows: out,
                        has_more: !exhausted,
                    }),
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
        sh: Shared {
            token: ctl.token.clone(),
            session: sess.clone(),
            tx,
            ctl: ctl.clone(),
        },
        cmd_rx,
        opts,
        exec: Duration::ZERO,
        fetch: Duration::ZERO,
        started: Instant::now(),
        done_sent: false,
        abort_err: None,
    };
    let mut guard = sess.conn.clone().lock_owned().await;
    match sess.ensure_conn(&mut guard).await {
        Err(e) => {
            let first = stmts.first().map(|s| s.text.as_str()).unwrap_or("");
            task.send_error(0, first, &e);
        }
        Ok(reopened) => {
            if reopened {
                task.sh.send(ExecEvent::Message {
                    index: None,
                    text: "The connection to the server had been lost: a new connection was opened. Session settings \
                           (current database / schema, search_path, SET variables) were reset."
                        .to_string(),
                });
            }
            let n = stmts.len();
            for (i, st) in stmts.iter().enumerate() {
                if task.sh.token.is_cancelled() {
                    break;
                }
                let Some(conn) = guard.as_mut() else { break };
                task.sh.send(ExecEvent::Statement {
                    index: i,
                    sql: st.text.clone(),
                    range: st.range(),
                });
                ctl.running.store(true, Ordering::Relaxed);
                let mut lost = false;
                match run_statement(&mut task, conn, i, &st.text, i + 1 == n).await {
                    Ok(Flow::Next) => match task.abort_err.take() {
                        None => match task.oracle_after(conn, i, &st.text, true).await {
                            None => {
                                task.tx_after(Some(&mut *conn), i, &st.text, tx::Outcome::Ok)
                                    .await
                            }
                            // Auto mode: the commit after the statement failed
                            Some(e) => {
                                lost = task
                                    .statement_failed(Some(&mut *conn), i, &st.text, &e, true)
                                    .await;
                                if !lost && task.opts.stop_on_error {
                                    break;
                                }
                            }
                        },
                        // the statement itself finished; closing its stream hit an error (a cancel)
                        Some(e) => {
                            lost = task
                                .statement_failed(Some(&mut *conn), i, &st.text, &e, false)
                                .await
                        }
                    },
                    Ok(Flow::Paged) => lost = sess.is_lost(),
                    Err(e) => {
                        let e = e.for_driver(sess.live.driver());
                        if !e.is_connection_lost() {
                            task.oracle_after(conn, i, &st.text, false).await;
                        }
                        lost = task
                            .statement_failed(Some(&mut *conn), i, &st.text, &e, true)
                            .await;
                        if !lost && task.opts.stop_on_error {
                            break;
                        }
                    }
                }
                if lost {
                    // the connection is gone: drop it, the rest of the script cannot run
                    *guard = None;
                    break;
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
    pub async fn execute(
        &self,
        session: &SessionId,
        sql: &str,
        opts: ExecOptions,
    ) -> Result<ExecHandle> {
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
                    return Err(DbError::Busy(
                        "The session is busy executing another statement".into(),
                    ));
                }
                // previous result is only being held open for paging: release it
                let _ = prev.cmd.send(ExecCmd::Close);
            }
            *cur = Some((id.clone(), ctl.clone()));
        }
        self.inner
            .execs
            .lock()
            .unwrap()
            .insert(id.clone(), ctl.clone());
        tokio::spawn(exec_task(
            self.clone(),
            sess,
            ctl,
            id.clone(),
            stmts,
            opts,
            tx,
            cmd_rx,
        ));
        Ok(ExecHandle {
            id: ExecutionId(id),
            events: rx,
        })
    }

    fn exec_ctl(&self, id: &ExecutionId) -> Result<Arc<ExecCtl>> {
        self.inner
            .execs
            .lock()
            .unwrap()
            .get(&id.0)
            .cloned()
            .ok_or_else(|| {
                if self
                    .inner
                    .closed_execs
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|c| c == &id.0)
                {
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
    pub async fn fetch_more(
        &self,
        exec: &ExecutionId,
        result_index: usize,
        count: usize,
    ) -> Result<FetchedRows> {
        let ctl = self.exec_ctl(exec)?;
        let (reply, rx) = oneshot::channel();
        ctl.cmd
            .send(ExecCmd::FetchMore {
                result_index,
                count,
                reply,
            })
            .map_err(|_| result_closed())?;
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
    pub async fn execute_collect(
        &self,
        session: &SessionId,
        sql: &str,
        opts: ExecOptions,
    ) -> Result<Vec<ExecEvent>> {
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
