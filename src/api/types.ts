// Types mirroring the Rust structs of `crates/dbcore` (src/model.rs, split.rs, history.rs,
// export.rs, manager.rs) and `src-tauri` (store.rs, commands.rs). All JSON is camelCase.
// Keep in sync by hand: when a Rust struct changes, change it here.

// ---------------------------------------------------------------- values

/**
 * A single value of a result grid. `null` is SQL NULL.
 *  - integers fit in a JSON number when |v| <= 2^53, otherwise they are strings;
 *  - numeric/decimal/money are always strings;
 *  - floats are numbers (NaN/Infinity are strings);
 *  - binary values are `{ $bin: "<hex preview>", len: <total bytes>, truncated?: true }`;
 *  - PG arrays are JSON arrays; everything else is the server's text rendering.
 */
export type Cell = null | boolean | number | string | Cell[] | { [key: string]: Cell };

export interface BinaryCell {
  $bin: string;
  len: number;
  truncated?: boolean;
}

// ---------------------------------------------------------------- data sources

export type Driver = "postgres" | "mysql" | "sqlite" | "oracle";

/** Where the password of a data source is stored. */
export type PasswordStorage = "keyring" | "file";

/** dbcore `DataSourceConfig`. */
export interface DataSourceConfig {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  database: string;
  user: string;
  /**
   * Input only (`save_data_source`, `test_connection`): `null`/absent keeps the stored
   * password, `""` clears it, any other string replaces it. Never returned by the backend.
   */
  password?: string | null;
  /** SQLite database file path. */
  file: string;
  /**
   * Full connection URL; when set it replaces host/port/user/database. A password typed into it
   * (`user:pass@` or `?password=`) is moved to the keyring on save: the backend returns the URL without
   * it (`hasPassword: true`) and sends the password field when connecting.
   */
  urlOverride: string | null;
  /** Driver specific options: `sslmode`, `application_name`, `connectTimeout` (seconds), ... */
  options: Record<string, string>;
  color: string | null;
  readOnly: boolean;
}

/** What the backend returns for a data source (no password). */
export interface DataSource extends Omit<DataSourceConfig, "password"> {
  hasPassword: boolean;
  passwordStorage: PasswordStorage;
}

export interface TestResult {
  ok: boolean;
  serverVersion: string | null;
  message: string;
  elapsedMs: number;
  /** Whether the test session was encrypted (negotiated); null when unknown (SQLite). */
  ssl?: boolean | null;
}

export interface ConnectInfo {
  serverVersion: string;
}

// ---------------------------------------------------------------- introspection

export type NodeKind =
  | "dataSource"
  | "database"
  | "schema"
  | "folder"
  | "table"
  | "view"
  | "materializedView"
  | "package"
  | "synonym"
  | "column"
  | "primaryKey"
  | "foreignKey"
  | "index"
  | "uniqueKey"
  | "check"
  | "trigger"
  | "routine"
  | "function"
  | "procedure"
  | "sequence"
  | "role"
  | "tablespace"
  | "extension"
  | "user";

export interface TreeNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Grey text next to the name: column type, folder count, comment, ... */
  hint: string | null;
  /** Path to pass back to `introspect` to load this node's children. */
  path: string[];
  hasChildren: boolean;
  /** Extra attributes (`schema`, `table`, `dataType`, `nullable`, `isPk`, `signature`, ...). */
  extra: Record<string, any>;
}

/** Reference to a database object (DDL, table data, editing). */
export interface ObjectRef {
  /** PG schema, MySQL database or SQLite schema (`main`). */
  schema?: string | null;
  name: string;
  kind: NodeKind;
  /** Parent table for columns, indexes, constraints and triggers. */
  table?: string | null;
  /** Identity arguments for (overloaded) PG routines, e.g. `integer, text`. */
  signature?: string | null;
}

export interface SnapshotColumn {
  name: string;
  typeName: string;
  isPk: boolean;
}

export interface SnapshotObject {
  schema: string;
  name: string;
  kind: NodeKind;
  columns: SnapshotColumn[];
}

// ---------------------------------------------------------------- result sets

export interface ColumnMeta {
  name: string;
  typeName: string;
  nullable: boolean;
  isPk: boolean;
  /** `schema.table` when the column is known to come from a single table. */
  tableRef: string | null;
}

