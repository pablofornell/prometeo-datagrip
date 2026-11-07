//! Oracle runtime on the pure-Rust thin driver `oracledb` (vendored at `vendor/oracledb`, no Instant Client).
//!
//! The driver is blocking, so every connection is owned by one worker thread; [`OraConn`] is the async handle that
//! sends it commands. A query streams its rows back through a bounded channel (the worker waits when nobody reads),
//! which gives `fetch_more` its back pressure. Cancel is a shared flag the worker checks between rows plus the
//! patched driver's break marker (`oracledb::CancelHandle`) for a call that is running on the server.
//!
//! * **Types**: `NUMBER` is handed over as exact decimal text and becomes a JSON number only when that is lossless
//!   (see [`number_cell`]); `DATE` / `TIMESTAMP [WITH [LOCAL] TIME ZONE]` / `INTERVAL` are text, `CLOB` text,
//!   `BLOB` / `RAW` the usual `$bin` cell, `BOOLEAN` a JSON boolean. The thin driver reads `CLOB` / `BLOB` as
//!   `LONG` / `LONG RAW`; the vendored copy remembers the declared type, so columns still say `CLOB` / `BLOB`.
//!   Time zones: the driver delivers the UTC instant of a `TIMESTAMP WITH [LOCAL] TIME ZONE`, so it is shown as
//!   `... +00:00`.
//! * **Transactions**: the server reports whether a transaction is open after every call, so the tracker (`tx.rs`)
//!   is exact: DML opens one (there is no `BEGIN`), `COMMIT` / `ROLLBACK` / DDL end it.
//! * **Read-only data sources**: Oracle has no read-only session. DDL / DCL is refused here, and a
//!   `SET TRANSACTION READ ONLY` is opened before anything that could write, so the server rejects DML with
//!   `ORA-01456`. What would end that transaction or escape it (`COMMIT` / `ROLLBACK` / `EXECUTE IMMEDIATE` /
//!   `DBMS_SQL` in a PL/SQL block, `SET TRANSACTION` other than `READ ONLY`) is refused too. The transaction is
//!   reported like any other (Auto mode ends it after the statement, Manual mode leaves it to the user).
//! * **Keep alive**: an idle connection pings the server every `keepAlive` seconds (option, default 90, 0 = off).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use oracledb as odb;
use oracledb::ToDbValue;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

use crate::error::{DbError, Result, ServerError};
use crate::exec::Item;
use crate::model::{Cell, ColumnMeta, DataSourceConfig, Driver};
use crate::quote::{first_keyword, hex_encode};
use crate::value::{bin_cell, float_cell, DecodeOpts, RawRow};

/// Query whose first column is the server banner (`Oracle AI Database 26ai Free Release 23.26.3.0.0 - ...`).
pub(crate) const VERSION_SQL: &str = "select banner from v$version where rownum = 1";

/// Connections kept by one pool.
const POOL_MAX: usize = 8;
/// Rows fetched per round trip.
const FETCH_ROWS: u32 = 500;
/// Rows buffered between the worker and the reader of a stream.
const STREAM_BUFFER: usize = 256;
const DEFAULT_KEEPALIVE_SECS: u64 = 90;

/// Banner -> label shown as the server version.
pub(crate) fn version_label(banner: &str) -> String {
    let b = banner.split_whitespace().collect::<Vec<_>>().join(" ");
    if b.is_empty() {
        "Oracle Database".to_string()
    } else {
        b
    }
}

/// ORA codes that say the session is over (`ORA-03113` end-of-file on communication channel, `03114`, `03135`,
/// `12537` ..., `00028` session killed, `01012`, `01033`/`01034`/`01089`/`01090` shutdown).
pub(crate) fn ends_connection(code: i64) -> bool {
    matches!(
        code,
        28 | 1012
            | 1033
            | 1034
            | 1089
            | 1090
            | 3113
            | 3114
            | 3135
            | 3136
            | 12170
            | 12537
            | 12541
            | 12543
            | 12547
            | 12571
    )
}

// ------------------------------------------------------------------ errors

fn lost(cause: impl Into<String>) -> DbError {
    DbError::ConnectionLost(crate::error::ConnectionLost {
        driver: Some(Driver::Oracle),
        server: None,
        cause: cause.into(),
    })
}

fn worker_gone() -> DbError {
    lost("the Oracle connection worker stopped")
}

/// `ORA-NNNNN` error produced here (not by the server).
fn ora_error(code: i64, text: &str) -> DbError {
    DbError::Server(Box::new(ServerError {
        driver: Driver::Oracle,
        code: format!("ORA-{code:05}"),
        native_code: Some(code),
        severity: None,
        message: format!("ORA-{code:05}: {text}"),
        detail: None,
        hint: None,
        position: None,
    }))
}

fn cancelled() -> DbError {
    ora_error(1013, "user requested cancel of current operation")
}

/// 1-based position (in code points) of the byte `offset` of `sql`.
fn position_of(sql: &str, offset: usize) -> usize {
    sql.char_indices().take_while(|(i, _)| *i < offset).count() + 1
}

/// Driver error -> [`DbError`]. `sql` is the statement that was sent (to turn the byte offset of a parse error into
/// a position); `at_connect`: the error happened while logging in (a refusal is then not a lost connection).
fn map_error(e: odb::Error, at_connect: bool, sql: Option<&str>) -> DbError {
    use odb::ErrorKind as K;
    match e.kind() {
        K::DbError(db) => {
            let code = db.code() as i64;
            let offset = db.offset();
            let position = sql
                .filter(|_| offset > 0 || (900..=999).contains(&code))
                .map(|s| position_of(s, offset));
            let s = ServerError {
                driver: Driver::Oracle,
                code: format!("ORA-{code:05}"),
                native_code: Some(code),
                severity: None,
                message: db.message().trim().to_string(),
                detail: None,
                hint: None,
                position,
            };
            if at_connect {
                DbError::Connection(s.message)
            } else if ends_connection(code) {
                DbError::ConnectionLost(crate::error::ConnectionLost {
                    driver: Some(Driver::Oracle),
                    server: Some(s.message),
                    cause: String::new(),
                })
            } else {
                DbError::Server(Box::new(s))
            }
        }
        K::DeadConnection | K::StreamOperation | K::NotConnected | K::UnableToRecover
            if !at_connect =>
        {
            lost(e.to_string())
        }
        _ => DbError::Connection(e.to_string()),
    }
}

// ------------------------------------------------------------------ options

/// A bound value (positional `:1`, `:2`, ...).
#[derive(Debug, Clone)]
pub enum OraBind {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
}

fn to_db_value(b: &OraBind) -> Box<dyn ToDbValue> {
    match b {
        OraBind::Null => Box::new(None::<String>),
        OraBind::Bool(v) => Box::new(*v),
        OraBind::Int(v) => Box::new(*v),
        OraBind::UInt(v) => Box::new(*v),
        OraBind::Float(v) => Box::new(*v),
        OraBind::Text(v) => Box::new(v.clone()),
        OraBind::Bytes(v) => Box::new(v.clone()),
    }
}

/// Connect options of an Oracle data source (see [`build_opts`]).
#[derive(Clone)]
pub(crate) struct OraOpts {
    /// Easy connect string or a full `(DESCRIPTION=...)`.
    pub connect_string: String,
    pub user: String,
    pub password: String,
    /// `odb` auth mode (`0` normal, `4` SYSDBA, `32` SYSOPER).
    pub auth_mode: u8,
    pub read_only: bool,
    pub connect_timeout_secs: u64,
    /// Idle ping interval, 0 = never.
    pub keepalive_secs: u64,
}

impl std::fmt::Debug for OraOpts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OraOpts")
            .field("connect_string", &self.connect_string)
            .field("user", &self.user)
            .field("password", &"***")
            .field("read_only", &self.read_only)
            .finish_non_exhaustive()
    }
}

fn opt<'a>(cfg: &'a DataSourceConfig, key: &str) -> Option<&'a str> {
    cfg.options
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

fn descriptor(host: &str, port: u16, key: &str, name: &str) -> String {
    format!("(DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST={host})(PORT={port}))(CONNECT_DATA=({key}={name})))")
}

/// What the `@...` part of a URL says.
fn connect_target(target: &str) -> Result<String> {
    let t = target.trim();
    if t.starts_with('(') {
        return Ok(t.to_string());
    }
    let t = t.trim_start_matches("//");
    // host:port:SID (the old JDBC form) -> a SID descriptor; host[:port]/service stays easy connect
    if !t.contains('/') {
        let parts: Vec<&str> = t.split(':').collect();
        if parts.len() == 3 {
            if let Ok(port) = parts[1].parse::<u16>() {
                return Ok(descriptor(parts[0], port, "SID", parts[2]));
            }
        }
    }
    if t.is_empty() {
        return Err(DbError::InvalidArgument(
            "Oracle connection URL has no host".into(),
        ));
    }
    Ok(t.to_string())
}

