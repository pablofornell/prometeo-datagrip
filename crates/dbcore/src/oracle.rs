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
//!   `ORA-01456`.
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
        let (cred, target) = rest.split_once('@').ok_or_else(|| {
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
    fn track(&self) {
        let open = !self.read_only && self.conn.in_transaction().unwrap_or(false);
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
        self.cancel.store(false, Ordering::SeqCst);
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
            sink(Out::Done(res.rows_affected()));
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

fn worker_main(
    opts: OraOpts,
    enable_output: bool,
    rx: std_mpsc::Receiver<Cmd>,
    in_tx: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    cancel: OraCancel,
    ready: oneshot::Sender<Result<()>>,
) {
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
            Cmd::Strings { sql, reply } => {
                let mut rows = Vec::new();
                let r = w.run(&sql, &[], &mut |o| {
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

    async fn call<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Cmd) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(make(tx)).map_err(|_| worker_gone())?;
        rx.await.map_err(|_| worker_gone())
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
        if self.tx.send(cmd).is_err() {
            let _ = out.try_send(Err(worker_gone()));
        }
        rx
    }

    /// Stream the items of one statement (rows, then the rows-affected count).
    pub(crate) fn stream(&mut self, sql: &str) -> crate::exec::ItemStream<'_> {
        let rx = self.start_stream(sql);
        futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
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
        let sql = sql.to_string();
        self.call(|reply| Cmd::Strings { sql, reply }).await?
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
        match self.acquire().await {
            Ok(p) => {
                let sql = sql.to_string();
                match p.conn().call(|reply| Cmd::Describe { sql, reply }).await {
                    Ok(cols) => metas_of(&cols),
                    Err(_) => Vec::new(),
                }
            }
            Err(_) => Vec::new(),
        }
    }

    /// Stream the items of one statement on a pooled connection.
    pub(crate) fn stream<'a>(&'a self, sql: &'a str) -> crate::exec::ItemStream<'a> {
        enum St<'a> {
            Init(&'a OraPool, &'a str),
            Run(PoolStream),
            Done,
        }
        /// Cancels the statement when the reader goes away before the end.
        struct PoolStream {
            rx: mpsc::Receiver<Result<Item>>,
            pooled: Pooled,
            finished: bool,
        }
        impl Drop for PoolStream {
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
                    Ok(pooled) => PoolStream {
                        rx: pooled.conn().start_stream(sql),
                        pooled,
                        finished: false,
                    },
                },
                St::Run(ps) => ps,
                St::Done => return None,
            };
            match ps.rx.recv().await {
                Some(item) => Some((item, St::Run(ps))),
                None => {
                    ps.finished = true;
                    None
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

    /// Run `sql` with positional binds (`:1`, `:2`, ...; [`OraBind::Null`] is NULL) on a pooled connection and
    /// commit.
    pub async fn exec_binds(&self, sql: &str, binds: &[OraBind]) -> Result<u64> {
        self.with_conn(|p| async move { p.conn().exec_with(sql, binds, true).await })
            .await
    }

    pub async fn begin(&self) -> Result<OraTx> {
        Ok(OraTx {
            pooled: self.acquire().await?,
        })
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
}
