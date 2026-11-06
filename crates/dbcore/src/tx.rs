//! Transaction state of a session.
//!
//! The UI needs to know whether a session is `idle`, in a transaction (`active`) or in an aborted one
//! (`failed`, PostgreSQL only), and it must be what the *server* thinks, not what the user typed:
//!
//! * **MySQL / MariaDB**: DDL & co. commit implicitly, `SET autocommit = 0` opens transactions without a
//!   `BEGIN`. sqlx keeps the server status flags private, and `@@in_transaction` only exists on MariaDB, so
//!   after a statement the session asks the server with a savepoint probe (one round trip):
//!   `savepoint p; rollback to savepoint p; release savepoint p`. Outside a transaction `ROLLBACK TO` fails
//!   with error 1305 (the savepoint died with the statement); inside one all three succeed and change nothing.
//!   Plain reads / DML on an idle autocommit session skip the probe (they cannot change the state).
//! * **SQLite**: `sqlite3_get_autocommit` on the raw handle (exact).
//! * **PostgreSQL**: the wire protocol reports the transaction status in every `ReadyForQuery`, but sqlx
//!   does not expose it and there is no reliable SQL-level probe that is free of side effects (`SAVEPOINT`
//!   would log an error in the server log on every autocommit statement). The state is therefore tracked
//!   from `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` statements and statement errors (an error inside a
//!   transaction aborts it), and corrected by what the server says: SQLSTATE `25P02` means failed, `25P01`
//!   means idle, and a statement that succeeds in a "failed" transaction proves it was not failed. Not
//!   detected: transaction control inside `DO` blocks / procedures (`CALL p()` that commits), and the
//!   server ending the session's transaction on its own (`idle_in_transaction_session_timeout` also closes
//!   the connection).

use std::sync::atomic::Ordering;

use crate::conn::Conn;
use crate::error::{DbError, Result};
use crate::exec::open_stream;
use crate::manager::Session;
use crate::model::{Driver, TxStatus};
use futures_util::StreamExt;

/// What a statement does to the transaction, judged from its text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TxKind {
    Begin,
    Commit { chain: bool },
    Rollback { chain: bool },
    /// `ROLLBACK TO SAVEPOINT`: ends a failed state but not the transaction.
    RollbackTo,
    /// `PREPARE TRANSACTION` (PG): the session leaves the transaction.
    Prepare,
    Other,
}

fn strip_comments(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map(|x| x.1).unwrap_or("").trim_start();
        } else {
            return rest;
        }
    }
}

/// The first `n` words (letters / digits / `_`) of the statement, upper-cased.
fn words(sql: &str, n: usize) -> Vec<String> {
    strip_comments(sql)
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .take(n)
        .map(|w| w.to_ascii_uppercase())
        .collect()
}

pub(crate) fn classify(sql: &str) -> TxKind {
    let w = words(sql, 12);
    let w: Vec<&str> = w.iter().map(String::as_str).collect();
    let chain = || w.windows(2).any(|p| p == ["AND", "CHAIN"]);
    match w.first().copied() {
        Some("BEGIN") => TxKind::Begin,
        Some("START") if w.get(1) == Some(&"TRANSACTION") => TxKind::Begin,
        Some("COMMIT" | "END") if w.get(1) == Some(&"PREPARED") => TxKind::Other,
        Some("COMMIT" | "END") => TxKind::Commit { chain: chain() },
        Some("ROLLBACK" | "ABORT") if w.get(1) == Some(&"PREPARED") => TxKind::Other,
        Some("ROLLBACK" | "ABORT") if w.get(1) == Some(&"TO") || w.get(2) == Some(&"TO") => TxKind::RollbackTo,
        Some("ROLLBACK" | "ABORT") => TxKind::Rollback { chain: chain() },
        Some("PREPARE") if w.get(1) == Some(&"TRANSACTION") => TxKind::Prepare,
        _ => TxKind::Other,
    }
}