/// `(connect string, user from the URL, password from the URL)`.
fn parse_url(url: &str) -> Result<(String, Option<String>, Option<String>)> {
    let u = url.trim();
    let u = u.strip_prefix("jdbc:").unwrap_or(u);
    if let Some(rest) = u.strip_prefix("oracle:thin:") {
        // oracle:thin:[user/password]@target
        // the password may hold an '@': the target starts after the last one
        let (cred, target) = rest.rsplit_once('@').ok_or_else(|| {
            DbError::InvalidArgument("Oracle JDBC URL: expected oracle:thin:@host:port:SID".into())
        })?;
        let (user, pw) = match cred.split_once('/') {
            Some((a, b)) => (Some(a.to_string()), Some(b.to_string())),
            None if cred.is_empty() => (None, None),
            None => (Some(cred.to_string()), None),
        };
        return Ok((connect_target(target)?, user, pw));
    }
    if let Some(rest) = u.strip_prefix("oracle://") {
        let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
        let (cred, target) = match rest.rsplit_once('@') {
            Some((c, t)) => (Some(c), t),
            None => (None, rest),
        };
        let (user, pw) = match cred {
            Some(c) => match c.split_once(':') {
                Some((a, b)) => (Some(a.to_string()), Some(b.to_string())),
                None => (Some(c.to_string()), None),
            },
            None => (None, None),
        };
        let sid = query.split('&').any(|p| matches!(p, "sid=1" | "sid=true"));
        let (hostport, name) = target.split_once('/').unwrap_or((target, ""));
        if sid && !name.is_empty() {
            let (host, port) = hostport.split_once(':').unwrap_or((hostport, "1521"));
            let port = port
                .parse::<u16>()
                .map_err(|_| DbError::InvalidArgument(format!("bad port '{port}'")))?;
            return Ok((descriptor(host, port, "SID", name), user, pw));
        }
        return Ok((connect_target(target)?, user, pw));
    }
    // anything else: a connect string, an alias or a descriptor
    Ok((connect_target(u)?, None, None))
}

pub(crate) fn build_opts(cfg: &DataSourceConfig) -> Result<OraOpts> {
    let url = cfg
        .url_override
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let (connect_string, url_user, url_pw) = match url {
        Some(u) => parse_url(u)?,
        None => {
            let host = if cfg.host.trim().is_empty() {
                "localhost"
            } else {
                cfg.host.trim()
            };
            let port = if cfg.port == 0 { 1521 } else { cfg.port };
            let name = cfg.database.trim();
            if name.is_empty() {
                return Err(DbError::InvalidArgument(
                    "Oracle service name (or SID) is not set".into(),
                ));
            }
            let key = if opt(cfg, "oracleConnType") == Some("sid") {
                "SID"
            } else {
                "SERVICE_NAME"
            };
            (descriptor(host, port, key, name), None, None)
        }
    };
    let user = if cfg.user.is_empty() {
        url_user.unwrap_or_default()
    } else {
        cfg.user.clone()
    };
    if user.is_empty() {
        return Err(DbError::InvalidArgument("Oracle user is not set".into()));
    }
    let password = cfg.password.clone().or(url_pw).unwrap_or_default();
    let auth_mode = match opt(cfg, "oracleRole")
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("sysdba") => 4,
        Some("sysoper") => 32,
        _ => 0,
    };
    let secs = |key: &str, default: u64| {
        opt(cfg, key)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default)
    };
    Ok(OraOpts {
        connect_string,
        user,
        password,
        auth_mode,
        read_only: cfg.read_only,
        connect_timeout_secs: secs("connectTimeout", 15).max(1),
        keepalive_secs: secs("keepAlive", DEFAULT_KEEPALIVE_SECS),
    })
}

// ------------------------------------------------------------------ values

/// One value of an Oracle row, as the worker thread read it (no driver types leak out of this module).
#[derive(Debug, Clone)]
pub(crate) enum OraVal {
    Null,
    /// A NUMBER in plain decimal text (`-12.5`, `1000000000000000000000`).
    Number(String),
    Float(f64),
    Text(String),
    Bytes(Vec<u8>),
    Bool(bool),
}

#[derive(Debug, Clone)]
pub(crate) struct OraCol {
    pub name: String,
    /// DataGrip style: `NUMBER(10,2)`, `VARCHAR2(50)`, `TIMESTAMP(6) WITH TIME ZONE`, `CLOB`.
    pub type_name: String,
    pub nullable: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct OraRow {
    pub cols: Arc<Vec<OraCol>>,
    pub vals: Vec<OraVal>,
}

/// NUMBER text -> JSON: a number when that loses nothing (an integer within 2^53, or a decimal of at most 15
/// significant digits whose double prints back as the same text), else the exact text.
pub(crate) fn number_cell(s: &str) -> Cell {
    const SAFE: u64 = 9_007_199_254_740_992;
    if let Ok(i) = s.parse::<i64>() {
        return if i.unsigned_abs() <= SAFE {
            Value::from(i)
        } else {
            Value::String(s.to_string())
        };
    }
    let digits = s.chars().filter(char::is_ascii_digit).count();
    let integer = !s.contains('.');
    if !integer && digits <= 15 {
        if let Ok(f) = s.parse::<f64>() {
            if f.to_string() == s {
                if let Some(n) = serde_json::Number::from_f64(f) {
                    return Value::Number(n);
                }
            }
        }
    }
    Value::String(s.to_string())
}

/// The cells of a row (JSON contract of `model::Cell`).
pub(crate) fn row_cells(r: &OraRow, opts: DecodeOpts) -> Vec<Cell> {
    r.vals
        .iter()
        .map(|v| match v {
            OraVal::Null => Value::Null,
            OraVal::Number(s) => number_cell(s),
            OraVal::Float(f) => float_cell(*f),
            OraVal::Text(s) => Value::String(s.clone()),
            OraVal::Bytes(b) => bin_cell(b, opts),
            OraVal::Bool(b) => Value::Bool(*b),
        })
        .collect()
}

/// A row as strings (NULL = `None`), for introspection.
pub(crate) fn row_strings(r: &OraRow) -> Vec<Option<String>> {
    r.vals
        .iter()
        .map(|v| match v {
            OraVal::Null => None,
            OraVal::Number(s) | OraVal::Text(s) => Some(s.clone()),
            OraVal::Float(f) => Some(f.to_string()),
            OraVal::Bytes(b) => Some(hex_encode(b).to_ascii_uppercase()),
            OraVal::Bool(b) => Some(b.to_string()),
        })
        .collect()
}

fn frac_digits(md: &odb::Metadata) -> usize {
    match md.scale() {
        s @ 0..=9 => s as usize,
        _ => 6,
    }
}

fn timestamp_text(t: &odb::OracleTimestamp, frac: usize, with_zone: bool) -> String {
    let mut s = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.year(),
        t.month(),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    );
    if frac > 0 {
        let nanos = format!("{:09}", t.nanoseconds());
        s.push('.');
        s.push_str(&nanos[..frac.min(9)]);
    }
    if with_zone {
        s.push_str(" +00:00");
    }
    s
}

fn interval_ds_text(v: &odb::OracleIntervalDS, frac: usize) -> String {
    let neg =
        v.days() < 0 || v.hours() < 0 || v.minutes() < 0 || v.seconds() < 0 || v.nanoseconds() < 0;
    let mut s = format!(
        "{}{:02} {:02}:{:02}:{:02}",
        if neg { '-' } else { '+' },
        v.days().unsigned_abs(),
        v.hours().unsigned_abs(),
        v.minutes().unsigned_abs(),
        v.seconds().unsigned_abs()
    );
    if frac > 0 {
        let nanos = format!("{:09}", v.nanoseconds().unsigned_abs());
        s.push('.');
        s.push_str(&nanos[..frac.min(9)]);
    }
    s
}

fn interval_ym_text(v: &odb::OracleIntervalYM) -> String {
    let neg = v.years() < 0 || v.months() < 0;
    format!(
        "{}{:02}-{:02}",
        if neg { '-' } else { '+' },
        v.years().unsigned_abs(),
        v.months().unsigned_abs()
    )
}

