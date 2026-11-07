//! Error type. Server errors keep the server's real message and SQLSTATE so the UI can
//! show what DataGrip shows, e.g. `[42P01] ERROR: relation "x" does not exist` plus a
//! `Position: 15` line.

use std::fmt;

use serde::{Serialize, Serializer};
use sqlx::error::DatabaseError;
use sqlx::mysql::MySqlDatabaseError;
use sqlx::postgres::{PgDatabaseError, PgErrorPosition};
use sqlx::sqlite::SqliteError;

use crate::model::Driver;

pub type Result<T> = std::result::Result<T, DbError>;

/// An error reported by the database server itself.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerError {
    pub driver: Driver,
    /// SQLSTATE for PG/MySQL, symbolic result code (`SQLITE_ERROR`) for SQLite.
    pub code: String,
    /// Vendor specific number (MySQL error number, SQLite extended code).
    pub native_code: Option<i64>,
    /// `ERROR`, `FATAL`, ... (PG only).
    pub severity: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 1-based character position inside the statement that was sent (PG only).
    pub position: Option<usize>,
}

impl fmt::Display for ServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.driver {
            Driver::Postgres => {
                write!(
                    f,
                    "[{}] {}: {}",
                    self.code,
                    self.severity.as_deref().unwrap_or("ERROR"),
                    self.message
                )?;
                if let Some(d) = &self.detail {
                    write!(f, "\n  Detail: {d}")?;
                }
                if let Some(h) = &self.hint {
                    write!(f, "\n  Hint: {h}")?;
                }
                if let Some(p) = self.position {
                    write!(f, "\n  Position: {p}")?;
                }
                Ok(())
            }
            Driver::MySql => match self.native_code {
                Some(n) => write!(f, "[{}][{}] {}", self.code, n, self.message),
                None => write!(f, "[{}] {}", self.code, self.message),
            },
            // DataGrip prefixes the (extended) result code: `[1] [SQLITE_ERROR] SQL error or missing database (...)`
            Driver::Sqlite => {
                if let Some(n) = self.native_code.filter(|n| *n != 0) {
                    write!(f, "[{n}] ")?;
                }
                match sqlite_description(self.native_code.unwrap_or(0)) {
                    Some(desc) => write!(f, "[{}] {} ({})", self.code, desc, self.message),
                    None => write!(f, "[{}] {}", self.code, self.message),
                }
            }
            // the message already starts with the `ORA-NNNNN: ` code
            Driver::Oracle => f.write_str(&self.message),
        }
    }
}

/// The connection to the server is gone (socket closed / reset, server shut down or terminated the backend,
/// pool closed). Shown as `[08006] ...` (`[08S01] ...` on MySQL), the way DataGrip reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionLost {
    /// Unknown (`None`) until the error reaches code that knows the session's driver, see [`DbError::for_driver`].
    pub driver: Option<Driver>,
    /// What the server itself said when it announced the end (`FATAL: terminating connection due to
    /// administrator command`); `None` when the socket just broke.
    pub server: Option<String>,
    /// The underlying client error (`error communicating with database: ...`), shown on a second line.
    pub cause: String,
}

impl ConnectionLost {
    /// `08S01` (communication link failure) for MySQL, `08006` (connection failure) otherwise.
    pub fn sqlstate(&self) -> &'static str {
        if self.driver == Some(Driver::MySql) {
            "08S01"
        } else {
            "08006"
        }
    }
}