/// How a statement ended (owned, so it can be held across `.await`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    Ok,
    /// Failed; carries the SQLSTATE when the server reported one.
    Err(Option<String>),
}

impl Outcome {
    pub fn of<T>(r: &Result<T>) -> Outcome {
        match r {
            Ok(_) => Outcome::Ok,
            Err(e) => Outcome::from_error(e),
        }
    }

    pub fn from_error(e: &DbError) -> Outcome {
        Outcome::Err(e.server().map(|s| s.code.clone()))
    }

    fn is_ok(&self) -> bool {
        *self == Outcome::Ok
    }
}

/// PostgreSQL: next state from the previous one, the statement and its outcome.
pub(crate) fn track_pg(prev: TxStatus, kind: TxKind, outcome: &Outcome) -> TxStatus {
    use TxStatus::*;
    match outcome {
        Outcome::Ok => match kind {
            TxKind::Begin => {
                if prev == Idle {
                    Active
                } else {
                    prev
                }
            }
            TxKind::Commit { chain } | TxKind::Rollback { chain } => {
                if chain {
                    Active
                } else {
                    Idle
                }
            }
            TxKind::RollbackTo => Active,
            TxKind::Prepare => Idle,
            // it ran, so the transaction was not aborted after all
            TxKind::Other => {
                if prev == Failed {
                    Active
                } else {
                    prev
                }
            }
        },
        Outcome::Err(state) => {
            match (state.as_deref(), kind) {
                (Some("25P02"), _) => Failed,
                (Some("25P01"), _) => Idle,
                // a failing COMMIT still ends the transaction (rolled back)
                (_, TxKind::Commit { chain: false }) => Idle,
                _ if prev == Active => Failed,
                _ => prev,
            }
        }
    }
}

/// MySQL / SQLite fallback when the server cannot be asked (result stream still open).
pub(crate) fn track_keywords(prev: TxStatus, kind: TxKind, ok: bool) -> TxStatus {
    if !ok {
        return prev;
    }
    match kind {
        TxKind::Begin => TxStatus::Active,
        TxKind::Commit { chain } | TxKind::Rollback { chain } => {
            if chain {
                TxStatus::Active
            } else {
                TxStatus::Idle
            }
        }
        _ => prev,
    }
}

/// MySQL statements that cannot change the transaction state of an idle autocommit session.
fn mysql_plain(sql: &str) -> bool {
    matches!(
        words(sql, 1).first().map(String::as_str),
        Some(
            "SELECT" | "SHOW" | "EXPLAIN" | "DESCRIBE" | "DESC" | "USE" | "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "WITH"
                | "VALUES" | "TABLE"
        )
    )
}

fn starts_with_word(sql: &str, w: &str) -> bool {
    words(sql, 1).first().map(String::as_str) == Some(w)
}

/// MySQL: ask the server (see the module docs).
async fn probe_mysql(conn: &mut Conn) -> Option<TxStatus> {
    let sql = "savepoint prometeo_tx_probe; rollback to savepoint prometeo_tx_probe; release savepoint prometeo_tx_probe";
    let mut stream = open_stream(conn, sql);
    while let Some(item) = stream.next().await {
        if let Err(e) = item {
            return match DbError::from(e).server().and_then(|s| s.native_code) {
                // ER_SP_DOES_NOT_EXIST: no transaction, so no savepoint
                Some(1305) => Some(TxStatus::Idle),
                _ => None,
            };
        }
    }
    Some(TxStatus::Active)
}

async fn mysql_autocommit(conn: &mut Conn) -> Option<bool> {
    let v = crate::exec::conn_scalar(conn, "select @@autocommit").await.ok()??;
    Some(v != "0")
}