fn read_value(row: &odb::Row, i: usize, md: &odb::Metadata) -> OraVal {
    let t = md.db_type();
    let res: std::result::Result<OraVal, odb::Error> = (|| {
        Ok(if t == odb::DB_TYPE_NUMBER {
            row.get::<Option<odb::OracleNumber>>(i)?
                .map_or(OraVal::Null, |n| OraVal::Number(n.to_string()))
        } else if t == odb::DB_TYPE_BINARY_DOUBLE {
            row.get::<Option<f64>>(i)?
                .map_or(OraVal::Null, OraVal::Float)
        } else if t == odb::DB_TYPE_BINARY_FLOAT {
            row.get::<Option<f32>>(i)?.map_or(OraVal::Null, |f| {
                OraVal::Float(f.to_string().parse().unwrap_or(f as f64))
            })
        } else if t == odb::DB_TYPE_DATE {
            row.get::<Option<odb::OracleTimestamp>>(i)?
                .map_or(OraVal::Null, |v| OraVal::Text(timestamp_text(&v, 0, false)))
        } else if t == odb::DB_TYPE_TIMESTAMP {
            row.get::<Option<odb::OracleTimestamp>>(i)?
                .map_or(OraVal::Null, |v| {
                    OraVal::Text(timestamp_text(&v, frac_digits(md), false))
                })
        } else if t == odb::DB_TYPE_TIMESTAMP_TZ || t == odb::DB_TYPE_TIMESTAMP_LTZ {
            row.get::<Option<odb::OracleTimestamp>>(i)?
                .map_or(OraVal::Null, |v| {
                    OraVal::Text(timestamp_text(&v, frac_digits(md), true))
                })
        } else if t == odb::DB_TYPE_INTERVAL_DS {
            row.get::<Option<odb::OracleIntervalDS>>(i)?
                .map_or(OraVal::Null, |v| {
                    OraVal::Text(interval_ds_text(&v, frac_digits(md)))
                })
        } else if t == odb::DB_TYPE_INTERVAL_YM {
            row.get::<Option<odb::OracleIntervalYM>>(i)?
                .map_or(OraVal::Null, |v| OraVal::Text(interval_ym_text(&v)))
        } else if t == odb::DB_TYPE_RAW || t == odb::DB_TYPE_LONG_RAW || t == odb::DB_TYPE_BLOB {
            row.get::<Option<Vec<u8>>>(i)?
                .map_or(OraVal::Null, OraVal::Bytes)
        } else if t == odb::DB_TYPE_BOOLEAN {
            row.get::<Option<bool>>(i)?
                .map_or(OraVal::Null, OraVal::Bool)
        } else {
            row.get::<Option<String>>(i)?
                .map_or(OraVal::Null, OraVal::Text)
        })
    })();
    res.unwrap_or_else(|_| OraVal::Text(format!("<{}>", md.declared_data_type())))
}

fn cols_of(mds: &[odb::Metadata]) -> Arc<Vec<OraCol>> {
    Arc::new(
        mds.iter()
            .map(|m| OraCol {
                name: m.name().to_string(),
                type_name: m.declared_data_type(),
                nullable: m.nullable(),
            })
            .collect(),
    )
}

fn metas_of(cols: &[OraCol]) -> Vec<ColumnMeta> {
    cols.iter()
        .map(|c| ColumnMeta {
            name: c.name.clone(),
            type_name: c.type_name.clone(),
            nullable: c.nullable,
            is_pk: false,
            table_ref: None,
        })
        .collect()
}

// ------------------------------------------------------------------ cancel

/// Handle to interrupt whatever a connection is running (clonable, usable from any thread).
#[derive(Clone)]
pub(crate) struct OraCancel {
    flag: Arc<AtomicBool>,
    handle: Arc<Mutex<Option<odb::CancelHandle>>>,
}

impl OraCancel {
    fn new() -> OraCancel {
        OraCancel {
            flag: Arc::new(AtomicBool::new(false)),
            handle: Arc::new(Mutex::new(None)),
        }
    }

    /// Stop the running statement: the worker notices the flag between rows, and a call that is busy on the
    /// server gets the break marker.
    pub(crate) fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.lock().unwrap().as_ref() {
            let _ = h.cancel();
        }
    }

    /// The connection is gone: the handle does nothing from now on.
    pub(crate) fn detach(&self) {
        self.flag.store(false, Ordering::SeqCst);
        *self.handle.lock().unwrap() = None;
    }
}

// ------------------------------------------------------------------ worker

enum Cmd {
    Stream {
        sql: String,
        out: mpsc::Sender<Result<Item>>,
    },
    Exec {
        sql: String,
        binds: Vec<OraBind>,
        commit: bool,
        reply: oneshot::Sender<Result<u64>>,
    },
    Strings {
        sql: String,
        binds: Vec<OraBind>,
        reply: oneshot::Sender<Result<Vec<Vec<Option<String>>>>>,
    },
    Describe {
        sql: String,
        reply: oneshot::Sender<Vec<OraCol>>,
    },
    Output {
        reply: oneshot::Sender<Result<Vec<String>>>,
    },
    Commit {
        reply: oneshot::Sender<Result<()>>,
    },
    Rollback {
        reply: oneshot::Sender<Result<()>>,
    },
    Ping {
        reply: oneshot::Sender<Result<()>>,
    },
    /// Test hook: the worker panics.
    #[cfg(test)]
    Die,
}

/// What a statement produced, in order.
enum Out {
    Row(OraRow),
    Done(u64),
}

struct Worker {
    conn: odb::Connection,
    read_only: bool,
    in_tx: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    /// Columns of the last query, for [`Cmd::Describe`] of a query that returned no row.
    last_cols: Option<(String, Arc<Vec<OraCol>>)>,
}

/// Statements a read-only data source refuses (the server refuses DML itself, in the read-only transaction).
fn refused_when_read_only(sql: &str) -> bool {
    let kw = first_keyword(sql);
    match kw.as_str() {
        "CREATE" | "DROP" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" | "COMMENT" | "AUDIT"
        | "NOAUDIT" | "ANALYZE" | "PURGE" | "FLASHBACK" | "ASSOCIATE" | "DISASSOCIATE" => true,
        "ALTER" => !sql_words(sql, 2).get(1).is_some_and(|w| w == "SESSION"),
        _ => false,
    }
}

/// The words (upper case) of `sql` that are code: comments, string literals (also `q'[..]'`) and quoted identifiers
/// are skipped.
fn code_words(sql: &str) -> Vec<String> {
    let c: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch == '-' && c.get(i + 1) == Some(&'-') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            i += 2;
            while i < c.len() && !(c[i] == '*' && c.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else if ch == '\'' {
            i = skip_string(&c, i + 1);
        } else if ch == '"' {
            i += 1;
            while i < c.len() && c[i] != '"' {
                i += 1;
            }
            i += 1;
        } else if ch.is_alphanumeric() || matches!(ch, '_' | '$' | '#') {
            let start = i;
            while i < c.len() && (c[i].is_alphanumeric() || matches!(c[i], '_' | '$' | '#')) {
                i += 1;
            }
            let w: String = c[start..i].iter().collect::<String>().to_ascii_uppercase();
            // q'[..]' / nq'[..]' alternative quoting
            if (w == "Q" || w == "NQ") && c.get(i) == Some(&'\'') && i + 1 < c.len() {
                let open = c[i + 1];
                let close = match open {
                    '[' => ']',
                    '(' => ')',
                    '{' => '}',
                    '<' => '>',
                    o => o,
                };
                i += 2;
                while i < c.len() && !(c[i] == close && c.get(i + 1) == Some(&'\'')) {
                    i += 1;
                }
                i += 2;
            } else {
                out.push(w);
            }
        } else {
            i += 1;
        }
    }
    out
}

