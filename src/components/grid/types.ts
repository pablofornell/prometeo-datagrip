/**
 * Public types of the data grid. Deliberately independent from `src/api`:
 * a later integration step adapts the Tauri result types to these.
 *
 * Cell encoding mirrors `crates/dbcore/src/model.rs`:
 * JSON null = SQL NULL, decimals/bigints are strings, binary is `{ $bin, len?, truncated? }`.
 */

export type Cell = unknown;

export interface BinaryCell {
  $bin: string;
  len?: number;
  truncated?: boolean;
}

/** `{ "$default": true }` inserts SQL DEFAULT (dbcore RowChange). */
export interface DefaultCell {
  $default: true;
}

export interface GridColumn {
  name: string;
  /** Database type name, e.g. `int4`, `varchar(255)`, `timestamp`, `jsonb`. */
  typeName: string;
  nullable?: boolean;
  isPk?: boolean;
  isFk?: boolean;
  /** Part of an index (DataGrip draws the column icon with an index dot). */
  isIndexed?: boolean;
  /** Initial width in px; otherwise derived from header and the first rows. */
  width?: number;
  /** Never editable (generated columns, expressions...). */
  readOnly?: boolean;
}

export type ColumnKind =
  | "number"
  | "bool"
  | "date"
  | "time"
  | "datetime"
  | "text"
  | "json"
  | "binary"
  | "uuid"
  | "other";

export type SortDir = "asc" | "desc";

/** Sort key. `col` is the index into the `columns` prop (not the visual position). */
export interface SortSpec {
  col: number;
  dir: SortDir;
}

export type ChangeKind = "insert" | "update" | "delete";

/** `GridChange.row` of an inserted row (it has no place in the row source yet). */
export const NEW_ROW = -1;

/** Same shape as dbcore `RowChange` (column name -> value). */
export interface GridChange {
  kind: ChangeKind;
  /** Index of the row in the `getRow` source (update / delete); `NEW_ROW` (-1) for an inserted row. */
  row: number;
  /** Original values identifying the row (PK columns, or every column without a PK). Empty for inserts. */
  key: Record<string, Cell>;
  /** New values (update: only changed columns; insert: only the columns the user filled). */
  values: Record<string, Cell | DefaultCell>;
}

export type CopyFormat = "tsv" | "csv" | "json" | "sql" | "markdown";

export type ViewMode = "table" | "text";

/** Rectangular selection in display coordinates (inclusive); `c` is the visual column position. */
export interface SelRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface CellPos {
  r: number;
  c: number;
}

/** Imperative handle handed out through `apiRef`. */
export interface DataGridApi {
  /** Pending changes in dbcore shape. */
  getChanges(): GridChange[];
  hasChanges(): boolean;
  /** Revert every pending change. */
  revert(): void;
  /** Revert the changes of the selected rows/cells (Ctrl+Alt+Z). */
  revertSelected(): void;
  /** Drop pending state after the host applied the changes (the host then reloads the data). */
  clearChanges(): void;
  addRow(): void;
  cloneRow(): void;
  deleteRows(): void;
  setNull(): void;
  setDefault(): void;
  submit(): void;
  /** Text of the current selection in the requested format. */
  getSelectionText(format: CopyFormat): string;
  copy(format?: CopyFormat): void;
  selectAll(): void;
  scrollToRow(row: number): void;
  focus(): void;
  openValueEditor(): void;
  showAllColumns(): void;
  clearSort(): void;
}