impl fmt::Display for ConnectionLost {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] ", self.sqlstate())?;
        match (&self.server, self.driver) {
            (Some(s), _) => f.write_str(s)?,
            (None, Some(Driver::MySql)) => {
                f.write_str("Communications link failure: the connection to the server was lost.")?
            }
            (None, Some(Driver::Sqlite)) => f.write_str("The database connection is closed.")?,
            (None, Some(Driver::Oracle)) => {
                f.write_str("The connection to the database was lost.")?
            }
            (None, _) => f.write_str("An I/O error occurred while sending to the backend.")?,
        }
        if self.server.is_none() && !self.cause.is_empty() {
            write!(f, "\n  Cause: {}", self.cause)?;
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("{0}")]
    Server(Box<ServerError>),
    /// The connection died while a statement or command used it (see [`ConnectionLost`]).
    #[error("{0}")]
    ConnectionLost(ConnectionLost),
    /// Connection level failures (I/O, TLS, protocol, pool timeouts, bad options).
    #[error("{0}")]
    Connection(String),
    #[error("Data source '{0}' is not connected")]
    NotConnected(String),
    #[error("Session '{0}' does not exist")]
    NoSession(String),
    #[error("Execution '{0}' does not exist or has finished")]
    NoExecution(String),
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    InvalidArgument(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    NotFound(String),
    #[error("Statement cancelled by user")]
    Cancelled,
    #[error("Change #{index} failed: {source}")]
    Change {
        index: usize,
        #[source]
        source: Box<DbError>,
    },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl DbError {
    pub fn server(&self) -> Option<&ServerError> {
        match self {
            DbError::Server(s) => Some(s.as_ref()),
            DbError::Change { source, .. } => source.server(),
            _ => None,
        }
    }

    /// Did the connection die (as opposed to the statement failing)?
    pub fn is_connection_lost(&self) -> bool {
        matches!(self, DbError::ConnectionLost(_))
    }

    /// Tell a driver-less [`ConnectionLost`] which database it came from (sets the SQLSTATE and the text);
    /// any other error is returned unchanged.
    pub fn for_driver(self, driver: Driver) -> DbError {
        match self {
            DbError::ConnectionLost(mut l) if l.driver.is_none() => {
                l.driver = Some(driver);
                DbError::ConnectionLost(l)
            }
            DbError::Change { index, source } => DbError::Change {
                index,
                source: Box::new(source.for_driver(driver)),
            },
            e => e,
        }
    }

    /// 1-based position of the error inside the offending statement, when known.
    pub fn position(&self) -> Option<usize> {
        self.server().and_then(|s| s.position)
    }
}

impl Serialize for DbError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<DbError> for String {
    fn from(e: DbError) -> String {
        e.to_string()
    }
}

impl From<sqlx::Error> for DbError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::Database(db) => from_database_error(db.as_ref(), false),
            sqlx::Error::RowNotFound => DbError::NotFound("row not found".into()),
            sqlx::Error::PoolTimedOut => {
                DbError::Connection("Timed out waiting for a free connection from the pool".into())
            }
            other if sqlx_connection_lost(&other) => DbError::ConnectionLost(ConnectionLost {
                driver: None,
                server: None,
                cause: other.to_string(),
            }),
            other => DbError::Connection(other.to_string()),
        }
    }
}

/// Error of *opening* a connection (nothing was lost: the server was never reached): the plain client text.
/// A server refusal while connecting (FATAL `28P01`, `53300`, ...) is a plain server error, not a lost session.
pub(crate) fn connect_error(e: sqlx::Error) -> DbError {
    if sqlx_connection_lost(&e) {
        DbError::Connection(e.to_string())
    } else if let sqlx::Error::Database(db) = &e {
        from_database_error(db.as_ref(), true)
    } else {
        e.into()
    }
}

/// Does this client error mean the connection is gone? (I/O and TLS failures, a closed pool, a dead worker
/// thread, protocol errors caused by a socket that closed in the middle of a message.)
pub(crate) fn sqlx_connection_lost(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed => true,
        sqlx::Error::Protocol(m) => {
            let m = m.to_lowercase();
            ["eof", "closed", "reset", "broken pipe", "unexpected end"]
                .iter()
                .any(|k| m.contains(k))
        }
        _ => false,
    }
}

