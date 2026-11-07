//! Transaction state of a session.
//!
//! The UI needs to know whether a session is `idle`, in a transaction (`active`) or in an aborted one
//! (`failed`, PostgreSQL only), and it must be what the *server* thinks, not what the user typed:
//!
//! * **MySQL / MariaDB**: DDL & co. commit implicitly, `SET autocommit = 0` opens transactions without a
//!   `BEGIN`. sqlx keeps the server status flags private and any probe statement would have side effects
//!   (`show warnings`, `row_count()`, `found_rows()` are per statement, and with `autocommit = 0` the probe
//!   itself would open a transaction), so **nothing is sent to the server**: the state is derived
//!   deterministically from the statements (see [`track_mysql`]). `@@autocommit` is read once, when the
//!   session is opened, before any user statement. From then on:
//!   - `BEGIN` / `START TRANSACTION` / `XA START` commit what is open and start a transaction;
//!     `COMMIT` / `ROLLBACK` / `XA COMMIT` / `XA ROLLBACK` end it (`AND CHAIN` starts the next one);
//!   - the statements of MySQL 8.4 manual 15.3.3 "Statements That Cause an Implicit Commit" end it with a
//!     commit (DDL on tables / databases / views / routines / triggers / events / indexes / users, `GRANT`,
//!     `REVOKE`, `SET PASSWORD`, `LOCK TABLES`, `UNLOCK TABLES` after a `LOCK TABLES`, `ANALYZE` / `CHECK` /
//!     `OPTIMIZE` / `REPAIR TABLE`, `CACHE INDEX`, `LOAD INDEX`, `FLUSH`, `RESET`, replication control, ...;
//!     not `CREATE / DROP TEMPORARY TABLE`). They commit before they run, so they commit even when they
//!     fail, unless they fail to parse (error 1064);
//!   - statements are classified on a token stream without comments (`-- `, `#`, `/* */`, `/*+ hint */`);
//!     `/*! ... */` and `/*!NNNNN ... */` are code when `NNNNN` is not above the server version (`@@version`, read
//!     once with `@@autocommit`) and their content is classified like the rest of the statement;
//!   - `SET [SESSION] autocommit = 0|1|ON|OFF` / `SET @@autocommit` is followed; `SET autocommit = 1` commits
//!     an open transaction (only when it was 0);
//!   - with `autocommit = 0` every other statement opens a transaction, except the ones that cannot touch
//!     a table: `SET`, `USE`, `SHOW WARNINGS` / `ERRORS`, `SELECT` without `FROM`, `PREPARE`, `KILL`, ...;
//!   - a deadlock (error 1213) rolls the transaction back; other errors leave the state as it was (the
//!     statement is rolled back, the transaction stays, also after `KILL QUERY`).
//!
//!   Not detected: transaction control inside stored routines (`CALL p()` that commits) and
//!   `SET autocommit = <expression>`; a `SELECT` of a non-transactional table with `autocommit = 0`
//!   is counted as opening a transaction.
//!   PostgreSQL details checked against a real server (`tests/tx_pg.rs`): `COMMIT AND CHAIN` /
//!   `ROLLBACK AND CHAIN` keep a transaction open, also from a failed one (which rolls back and chains) and
//!   fail with `25P01` outside one; a failing `COMMIT` / `COMMIT AND CHAIN` / `END` rolls back and leaves the
//!   session idle; `PREPARE TRANSACTION` detaches the transaction (idle, `TxEnded` tag `PREPARE TRANSACTION`),
//!   rolls back when it fails, and acts as `ROLLBACK` in a failed transaction; `COMMIT PREPARED` /
//!   `ROLLBACK PREPARED` inside a transaction fail it. `apply_changes_in_session` rolls back to its own
//!   savepoint, so a failing batch leaves an active transaction active.
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
use crate::split::Scanner;
use futures_util::StreamExt;

/// What a statement does to the transaction, judged from its text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TxKind {
    Begin,
    Commit {
        chain: bool,
    },
    Rollback {
        chain: bool,
    },
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
        Some("ROLLBACK" | "ABORT") if w.get(1) == Some(&"TO") || w.get(2) == Some(&"TO") => {
            TxKind::RollbackTo
        }
        Some("ROLLBACK" | "ABORT") => TxKind::Rollback { chain: chain() },
        Some("PREPARE") if w.get(1) == Some(&"TRANSACTION") => TxKind::Prepare,
        _ => TxKind::Other,
    }
}

/// How a statement ended (owned, so it can be held across `.await`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    Ok,
    /// Failed; carries the SQLSTATE / vendor number when the server reported one.
    Err {
        state: Option<String>,
        native: Option<i64>,
    },
}

impl Outcome {
    pub fn of<T>(r: &Result<T>) -> Outcome {
        match r {
            Ok(_) => Outcome::Ok,
            Err(e) => Outcome::from_error(e),
        }
    }

