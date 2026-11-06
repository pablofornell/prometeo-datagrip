import type { Dialect } from "./split";

export type { Dialect } from "./split";

/** Column of a table in the schema snapshot used for highlighting and completion. */
export interface SchemaColumn {
  name: string;
  /** Data type as the DBMS reports it, shown in gray at the right of completion rows. */
  type: string;
  /** Key participation (gold key / blue key icon in completion). */
  key?: "pk" | "fk" | "pkfk";
}

export type TableKind = "table" | "view" | "matview" | "foreign" | "sequence" | string;

export interface SchemaTable {
  name: string;
  kind: TableKind;
  columns: SchemaColumn[];
}

export interface SchemaRoutine {
  name: string;
  /** Argument list as written, `cid integer`. */
  args: string;
  /** Return type shown at the right of the completion row. */
  returns?: string;
}

export interface SchemaNode {
  name: string;
  tables: SchemaTable[];
  /** Functions / procedures of the schema (offered by completion). */
  routines?: SchemaRoutine[];
}

/** Snapshot of the introspected database: `{schemas:[{name, tables:[{name, kind, columns:[{name,type}]}]}]}`. */
export interface SchemaSnapshot {
  /** Database name, shown as `(database.schema)` after table names in completion. */
  database?: string;
  schemas: SchemaNode[];
}

/** A half-open `[from, to)` range of document offsets (UTF-16 code units). */
export interface Range {
  from: number;
  to: number;
}

/** What `onExecute` receives and `getSelectionOrStatement()` returns. */
export interface ExecuteRequest {
  /** Text to send to the backend. With several selection ranges the texts are joined with "\n". */
  sql: string;
  /** Source ranges in the document: the statement, the selection, or the whole script. */
  ranges: Range[];
  /** Why this text was picked. */
  source: "statement" | "selection" | "script";
}

/** An execution error to show in the editor. */
export interface EditorError {
  /** Document offset where the failed statement starts (`ExecEvent::Statement.range.start_utf16` + script offset). */
  statementFrom: number;
  /** Document offset where it ends. Defaults to the end of the statement at `statementFrom`. */
  statementTo?: number;
  /** 1-based character position inside the statement reported by the server (PostgreSQL `position`). */
  position?: number;
  message: string;
}

/** Result of an executed statement: gutter check / red `!` and the gray inline `994 ms` hint. */
export interface ExecMark {
  from: number;
  to: number;
  status: "ok" | "error";
  ms?: number;
}

export interface SqlEditorHandle {
  focus(): void;
  /** The selection (all non-empty ranges) or else the statement at the caret; `null` when there is none. */
  getSelectionOrStatement(): ExecuteRequest | null;
  /** The whole script as one request (for the toolbar's "execute all"). */
  getScript(): ExecuteRequest | null;
  /** Statement ranges of the current text. */
  getStatements(): Range[];
  /** Select / reveal a range (e.g. to show where an error happened). */
  revealRange(range: Range): void;
  /** Run the same code path as Ctrl+Enter. */
  execute(): void;
  /** Reformat the selection or the whole script (Ctrl+Alt+L). */
  reformat(): void;
  /** The underlying CodeMirror view (escape hatch). */
  readonly view: import("@codemirror/view").EditorView | undefined;
}

export interface SqlEditorProps {
  value: string;
  onChange?: (value: string) => void;
  dialect: Dialect;
  schema?: SchemaSnapshot;
  /** Schema used to resolve unqualified table names first (`public`, `main`, ...). */
  defaultSchema?: string;
  /** Datasource label shown in the right-hand hint of table completion rows (`postgres@localhost`). */
  sourceLabel?: string;
  readOnly?: boolean;
  errors?: EditorError[];
  execMarks?: ExecMark[];
  /** Ctrl+Enter (selection or statement). The statement chooser may be shown first. */
  onExecute?: (req: ExecuteRequest) => void;
  /** 1-based line and column of the main caret, for the status bar. */
  onCaretChange?: (line: number, col: number) => void;
  /** Shows the `Customize` link of the Statements chooser and handles its click (open execution settings). */
  onCustomizeExecution?: () => void;
  /** Ctrl+F2 and other host-level keys are not handled here; this is called for `Escape` with no popup open. */
  onEscape?: () => void;
  /** Show the right-hand error stripe and inspection widget (default true). */
  stripe?: boolean;
  /** Show the green current-statement frame (default true; off for read-only DDL views). */
  statementFrame?: boolean;
  /** Show the gutter (line numbers). Default true. */
  gutter?: boolean;
  /**
   * Single-line mode for the table editor's WHERE / ORDER BY fields: no gutter, stripe or frame,
   * newlines are stripped and Enter calls `onSubmit`.
   */
  singleLine?: boolean;
  onSubmit?: () => void;
  placeholder?: string;
  /** Table that unqualified column names resolve against (the table of the table data editor). */
  scopeTable?: { schema?: string; name: string };
  autofocus?: boolean;
  class?: string;
  /** Receives the imperative handle once the editor is mounted. */
  ref?: (handle: SqlEditorHandle) => void;
}