/// Server errors that announce the end of the connection: PG class `08` (connection exception) and
/// `57P01` / `57P02` / `57P03` (admin shutdown, crash shutdown, cannot connect now); MySQL 2006 / 2013
/// (gone away / lost connection), 1927 (connection was killed), 1053 (server shutdown in progress),
/// 4031 (`ER_CLIENT_INTERACTION_TIMEOUT`: disconnected for inactivity, 8.0.24+).
fn known_codes_end_connection(s: &ServerError) -> bool {
    match s.driver {
        Driver::Postgres => {
            s.code.starts_with("08") || matches!(s.code.as_str(), "57P01" | "57P02" | "57P03")
        }
        Driver::MySql => {
            matches!(s.native_code, Some(2006 | 2013 | 1927 | 1053 | 4031)) || s.code == "08S01"
        }
        Driver::Sqlite => false,
        Driver::Oracle => {
            matches!(s.native_code, Some(c) if crate::oracle::ends_connection(c))
        }
    }
}

/// Does this error, received on an established session, mean the session is over? Besides
/// [`known_codes_end_connection`]: any PostgreSQL `FATAL` / `PANIC` (the backend exits after sending it:
/// `25P03` idle_in_transaction_session_timeout, `57P04` database dropped, ...). Plain `ERROR`s such as
/// `57014` (statement_timeout), `40P01` (deadlock) and `55P03` (lock_timeout) leave the session alive.
fn server_error_ends_connection(s: &ServerError) -> bool {
    known_codes_end_connection(s)
        || (s.driver == Driver::Postgres
            && matches!(s.severity.as_deref(), Some("FATAL" | "PANIC")))
}

fn from_database_error(db: &(dyn DatabaseError + 'static), at_connect: bool) -> DbError {
    if let Some(pg) = db.try_downcast_ref::<PgDatabaseError>() {
        let position = match pg.position() {
            Some(PgErrorPosition::Original(p)) => Some(p),
            _ => None,
        };
        return server_error(
            at_connect,
            ServerError {
                driver: Driver::Postgres,
                code: pg.code().to_string(),
                native_code: None,
                severity: Some(format!("{:?}", pg.severity()).to_uppercase()),
                message: pg.message().to_string(),
                detail: pg.detail().map(str::to_string),
                hint: pg.hint().map(str::to_string),
                position,
            },
        );
    }
    if let Some(my) = db.try_downcast_ref::<MySqlDatabaseError>() {
        return server_error(
            at_connect,
            ServerError {
                driver: Driver::MySql,
                code: my.code().unwrap_or("HY000").to_string(),
                native_code: Some(my.number() as i64),
                severity: None,
                message: my.message().to_string(),
                detail: None,
                hint: None,
                position: None,
            },
        );
    }
    if let Some(lite) = db.try_downcast_ref::<SqliteError>() {
        let native: i64 = lite.code().and_then(|c| c.parse().ok()).unwrap_or(0);
        return server_error(
            at_connect,
            ServerError {
                driver: Driver::Sqlite,
                code: sqlite_name(native).map(str::to_string).unwrap_or_else(|| {
                    lite.code()
                        .map(|c| format!("SQLITE_{c}"))
                        .unwrap_or_else(|| "SQLITE_ERROR".into())
                }),
                native_code: Some(native),
                severity: None,
                message: lite.message().to_string(),
                detail: None,
                hint: None,
                position: None,
            },
        );
    }
    DbError::Connection(db.message().to_string())
}

/// A server error, or a lost connection when the server said it is hanging up. While connecting only the
/// known codes count: a FATAL refusal (bad password, too many connections) lost nothing.
fn server_error(at_connect: bool, s: ServerError) -> DbError {
    if if at_connect {
        known_codes_end_connection(&s)
    } else {
        server_error_ends_connection(&s)
    } {
        let server = match s.driver {
            Driver::Postgres => format!(
                "{}: {}",
                s.severity.as_deref().unwrap_or("FATAL"),
                s.message
            ),
            _ => s.message.clone(),
        };
        return DbError::ConnectionLost(ConnectionLost {
            driver: Some(s.driver),
            server: Some(server),
            cause: String::new(),
        });
    }
    DbError::Server(Box::new(s))
}

fn sqlite_name(code: i64) -> Option<&'static str> {
    Some(match code {
        1 => "SQLITE_ERROR",
        2 => "SQLITE_INTERNAL",
        3 => "SQLITE_PERM",
        4 => "SQLITE_ABORT",
        5 => "SQLITE_BUSY",
        6 => "SQLITE_LOCKED",
        7 => "SQLITE_NOMEM",
        8 => "SQLITE_READONLY",
        9 => "SQLITE_INTERRUPT",
        10 => "SQLITE_IOERR",
        11 => "SQLITE_CORRUPT",
        13 => "SQLITE_FULL",
        14 => "SQLITE_CANTOPEN",
        19 => "SQLITE_CONSTRAINT",
        20 => "SQLITE_MISMATCH",
        21 => "SQLITE_MISUSE",
        275 => "SQLITE_CONSTRAINT_CHECK",
        787 => "SQLITE_CONSTRAINT_FOREIGNKEY",
        1299 => "SQLITE_CONSTRAINT_NOTNULL",
        1555 => "SQLITE_CONSTRAINT_PRIMARYKEY",
        2067 => "SQLITE_CONSTRAINT_UNIQUE",
        _ => return None,
    })
}