    pub fn from_error(e: &DbError) -> Outcome {
        Outcome::Err {
            state: e.server().map(|s| s.code.clone()),
            native: e.server().and_then(|s| s.native_code),
        }
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
        Outcome::Err { state, .. } => {
            match (state.as_deref(), kind) {
                (Some("25P02"), _) => Failed,
                (Some("25P01"), _) => Idle,
                // a failing COMMIT [AND CHAIN] / END still ends the transaction (rolled back; no new one is chained)
                (_, TxKind::Commit { .. }) => Idle,
                // a PREPARE TRANSACTION that fails (prepared transactions disabled, duplicate gid, ...) rolls the
                // transaction back; only a syntax error is an ordinary error of the transaction
                (Some("42601"), TxKind::Prepare) if prev == Active => Failed,
                (_, TxKind::Prepare) => Idle,
                _ if prev == Active => Failed,
                _ => prev,
            }
        }
    }
}

/// SQLite fallback while a result stream still occupies the connection: the statement text only.
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

// ------------------------------------------------------------------ MySQL

/// What a MySQL statement does to the transaction, judged from its text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MyStmt {
    /// `BEGIN`, `START TRANSACTION`, `XA START`: commits what is open, then starts a transaction.
    Begin,
    /// `COMMIT`, `ROLLBACK`, `XA COMMIT`, `XA ROLLBACK` (`chain`: `AND CHAIN` starts the next transaction).
    End {
        commit: bool,
        chain: bool,
    },
    /// `ROLLBACK TO SAVEPOINT`: the transaction stays.
    RollbackTo,
    /// `SET ... autocommit = v ...` (`None`: a value that is not a literal).
    SetAutocommit(Option<bool>),
    /// A statement that commits implicitly (manual 15.3.3).
    ImplicitCommit,
    LockTables,
    UnlockTables,
    /// Cannot open a transaction nor change one: `SET`, `USE`, `SHOW WARNINGS`, `SELECT 1`, `PREPARE`, ...
    Passive,
    Other,
}

/// A token of a MySQL statement. Comments are gone; the content of executable comments is part of the stream.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    /// Bare word or number, upper-cased.
    Word(String),
    /// `` `quoted` `` identifier, upper-cased (never a keyword).
    Ident(String),
    /// `'...'` / `"..."`, the text between the quotes, lower-cased.
    Str(String),
    /// Any other single character.
    Sym(u8),
}

/// The server a MySQL session runs on, as far as comment handling needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ServerVer {
    /// `major * 10000 + minor * 100 + patch`, like `MYSQL_VERSION_ID` (`u32::MAX` when unknown: every
    /// version-gated comment is then executed).
    pub num: u32,
    pub mariadb: bool,
}

impl ServerVer {
    pub(crate) const UNKNOWN: ServerVer = ServerVer {
        num: u32::MAX,
        mariadb: false,
    };

    /// From `@@version`: `8.4.3`, `8.0.36-0ubuntu0.22.04.1`, `10.11.6-MariaDB-1:10.11.6+maria~ubu2204`,
    /// `5.5.5-10.0.38-MariaDB` (the replication-compatible prefix of old MariaDB clients).
    pub(crate) fn parse(v: &str) -> ServerVer {
        let mariadb = v.contains("MariaDB");
        let v = if mariadb {
            v.strip_prefix("5.5.5-").unwrap_or(v)
        } else {
            v
        };
        let mut it = v
            .split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .map(|p| p.parse::<u32>().unwrap_or(0));
        match (it.next(), it.next(), it.next()) {
            (Some(a), Some(b), Some(c)) => ServerVer {
                num: a * 10000 + b * 100 + c,
                mariadb,
            },
            _ => ServerVer::UNKNOWN,
        }
    }
}

/// Tokens of a MySQL statement, the way the server's lexer sees them:
/// * `-- ` (a space or control character must follow the dashes), `#` and `/* */` are comments, as are
///   `/*+ ... */` optimizer hints;
/// * `/*! ... */` and `/*!NNNNN ... */` (also `/*M!NNNNN ... */` on MariaDB) are *code* when `NNNNN` (five or six
///   digits) is not above the server version: only the delimiters go, the content is tokenized. Above it, the
///   whole comment is skipped.
///
/// The comment and quote scanning is the splitter's ([`Scanner`]).
fn mysql_tokens(sql: &str, ver: ServerVer) -> Vec<Tok> {
    let sc = Scanner::new(sql, Driver::MySql);
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut i = 0;
    // executable comments that are open: their `*/` is skipped
    let mut open = 0usize;
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80;
    while i < n {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'*' && open > 0 && b.get(i + 1) == Some(&b'/') {
            open -= 1;
            i += 2;
        } else if c == b'/'
            && b.get(i + 1) == Some(&b'*')
            && (b.get(i + 2) == Some(&b'!')
                || (ver.mariadb && b.get(i + 2..i + 4) == Some(&b"M!"[..])))
        {
            let mut j = i + if b[i + 2] == b'!' { 3 } else { 4 };
            let digits = b[j..].iter().take_while(|d| d.is_ascii_digit()).count();
            let mut run = true;
            if digits == 5 || digits == 6 {
                // a leading 0 is allowed in the six digit form (`080000`)
                let v: u32 = sql[j..j + digits].parse().unwrap_or(u32::MAX);
                run = v <= ver.num;
                j += digits;
            }
            if run {
                open += 1;
                i = j;
            } else {
                i = sc.skip_block_comment(i);
            }
        } else if let Some(e) = sc.comment_end(i, false) {
            i = e;
        } else if matches!(c, b'\'' | b'"' | b'`') {
            let e = sc.skip_quoted(i, c, c != b'`');
            let text = &sql[i + 1..e.saturating_sub(1).max(i + 1)];
            out.push(match c {
                b'`' => Tok::Ident(text.to_ascii_uppercase()),
                _ => Tok::Str(text.to_ascii_lowercase()),
            });
            i = e;
        } else if is_word(c) {
            let st = i;
            while i < n && is_word(b[i]) {
                i += 1;
            }
            out.push(Tok::Word(sql[st..i].to_ascii_uppercase()));
        } else {
            out.push(Tok::Sym(c));
            i += 1;
        }
    }
    out
}

