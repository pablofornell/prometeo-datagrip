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
            Driver::Sqlite => match sqlite_description(self.native_code.unwrap_or(0)) {
                Some(desc) => write!(f, "[{}] {} ({})", self.code, desc, self.message),
                None => write!(f, "[{}] {}", self.code, self.message),
            },
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("{0}")]
    Server(Box<ServerError>),
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
            sqlx::Error::Database(db) => from_database_error(db.as_ref()),
            sqlx::Error::RowNotFound => DbError::NotFound("row not found".into()),
            sqlx::Error::PoolTimedOut => {
                DbError::Connection("Timed out waiting for a free connection from the pool".into())
            }
            other => DbError::Connection(other.to_string()),
        }
    }
}

fn from_database_error(db: &(dyn DatabaseError + 'static)) -> DbError {
    if let Some(pg) = db.try_downcast_ref::<PgDatabaseError>() {
        let position = match pg.position() {
            Some(PgErrorPosition::Original(p)) => Some(p),
            _ => None,
        };
        return DbError::Server(Box::new(ServerError {
            driver: Driver::Postgres,
            code: pg.code().to_string(),
            native_code: None,
            severity: Some(format!("{:?}", pg.severity()).to_uppercase()),
            message: pg.message().to_string(),
            detail: pg.detail().map(str::to_string),
            hint: pg.hint().map(str::to_string),
            position,
        }));
    }
    if let Some(my) = db.try_downcast_ref::<MySqlDatabaseError>() {
        return DbError::Server(Box::new(ServerError {
            driver: Driver::MySql,
            code: my.code().unwrap_or("HY000").to_string(),
            native_code: Some(my.number() as i64),
            severity: None,
            message: my.message().to_string(),
            detail: None,
            hint: None,
            position: None,
        }));
    }
    if let Some(lite) = db.try_downcast_ref::<SqliteError>() {
        let native: i64 = lite.code().and_then(|c| c.parse().ok()).unwrap_or(0);
        return DbError::Server(Box::new(ServerError {
            driver: Driver::Sqlite,
            code: sqlite_name(native).map(str::to_string).unwrap_or_else(|| {
                lite.code().map(|c| format!("SQLITE_{c}")).unwrap_or_else(|| "SQLITE_ERROR".into())
            }),
            native_code: Some(native),
            severity: None,
            message: lite.message().to_string(),
            detail: None,
            hint: None,
            position: None,
        }));
    }
    DbError::Connection(db.message().to_string())
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
