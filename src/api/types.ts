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

export type Driver = "postgres" | "mysql" | "sqlite";

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
  /** Full connection URL; when set it replaces host/port/user/password/database. */
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
  | "sequence";

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
  /** `position` is the 1-based character offset inside the statement (PG). */
  | { kind: "error"; index: number; message: string; position: number | null }
  | { kind: "message"; index: number | null; text: string }
  | { kind: "done"; elapsedMs: number; executionMs: number; fetchingMs: number };

export type ExecEventKind = ExecEvent["kind"];

// ---------------------------------------------------------------- export

export type ExportFormat = "csv" | "tsv" | "json" | "sqlInsert" | "markdown";

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
}