export interface ResultSet {
  columns: ColumnMeta[];
  rows: Cell[][];
  hasMore: boolean;
  /** Exact total row count when it was requested (table data). */
  totalHint: number | null;
  /**
   * Hidden physical row locators parallel to `rows`, only set by `table_data` for tables
   * WITHOUT a primary key (PG ctid, SQLite rowid). Pass the one of the edited row back as
   * `RowChange.rowLocator`. Not a column.
   */
  rowLocators?: Cell[];
}

export interface FetchedRows {
  rows: Cell[][];
  hasMore: boolean;
}

// ---------------------------------------------------------------- table editing

export type ChangeKind = "update" | "insert" | "delete";

/**
 * One edited row.
 *  - `key`: column -> original value identifying the row (PK columns, or every column's original
 *    value when the table has no PK). Ignored for inserts.
 *  - `values`: column -> new value (update/insert). `{ $default: true }` inserts DEFAULT.
 *    Binary values may be sent as `{ $bin: "<hex>" }`.
 */
export interface RowChange {
  kind: ChangeKind;
  key?: Record<string, Cell>;
  values?: Record<string, Cell>;
  /** `ResultSet.rowLocators[i]` of the edited row (tables without PK); then `key` is ignored. */
  rowLocator?: Cell;
}

export interface ChangeResult {
  index: number;
  rowsAffected: number;
  error: string | null;
}

export interface ApplyResult {
  /** Number of changes that were committed (0 when the transaction was rolled back). */
  applied: number;
  committed: boolean;
  results: ChangeResult[];
}

export interface TableDataRequest {
  /** Raw SQL boolean expression (without the WHERE keyword). */
  whereClause?: string | null;
  /** Raw ORDER BY list (without the keywords), e.g. `"name ASC, id DESC"`. */
  orderBy?: string | null;
  offset?: number;
  /** 0 means 500. */
  limit?: number;
  /** Run `select count(*)` and fill `totalHint`. */
  countTotal?: boolean;
}

// ---------------------------------------------------------------- execution

export interface ExecOptions {
  /** Rows sent with the first `resultset` event (default 500). */
  maxRows: number;
  /** Stop the script at the first failing statement (default true). */
  stopOnError: boolean;
  /**
   * Seconds a pageable result stays open without `fetch_more` before the backend closes it
   * (default 120, 0 = never). Later `fetch_more` fails with "result set is closed".
   */
  keepOpenSecs: number;
  /**
   * Oracle only (it has no server-side autocommit): commit after every statement that succeeded. The console sends it in
   * Auto transaction mode; absent / false = the transaction stays open until COMMIT.
   */
  autoCommit?: boolean;
}

/** Range of an executed statement in the editor text (byte / char / UTF-16 offsets). */
export interface StatementRange {
  start: number;
  end: number;
  startChar: number;
  endChar: number;
  /** What CodeMirror / JavaScript use. */
  startUtf16: number;
  endUtf16: number;
}

/** Output of the backend statement splitter (`split_statements` / `statement_at`). */
export interface Statement extends StatementRange {
  index: number;
  /** Statement text without the trailing delimiter and surrounding whitespace. */
  text: string;
}