/// Index after the string literal whose body starts at `i` (`''` is an escaped quote).
fn skip_string(c: &[char], mut i: usize) -> usize {
    while i < c.len() {
        if c[i] == '\'' {
            if c.get(i + 1) == Some(&'\'') {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    i
}

/// Why a read-only data source must not run this statement even though the server would accept it: it would end
/// the read-only transaction or escape from it (`SET TRANSACTION READ WRITE`, a PL/SQL block that commits, rolls
/// back, runs dynamic SQL / DDL ...).
fn read_only_violation(sql: &str) -> Option<&'static str> {
    let w = code_words(sql);
    let first = w.first().map(String::as_str).unwrap_or("");
    if first == "SET" && w.get(1).map(String::as_str) == Some("TRANSACTION") {
        let ro = w.get(2).map(String::as_str) == Some("READ")
            && w.get(3).map(String::as_str) == Some("ONLY");
        return (!ro).then_some("SET TRANSACTION other than READ ONLY");
    }
    let block = matches!(first, "BEGIN" | "DECLARE" | "CALL" | "EXEC" | "EXECUTE")
        || sql.trim_start().starts_with("<<");
    if !block {
        return None;
    }
    for (i, word) in w.iter().enumerate() {
        let hit = match word.as_str() {
            "COMMIT" | "ROLLBACK" => Some("COMMIT / ROLLBACK in a PL/SQL block"),
            "IMMEDIATE" if i > 0 && w[i - 1] == "EXECUTE" => {
                Some("EXECUTE IMMEDIATE in a PL/SQL block")
            }
            "DBMS_SQL" | "DBMS_JOB" | "DBMS_SCHEDULER" | "EXEC_DDL_STATEMENT" => {
                Some("dynamic SQL / jobs (DBMS_SQL, DBMS_JOB, DBMS_SCHEDULER) in a PL/SQL block")
            }
            "AUTONOMOUS_TRANSACTION" => Some("an autonomous transaction in a PL/SQL block"),
            "TRANSACTION" if i > 0 && w[i - 1] == "SET" => {
                Some("SET TRANSACTION in a PL/SQL block")
            }
            _ => None,
        };
        if hit.is_some() {
            return hit;
        }
    }
    None
}

fn sql_words(sql: &str, n: usize) -> Vec<String> {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map(|x| x.1).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    rest.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .take(n)
        .map(str::to_ascii_uppercase)
        .collect()
}

/// Can this statement write (so a read-only data source must have its read-only transaction open first)?
fn may_write(sql: &str) -> bool {
    !matches!(
        first_keyword(sql).as_str(),
        "" | "SELECT"
            | "WITH"
            | "EXPLAIN"
            | "DESC"
            | "DESCRIBE"
            | "SHOW"
            | "COMMIT"
            | "ROLLBACK"
            | "SET"
            | "ALTER"
            | "SAVEPOINT"
    ) || sql.to_ascii_uppercase().contains("FOR UPDATE")
}

const DRAIN_OUTPUT: &str =
    "declare l varchar2(32767); s integer; begin :1 := null; :2 := null; loop \
dbms_output.get_line(l, s); exit when s <> 0; \
if :1 is not null and lengthb(:1) + lengthb(l) + 1 > 30000 then :2 := l; exit; end if; \
:1 := :1 || l || chr(10); end loop; end;";

impl Worker {
    /// Publish whether the server says a transaction is open (the read-only transaction of a read-only data source
    /// included: it holds a snapshot until it is ended, so Auto mode ends it and Manual mode shows it).
    fn track(&self) {
        let open = self.conn.in_transaction().unwrap_or(false);
        self.in_tx.store(open, Ordering::SeqCst);
    }

    fn map(&self, e: odb::Error, sql: Option<&str>) -> DbError {
        let err = map_error(e, false, sql);
        if err.is_connection_lost() {
            self.alive.store(false, Ordering::SeqCst);
        }
        err
    }

    /// Read-only data sources: refuse DDL / DCL, open the read-only transaction before anything that could write.
    fn gate(&mut self, sql: &str) -> Result<()> {
        if !self.read_only {
            return Ok(());
        }
        if refused_when_read_only(sql) {
            return Err(ora_error(
                1456,
                "may not perform insert/delete/update operation inside a READ ONLY transaction (the data source is read-only)",
            ));
        }
        if let Some(why) = read_only_violation(sql) {
            return Err(ora_error(
                1456,
                &format!("the data source is read-only: {why} is not allowed"),
            ));
        }
        if may_write(sql) && !self.conn.in_transaction().unwrap_or(false) {
            self.conn
                .execute("set transaction read only", &[])
                .map_err(|e| self.map(e, None))?;
        }
        Ok(())
    }

    /// Run one statement; every row / the final count goes to `sink` (`false` = nobody listens any more).
    fn run(
        &mut self,
        sql: &str,
        binds: &[OraBind],
        sink: &mut dyn FnMut(Out) -> bool,
    ) -> Result<()> {
        // the cancel flag is cleared when the command is queued ([`OraConn::queue`]), not here: a Stop pressed while
        // the command waits for the worker must still stop it
        let r = self
            .gate(sql)
            .and_then(|_| self.run_inner(sql, binds, sink));
        self.track();
        r
    }

    fn run_inner(
        &mut self,
        sql: &str,
        binds: &[OraBind],
        sink: &mut dyn FnMut(Out) -> bool,
    ) -> Result<()> {
        let owned: Vec<Box<dyn ToDbValue>> = binds.iter().map(to_db_value).collect();
        let refs: Vec<&dyn ToDbValue> = owned.iter().map(|b| b.as_ref()).collect();
        let stmt = self
            .conn
            .statement(sql)
            .map_err(|e| self.map(e, Some(sql)))?
            .fetch_array_size(FETCH_ROWS)
            .build()
            .map_err(|e| self.map(e, Some(sql)))?;
        if stmt.is_query() {
            let cursor = stmt.query(&refs).map_err(|e| self.map(e, Some(sql)))?;
            let mds = cursor.columns().to_vec();
            let cols = cols_of(&mds);
            self.last_cols = Some((sql.to_string(), cols.clone()));
            let mut n = 0u64;
            for row in cursor {
                if self.cancel.load(Ordering::SeqCst) {
                    return Err(cancelled());
                }
                let row = row.map_err(|e| self.map(e, Some(sql)))?;
                let vals = mds
                    .iter()
                    .enumerate()
                    .map(|(i, md)| read_value(&row, i, md))
                    .collect();
                n += 1;
                if !sink(Out::Row(OraRow {
                    cols: cols.clone(),
                    vals,
                })) {
                    return Ok(());
                }
            }
            sink(Out::Done(n));
        } else {
            let mut stmt = stmt;
            let res = stmt.execute(&refs).map_err(|e| self.map(e, Some(sql)))?;
            // a PL/SQL block / call reports "1 row" (the OCI convention), which is no row count of anything
            let n = match first_keyword(sql).as_str() {
                "BEGIN" | "DECLARE" | "CALL" | "EXEC" | "EXECUTE" => 0,
                _ => res.rows_affected(),
            };
            sink(Out::Done(n));
        }
        Ok(())
    }

    fn commit(&mut self) -> Result<()> {
        let r = self.conn.commit().map_err(|e| self.map(e, None));
        self.track();
        r
    }

    fn rollback(&mut self) -> Result<()> {
        let r = self.conn.rollback().map_err(|e| self.map(e, None));
        self.track();
        r
    }

    fn describe(&mut self, sql: &str) -> Vec<OraCol> {
        if let Some((s, cols)) = &self.last_cols {
            if s == sql {
                return cols.to_vec();
            }
        }
        let Ok(builder) = self.conn.statement(sql) else {
            return Vec::new();
        };
        let Ok(mut stmt) = builder.build() else {
            return Vec::new();
        };
        if !stmt.is_query() || stmt.ensure_fully_parsed().is_err() {
            return Vec::new();
        }
        cols_of(stmt.out_metadata()).to_vec()
    }

    /// Everything `DBMS_OUTPUT` collected, one entry per line.
    fn output(&mut self) -> Result<Vec<String>> {
        let mut lines = Vec::new();
        loop {
            let buf = " ".repeat(32767);
            let tail = " ".repeat(32767);
            let mut res = self
                .conn
                .execute(DRAIN_OUTPUT, &[&buf, &tail])
                .map_err(|e| self.map(e, None))?;
            let data = res.out_bind_data();
            let text = data
                .get::<Option<String>>(0)
                .map_err(|e| self.map(e, None))?;
            let more = data
                .get::<Option<String>>(1)
                .map_err(|e| self.map(e, None))?;
            if let Some(text) = text {
                let text = text.strip_suffix('\n').unwrap_or(&text);
                lines.extend(text.split('\n').map(str::to_string));
            }
            match more {
                Some(line) => lines.push(line),
                None => break,
            }
            if lines.len() > 100_000 {
                break;
            }
        }
        Ok(lines)
    }
}

/// Marks the connection dead when the worker thread ends for whatever reason (a panic included), so a pool never
/// hands out a connection nobody serves.
struct AliveGuard(Arc<AtomicBool>);

impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn worker_main(
    opts: OraOpts,
    enable_output: bool,
    rx: std_mpsc::Receiver<Cmd>,
    in_tx: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    cancel: OraCancel,
    ready: oneshot::Sender<Result<()>>,
) {
    let _alive_guard = AliveGuard(alive.clone());
    let connected = (|| {
        let config = odb::Config::default()
            .set_connect_string(&opts.connect_string)
            .map_err(|e| map_error(e, true, None))?
            .set_credentials(&opts.user, &opts.password)
            .set_auth_mode(opts.auth_mode)
            .set_transport_connect_timeout(Some(Duration::from_secs(opts.connect_timeout_secs)));
        // the program name shows up in V$SESSION (the driver rejects blanks and parentheses)
        let config = match config.clone().set_program("Prometeo-DataGrip") {
            Ok(c) => c,
            Err(_) => config,
        };
        let conn = odb::connect(config).map_err(|e| map_error(e, true, None))?;
        if enable_output {
            conn.execute("begin dbms_output.enable(null); end;", &[])
                .map_err(|e| map_error(e, true, None))?;
        }
        Ok::<_, DbError>(conn)
    })();
    let conn = match connected {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    *cancel.handle.lock().unwrap() = conn.cancel_handle().ok();
    let mut w = Worker {
        conn,
        read_only: opts.read_only,
        in_tx,
        alive,
        cancel: cancel.flag.clone(),
        last_cols: None,
    };
    if ready.send(Ok(())).is_err() {
        return;
    }
    let keepalive = (opts.keepalive_secs > 0).then(|| Duration::from_secs(opts.keepalive_secs));
    loop {
        let cmd = match keepalive {
            Some(d) => match rx.recv_timeout(d) {
                Ok(c) => c,
                Err(std_mpsc::RecvTimeoutError::Timeout) => {
                    if w.conn.ping().is_err() {
                        w.alive.store(false, Ordering::SeqCst);
                    }
                    continue;
                }
                Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(c) => c,
                Err(_) => break,
            },
        };
        match cmd {
            Cmd::Stream { sql, out } => {
                let tx = out.clone();
                let r = w.run(&sql, &[], &mut |o| {
                    let item = match o {
                        Out::Row(r) => Item::Row(RawRow::Ora(r)),
                        Out::Done(n) => Item::Done(n),
                    };
                    tx.blocking_send(Ok(item)).is_ok()
                });
                if let Err(e) = r {
                    let _ = out.blocking_send(Err(e));
                }
            }
            Cmd::Exec {
                sql,
                binds,
                commit,
                reply,
            } => {
                let mut n = 0;
                let mut r = w.run(&sql, &binds, &mut |o| {
                    if let Out::Done(c) = o {
                        n = c;
                    }
                    true
                });
                if r.is_ok() && commit && w.conn.in_transaction().unwrap_or(false) {
                    r = w.commit();
                }
                let _ = reply.send(r.map(|_| n));
            }
            Cmd::Strings { sql, binds, reply } => {
                let mut rows = Vec::new();
                let r = w.run(&sql, &binds, &mut |o| {
                    if let Out::Row(r) = o {
                        rows.push(row_strings(&r));
                    }
                    true
                });
                let _ = reply.send(r.map(|_| rows));
            }
            Cmd::Describe { sql, reply } => {
                let _ = reply.send(w.describe(&sql));
            }
            Cmd::Output { reply } => {
                let _ = reply.send(w.output());
            }
            Cmd::Commit { reply } => {
                let _ = reply.send(w.commit());
            }
            Cmd::Rollback { reply } => {
                let _ = reply.send(w.rollback());
            }
            Cmd::Ping { reply } => {
                let r = w.conn.ping().map_err(|e| w.map(e, None));
                let _ = reply.send(r);
            }
            #[cfg(test)]
            Cmd::Die => panic!("test: the Oracle worker dies"),
        }
    }
    let _ = w.conn.close();
}

// ------------------------------------------------------------------ connection handle

/// Dedicated Oracle session connection (owned by a worker thread; this is the handle).
pub struct OraConn {
    tx: std_mpsc::Sender<Cmd>,
    cancel: OraCancel,
    in_tx: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
}

impl OraConn {
    /// A console / probe connection: `DBMS_OUTPUT` is enabled.
    pub(crate) async fn connect(opts: &OraOpts, _cfg: &DataSourceConfig) -> Result<OraConn> {
        Self::open(opts, true).await
    }

    async fn open(opts: &OraOpts, enable_output: bool) -> Result<OraConn> {
        let (tx, rx) = std_mpsc::channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let cancel = OraCancel::new();
        let in_tx = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let (o, i, a, c) = (opts.clone(), in_tx.clone(), alive.clone(), cancel.clone());
        std::thread::Builder::new()
            .name("oracle-conn".into())
            .spawn(move || worker_main(o, enable_output, rx, i, a, c, ready_tx))
            .map_err(DbError::Io)?;
        ready_rx.await.map_err(|_| worker_gone())??;
        Ok(OraConn {
            tx,
            cancel,
            in_tx,
            alive,
        })
    }

    pub(crate) fn cancel_handle(&self) -> OraCancel {
        self.cancel.clone()
    }

    /// The server reports an open transaction (exact, no round trip).
    pub(crate) fn in_transaction(&self) -> bool {
        self.in_tx.load(Ordering::SeqCst)
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// The worker is gone (its channel is closed): the connection is dead for good.
    fn gone(&self) -> DbError {
        self.alive.store(false, Ordering::SeqCst);
        worker_gone()
    }

    /// Hand a command to the worker. A Stop pressed before this point belonged to an earlier command, one pressed
    /// after it must find the flag set when the worker gets to the command: so the flag is cleared here.
    fn queue(&self, cmd: Cmd) -> Result<()> {
        self.cancel.flag.store(false, Ordering::SeqCst);
        self.tx.send(cmd).map_err(|_| self.gone())
    }

    async fn call<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.queue(make(tx))?;
        rx.await.map_err(|_| self.gone())
    }

    /// Columns of a statement without running it (empty when unknown).
    pub(crate) async fn describe(&mut self, sql: &str) -> Vec<ColumnMeta> {
        let sql = sql.to_string();
        match self.call(|reply| Cmd::Describe { sql, reply }).await {
            Ok(cols) => metas_of(&cols),
            Err(_) => Vec::new(),
        }
    }

    fn start_stream(&self, sql: &str) -> mpsc::Receiver<Result<Item>> {
        let (out, rx) = mpsc::channel(STREAM_BUFFER);
        let cmd = Cmd::Stream {
            sql: sql.to_string(),
            out: out.clone(),
        };
        if let Err(e) = self.queue(cmd) {
            let _ = out.try_send(Err(e));
        }
        rx
    }

    /// Stream the items of one statement (rows, then the rows-affected count).
    pub(crate) fn stream(&mut self, sql: &str) -> crate::exec::ItemStream<'_> {
        let rx = self.start_stream(sql);
        let alive = self.alive.clone();
        futures_util::stream::unfold((rx, false), move |(mut rx, mut ended)| {
            let alive = alive.clone();
            async move {
                next_item(&mut rx, &mut ended, &alive)
                    .await
                    .map(|item| (item, (rx, ended)))
            }
        })
        .boxed()
    }

    /// Run one statement (positional binds `:1`.., [`OraBind::Null`] = NULL); rows affected. Does not commit.
    pub async fn execute(&mut self, sql: &str, binds: &[OraBind]) -> Result<u64> {
        self.exec_with(sql, binds, false).await
    }

    async fn exec_with(&self, sql: &str, binds: &[OraBind], commit: bool) -> Result<u64> {
        let (sql, binds) = (sql.to_string(), binds.to_vec());
        self.call(|reply| Cmd::Exec {
            sql,
            binds,
            commit,
            reply,
        })
        .await?
    }

    pub async fn query_strings(&mut self, sql: &str) -> Result<Vec<Vec<Option<String>>>> {
        self.strings(sql).await
    }

    async fn strings(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>> {
        self.strings_with(sql, &[]).await
    }

    async fn strings_with(&self, sql: &str, binds: &[OraBind]) -> Result<Vec<Vec<Option<String>>>> {
        let (sql, binds) = (sql.to_string(), binds.to_vec());
        self.call(|reply| Cmd::Strings { sql, binds, reply })
            .await?
    }

    /// [`OraPool::query_binds`] on this connection.
    pub(crate) async fn query_binds(
        &mut self,
        sql: &str,
        binds: &[OraBind],
    ) -> Result<Vec<Vec<Option<String>>>> {
        self.strings_with(sql, binds).await
    }

    pub async fn commit(&mut self) -> Result<()> {
        self.call(|reply| Cmd::Commit { reply }).await?
    }

    pub async fn rollback(&mut self) -> Result<()> {
        self.call(|reply| Cmd::Rollback { reply }).await?
    }

    /// Round trip to check the connection is alive.
    pub async fn ping(&mut self) -> Result<()> {
        self.call(|reply| Cmd::Ping { reply }).await?
    }

    /// Lines the session wrote with `DBMS_OUTPUT.PUT_LINE` since the last call.
    pub(crate) async fn drain_output(&mut self) -> Result<Vec<String>> {
        self.call(|reply| Cmd::Output { reply }).await?
    }

    pub async fn close(self) {}
}

/// The next item of a statement's stream. A stream that closes before its `Done` / an error means the worker died
/// under the statement: that is an error (and the connection is dead), not an empty result.
async fn next_item(
    rx: &mut mpsc::Receiver<Result<Item>>,
    ended: &mut bool,
    alive: &AtomicBool,
) -> Option<Result<Item>> {
    match rx.recv().await {
        Some(item) => {
            if matches!(item, Ok(Item::Done(_)) | Err(_)) {
                *ended = true;
            }
            Some(item)
        }
        None if *ended => None,
        None => {
            *ended = true;
            alive.store(false, Ordering::SeqCst);
            Some(Err(worker_gone()))
        }
    }
}

/// Should the console look for `DBMS_OUTPUT` after this statement? (A round trip, so only where output can
/// appear: PL/SQL, `CALL` / `EXEC`, or a query that calls something.)
pub(crate) fn may_print(sql: &str) -> bool {
    match first_keyword(sql).as_str() {
        "BEGIN" | "DECLARE" | "CALL" | "EXEC" | "EXECUTE" => true,
        "SELECT" | "WITH" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" => sql.contains('('),
        "" => false,
        _ => sql.to_ascii_lowercase().contains("dbms_output"),
    }
}

/// The stored object a `CREATE [OR REPLACE] PROCEDURE / FUNCTION / PACKAGE [BODY] / TRIGGER / TYPE [BODY] / VIEW`
/// statement defines: `(type as ALL_ERRORS names it, owner if written, name)`. Oracle reports such a statement as
/// a success even when the object is INVALID (`ORA-24344`, success with compilation error): the errors are in
/// `ALL_ERRORS`.
pub(crate) fn compiled_object(sql: &str) -> Option<(String, Option<String>, String)> {
    let mut rest = sql.trim_start();
    // leading comments
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map(|x| x.1).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    // words (upper-cased) and quoted identifiers (kept), `.` as its own token
    let mut toks: Vec<(String, bool)> = Vec::new();
    let mut it = rest.char_indices().peekable();
    while let Some(&(i, c)) = it.peek() {
        if toks.len() >= 12 {
            break;
        }
        if c.is_whitespace() {
            it.next();
        } else if c == '"' {
            it.next();
            let mut name = String::new();
            for (_, ch) in it.by_ref() {
                if ch == '"' {
                    break;
                }
                name.push(ch);
            }
            toks.push((name, true));
        } else if c == '.' {
            it.next();
            toks.push((".".into(), false));
        } else if c.is_alphanumeric() || matches!(c, '_' | '$' | '#') {
            let mut end = i;
            while let Some(&(j, ch)) = it.peek() {
                if ch.is_alphanumeric() || matches!(ch, '_' | '$' | '#') {
                    end = j + ch.len_utf8();
                    it.next();
                } else {
                    break;
                }
            }
            toks.push((rest[i..end].to_ascii_uppercase(), false));
        } else {
            break;
        }
    }
    let word = |k: usize, w: &str| toks.get(k).is_some_and(|t| !t.1 && t.0 == w);
    if !word(0, "CREATE") {
        return None;
    }
    let mut k = 1;
    if word(k, "OR") && word(k + 1, "REPLACE") {
        k += 2;
    }
    while [
        "EDITIONABLE",
        "NONEDITIONABLE",
        "FORCE",
        "NOFORCE",
        "EDITIONING",
    ]
    .iter()
    .any(|w| word(k, w))
    {
        k += 1;
    }
    let ty = match toks.get(k).filter(|t| !t.1).map(|t| t.0.as_str())? {
        t @ ("PROCEDURE" | "FUNCTION" | "TRIGGER" | "VIEW") => t.to_string(),
        t @ ("PACKAGE" | "TYPE") => {
            if word(k + 1, "BODY") {
                k += 1;
                format!("{t} BODY")
            } else {
                t.to_string()
            }
        }
        _ => return None,
    };
    k += 1;
    let (name, _) = toks.get(k)?.clone();
    if name == "." {
        return None;
    }
    if toks.get(k + 1).is_some_and(|t| !t.1 && t.0 == ".") {
        let (obj, _) = toks.get(k + 2)?.clone();
        return Some((ty, Some(name), obj));
    }
    Some((ty, None, name))
}

/// The compile errors Oracle recorded for the object a `CREATE` statement just defined (see [`compiled_object`]),
/// as `(line, column, text)`; empty when it compiled cleanly or `sql` defines no stored object.
pub(crate) async fn compile_errors(
    conn: &mut OraConn,
    sql: &str,
) -> Result<Option<(String, String, Vec<(i64, i64, String)>)>> {
    let Some((ty, owner, name)) = compiled_object(sql) else {
        return Ok(None);
    };
    let mut binds = Vec::new();
    let owner_cond = match &owner {
        Some(o) => {
            binds.push(OraBind::Text(o.clone()));
            "owner = :1"
        }
        None => "owner = sys_context('USERENV', 'CURRENT_SCHEMA')",
    };
    binds.push(OraBind::Text(name.clone()));
    binds.push(OraBind::Text(ty.clone()));
    let n = binds.len();
    let rows = conn
        .query_binds(
            &format!(
                "select line, position, text from all_errors where {owner_cond} and name = :{} and type = :{n} \
                 and attribute = 'ERROR' order by sequence",
                n - 1
            ),
            &binds,
        )
        .await?;
    let errors: Vec<(i64, i64, String)> = rows
        .into_iter()
        .map(|r| {
            let num = |i: usize| {
                r.get(i)
                    .cloned()
                    .flatten()
                    .and_then(|v| v.trim().parse::<i64>().ok())
                    .unwrap_or(0)
            };
            (
                num(0),
                num(1),
                r.get(2).cloned().flatten().unwrap_or_default(),
            )
        })
        .collect();
    if errors.is_empty() {
        return Ok(None);
    }
    let shown = match owner {
        Some(o) => format!("{o}.{name}"),
        None => name,
    };
    Ok(Some((ty, shown, errors)))
}

// ------------------------------------------------------------------ pool

struct PoolInner {
    opts: OraOpts,
    idle: Mutex<Vec<OraConn>>,
    permits: Arc<Semaphore>,
    closed: AtomicBool,
}

/// Pool of Oracle connections (introspection, table reads, edits).
#[derive(Clone)]
pub struct OraPool {
    inner: Arc<PoolInner>,
}

/// A pooled connection; goes back to the pool when dropped (unless it died or still has a transaction open: then
/// it is closed, which rolls the transaction back).
struct Pooled {
    conn: Option<OraConn>,
    inner: Arc<PoolInner>,
    /// Came out of the idle list (it may have gone stale: one retry is fair).
    reused: bool,
    _permit: OwnedSemaphorePermit,
}

impl Pooled {
    fn conn(&self) -> &OraConn {
        self.conn.as_ref().expect("connection present")
    }
}

impl Drop for Pooled {
    fn drop(&mut self) {
        if let Some(c) = self.conn.take() {
            if c.is_alive() && !c.in_transaction() && !self.inner.closed.load(Ordering::SeqCst) {
                self.inner.idle.lock().unwrap().push(c);
            }
        }
    }
}

impl OraPool {
    pub(crate) async fn open(opts: &OraOpts, _cfg: &DataSourceConfig) -> Result<OraPool> {
        Ok(OraPool {
            inner: Arc::new(PoolInner {
                opts: opts.clone(),
                idle: Mutex::new(Vec::new()),
                permits: Arc::new(Semaphore::new(POOL_MAX)),
                closed: AtomicBool::new(false),
            }),
        })
    }

    async fn acquire(&self) -> Result<Pooled> {
        let wait = Duration::from_secs(self.inner.opts.connect_timeout_secs);
        let permit = tokio::time::timeout(wait, self.inner.permits.clone().acquire_owned())
            .await
            .map_err(|_| {
                DbError::Connection("Timed out waiting for a free connection from the pool".into())
            })?
            .map_err(|_| DbError::Connection("The connection pool is closed".into()))?;
        loop {
            if self.inner.closed.load(Ordering::SeqCst) {
                return Err(DbError::Connection("The connection pool is closed".into()));
            }
            let idle = self.inner.idle.lock().unwrap().pop();
            match idle {
                Some(c) if c.is_alive() => {
                    return Ok(Pooled {
                        conn: Some(c),
                        inner: self.inner.clone(),
                        reused: true,
                        _permit: permit,
                    })
                }
                Some(_) => continue,
                None => {
                    let c = OraConn::open(&self.inner.opts, false).await?;
                    return Ok(Pooled {
                        conn: Some(c),
                        inner: self.inner.clone(),
                        reused: false,
                        _permit: permit,
                    });
                }
            }
        }
    }

    pub(crate) async fn describe(&self, sql: &str) -> Vec<ColumnMeta> {
        let r = self
            .with_conn(|p| async move {
                let sql = sql.to_string();
                p.conn().call(|reply| Cmd::Describe { sql, reply }).await
            })
            .await;
        r.map(|cols| metas_of(&cols)).unwrap_or_default()
    }

    /// Stream the items of one statement on a pooled connection. When a reused connection turns out dead before
    /// the first item, the statement runs once more on another one.
    pub(crate) fn stream<'a>(&'a self, sql: &'a str) -> crate::exec::ItemStream<'a> {
        enum St<'a> {
            Init(&'a OraPool, &'a str),
            Run(PoolStream<'a>),
            Done,
        }
        /// Cancels the statement when the reader goes away before the end.
        struct PoolStream<'a> {
            pool: &'a OraPool,
            sql: &'a str,
            rx: mpsc::Receiver<Result<Item>>,
            pooled: Pooled,
            /// The channel delivered `Done` / an error (or the worker died).
            ended: bool,
            /// Something was handed to the reader.
            yielded: bool,
            retried: bool,
            finished: bool,
        }
        impl<'a> PoolStream<'a> {
            fn new(pool: &'a OraPool, sql: &'a str, pooled: Pooled, retried: bool) -> Self {
                PoolStream {
                    pool,
                    sql,
                    rx: pooled.conn().start_stream(sql),
                    pooled,
                    ended: false,
                    yielded: false,
                    retried,
                    finished: false,
                }
            }
        }
        impl Drop for PoolStream<'_> {
            fn drop(&mut self) {
                if !self.finished {
                    self.pooled.conn().cancel.cancel();
                }
            }
        }
        futures_util::stream::unfold(St::Init(self, sql), |st| async move {
            let mut ps = match st {
                St::Init(pool, sql) => match pool.acquire().await {
                    Err(e) => return Some((Err(e), St::Done)),
                    Ok(pooled) => PoolStream::new(pool, sql, pooled, false),
                },
                St::Run(ps) => ps,
                St::Done => return None,
            };
            loop {
                let item = next_item(&mut ps.rx, &mut ps.ended, &ps.pooled.conn().alive).await;
                match item {
                    Some(Err(e))
                        if !ps.yielded
                            && !ps.retried
                            && ps.pooled.reused
                            && e.is_connection_lost() =>
                    {
                        let (pool, sql) = (ps.pool, ps.sql);
                        ps.finished = true;
                        drop(ps);
                        match pool.acquire().await {
                            Err(e) => return Some((Err(e), St::Done)),
                            Ok(pooled) => ps = PoolStream::new(pool, sql, pooled, true),
                        }
                    }
                    Some(item) => {
                        ps.yielded = true;
                        return Some((item, St::Run(ps)));
                    }
                    None => {
                        ps.finished = true;
                        return None;
                    }
                }
            }
        })
        .boxed()
    }

    /// Run `f` on a pooled connection; once more on a fresh one when a reused connection turned out dead.
    async fn with_conn<T, F, Fut>(&self, f: F) -> Result<T>
    where
        F: Fn(Pooled) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let p = self.acquire().await?;
        let reused = p.reused;
        match f(p).await {
            Err(e) if reused && e.is_connection_lost() => f(self.acquire().await?).await,
            r => r,
        }
    }

    /// Run `sql` and commit (pooled connections do not keep a transaction).
    pub async fn exec(&self, sql: &str) -> Result<u64> {
        self.exec_binds(sql, &[]).await
    }

    pub async fn query_strings(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>> {
        self.with_conn(|p| async move { p.conn().strings(sql).await })
            .await
    }

    /// [`query_strings`](Self::query_strings) with positional binds (`:1`, `:2`, ...). The dictionary queries of the
    /// hot paths use them: the server hard-parses a query text it has not seen (~0.8 s for `ALL_TAB_COLS`), so a
    /// table name inside the text would make every first visit of a table slow.
    pub async fn query_binds(
        &self,
        sql: &str,
        binds: &[OraBind],
    ) -> Result<Vec<Vec<Option<String>>>> {
        self.with_conn(|p| async move { p.conn().strings_with(sql, binds).await })
            .await
    }

    /// Run `sql` with positional binds (`:1`, `:2`, ...; [`OraBind::Null`] is NULL) on a pooled connection and
    /// commit.
    pub async fn exec_binds(&self, sql: &str, binds: &[OraBind]) -> Result<u64> {
        self.with_conn(|p| async move { p.conn().exec_with(sql, binds, true).await })
            .await
    }

    pub async fn begin(&self) -> Result<OraTx> {
        let mut pooled = self.acquire().await?;
        // a connection that sat in the pool may have died meanwhile: find out now, not at the first statement
        if pooled.reused {
            let ping = pooled.conn().call(|reply| Cmd::Ping { reply }).await;
            if !matches!(ping, Ok(Ok(()))) {
                pooled = self.acquire().await?;
            }
        }
        Ok(OraTx { pooled })
    }

    pub async fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.permits.close();
        let idle: Vec<OraConn> = std::mem::take(&mut *self.inner.idle.lock().unwrap());
        drop(idle);
    }
}

