//! Oracle runtime (skeleton: the bodies are being written, the API below is stable).

use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::Value;

use crate::error::{DbError, Result};
use crate::model::{Cell, ColumnMeta, DataSourceConfig};
use crate::value::DecodeOpts;

/// Query whose first column is the server banner (`Oracle Database 23ai Free Release ...`).
pub(crate) const VERSION_SQL: &str = "select banner_full from v$version fetch first 1 row only";

/// `Oracle Database 23ai Free Release 23.0.0.0.0 - Develop, Learn, and Run for Free Version 23.26.3.0.0` -> label.
pub(crate) fn version_label(banner: &str) -> String {
    banner.to_string()
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

fn todo_err<T>() -> Result<T> {
    Err(DbError::Unsupported("Oracle: not implemented yet".into()))
}

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

/// Connect options of an Oracle data source (see [`build_opts`]).
#[derive(Clone)]
pub(crate) struct OraOpts {
    pub connect_string: String,
    pub user: String,
    pub password: String,
    pub read_only: bool,
    pub connect_timeout_secs: u64,
}

pub(crate) fn build_opts(cfg: &DataSourceConfig) -> Result<OraOpts> {
    let _ = cfg;
    todo_err()
}

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
    /// DataGrip style: `NUMBER(10,2)`, `VARCHAR2(50)`, `TIMESTAMP(6) WITH TIME ZONE`.
    pub type_name: String,
    pub nullable: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct OraRow {
    pub cols: Arc<Vec<OraCol>>,
    pub vals: Vec<OraVal>,
}

/// NUMBER text -> JSON: a number when it is exactly representable (integer within 2^53, or a decimal whose f64
/// text round-trips), else a string.
pub(crate) fn number_cell(s: &str) -> Cell {
    Value::String(s.to_string())
}

/// The cells of a row (JSON contract of `model::Cell`).
pub(crate) fn row_cells(r: &OraRow, opts: DecodeOpts) -> Vec<Cell> {
    let _ = (r, opts);
    Vec::new()
}

/// Handle to interrupt whatever a connection is running (clonable, usable from any thread).
#[derive(Clone)]
pub(crate) struct OraCancel {}

impl OraCancel {
    pub(crate) fn cancel(&self) {}

    /// The connection is gone: the handle does nothing from now on.
    pub(crate) fn detach(&self) {}
}

/// A row as strings (NULL = `None`), for introspection.
pub(crate) fn row_strings(r: &OraRow) -> Vec<Option<String>> {
    let _ = r;
    Vec::new()
}

/// Dedicated Oracle session connection (owned by a worker thread; this is the handle).
pub struct OraConn {}

/// Pool of Oracle connections (introspection, table reads, edits).
#[derive(Clone)]
pub struct OraPool {}

/// A transaction on a pooled connection: statements run in order, `commit` / `rollback` end it, dropping it rolls
/// back. Oracle has no `BEGIN`: the transaction starts with the first DML statement.
pub struct OraTx {}

impl OraPool {
    pub(crate) async fn open(opts: &OraOpts, cfg: &DataSourceConfig) -> Result<OraPool> {
        let _ = (opts, cfg);
        todo_err()
    }

    pub(crate) async fn describe(&self, sql: &str) -> Vec<ColumnMeta> {
        let _ = sql;
        Vec::new()
    }

    /// Stream the items of one statement on a pooled connection.
    pub(crate) fn stream<'a>(&'a self, sql: &'a str) -> crate::exec::ItemStream<'a> {
        let _ = sql;
        futures_util::stream::once(async {
            Err(DbError::Unsupported("Oracle: not implemented yet".into()))
        })
        .boxed()
    }

    pub async fn exec(&self, sql: &str) -> Result<u64> {
        let _ = sql;
        todo_err()
    }

    pub async fn query_strings(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>> {
        let _ = sql;
        todo_err()
    }

    /// Run `sql` with positional binds (`:1`, `:2`, ...; `None` is NULL) on a pooled connection and commit.
    pub async fn exec_binds(&self, sql: &str, binds: &[OraBind]) -> Result<u64> {
        let _ = (sql, binds);
        todo_err()
    }

    pub async fn begin(&self) -> Result<OraTx> {
        todo_err()
    }

    pub async fn close(&self) {}
}

impl OraTx {
    /// Run one statement (positional binds `:1`.., `None` = NULL) in the transaction; rows affected.
    pub async fn execute(&mut self, sql: &str, binds: &[OraBind]) -> Result<u64> {
        let _ = (sql, binds);
        todo_err()
    }

    pub async fn commit(self) -> Result<()> {
        todo_err()
    }

    pub async fn rollback(self) -> Result<()> {
        todo_err()
    }
}

impl OraConn {
    pub(crate) async fn connect(opts: &OraOpts, cfg: &DataSourceConfig) -> Result<OraConn> {
        let _ = (opts, cfg);
        todo_err()
    }

    pub(crate) fn cancel_handle(&self) -> OraCancel {
        OraCancel {}
    }

    /// Columns of a statement without running it (empty when unknown).
    pub(crate) async fn describe(&mut self, sql: &str) -> Vec<ColumnMeta> {
        let _ = sql;
        Vec::new()
    }

    /// Stream the items of one statement (rows, then the rows-affected count).
    pub(crate) fn stream(&mut self, sql: &str) -> crate::exec::ItemStream<'_> {
        let _ = sql;
        futures_util::stream::once(async {
            Err(DbError::Unsupported("Oracle: not implemented yet".into()))
        })
        .boxed()
    }

    /// Run one statement (positional binds `:1`.., `None` = NULL); rows affected. Does not commit.
    pub async fn execute(&mut self, sql: &str, binds: &[OraBind]) -> Result<u64> {
        let _ = (sql, binds);
        todo_err()
    }

    pub async fn query_strings(&mut self, sql: &str) -> Result<Vec<Vec<Option<String>>>> {
        let _ = sql;
        todo_err()
    }

    pub async fn commit(&mut self) -> Result<()> {
        todo_err()
    }

    pub async fn rollback(&mut self) -> Result<()> {
        todo_err()
    }

    pub async fn close(self) {}
}