/** Events streamed through the `Channel` of `execute`. The last event is always `done`. */
export type ExecEvent =
  /** A statement is about to run (use `range` to highlight it in the editor). */
  | { kind: "statement"; index: number; sql: string; range: StatementRange }
  | { kind: "resultset"; index: number; columns: ColumnMeta[]; rows: Cell[][]; hasMore: boolean }
  | { kind: "update"; index: number; rowsAffected: number }
  /**
   * `position`: 1-based offset inside the statement in Unicode CODE POINTS (PG reports it that way).
   * `positionUtf16`: the same place as a 1-based offset in UTF-16 code units (what JS strings and
   * CodeMirror count; computed against the statement text that was sent). They differ after any emoji:
   * use `positionUtf16` for the underline. Both `null` when the server gives no position (MySQL, SQLite).
   *
   * `connectionLost: true` when the statement failed because the connection is gone (socket closed / reset,
   * the server terminated the backend or shut down, pool closed). The message then starts with the SQLSTATE in
   * brackets, `[08006] ` for PostgreSQL and SQLite, `[08S01] ` for MySQL, e.g.
   * `[08006] An I/O error occurred while sending to the backend.` The session is dead from then on (see
   * `SessionState`): the script stops, a `txEnded` with tag "CONNECTION LOST" follows if a transaction was
   * open, and every later call on the session returns the same error until it is closed - except when no
   * transaction was open, then the next `execute` opens a new connection (a `message` event says so).
   * `false` for every other error.
   */
  | {
      kind: "error";
      index: number;
      message: string;
      position: number | null;
      positionUtf16: number | null;
      connectionLost: boolean;
    }
  | { kind: "message"; index: number | null; text: string }
  /** The session's transaction state changed (sent right after the statement that changed it, before `done`). */
  | { kind: "txStatus"; status: TxStatus }
  /**
   * A COMMIT / ROLLBACK (or a MySQL implicit commit) ended a transaction. `committed: false` with tag
   * "ROLLBACK" after a COMMIT means PostgreSQL rolled back a failed transaction without an error:
   * warn the user that nothing was saved. `tag` is "COMMIT", "ROLLBACK", "IMPLICIT COMMIT",
   * "PREPARE TRANSACTION" (PostgreSQL: the transaction was detached, not committed) or "CONNECTION LOST"
   * (`committed: false`: the connection died with the transaction open; the server rolled it back).
   */
  | { kind: "txEnded"; index: number; committed: boolean; tag: string }
  | { kind: "done"; elapsedMs: number; executionMs: number; fetchingMs: number };

export type ExecEventKind = ExecEvent["kind"];

/**
 * Transaction state of a session as the server sees it: `idle` (autocommit), `active`, or `failed`
 * (PostgreSQL: aborted by an error; everything but ROLLBACK / ROLLBACK TO is refused and COMMIT rolls back).
 */
export type TxStatus = "idle" | "active" | "failed";

/**
 * `sessionState` result. `txStatus` / `inTransaction` are what `sessionTxStatus` / `sessionInTransaction`
 * return; a session whose connection died is `idle` there (the server rolled the transaction back).
 */
export interface SessionState {
  txStatus: TxStatus;
  /** `txStatus` is `active` or `failed`. */
  inTransaction: boolean;
  /** The connection died and was not re-established yet (calls fail with `[08006]` / `[08S01]`, `connectionLost: true`). */
  connectionLost: boolean;
  /**
   * The connection died while a transaction was open: its work is gone and the session never reconnects on
   * its own. `closeSession` it and `openSession` a new one. When `connectionLost` but not `transactionLost`,
   * the next `execute` reopens the connection (session settings such as `search_path` / `USE db` are reset).
   */
  transactionLost: boolean;
}

// ---------------------------------------------------------------- export

export type ExportFormat =
  | "csv"
  | "tsv"
  | "json"
  | "sqlInsert"
  | "markdown"
  | "csvPipe"
  | "csvSemicolon"
  | "jsonLines"
  | "sqlUpdate"
  | "whereClause"
  | "html"
  | "xml"
  | "pretty";

export interface ExportOptions {
  format: ExportFormat;
  header: boolean;
  /** Text written for SQL NULL in CSV / TSV / Markdown. */
  nullText: string;
  /** CSV field delimiter (default `,`). */
  delimiter: string | null;
  /** CSV quote character (default `"`). */
  quote: string;
  /** Target table for SQL INSERT (`schema.table`, parts are quoted). */
  tableName: string | null;
  /** SQL dialect for quoting and literals in SQL INSERT. */
  dialect: Driver;
  /** Rows per INSERT statement (multi-row VALUES when > 1). */
  rowsPerInsert: number;
  /** One output row per column (first cell the column name), one output column per result row. */
  transpose?: boolean;
  /** First column with the row number (CSV / TSV / Markdown only). */
  rowHeader?: boolean;
}

// ---------------------------------------------------------------- explain

export interface PlanProp {
  name: string;
  value: string;
}