/// A transaction on a pooled connection: statements run in order, `commit` / `rollback` end it, dropping it rolls
/// back. Oracle has no `BEGIN`: the transaction starts with the first DML statement.
pub struct OraTx {
    pooled: Pooled,
}

impl OraTx {
    /// Run one statement (positional binds `:1`.., [`OraBind::Null`] = NULL) in the transaction; rows affected.
    pub async fn execute(&mut self, sql: &str, binds: &[OraBind]) -> Result<u64> {
        self.pooled.conn().exec_with(sql, binds, false).await
    }

    pub async fn commit(self) -> Result<()> {
        self.pooled
            .conn()
            .call(|reply| Cmd::Commit { reply })
            .await?
    }

    pub async fn rollback(self) -> Result<()> {
        self.pooled
            .conn()
            .call(|reply| Cmd::Rollback { reply })
            .await?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[test]
    fn compiled_object_names_the_created_stored_object() {
        let o = |s: &str| compiled_object(s);
        let some = |t: &str, ow: Option<&str>, n: &str| {
            Some((t.to_string(), ow.map(str::to_string), n.to_string()))
        };
        assert_eq!(
            o("create or replace procedure qa_p as begin null; end;"),
            some("PROCEDURE", None, "QA_P")
        );
        assert_eq!(
            o("-- c\n  CREATE FUNCTION demo.f(x number) return number is begin return 1; end;"),
            some("FUNCTION", Some("DEMO"), "F")
        );
        assert_eq!(
            o("create or replace package body \"Pk\" as end;"),
            some("PACKAGE BODY", None, "Pk")
        );
        assert_eq!(
            o("create or replace editionable package pk as end;"),
            some("PACKAGE", None, "PK")
        );
        assert_eq!(
            o("create or replace type body t as end;"),
            some("TYPE BODY", None, "T")
        );
        assert_eq!(
            o("create or replace force view v as select 1 x from dual"),
            some("VIEW", None, "V")
        );
        assert_eq!(
            o("create or replace trigger trg before insert on t begin null; end;"),
            some("TRIGGER", None, "TRG")
        );
        assert_eq!(o("create table t (a number)"), None);
        assert_eq!(o("create index i on t (a)"), None);
        assert_eq!(o("select 1 from dual"), None);
        assert_eq!(o("create or replace procedure"), None);
    }

    #[test]
    fn numbers_become_json_numbers_only_when_lossless() {
        assert_eq!(number_cell("42"), Value::from(42));
        assert_eq!(number_cell("-7"), Value::from(-7));
        assert_eq!(number_cell("0"), Value::from(0));
        assert_eq!(number_cell("12.34"), serde_json::json!(12.34));
        assert_eq!(number_cell("0.1"), serde_json::json!(0.1));
        assert_eq!(number_cell("-0.5"), serde_json::json!(-0.5));
        // beyond 2^53 and 15 digits: exact text
        assert_eq!(
            number_cell("12345678901234567890123"),
            Value::String("12345678901234567890123".into())
        );
        assert_eq!(
            number_cell("9007199254740993"),
            Value::String("9007199254740993".into())
        );
        assert_eq!(
            number_cell("9007199254740992"),
            Value::from(9007199254740992i64)
        );
        assert_eq!(
            number_cell("1000000000000000000000000000000"),
            Value::String("1000000000000000000000000000000".into())
        );
        assert_eq!(
            number_cell("0.333333333333333333333333333333333333333"),
            Value::String("0.333333333333333333333333333333333333333".into())
        );
        assert_eq!(
            number_cell("123456789.123456789"),
            Value::String("123456789.123456789".into())
        );
    }

    #[test]
    fn connect_strings() {
        let cfg = |url: &str| DataSourceConfig {
            driver: Driver::Oracle,
            url_override: Some(url.into()),
            ..Default::default()
        };
        let o = build_opts(&cfg("jdbc:oracle:thin:@//db.example:1522/SVC")).unwrap_err();
        assert!(o.to_string().contains("user"), "{o}");
        let mut c = cfg("jdbc:oracle:thin:@//db.example:1522/SVC");
        c.user = "u".into();
        assert_eq!(
            build_opts(&c).unwrap().connect_string,
            "db.example:1522/SVC"
        );
        c.url_override = Some("jdbc:oracle:thin:@db.example:1521:ORCL".into());
        assert_eq!(
            build_opts(&c).unwrap().connect_string,
            "(DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=db.example)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))"
        );
        c.url_override = Some("oracle://scott:tiger@h:1599/PDB".into());
        let o = build_opts(&c).unwrap();
        assert_eq!(
            (
                o.connect_string.as_str(),
                o.user.as_str(),
                o.password.as_str()
            ),
            ("h:1599/PDB", "u", "tiger")
        );
        // an '@' inside the password: the target starts after the last one, nothing of the password reaches it
        c.url_override = Some("jdbc:oracle:thin:scott/p@ss@h:1521/PDB".into());
        let o = build_opts(&c).unwrap();
        assert_eq!(
            (o.connect_string.as_str(), o.password.as_str()),
            ("h:1521/PDB", "p@ss")
        );
        c.url_override = Some("oracle://scott@h/ORCL?sid=1".into());
        assert!(build_opts(&c)
            .unwrap()
            .connect_string
            .contains("(SID=ORCL)"));
        // fields
        let f = DataSourceConfig {
            driver: Driver::Oracle,
            host: "h".into(),
            user: "u".into(),
            database: "FREEPDB1".into(),
            ..Default::default()
        };
        assert!(build_opts(&f)
            .unwrap()
            .connect_string
            .contains("(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=FREEPDB1))"));
        let mut s = f.clone();
        s.options.insert("oracleConnType".into(), "sid".into());
        assert!(build_opts(&s)
            .unwrap()
            .connect_string
            .contains("(SID=FREEPDB1)"));
        assert!(build_opts(&DataSourceConfig {
            user: "u".into(),
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn read_only_gate() {
        assert!(refused_when_read_only("create table t (a int)"));
        assert!(refused_when_read_only("/* x */ drop table t"));
        assert!(refused_when_read_only("alter table t add b int"));
        assert!(!refused_when_read_only(
            "alter session set current_schema = x"
        ));
        assert!(!refused_when_read_only("select 1 from dual"));
        assert!(may_write("insert into t values (1)"));
        assert!(may_write("begin null; end;"));
        assert!(may_write("select * from t for update"));
        assert!(!may_write("select 1 from dual"));
        assert!(!may_write("commit"));
    }

    #[test]
    fn read_only_refuses_what_escapes_the_read_only_transaction() {
        let bad = |sql: &str| read_only_violation(sql).is_some();
        // SET TRANSACTION: only READ ONLY
        assert!(bad("set transaction read write"));
        assert!(bad("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"));
        assert!(bad("/* x */ set\n transaction read write name 'x'"));
        assert!(!bad("set transaction read only"));
        assert!(!bad("SET TRANSACTION READ ONLY NAME 'q'"));
        assert!(!bad("set role all"));
        // PL/SQL blocks
        assert!(bad(
            "begin execute immediate 'create table t (a int)'; end;"
        ));
        assert!(bad("begin\n  execute\n  immediate 'drop table t';\nend;"));
        assert!(bad("begin commit; delete from t; end;"));
        assert!(bad("declare n number; begin n := 1; ROLLBACK; end;"));
        assert!(bad("begin dbms_sql.execute(1); end;"));
        assert!(bad("begin sys.dbms_scheduler.create_job('j'); end;"));
        assert!(bad("<<l>> begin set transaction read write; end;"));
        assert!(bad(
            "declare pragma autonomous_transaction; begin null; end;"
        ));
        assert!(bad("call dbms_utility.exec_ddl_statement('drop table t')"));
        // text and comments are not code
        assert!(!bad(
            "begin dbms_output.put_line('commit; execute immediate'); end;"
        ));
        assert!(!bad("begin -- commit\n null; /* rollback */ end;"));
        assert!(!bad("begin dbms_output.put_line(q'[it's a commit]'); end;"));
        assert!(!bad("begin dbms_output.put_line(nq'{rollback}'); end;"));
        assert!(!bad("begin null; end; -- execute immediate"));
        assert!(!bad("begin select 1 into :x from \"COMMIT\"; end;"));
        assert!(!bad("begin update t set a = 1; end;"));
        // statements that are not blocks are the server's business
        assert!(!bad("select 'commit' from dual"));
        assert!(!bad("insert into t values (1)"));
        let w = code_words(
            "select 'a''b commit', q'#x# commit#', \"rollback\" -- x\n from /* y */ t_1$",
        );
        assert_eq!(w, ["SELECT", "FROM", "T_1$"]);
    }

    #[test]
    fn a_worker_that_ends_marks_the_connection_dead() {
        let alive = Arc::new(AtomicBool::new(true));
        let a = alive.clone();
        let t = std::thread::spawn(move || {
            let _g = AliveGuard(a);
            panic!("worker dies");
        });
        assert!(t.join().is_err());
        assert!(!alive.load(Ordering::SeqCst));
    }

    #[test]
    fn positions_count_code_points() {
        assert_eq!(position_of("select x from t", 7), 8);
        assert_eq!(position_of("sélect x", 7), 7);
    }

    #[test]
    fn output_heuristic() {
        assert!(may_print("begin dbms_output.put_line('x'); end;"));
        assert!(may_print("call p()"));
        assert!(may_print("select f(1) from dual"));
        assert!(!may_print("select 1 from dual"));
        assert!(!may_print("create table t (a int)"));
    }

    // ---- against the server (PROMETEO_ORACLE_URL); skipped without it

    fn env_opts() -> Option<OraOpts> {
        let url = std::env::var("PROMETEO_ORACLE_URL").ok()?;
        build_opts(&DataSourceConfig {
            driver: Driver::Oracle,
            url_override: Some(url),
            ..Default::default()
        })
        .ok()
    }

    #[tokio::test]
    async fn a_stop_pressed_while_a_command_is_queued_stops_it() {
        let Some(opts) = env_opts() else { return };
        let conn = OraConn::open(&opts, false).await.unwrap();
        // the first statement keeps the worker busy: it waits for a reader of its rows
        let rx_a = conn.start_stream("select level from dual connect by level <= 1000000");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let mut rx_b = conn.start_stream("select 1 from dual");
        conn.cancel_handle().cancel();
        drop(rx_a);
        let first = rx_b.recv().await.expect("the worker answers");
        let err = first.err().expect("the queued statement was stopped");
        assert!(err.to_string().contains("ORA-01013"), "{err}");
        // the next command starts clean
        let mut rx_c = conn.start_stream("select 1 from dual");
        assert!(rx_c.recv().await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn a_dead_worker_is_replaced_on_every_pool_path() {
        let Some(opts) = env_opts() else { return };
        let pool = OraPool::open(&opts, &DataSourceConfig::default())
            .await
            .unwrap();
        // makes the idle connections look alive although their worker thread is gone (the race the retry covers)
        async fn kill_idle(pool: &OraPool) {
            let conns: Vec<OraConn> = std::mem::take(&mut *pool.inner.idle.lock().unwrap());
            for c in &conns {
                c.tx.send(Cmd::Die).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            for c in &conns {
                assert!(
                    !c.is_alive(),
                    "the worker's guard marks the connection dead"
                );
                c.alive.store(true, Ordering::SeqCst);
            }
            pool.inner.idle.lock().unwrap().extend(conns);
        }
        assert_eq!(
            pool.query_strings("select 1 from dual")
                .await
                .unwrap()
                .len(),
            1
        );
        kill_idle(&pool).await;
        assert_eq!(
            pool.query_strings("select 2 from dual")
                .await
                .unwrap()
                .len(),
            1
        );
        kill_idle(&pool).await;
        assert_eq!(pool.describe("select 3 x from dual").await.len(), 1);
        kill_idle(&pool).await;
        let items: Vec<_> = pool.stream("select 4 from dual").collect().await;
        assert!(
            items.iter().all(|i| i.is_ok()) && items.len() == 2,
            "{}",
            items.len()
        );
        kill_idle(&pool).await;
        let mut tx = pool.begin().await.unwrap();
        assert_eq!(tx.execute("select 5 from dual", &[]).await.unwrap(), 1);
        tx.rollback().await.unwrap();
        kill_idle(&pool).await;
        pool.exec("select 6 from dual").await.unwrap();
        // a dead connection is not put back into the pool
        let conns: Vec<OraConn> = std::mem::take(&mut *pool.inner.idle.lock().unwrap());
        conns[0].tx.send(Cmd::Die).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        pool.inner.idle.lock().unwrap().extend(conns);
        let p = pool.acquire().await.unwrap();
        assert!(p.conn().is_alive() && !p.reused);
    }
}