/// SQLite: `sqlite3_get_autocommit`.
async fn probe_sqlite(conn: &mut Conn) -> Option<TxStatus> {
    let Conn::Lite(c) = conn else { return None };
    let mut h = c.lock_handle().await.ok()?;
    let ptr = h.as_raw_handle().as_ptr();
    // SAFETY: the handle is locked by `lock_handle` (the worker thread cannot use it meanwhile).
    let auto = unsafe { libsqlite3_sys::sqlite3_get_autocommit(ptr) };
    Some(if auto == 0 { TxStatus::Active } else { TxStatus::Idle })
}

/// Read the real state of an idle connection (MySQL / SQLite). PostgreSQL has no probe: `None`.
pub(crate) async fn probe(conn: &mut Conn) -> Option<TxStatus> {
    match conn {
        Conn::My(_) => probe_mysql(conn).await,
        Conn::Lite(_) => probe_sqlite(conn).await,
        Conn::Pg(_) => None,
    }
}

/// What a finished statement did to the transaction.
pub(crate) struct TxUpdate {
    pub status: TxStatus,
    pub changed: bool,
    /// `(committed, command tag)` when the statement ended a transaction.
    pub ended: Option<(bool, &'static str)>,
    /// Extra text for the user (the surprising cases).
    pub note: Option<String>,
}

/// Update the session's state after `sql` ran with `outcome`. `conn` is the (idle) session connection, or
/// `None` while a result stream still occupies it (the state is then derived from the statement text only).
pub(crate) async fn after_statement(
    sess: &Session,
    conn: Option<&mut Conn>,
    sql: &str,
    outcome: Outcome,
) -> TxUpdate {
    let prev = sess.tx_status();
    let kind = classify(sql);
    let ok = outcome.is_ok();
    let driver = sess.live.driver();
    let mut next = match driver {
        Driver::Postgres => track_pg(prev, kind, &outcome),
        _ => track_keywords(prev, kind, ok),
    };
    if let Some(conn) = conn {
        let probed = match driver {
            Driver::Postgres => None,
            Driver::Sqlite => probe(conn).await,
            Driver::MySql => {
                let plain = ok && kind == TxKind::Other && prev == TxStatus::Idle && mysql_plain(sql);
                if plain && sess.autocommit_on.load(Ordering::Relaxed) {
                    None
                } else {
                    let st = probe(conn).await;
                    if ok && (starts_with_word(sql, "SET") || starts_with_word(sql, "CALL")) {
                        if let Some(a) = mysql_autocommit(conn).await {
                            sess.autocommit_on.store(a, Ordering::Relaxed);
                        }
                    }
                    st
                }
            }
        };
        if let Some(p) = probed {
            next = p;
        }
    }
    sess.set_tx_status(next);

    let mut ended = None;
    let mut note = None;
    match kind {
        TxKind::Commit { .. } if prev.is_open() && ok => {
            if driver == Driver::Postgres && prev == TxStatus::Failed {
                ended = Some((false, "ROLLBACK"));
                note = Some(
                    "COMMIT rolled the transaction back: it was in a failed state (command tag: ROLLBACK). Nothing was saved."
                        .to_string(),
                );
            } else {
                ended = Some((true, "COMMIT"));
            }
        }
        TxKind::Commit { .. } if prev.is_open() && driver == Driver::Postgres => {
            // the COMMIT itself failed (e.g. a deferred constraint): the server rolled back
            ended = Some((false, "ROLLBACK"));
        }
        TxKind::Rollback { .. } if prev.is_open() && ok => ended = Some((false, "ROLLBACK")),
        _ => {
            if driver == Driver::MySql && ok && prev.is_open() && next == TxStatus::Idle && matches!(kind, TxKind::Other | TxKind::Begin) {
                ended = Some((true, "IMPLICIT COMMIT"));
                note = Some("The statement committed the open transaction implicitly (MySQL DDL / transaction control).".to_string());
            }
        }
    }
    TxUpdate { status: next, changed: next != prev, ended, note }
}

/// An error that surfaced while paging an open result (after the statement itself was accounted for).
pub(crate) fn note_stream_error(sess: &Session, e: &DbError) {
    if sess.live.driver() == Driver::Postgres {
        sess.set_tx_status(track_pg(sess.tx_status(), TxKind::Other, &Outcome::from_error(e)));
    }
}

/// Re-read the state of an idle session connection that someone else used (edits, table reads).
pub(crate) async fn refresh(sess: &Session, conn: &mut Conn) {
    if let Some(p) = probe(conn).await {
        sess.set_tx_status(p);
    }
}

/// Run `sql` on a freshly opened connection and track it (used for the `init_sql` of `open_session`).
pub(crate) async fn run_tracked(sess: &Session, conn: &mut Conn, sql: &str) -> Result<()> {
    let res: Result<()> = async {
        let mut stream = open_stream(conn, sql);
        while let Some(item) = stream.next().await {
            item?;
        }
        Ok(())
    }
    .await;
    after_statement(sess, Some(conn), sql, Outcome::of(&res)).await;
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ServerError;

    fn pg_err(code: &str) -> DbError {
        DbError::Server(Box::new(ServerError {
            driver: Driver::Postgres,
            code: code.into(),
            native_code: None,
            severity: None,
            message: "x".into(),
            detail: None,
            hint: None,
            position: None,
        }))
    }

    #[test]
    fn classification() {
        assert_eq!(classify("  /* c */ begin isolation level serializable"), TxKind::Begin);
        assert_eq!(classify("START TRANSACTION READ ONLY"), TxKind::Begin);
        assert_eq!(classify("start slave"), TxKind::Other);
        assert_eq!(classify("commit"), TxKind::Commit { chain: false });
        assert_eq!(classify("END"), TxKind::Commit { chain: false });
        assert_eq!(classify("commit and chain"), TxKind::Commit { chain: true });
        assert_eq!(classify("commit and no chain"), TxKind::Commit { chain: false });
        assert_eq!(classify("rollback"), TxKind::Rollback { chain: false });
        assert_eq!(classify("abort and chain"), TxKind::Rollback { chain: true });
        assert_eq!(classify("rollback to savepoint a"), TxKind::RollbackTo);
        assert_eq!(classify("rollback to a"), TxKind::RollbackTo);
        assert_eq!(classify("commit prepared 'x'"), TxKind::Other);
        assert_eq!(classify("prepare transaction 'x'"), TxKind::Prepare);
        assert_eq!(classify("prepare p as select 1"), TxKind::Other);
        assert_eq!(classify("select 'commit'"), TxKind::Other);
    }

    #[test]
    fn postgres_state_machine() {
        use TxStatus::*;
        let ok = &Outcome::Ok;
        assert_eq!(track_pg(Idle, TxKind::Begin, ok), Active);
        assert_eq!(track_pg(Active, TxKind::Other, ok), Active);
        let e = Outcome::from_error(&pg_err("22012"));
        assert_eq!(track_pg(Active, TxKind::Other, &e), Failed);
        assert_eq!(track_pg(Idle, TxKind::Other, &e), Idle);
        assert_eq!(track_pg(Failed, TxKind::Other, &Outcome::from_error(&pg_err("25P02"))), Failed);
        assert_eq!(track_pg(Failed, TxKind::RollbackTo, ok), Active);
        assert_eq!(track_pg(Failed, TxKind::Commit { chain: false }, ok), Idle);
        assert_eq!(track_pg(Failed, TxKind::Rollback { chain: false }, ok), Idle);
        assert_eq!(track_pg(Active, TxKind::Commit { chain: true }, ok), Active);
        assert_eq!(track_pg(Active, TxKind::Commit { chain: false }, &e), Idle);
        // self-healing
        assert_eq!(track_pg(Idle, TxKind::Other, &Outcome::from_error(&pg_err("25P02"))), Failed);
        assert_eq!(track_pg(Active, TxKind::Other, &Outcome::from_error(&pg_err("25P01"))), Idle);
        assert_eq!(track_pg(Failed, TxKind::Other, ok), Active);
    }
}