/** One row of a query plan: the columns of the `Query Plan` tab and its `Property | Value` pane. */
export interface PlanNode {
  operation: string;
  /** `table: orders; index: orders_pkey;` */
  params: string;
  rows: number | null;
  totalCost: number | null;
  startupCost: number | null;
  /** `Parallel Aware = false;Async Capable = false;...` */
  raw: string;
  props: PlanProp[];
  children: PlanNode[];
}

export interface ExplainPlan {
  driver: Driver;
  analyze: boolean;
  /** The statement that was explained. */
  sql: string;
  /** `Select` (or the statement kind); its child is the top of the plan. */
  root: PlanNode;
  elapsedMs: number;
}

// ---------------------------------------------------------------- history

export interface HistoryEntry {
  id: string;
  /** Unix time in milliseconds. */
  tsMs: number;
  dataSourceId: string;
  sql: string;
  durationMs: number | null;
  ok: boolean;
  error: string | null;
  rows: number | null;
}

// ---------------------------------------------------------------- app

export interface AppInfo {
  name: string;
  version: string;
  /** Directory of data-sources.json / ui-state.json (`null` in the browser mock). */
  configDir: string | null;
  /** Directory of consoles/ and history.jsonl (`null` in the browser mock). */
  dataDir: string | null;
  /** Where new passwords are stored: the OS keyring when reachable, otherwise the JSON file. */
  passwordStorage: PasswordStorage;
  /**
   * Config files that were corrupt at startup: the backend set them aside and started with an empty
   * one. Show each once (a notice). Absent / empty in the normal case.
   */
  startupWarnings?: StartupNotice[];
}

export interface StartupNotice {
  /** `data-sources.json` or `ui-state.json`. */
  file: string;
  /** Ready to show; says where the damaged file went. */
  message: string;
  /** Full path of `<file>.corrupt-<unix seconds>`, when the backup could be made. */
  backup: string | null;
}

// ---------------------------------------------------------------- import (crates/dbcore/src/import.rs)

export type InferredType = "boolean" | "integer" | "bigint" | "double" | "date" | "timestamp" | "text";

/** How a delimited file is read. */
export interface ImportFormat {
  /** `UTF-8` (default) or `ISO-8859-1`. */
  encoding: string;
  delimiter: string;
  /** Quote character; empty = never quoted. */
  quote: string;
  /** The first record holds the column names. */
  header: boolean;
  /** The first column holds row labels and is dropped. */
  firstColumnHeader: boolean;
  trim: boolean;
  /** An unquoted value equal to this text is NULL (empty: empty cells are NULL). */
  nullText: string;
}

/** The file picked in the native open dialog. */
export interface ImportSource {
  path: string;
  name: string;
  size: number;
  /** Where the failing rows are written unless the user picks another file. */
  defaultErrorFile: string;
}

export interface ImportPreview {
  columns: { name: string; inferredType: InferredType }[];
  /** The first rows (`null` = NULL). */
  rows: (string | null)[][];
  /** Rows the types were inferred from. */
  sampled: number;
  truncated: boolean;
  fileSize: number;
}

export interface ImportColumnMap {
  /** Column of the target table. */
  name: string;
  /** Index of the file column; `null` leaves the column to its default. */
  source: number | null;
  /** Type of the column (the one to create, or the existing one). */
  type: string;
}

export interface ImportOptions {
  insertInconvertibleAsNull: boolean;
  abortOnError: boolean;
  errorFile: string | null;
  batchSize?: number;
}

export interface ImportRequest {
  path: string;
  format: ImportFormat;
  schema: string | null;
  table: string;
  createTable: boolean;
  columns: ImportColumnMap[];
  options: ImportOptions;
}

export interface ImportRowError {
  /** Record number in the file (the first line is 1; the header counts). */
  row: number;
  message: string;
}

export interface ImportProgress {
  rows: number;
  failed: number;
  /** Share of the file read, 0..1. */
  fraction: number;
}

export interface ImportResult {
  imported: number;
  failed: number;
  /** The first failing rows (the error file has all of them). */
  errors: ImportRowError[];
  errorFile: string | null;
  errorFileError: string | null;
  cancelled: boolean;
  /** Nothing was kept: cancelled, or an error with `abortOnError`. */
  rolledBack: boolean;
  createdTable: boolean;
  elapsedMs: number;
}