fn sqlite_description(code: i64) -> Option<&'static str> {
    Some(match code {
        1 => "SQL error or missing database",
        5 => "The database file is locked",
        6 => "A table in the database is locked",
        8 => "Attempt to write a readonly database",
        9 => "Operation terminated by sqlite3_interrupt()",
        11 => "The database disk image is malformed",
        14 => "Unable to open the database file",
        19 => "Abort due to constraint violation",
        275 => "A CHECK constraint failed",
        787 => "A foreign key constraint failed",
        1299 => "A NOT NULL constraint failed",
        1555 => "A PRIMARY KEY constraint failed",
        2067 => "A UNIQUE constraint failed",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lost(driver: Option<Driver>, server: Option<&str>) -> DbError {
        DbError::ConnectionLost(ConnectionLost {
            driver,
            server: server.map(str::to_string),
            cause: "boom".into(),
        })
    }

    #[test]
    fn oracle_codes_that_end_the_session() {
        let e = lost(None, None).for_driver(Driver::Oracle);
        assert!(
            e.to_string()
                .starts_with("[08006] The connection to the database was lost."),
            "{e}"
        );
        let ora = |n: i64| ServerError {
            driver: Driver::Oracle,
            code: format!("ORA-{n:05}"),
            native_code: Some(n),
            severity: None,
            message: format!("ORA-{n:05}: x"),
            detail: None,
            hint: None,
            position: None,
        };
        // killed session, end-of-file on the channel, not logged on, shutdown in progress
        for n in [28, 1012, 1033, 1089, 3113, 3114, 3135, 12537, 12541] {
            assert!(known_codes_end_connection(&ora(n)), "ORA-{n:05}");
        }
        // a statement error does not end it (table missing, cancelled, unique violation, deadlock)
        for n in [942, 1013, 1, 60, 1017] {
            assert!(!known_codes_end_connection(&ora(n)), "ORA-{n:05}");
        }
    }

    #[test]
    fn connection_lost_text_and_sqlstate() {
        let e = lost(None, None).for_driver(Driver::Postgres);
        assert!(
            e.to_string()
                .starts_with("[08006] An I/O error occurred while sending to the backend."),
            "{e}"
        );
        assert!(e.to_string().contains("Cause: boom"));
        let e = lost(None, None).for_driver(Driver::MySql);
        assert!(
            e.to_string()
                .starts_with("[08S01] Communications link failure"),
            "{e}"
        );
        let e = lost(None, None).for_driver(Driver::Sqlite);
        assert!(
            e.to_string()
                .starts_with("[08006] The database connection is closed."),
            "{e}"
        );
        let e = lost(
            Some(Driver::Postgres),
            Some("FATAL: terminating connection due to administrator command"),
        );
        assert_eq!(
            e.to_string(),
            "[08006] FATAL: terminating connection due to administrator command"
        );
        // the driver sticks once known
        assert!(lost(Some(Driver::MySql), None)
            .for_driver(Driver::Postgres)
            .to_string()
            .starts_with("[08S01]"));
        assert!(e.is_connection_lost() && !DbError::Cancelled.is_connection_lost());
    }

    #[test]
    fn client_errors_that_mean_a_dead_connection() {
        let io = |kind| sqlx::Error::Io(std::io::Error::new(kind, "x"));
        for e in [
            io(std::io::ErrorKind::BrokenPipe),
            io(std::io::ErrorKind::ConnectionReset),
            io(std::io::ErrorKind::UnexpectedEof),
            sqlx::Error::PoolClosed,
            sqlx::Error::WorkerCrashed,
            sqlx::Error::Protocol("unexpected EOF".into()),
        ] {
            assert!(DbError::from(e).is_connection_lost());
        }
        for e in [
            sqlx::Error::PoolTimedOut,
            sqlx::Error::RowNotFound,
            sqlx::Error::Protocol("invalid utf8 in column".into()),
        ] {
            assert!(!DbError::from(e).is_connection_lost());
        }
    }

    fn server_sev(driver: Driver, code: &str, native: Option<i64>, severity: &str) -> ServerError {
        ServerError {
            driver,
            code: code.into(),
            native_code: native,
            severity: Some(severity.into()),
            message: "m".into(),
            detail: None,
            hint: None,
            position: None,
        }
    }

    fn server(driver: Driver, code: &str, native: Option<i64>) -> ServerError {
        server_sev(driver, code, native, "ERROR")
    }

    #[test]
    fn server_errors_that_end_the_connection() {
        for c in ["57P01", "57P02", "57P03", "08006", "08003", "08001"] {
            assert!(
                server_error_ends_connection(&server(Driver::Postgres, c, None)),
                "{c}"
            );
        }
        for c in ["57014", "42P01", "25P02", "40001"] {
            assert!(
                !server_error_ends_connection(&server(Driver::Postgres, c, None)),
                "{c}"
            );
        }
        for n in [2006, 2013, 1927, 1053, 4031] {
            assert!(
                server_error_ends_connection(&server(Driver::MySql, "HY000", Some(n))),
                "{n}"
            );
        }
        for n in [1317, 1205, 1213, 1064] {
            assert!(
                !server_error_ends_connection(&server(Driver::MySql, "HY000", Some(n))),
                "{n}"
            );
        }
        // every PG FATAL / PANIC ends the session, whatever its code; ERROR never does (except the known codes)
        for (c, sev) in [
            ("25P03", "FATAL"),
            ("57P04", "FATAL"),
            ("53300", "FATAL"),
            ("XX000", "PANIC"),
        ] {
            assert!(
                server_error_ends_connection(&server_sev(Driver::Postgres, c, None, sev)),
                "{c}"
            );
        }
        for c in ["57014", "40P01", "55P03", "25P03"] {
            assert!(
                !server_error_ends_connection(&server_sev(Driver::Postgres, c, None, "ERROR")),
                "{c} as ERROR"
            );
        }
        assert!(!server_error_ends_connection(&server_sev(
            Driver::MySql,
            "HY000",
            Some(1205),
            "FATAL"
        )));
        match server_error(false, server_sev(Driver::Postgres, "57P01", None, "FATAL")) {
            DbError::ConnectionLost(l) => assert_eq!(l.to_string(), "[08006] FATAL: m"),
            other => panic!("{other:?}"),
        }
        // while connecting a FATAL refusal is a plain server error
        assert!(matches!(
            server_error(true, server_sev(Driver::Postgres, "28P01", None, "FATAL")),
            DbError::Server(_)
        ));
        assert!(matches!(
            server_error(true, server_sev(Driver::Postgres, "53300", None, "FATAL")),
            DbError::Server(_)
        ));
    }
}
