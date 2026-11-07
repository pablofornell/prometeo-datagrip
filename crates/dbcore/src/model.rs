//! Serde types shared with the UI. All JSON is camelCase.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A single value in a result grid. `null` is SQL NULL.
///
/// * integers fit in a JSON number when `|v| <= 2^53`, otherwise they are sent as strings;
/// * `numeric`/`decimal`/`money` are always strings (no precision loss);
/// * floats are numbers (`NaN`/`Infinity` are strings);
/// * binary values are `{ "$bin": "<hex preview>", "len": <total bytes> }` (+ `"truncated": true`);
/// * PG arrays are JSON arrays; everything else is the server's text rendering.
pub type Cell = serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    #[default]
    Postgres,
    #[serde(rename = "mysql")]
    MySql,
    Sqlite,
    Oracle,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DataSourceConfig {
    pub id: String,
    pub name: String,
    pub driver: Driver,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: Option<String>,
    /// SQLite database file path.
    pub file: String,
    /// Full connection URL; when set it replaces host/port/user/database. A non-null `password` still
    /// overrides the password inside the URL (the app stores the password separately, never in the URL).
    pub url_override: Option<String>,
    /// Driver specific options: `sslmode`, `application_name`, `connectTimeout` (seconds), ...
    pub options: BTreeMap<String, String>,
    pub color: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    DataSource,
    Database,
    Schema,
    Folder,
    Table,
    View,
    MaterializedView,
    /// Oracle package.
    Package,
    /// Oracle synonym.
    Synonym,
    Column,
    PrimaryKey,
    ForeignKey,
    Index,
    UniqueKey,
    Check,
    Trigger,
    Routine,
    Function,
    Procedure,
    Sequence,
    /// PostgreSQL role (under `Server Objects`).
    Role,
    Tablespace,
    /// PostgreSQL extension (under `Database Objects`).
    Extension,
    /// MySQL account (under `Server Objects`).
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    /// Grey text next to the name: column type, folder count, comment, ...
    pub hint: Option<String>,
    /// Path to pass back to `introspect` to load this node's children.
    pub path: Vec<String>,
    pub has_children: bool,
    /// Extra attributes (`schema`, `table`, `dataType`, `nullable`, `isPk`, `signature`, ...).
    pub extra: serde_json::Value,
}

/// Reference to a database object, used by DDL / table data / editing.
///
/// `schema` is the PG schema, the MySQL database, or the SQLite schema (`main`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
    pub kind: NodeKind,
    /// Parent table for columns, indexes, constraints and triggers.
    #[serde(default)]
    pub table: Option<String>,
    /// Identity arguments for (overloaded) PG routines, e.g. `integer, text`.
    #[serde(default)]
    pub signature: Option<String>,
}

impl ObjectRef {
    pub fn table(schema: Option<&str>, name: &str) -> Self {
        ObjectRef {
            schema: schema.map(str::to_string),
            name: name.to_string(),
            kind: NodeKind::Table,
            table: None,
            signature: None,
        }
    }

    /// Build a reference from a tree node produced by `introspect`.
    pub fn from_node(node: &TreeNode) -> ObjectRef {
        let s = |k: &str| {
            node.extra
                .get(k)
                .and_then(|v| v.as_str())
                .map(str::to_string)
        };
        ObjectRef {
            schema: s("schema"),
            name: node.name.clone(),
            kind: node.kind,
            table: s("table"),
            signature: s("signature"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub is_pk: bool,
    /// `schema.table` when the column is known to come from a single table.
    pub table_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Cell>>,
    pub has_more: bool,
    /// Exact total row count when it was requested (table data).
    pub total_hint: Option<i64>,
    /// Hidden physical row locators, parallel to `rows` (same length), only set by
    /// `table_data` for tables **without a primary key** (PG `ctid`, SQLite `rowid`). The
    /// grid keeps one per row and passes it back as `RowChange.row_locator` when editing or
    /// deleting that row. It is not a column: `columns` / `rows` do not contain it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_locators: Option<Vec<Cell>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub server_version: Option<String>,
    pub message: String,
    pub elapsed_ms: u64,
    /// Whether the test session was encrypted (as negotiated); `None` when the server does not tell (SQLite).
    #[serde(default)]
    pub ssl: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub server_version: String,
}

// ---------- table editing ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Update,
    Insert,
    Delete,
}

/// One edited row.
///
/// * `key`: column -> original value identifying the row (PK columns, or every column's
///   original value when the table has no PK). Ignored for inserts.
/// * `values`: column -> new value (update/insert). A value of `{"$default": true}` inserts
///   `DEFAULT`. Binary values may be sent as `{"$bin": "<hex>"}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowChange {
    pub kind: ChangeKind,
    #[serde(default)]
    pub key: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub values: BTreeMap<String, serde_json::Value>,
    /// The `ResultSet.row_locators[i]` of the edited row (update / delete of a table without
    /// a primary key). When present it identifies the row exactly and `key` is ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_locator: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeResult {
    pub index: usize,
    pub rows_affected: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    /// Number of changes that were committed (0 when the transaction was rolled back).
    pub applied: usize,
    pub committed: bool,
    pub results: Vec<ChangeResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TableDataRequest {
    /// Raw SQL boolean expression (without the `WHERE` keyword).
    pub where_clause: Option<String>,
    /// Raw `ORDER BY` list (without the keywords), e.g. `"name ASC, id DESC"`.
    pub order_by: Option<String>,
    pub offset: u64,
    pub limit: u64,
    /// Run `SELECT count(*)` and fill `total_hint`.
    pub count_total: bool,
}

// ---------- execution ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOptions {
    pub max_rows: usize,
    pub stop_on_error: bool,
    /// Seconds a pageable result stays open without a `fetch_more` before it is closed
    /// (the server query is cancelled outside explicit transactions, so it does not hold
    /// locks forever). `0` disables the timeout. Later `fetch_more` calls fail with
    /// "result set is closed".
    #[serde(default = "default_keep_open_secs")]
    pub keep_open_secs: u64,
    /// Oracle only (the server has no autocommit): commit after every statement that succeeded, like
    /// the console's Auto transaction mode. `false` (the default) keeps the transaction open (Manual mode).
    #[serde(default)]
    pub auto_commit: bool,
}

fn default_keep_open_secs() -> u64 {
    120
}

impl Default for ExecOptions {
    fn default() -> Self {
        ExecOptions {
            max_rows: 500,
            stop_on_error: true,
            keep_open_secs: default_keep_open_secs(),
            auto_commit: false,
        }
    }
}

/// Range of an executed statement in the editor text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatementRange {
    pub start: usize,
    pub end: usize,
    pub start_char: usize,
    pub end_char: usize,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

/// Transaction state of a session, as the server sees it (see `tx.rs` for how it is determined).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TxStatus {
    /// No open transaction (autocommit).
    #[default]
    Idle,
    /// Inside a transaction.
    Active,
    /// Inside a transaction that the server aborted (PostgreSQL `25P02`): everything but
    /// `ROLLBACK` / `ROLLBACK TO SAVEPOINT` is refused, and `COMMIT` rolls back.
    Failed,
}