/// `SET [SESSION] autocommit = 0, @@autocommit = ON, ...`: `Some(value)` of the last assignment to the
/// session variable `autocommit` (`Some(None)` when its value is not a plain 0 / 1 / ON / OFF / TRUE / FALSE).
fn set_autocommit(toks: &[Tok]) -> Option<Option<bool>> {
    let set = toks.iter().position(|t| matches!(t, Tok::Word(_)))?;
    let body = &toks[set + 1..];
    let (mut parts, mut from, mut depth) = (Vec::new(), 0, 0i32);
    for (i, t) in body.iter().enumerate() {
        match t {
            Tok::Sym(b'(') => depth += 1,
            Tok::Sym(b')') => depth -= 1,
            Tok::Sym(b',') if depth == 0 => {
                parts.push(&body[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&body[from..]);
    let mut found = None;
    for part in parts {
        let Some(eq) = part.iter().position(|t| *t == Tok::Sym(b'=')) else {
            continue;
        };
        let mut lhs = &part[..eq];
        let mut rhs = &part[eq + 1..];
        if lhs.last() == Some(&Tok::Sym(b':')) {
            lhs = &lhs[..lhs.len() - 1];
        }
        while rhs.last() == Some(&Tok::Sym(b';')) {
            rhs = &rhs[..rhs.len() - 1];
        }
        let name: Vec<String> = lhs
            .iter()
            .map(|t| match t {
                Tok::Word(w) | Tok::Ident(w) => w.clone(),
                Tok::Str(_) => "'".into(),
                Tok::Sym(c) => (*c as char).to_string(),
            })
            .collect();
        let name: Vec<&str> = name.iter().map(String::as_str).collect();
        let session_var = matches!(
            name.as_slice(),
            ["AUTOCOMMIT"]
                | ["SESSION" | "LOCAL", "AUTOCOMMIT"]
                | ["@", "@", "AUTOCOMMIT"]
                | ["@", "@", "SESSION" | "LOCAL", ".", "AUTOCOMMIT"]
        );
        if !session_var {
            continue;
        }
        found = Some(match rhs {
            [Tok::Word(v)] | [Tok::Str(v)] => match v.to_ascii_lowercase().as_str() {
                "0" | "off" | "false" => Some(false),
                "1" | "on" | "true" | "default" => Some(true),
                _ => None,
            },
            _ => None,
        });
    }
    found
}

/// Classify a MySQL statement. Everything is judged on the token stream (see [`mysql_tokens`]), so comments
/// anywhere in the statement neither hide nor fake a keyword. `ver` is the server version of the session.
pub(crate) fn classify_mysql(sql: &str, ver: ServerVer) -> MyStmt {
    let toks = mysql_tokens(sql, ver);
    let w: Vec<&str> = toks
        .iter()
        .filter_map(|t| {
            if let Tok::Word(w) = t {
                Some(w.as_str())
            } else {
                None
            }
        })
        .take(6)
        .collect();
    let w1 = w.get(1).copied();
    let chain = w.windows(2).any(|p| p == ["AND", "CHAIN"]);
    let no_chain = chain && !w.windows(3).any(|p| p == ["AND", "NO", "CHAIN"]);
    match w.first().copied() {
        Some("BEGIN") => MyStmt::Begin,
        Some("START") => match w1 {
            Some("TRANSACTION") => MyStmt::Begin,
            Some("REPLICA" | "SLAVE" | "GROUP_REPLICATION") => MyStmt::ImplicitCommit,
            _ => MyStmt::Other,
        },
        Some("COMMIT") => MyStmt::End {
            commit: true,
            chain: no_chain,
        },
        Some("ROLLBACK") if w1 == Some("TO") || w.get(2) == Some(&"TO") => MyStmt::RollbackTo,
        Some("ROLLBACK") => MyStmt::End {
            commit: false,
            chain: no_chain,
        },
        Some("XA") => match w1 {
            Some("START" | "BEGIN") => MyStmt::Begin,
            Some("COMMIT") => MyStmt::End {
                commit: true,
                chain: false,
            },
            Some("ROLLBACK") => MyStmt::End {
                commit: false,
                chain: false,
            },
            _ => MyStmt::Passive,
        },
        Some("SET") => match set_autocommit(&toks) {
            Some(v) => MyStmt::SetAutocommit(v),
            None if w1 == Some("PASSWORD") => MyStmt::ImplicitCommit,
            None => MyStmt::Passive,
        },
        Some("CREATE" | "DROP") if w1 == Some("TEMPORARY") => MyStmt::Other,
        Some(
            "CREATE" | "ALTER" | "DROP" | "RENAME" | "TRUNCATE" | "GRANT" | "REVOKE" | "INSTALL"
            | "UNINSTALL" | "ANALYZE" | "CHECK" | "OPTIMIZE" | "REPAIR" | "CACHE" | "FLUSH"
            | "CHANGE",
        ) => MyStmt::ImplicitCommit,
        Some("LOAD") if w1 == Some("INDEX") => MyStmt::ImplicitCommit,
        Some("RESET") if w1 != Some("PERSIST") => MyStmt::ImplicitCommit,
        Some("STOP") if matches!(w1, Some("REPLICA" | "SLAVE" | "GROUP_REPLICATION")) => {
            MyStmt::ImplicitCommit
        }
        Some("LOCK") if w1 == Some("TABLES") || w1 == Some("TABLE") => MyStmt::LockTables,
        Some("UNLOCK") if w1 == Some("TABLES") || w1 == Some("TABLE") => MyStmt::UnlockTables,
        Some("USE" | "PREPARE" | "DEALLOCATE" | "KILL" | "HELP" | "DO" | "VALUES") => {
            MyStmt::Passive
        }
        Some("SHOW") if matches!(w1, Some("WARNINGS" | "ERRORS")) || w1 == Some("COUNT") => {
            MyStmt::Passive
        }
        Some("SELECT")
            if !toks
                .iter()
                .any(|t| matches!(t, Tok::Word(w) if w == "FROM")) =>
        {
            MyStmt::Passive
        }
        _ => MyStmt::Other,
    }
}

/// The session state MySQL tracking works on, and what a statement did to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MyState {
    pub status: TxStatus,
    pub autocommit: bool,
    /// `LOCK TABLES` in effect.
    pub locked: bool,
}

/// What a MySQL statement did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MyStep {
    pub next: MyState,
    /// `(committed, tag)` when an open transaction ended.
    pub ended: Option<(bool, &'static str)>,
}

/// MySQL: next state from the previous one, the statement and its outcome (no server round trip, see the
/// module docs).
pub(crate) fn track_mysql(prev: MyState, stmt: MyStmt, outcome: &Outcome) -> MyStep {
    let open = prev.status.is_open();
    let mut next = prev;
    let mut ended = None;
    let implicit = |next: &mut MyState, ended: &mut Option<(bool, &'static str)>| {
        if open {
            *ended = Some((true, "IMPLICIT COMMIT"));
        }
        next.status = TxStatus::Idle;
    };
    match outcome {
        Outcome::Ok => match stmt {
            MyStmt::Begin => {
                if open {
                    ended = Some((true, "IMPLICIT COMMIT"));
                }
                next.status = TxStatus::Active;
                // starting a transaction also releases the table locks of LOCK TABLES
                next.locked = false;
            }
            MyStmt::End { commit, chain } => {
                if open {
                    ended = Some((commit, if commit { "COMMIT" } else { "ROLLBACK" }));
                }
                next.status = if chain {
                    TxStatus::Active
                } else {
                    TxStatus::Idle
                };
            }
            MyStmt::SetAutocommit(Some(v)) => {
                if v && !prev.autocommit {
                    implicit(&mut next, &mut ended);
                }
                next.autocommit = v;
            }
            MyStmt::ImplicitCommit => implicit(&mut next, &mut ended),
            MyStmt::LockTables => {
                implicit(&mut next, &mut ended);
                next.locked = true;
            }
            MyStmt::UnlockTables => {
                if prev.locked {
                    implicit(&mut next, &mut ended);
                }
                next.locked = false;
            }
            MyStmt::Other => {
                if !prev.autocommit && !open {
                    next.status = TxStatus::Active;
                }
            }
            MyStmt::RollbackTo | MyStmt::SetAutocommit(None) | MyStmt::Passive => {}
        },
        Outcome::Err { state, native } => match stmt {
            // they commit before they run: a statement that parsed has committed, even if it then failed
            MyStmt::ImplicitCommit | MyStmt::LockTables | MyStmt::UnlockTables
                if *native != Some(1064) =>
            {
                implicit(&mut next, &mut ended);
                if stmt == MyStmt::LockTables && prev.locked {
                    next.locked = false;
                }
            }
            // InnoDB rolls the whole transaction back on a deadlock
            _ if *native == Some(1213) => {
                if open {
                    ended = Some((false, "ROLLBACK"));
                }
                next.status = TxStatus::Idle;
            }
            // the statement ran against a table before it failed: it opened the transaction
            MyStmt::Other
                if !prev.autocommit
                    && !open
                    && matches!(state.as_deref(), Some(s) if s.starts_with("23") || s.starts_with("22")) =>
            {
                next.status = TxStatus::Active;
            }
            _ => {}
        },
    }
    MyStep { next, ended }
}

/// SQLite: `sqlite3_get_autocommit`.
async fn probe_sqlite(conn: &mut Conn) -> Option<TxStatus> {
    let Conn::Lite(c) = conn else { return None };
    let mut h = c.lock_handle().await.ok()?;
    let ptr = h.as_raw_handle().as_ptr();
    // SAFETY: the handle is locked by `lock_handle` (the worker thread cannot use it meanwhile).
    let auto = unsafe { libsqlite3_sys::sqlite3_get_autocommit(ptr) };
    Some(if auto == 0 {
        TxStatus::Active
    } else {
        TxStatus::Idle
    })
}

/// Read the real state of an idle connection (SQLite only; PostgreSQL and MySQL have no probe: `None`).
pub(crate) async fn probe(conn: &mut Conn) -> Option<TxStatus> {
    match conn {
        Conn::Lite(_) => probe_sqlite(conn).await,
        Conn::My(_) | Conn::Pg(_) | Conn::Ora(_) => None,
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
    let driver = sess.live.driver();
    if driver == Driver::MySql {
        return after_mysql(sess, prev, sql, &outcome);
    }
    let kind = classify(sql);
    let ok = outcome.is_ok();
    let mut next = match driver {
        Driver::Postgres => track_pg(prev, kind, &outcome),
        _ => track_keywords(prev, kind, ok),
    };
    if let (Some(conn), Driver::Sqlite) = (conn, driver) {
        if let Some(p) = probe(conn).await {
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
        // PostgreSQL: the transaction left the session. Prepared (detached, not committed), or rolled back when
        // it was failed or the PREPARE itself failed.
        TxKind::Prepare
            if driver == Driver::Postgres && prev.is_open() && next == TxStatus::Idle =>
        {
            ended = Some((
                false,
                if ok && prev == TxStatus::Active {
                    "PREPARE TRANSACTION"
                } else {
                    "ROLLBACK"
                },
            ));
        }
        _ => {}
    }
    TxUpdate {
        status: next,
        changed: next != prev,
        ended,
        note,
    }
}

fn after_mysql(sess: &Session, prev: TxStatus, sql: &str, outcome: &Outcome) -> TxUpdate {
    let state = MyState {
        status: prev,
        autocommit: sess.autocommit_on.load(Ordering::Relaxed),
        locked: sess.tables_locked.load(Ordering::Relaxed),
    };
    let ver = ServerVer {
        num: sess.server_version.load(Ordering::Relaxed),
        mariadb: sess.mariadb.load(Ordering::Relaxed),
    };
    let step = track_mysql(state, classify_mysql(sql, ver), outcome);
    sess.autocommit_on
        .store(step.next.autocommit, Ordering::Relaxed);
    sess.tables_locked
        .store(step.next.locked, Ordering::Relaxed);
    sess.set_tx_status(step.next.status);
    let note = step.ended.filter(|e| e.1 == "IMPLICIT COMMIT").map(|_| {
        "The statement committed the open transaction implicitly (MySQL DDL / transaction control).".to_string()
    });
    TxUpdate {
        status: step.next.status,
        changed: step.next.status != prev,
        ended: step.ended,
        note,
    }
}

/// An error that surfaced while paging an open result (after the statement itself was accounted for).
pub(crate) fn note_stream_error(sess: &Session, e: &DbError) {
    if sess.live.driver() == Driver::Postgres {
        sess.set_tx_status(track_pg(
            sess.tx_status(),
            TxKind::Other,
            &Outcome::from_error(e),
        ));
    }
}

/// Re-read the state of an idle session connection that someone else used (edits, table reads). Only SQLite
/// can be asked; PostgreSQL / MySQL keep what the statements said.
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
        assert_eq!(
            classify("  /* c */ begin isolation level serializable"),
            TxKind::Begin
        );
        assert_eq!(classify("START TRANSACTION READ ONLY"), TxKind::Begin);
        assert_eq!(classify("start slave"), TxKind::Other);
        assert_eq!(classify("commit"), TxKind::Commit { chain: false });
        assert_eq!(classify("END"), TxKind::Commit { chain: false });
        assert_eq!(classify("commit and chain"), TxKind::Commit { chain: true });
        assert_eq!(
            classify("commit and no chain"),
            TxKind::Commit { chain: false }
        );
        assert_eq!(classify("rollback"), TxKind::Rollback { chain: false });
        assert_eq!(
            classify("abort and chain"),
            TxKind::Rollback { chain: true }
        );
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
        assert_eq!(
            track_pg(
                Failed,
                TxKind::Other,
                &Outcome::from_error(&pg_err("25P02"))
            ),
            Failed
        );
        assert_eq!(track_pg(Failed, TxKind::RollbackTo, ok), Active);
        assert_eq!(track_pg(Failed, TxKind::Commit { chain: false }, ok), Idle);
        assert_eq!(
            track_pg(Failed, TxKind::Rollback { chain: false }, ok),
            Idle
        );
        assert_eq!(track_pg(Active, TxKind::Commit { chain: true }, ok), Active);
        assert_eq!(track_pg(Active, TxKind::Commit { chain: false }, &e), Idle);
        // a failing COMMIT AND CHAIN ends the transaction too; a failing PREPARE TRANSACTION rolls back
        assert_eq!(track_pg(Active, TxKind::Commit { chain: true }, &e), Idle);
        assert_eq!(
            track_pg(
                Active,
                TxKind::Prepare,
                &Outcome::from_error(&pg_err("55000"))
            ),
            Idle
        );
        assert_eq!(
            track_pg(
                Active,
                TxKind::Prepare,
                &Outcome::from_error(&pg_err("42601"))
            ),
            Failed
        );
        assert_eq!(track_pg(Failed, TxKind::Prepare, ok), Idle);
        // self-healing
        assert_eq!(
            track_pg(Idle, TxKind::Other, &Outcome::from_error(&pg_err("25P02"))),
            Failed
        );
        assert_eq!(
            track_pg(
                Active,
                TxKind::Other,
                &Outcome::from_error(&pg_err("25P01"))
            ),
            Idle
        );
        assert_eq!(track_pg(Failed, TxKind::Other, ok), Active);
    }

    /// A MySQL 8.4 server.
    const V84: ServerVer = ServerVer {
        num: 80400,
        mariadb: false,
    };

    fn cm(sql: &str) -> MyStmt {
        classify_mysql(sql, V84)
    }

    fn my_err(native: i64, state: &str) -> Outcome {
        Outcome::Err {
            state: Some(state.into()),
            native: Some(native),
        }
    }

    fn my_state(status: TxStatus, autocommit: bool) -> MyState {
        MyState {
            status,
            autocommit,
            locked: false,
        }
    }

    #[test]
    fn mysql_classification() {
        use MyStmt::*;
        assert_eq!(cm("  /* c */ begin work"), Begin);
        assert_eq!(cm("START TRANSACTION READ ONLY"), Begin);
        assert_eq!(cm("xa start 'a'"), Begin);
        assert_eq!(
            cm("commit"),
            End {
                commit: true,
                chain: false
            }
        );
        assert_eq!(
            cm("commit and chain"),
            End {
                commit: true,
                chain: true
            }
        );
        assert_eq!(
            cm("commit and no chain"),
            End {
                commit: true,
                chain: false
            }
        );
        assert_eq!(
            cm("rollback and chain"),
            End {
                commit: false,
                chain: true
            }
        );
        assert_eq!(
            cm("xa rollback 'a'"),
            End {
                commit: false,
                chain: false
            }
        );
        assert_eq!(cm("rollback to savepoint a"), RollbackTo);
        assert_eq!(cm("end"), Other, "END is not MySQL");
        // implicit commits (15.3.3) and their exceptions
        for sql in [
            "create table t (i int)",
            "alter table t add x int",
            "drop database d",
            "truncate t",
            "rename table a to b",
            "create index i on t (c)",
            "create or replace view v as select 1",
            "create user u",
            "drop role r",
            "grant all on *.* to u",
            "revoke all on *.* from u",
            "set password = 'x'",
            "analyze table t",
            "optimize table t",
            "repair table t",
            "check table t",
            "cache index t in k",
            "load index into cache t",
            "flush tables",
            "reset master",
            "reset replica",
            "start replica",
            "stop slave",
            "change replication source to source_host='h'",
            "install plugin p soname 'x'",
            "alter instance rotate innodb master key",
            "create spatial reference system 1 definition 'x'",
        ] {
            assert_eq!(cm(sql), ImplicitCommit, "{sql}");
        }
        assert_eq!(cm("create temporary table t (i int)"), Other);
        assert_eq!(cm("drop temporary table t"), Other);
        assert_eq!(cm("reset persist x"), Other);
        assert_eq!(cm("lock tables t write"), LockTables);
        assert_eq!(cm("unlock tables"), UnlockTables);
        // passive statements
        for sql in [
            "set @a = 1",
            "set names utf8mb4",
            "set transaction isolation level serializable",
            "use d",
            "show warnings",
            "show errors",
            "select 1",
            "select now(), @@version",
            "select 'from'",
            "select 1 -- from t",
            "prepare s from 'select 1'",
            "kill 3",
        ] {
            assert_eq!(cm(sql), Passive, "{sql}");
        }
        for sql in [
            "select * from t",
            "select 1 from dual",
            "show tables",
            "insert into t values (1)",
            "call p()",
            "execute s",
            "with x as (select 1) select * from x",
        ] {
            assert_eq!(cm(sql), Other, "{sql}");
        }
    }

    #[test]
    fn mysql_set_autocommit_forms() {
        let v = |sql: &str| set_autocommit(&mysql_tokens(sql, V84));
        assert_eq!(v("set autocommit = 0"), Some(Some(false)));
        assert_eq!(v("SET AUTOCOMMIT=1"), Some(Some(true)));
        assert_eq!(v("set autocommit := off;"), Some(Some(false)));
        assert_eq!(v("set session autocommit = on"), Some(Some(true)));
        assert_eq!(v("set local autocommit = 'OFF'"), Some(Some(false)));
        assert_eq!(v("set @@autocommit = 0"), Some(Some(false)));
        assert_eq!(v("set @@session.autocommit = false"), Some(Some(false)));
        assert_eq!(
            v("/* c */ set sql_mode = '', autocommit = 0"),
            Some(Some(false))
        );
        assert_eq!(
            v("set autocommit = 0, autocommit = 1"),
            Some(Some(true)),
            "the last assignment wins"
        );
        assert_eq!(v("set autocommit = @x"), Some(None));
        assert_eq!(v("set autocommit = if(1, 0, 1)"), Some(None));
        assert_eq!(v("set @autocommit = 0"), None, "a user variable");
        assert_eq!(v("set global autocommit = 0"), None);
        assert_eq!(v("set @@global.autocommit = 0"), None);
        assert_eq!(v("set sql_mode = 'autocommit=0'"), None);
        assert_eq!(v("set names utf8mb4"), None);
    }

    #[test]
    fn mysql_comments_are_not_tokens_and_version_comments_are_code() {
        use MyStmt::*;
        let c = |sql: &str, ver: ServerVer| classify_mysql(sql, ver);
        // (statement, implicit commit?) The first three are the cases proved against a real server by the re-check.
        let cases: &[(&str, bool)] = &[
            ("create /* tmp */ temporary table tt(i int)", false),
            ("/*!50001 create table t_ver(i int) */", true),
            ("# hash comment\ncreate table t_hash(i int)", true),
            ("-- c\ncreate table t(i int)", true),
            ("/* a */ /* b */ create table t(i int)", true),
            ("/*+ hint */ create table t(i int)", true),
            ("create/**/table t(i int)", true),
            ("CREATE /* x */ TABLE /* y */ t(i int)", true),
            (
                "create /* x */ or /* y */ replace /* z */ view v as select 1",
                true,
            ),
            ("create # x\n table t(i int)", true),
            ("create -- x\n table t(i int)", true),
            ("create table t2 select 1 as i", true),
            ("create table t2 as select 1 as i", true),
            ("CREATE TEMPORARY TABLE t2 SELECT 1 AS i", false),
            ("create temporary /* x */ table t2 select 1", false),
            ("create # x\n temporary table t2(i int)", false),
            ("create -- x\n temporary table t2(i int)", false),
            ("create /*!50001 temporary */ table t2(i int)", false),
            ("/*!50001 create temporary table t2(i int) */", false),
            ("DROP TEMPORARY TABLE t2", false),
            ("drop /* x */ temporary /* y */ table t2", false),
            ("drop table t2", true),
            ("alter table t2 add j int", true),
            ("alter /* x */ table t2 add j int", true),
            ("/*! create table t(i int) */", true),
            ("/*!80000 create table t(i int) */", true),
            ("/*!080000 create table t(i int) */", true),
            ("/*!80400 create table t(i int) */", true),
            // above the server version: a comment, the statement is empty
            ("/*!80401 create table t(i int) */", false),
            ("/*!999999 create table t(i int) */", false),
            ("/*!99999 create table t(i int) */ select 1", false),
            // the closing */ ends the executable comment, the rest is ordinary
            ("/*!50001 create */ table t(i int)", true),
            ("/*!50001 select 1 */ ; drop table t", false),
            // keywords that only live in comments, strings and quoted identifiers
            ("select 1 -- create table t(i int)", false),
            ("select 1 # create table t(i int)", false),
            ("select 'create table t(i int)'", false),
            ("select \"drop table t\"", false),
            ("select 1 as `create`", false),
            ("/* create table t(i int) */ select 1", false),
            ("/* create table t(i int) */", false),
            ("select 1 /* ' */ , 2 -- '\n", false),
            // `--` needs a space after it in MySQL: this is not a comment, the minus signs stay
            ("select 1 --1", false),
        ];
        for (sql, commits) in cases {
            let got = c(sql, V84) == ImplicitCommit;
            assert_eq!(got, *commits, "{sql:?}");
        }
        // a gated comment follows the server version
        assert_eq!(c("/*!80500 create table t(i int) */", V84), Other);
        assert_eq!(
            c(
                "/*!80500 create table t(i int) */",
                ServerVer {
                    num: 80500,
                    mariadb: false
                }
            ),
            ImplicitCommit
        );
        assert_eq!(
            c("/*!80500 create table t(i int) */", ServerVer::UNKNOWN),
            ImplicitCommit
        );
        // MariaDB's own marker is a plain comment on MySQL
        let maria = ServerVer {
            num: 101106,
            mariadb: true,
        };
        assert_eq!(
            c("/*M!100100 create table t(i int) */", maria),
            ImplicitCommit
        );
        assert_eq!(
            c(
                "/*M!100100 create table t(i int) */",
                ServerVer {
                    num: 101000,
                    mariadb: true
                }
            ),
            ImplicitCommit
        );
        assert_eq!(c("/*M!999999 create table t(i int) */", maria), Other);
        assert_eq!(c("/*M!100100 create table t(i int) */", V84), Other);
        // transaction control and SET behind comments
        assert_eq!(
            c("/* a */ commit /* b */ and /* c */ chain", V84),
            End {
                commit: true,
                chain: true
            }
        );
        assert_eq!(c("rollback # x\n to savepoint a", V84), RollbackTo);
        assert_eq!(c("/*!50001 start transaction */", V84), Begin);
        assert_eq!(
            c("set autocommit = 0 -- manual", V84),
            SetAutocommit(Some(false))
        );
        assert_eq!(
            c("set /* a */ @@session.autocommit /* b */ = /* c */ 0", V84),
            SetAutocommit(Some(false))
        );
        assert_eq!(
            c("SET @@session.autocommit=0", V84),
            SetAutocommit(Some(false))
        );
        assert_eq!(
            c("SET autocommit=OFF /* x */", V84),
            SetAutocommit(Some(false))
        );
        assert_eq!(c("set sql_mode = '' # autocommit = 0", V84), Passive);
        assert_eq!(
            c("set /*!50001 autocommit = 0 */", V84),
            SetAutocommit(Some(false))
        );
        assert_eq!(c("set /*!99999 autocommit = 0 */", V84), Passive);
        assert_eq!(c("set `autocommit` = 1", V84), SetAutocommit(Some(true)));
    }

    #[test]
    fn server_versions_parse() {
        let p = ServerVer::parse;
        assert_eq!(
            p("8.4.3"),
            ServerVer {
                num: 80403,
                mariadb: false
            }
        );
        assert_eq!(
            p("8.0.36-0ubuntu0.22.04.1"),
            ServerVer {
                num: 80036,
                mariadb: false
            }
        );
        assert_eq!(
            p("5.7.44-log"),
            ServerVer {
                num: 50744,
                mariadb: false
            }
        );
        assert_eq!(
            p("10.11.6-MariaDB-1:10.11.6+maria~ubu2204"),
            ServerVer {
                num: 101106,
                mariadb: true
            }
        );
        assert_eq!(
            p("5.5.5-10.0.38-MariaDB"),
            ServerVer {
                num: 100038,
                mariadb: true
            }
        );
        assert_eq!(p("unknown"), ServerVer::UNKNOWN);
    }

    #[test]
    fn mysql_state_machine() {
        use MyStmt::*;
        use TxStatus::*;
        let ok = &Outcome::Ok;
        let step = |st: MyState, stmt: MyStmt, o: &Outcome| track_mysql(st, stmt, o);
        // plain statement, autocommit on: nothing; off: opens
        assert_eq!(step(my_state(Idle, true), Other, ok).next.status, Idle);
        assert_eq!(step(my_state(Idle, false), Other, ok).next.status, Active);
        assert_eq!(step(my_state(Idle, false), Passive, ok).next.status, Idle);
        // SET autocommit
        let s = step(my_state(Active, false), SetAutocommit(Some(true)), ok);
        assert_eq!(
            (s.next.status, s.next.autocommit, s.ended),
            (Idle, true, Some((true, "IMPLICIT COMMIT")))
        );
        let s = step(my_state(Idle, false), SetAutocommit(Some(true)), ok);
        assert_eq!(
            (s.next.status, s.ended),
            (Idle, None),
            "nothing open: nothing committed"
        );
        let s = step(my_state(Active, true), SetAutocommit(Some(true)), ok);
        assert_eq!(
            (s.next.status, s.ended),
            (Active, None),
            "already 1: no implicit commit"
        );
        let s = step(my_state(Active, true), SetAutocommit(Some(false)), ok);
        assert_eq!((s.next.status, s.next.autocommit), (Active, false));
        // transaction control
        let s = step(my_state(Active, true), Begin, ok);
        assert_eq!(
            (s.next.status, s.ended),
            (Active, Some((true, "IMPLICIT COMMIT")))
        );
        let s = step(
            my_state(Active, false),
            End {
                commit: true,
                chain: false,
            },
            ok,
        );
        assert_eq!((s.next.status, s.ended), (Idle, Some((true, "COMMIT"))));
        let s = step(
            my_state(Active, false),
            End {
                commit: false,
                chain: true,
            },
            ok,
        );
        assert_eq!(
            (s.next.status, s.ended),
            (Active, Some((false, "ROLLBACK")))
        );
        // implicit commit, also when it fails but parsed
        let s = step(my_state(Active, true), ImplicitCommit, ok);
        assert_eq!(
            (s.next.status, s.ended),
            (Idle, Some((true, "IMPLICIT COMMIT")))
        );
        let s = step(
            my_state(Active, true),
            ImplicitCommit,
            &my_err(1050, "42S01"),
        );
        assert_eq!(
            (s.next.status, s.ended),
            (Idle, Some((true, "IMPLICIT COMMIT")))
        );
        let s = step(
            my_state(Active, true),
            ImplicitCommit,
            &my_err(1064, "42000"),
        );
        assert_eq!(
            (s.next.status, s.ended),
            (Active, None),
            "a syntax error never ran"
        );
        // LOCK / UNLOCK TABLES
        let s = step(my_state(Active, true), LockTables, ok);
        assert!(s.next.locked && s.next.status == Idle);
        let s = step(
            MyState {
                status: Active,
                autocommit: true,
                locked: true,
            },
            UnlockTables,
            ok,
        );
        assert!(!s.next.locked && s.next.status == Idle);
        let s = step(my_state(Active, true), UnlockTables, ok);
        assert_eq!(s.next.status, Active);
        let s = step(
            MyState {
                status: Idle,
                autocommit: true,
                locked: true,
            },
            Begin,
            ok,
        );
        assert!(!s.next.locked, "START TRANSACTION releases the locks");
        // errors
        assert_eq!(
            step(my_state(Active, true), Other, &my_err(1146, "42S02"))
                .next
                .status,
            Active
        );
        assert_eq!(
            step(my_state(Idle, false), Other, &my_err(1146, "42S02"))
                .next
                .status,
            Idle
        );
        assert_eq!(
            step(my_state(Idle, false), Other, &my_err(1062, "23000"))
                .next
                .status,
            Active
        );
        let s = step(my_state(Active, true), Other, &my_err(1213, "40001"));
        assert_eq!(
            (s.next.status, s.ended),
            (Idle, Some((false, "ROLLBACK"))),
            "deadlock rolls the transaction back"
        );
        assert_eq!(
            step(my_state(Active, true), Other, &my_err(1205, "HY000"))
                .next
                .status,
            Active,
            "lock wait timeout does not"
        );
        assert_eq!(
            step(my_state(Active, true), Other, &my_err(1317, "70100"))
                .next
                .status,
            Active,
            "KILL QUERY does not"
        );
    }
}