impl TxStatus {
    /// Is there an open transaction (`Active` or `Failed`)?
    pub fn is_open(self) -> bool {
        self != TxStatus::Idle
    }
}

/// Everything the UI needs to know about a session's transaction / connection (`session_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// Same value as `session_tx_status`. `idle` when the connection is lost (a lost connection has no
    /// transaction any more: the server rolled it back).
    pub tx_status: TxStatus,
    /// Same value as `session_in_transaction` (`tx_status` is `active` or `failed`).
    pub in_transaction: bool,
    /// The connection died and was not re-established yet. Calls fail with `[08006]` / `[08S01]`
    /// (`transaction_lost`), or the next `execute` reopens the connection (not `transaction_lost`).
    pub connection_lost: bool,
    /// The connection died while a transaction was open: its work is gone, and the session refuses to
    /// reconnect on its own. Close it (`close_session`) and open a new one.
    pub transaction_lost: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecEvent {
    /// A statement is about to run (use `range` to highlight it in the editor).
    Statement {
        index: usize,
        sql: String,
        range: StatementRange,
    },
    #[serde(rename = "resultset")]
    ResultSet {
        index: usize,
        columns: Vec<ColumnMeta>,
        rows: Vec<Vec<Cell>>,
        has_more: bool,
    },
    Update {
        index: usize,
        rows_affected: u64,
    },
    /// `position` is the 1-based offset inside the statement **in Unicode code points** (PG reports
    /// it that way); `position_utf16` is the same place as a 1-based offset in UTF-16 code units
    /// (what JS strings / CodeMirror count), computed against the statement text that was sent.
    /// They differ after any character outside the BMP (emoji). Use `position_utf16` in the editor.
    ///
    /// `connection_lost` is true when the statement failed because the connection is gone (message starts
    /// with `[08006]`, or `[08S01]` on MySQL); the session is then dead, see `ConnectionManager::session_state`.
    Error {
        index: usize,
        message: String,
        position: Option<usize>,
        position_utf16: Option<usize>,
        connection_lost: bool,
    },
    Message {
        index: Option<usize>,
        text: String,
    },
    /// The transaction state of the session changed (sent right after the statement that changed
    /// it, before `Done`). Also see `ConnectionManager::session_tx_status`.
    TxStatus {
        status: TxStatus,
    },
    /// A `COMMIT` / `ROLLBACK` / `END` / `ABORT` statement finished, or MySQL committed implicitly.
    /// `committed == false` for a `COMMIT` of a failed PostgreSQL transaction: the server rolled
    /// it back (command tag `ROLLBACK`) without reporting an error. `tag` is the command tag:
    /// `COMMIT`, `ROLLBACK` or `IMPLICIT COMMIT` (MySQL DDL & co. ended the transaction), or
    /// `CONNECTION LOST` (`committed == false`: the connection died with the transaction open, so the
    /// server rolled it back).
    TxEnded {
        index: usize,
        committed: bool,
        tag: String,
    },
    Done {
        elapsed_ms: u64,
        execution_ms: u64,
        fetching_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedRows {
    pub rows: Vec<Vec<Cell>>,
    pub has_more: bool,
}

// ---------- schema snapshot / search ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotColumn {
    pub name: String,
    pub type_name: String,
    pub is_pk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotObject {
    pub schema: String,
    pub name: String,
    pub kind: NodeKind,
    pub columns: Vec<SnapshotColumn>,
}
