// Typed wrappers for every Tauri command of `src-tauri/src/commands.rs`.
// One function per command; argument names match the Rust parameters (camelCase).
// In a plain browser (no Tauri) every call is answered by the mock in `./mock.ts`.

import { Channel } from "@tauri-apps/api/core";
import { invoke, isTauri } from "./tauri";
import type {
  ApplyResult,
  AppInfo,
  ConnectInfo,
  DataSource,
  DataSourceConfig,
  Driver,
  ExecEvent,
  ExecOptions,
  ExportFormat,
  ExportOptions,
  FetchedRows,
  HistoryEntry,
  ObjectRef,
  ResultSet,
  RowChange,
  SnapshotObject,
  Statement,
  TableDataRequest,
  TestResult,
  TreeNode,
  TxStatus,
} from "./types";

export * from "./types";
export { isTauri } from "./tauri";

// ---------------------------------------------------------------- app

export const appInfo = (): Promise<AppInfo> => invoke("app_info");

// ---------------------------------------------------------------- data sources

export const listDataSources = (): Promise<DataSource[]> => invoke("list_data_sources");

/** Insert or update (by `id`). A data source without `id` gets a new one. Returns the saved view. */
export const saveDataSource = (ds: Partial<DataSourceConfig> & { name: string }): Promise<DataSource> =>
  invoke("save_data_source", { ds });

export const deleteDataSource = (id: string): Promise<void> => invoke("delete_data_source", { id });

export const duplicateDataSource = (id: string): Promise<DataSource> => invoke("duplicate_data_source", { id });

/** Works with an unsaved config; if `ds.id` is saved and `ds.password` is null the stored password is used. */
export const testConnection = (ds: Partial<DataSourceConfig>): Promise<TestResult> =>
  invoke("test_connection", { ds });

export const connect = (id: string): Promise<ConnectInfo> => invoke("connect", { id });

/** Closes the pool and every session of the data source. */
export const disconnect = (id: string): Promise<void> => invoke("disconnect", { id });

/** Ids of the currently connected data sources. */
export const connectedDataSources = (): Promise<string[]> => invoke("connected_data_sources");

// ---------------------------------------------------------------- sessions

/**
 * Dedicated connection (a console): transaction state and `SET` / `USE` persist.
 * `initSql`: statements run, in order, on the new connection before it is returned. The backend does not
 * remember session settings, so a reopened console (or one on a reconnected data source) re-applies its
 * `SET search_path` / `USE db` / isolation level this way. A failing statement rejects and no session is left.
 */
export const openSession = (dsId: string, initSql: string[] = []): Promise<string> =>
  invoke("open_session", { dsId, initSql });

export const closeSession = (sessionId: string): Promise<void> => invoke("close_session", { sessionId });

/** True while a transaction is open on the session (`active` or `failed`), as the server sees it. */
export const sessionInTransaction = (sessionId: string): Promise<boolean> =>
  invoke("session_in_transaction", { sessionId });

/**
 * `idle` / `active` / `failed` (see `TxStatus`). MySQL DDL ends a transaction implicitly, so this is the
 * truth, not the keywords that were typed. The same changes arrive as `txStatus` events of `execute`.
 */
export const sessionTxStatus = (sessionId: string): Promise<TxStatus> =>
  invoke("session_tx_status", { sessionId });

// ---------------------------------------------------------------- introspection

/** Lazy children of a tree path (see crates/dbcore/src/introspect.rs for the path layout). */
export const introspect = (dsId: string, path: string[], showSystem = false): Promise<TreeNode[]> =>
  invoke("introspect", { dsId, path, showSystem });

export const getDdl = (dsId: string, object: ObjectRef): Promise<string> => invoke("get_ddl", { dsId, object });

/** Flat tables/views with columns, for completion. `schema` omitted = every non-system schema. */
export const schemaSnapshot = (dsId: string, schema?: string | null): Promise<SnapshotObject[]> =>
  invoke("schema_snapshot", { dsId, schema: schema ?? null });

// ---------------------------------------------------------------- execution

/** Callbacks per event kind of an execution. `onEvent` receives every event, first. */
export interface ExecHandlers {
  onEvent?: (e: ExecEvent) => void;
  onStatement?: (e: Extract<ExecEvent, { kind: "statement" }>) => void;
  onResultSet?: (e: Extract<ExecEvent, { kind: "resultset" }>) => void;
  onUpdate?: (e: Extract<ExecEvent, { kind: "update" }>) => void;
  onError?: (e: Extract<ExecEvent, { kind: "error" }>) => void;
  onMessage?: (e: Extract<ExecEvent, { kind: "message" }>) => void;
  onTxStatus?: (e: Extract<ExecEvent, { kind: "txStatus" }>) => void;
  onTxEnded?: (e: Extract<ExecEvent, { kind: "txEnded" }>) => void;
  onDone?: (e: Extract<ExecEvent, { kind: "done" }>) => void;
}

export interface ExecHandle {
  executionId: string;
  /** Cancel the running statement on the server (also releases an open result set). */
  cancel(): Promise<void>;
  /** Release the open result set (paging stream) without cancelling a running statement. */
  close(): Promise<void>;
  /** Next rows of a still-open result (`hasMore` of the `resultset` event). */
  fetchMore(resultIndex: number, count: number): Promise<FetchedRows>;
  /** Resolves with the `done` event. Never rejects. */
  done: Promise<Extract<ExecEvent, { kind: "done" }>>;
}

/** Minimal shape of a Tauri `Channel` (also implemented by the browser mock). */
interface EventSink {
  onmessage: (e: ExecEvent) => void;
}

export const DEFAULT_EXEC_OPTIONS: ExecOptions = { maxRows: 500, stopOnError: true, keepOpenSecs: 120 };

/**
 * Run `sql` (one or more statements) on a session. Events are delivered to `handlers` in
 * order, possibly before the returned promise resolves. Rejects (with the server message)
 * if the execution could not start, e.g. the session is busy.
 */
export async function execute(
  sessionId: string,
  sql: string,
  handlers: ExecHandlers = {},
  options: Partial<ExecOptions> = {},
): Promise<ExecHandle> {
  let resolveDone!: (e: Extract<ExecEvent, { kind: "done" }>) => void;
  const done = new Promise<Extract<ExecEvent, { kind: "done" }>>((r) => (resolveDone = r));

  const dispatch = (e: ExecEvent) => {
    try {
      handlers.onEvent?.(e);
      switch (e.kind) {
        case "statement": handlers.onStatement?.(e); break;
        case "resultset": handlers.onResultSet?.(e); break;
        case "update": handlers.onUpdate?.(e); break;
        case "error": handlers.onError?.(e); break;
        case "message": handlers.onMessage?.(e); break;
        case "txStatus": handlers.onTxStatus?.(e); break;
        case "txEnded": handlers.onTxEnded?.(e); break;
        case "done": handlers.onDone?.(e); break;
      }
    } finally {
      if (e.kind === "done") resolveDone(e);
    }
  };

  const sink: EventSink = isTauri() ? new Channel<ExecEvent>() : { onmessage: () => {} };
  sink.onmessage = dispatch;

  const executionId = await invoke<string>("execute", {
    sessionId,
    sql,
    options: { ...DEFAULT_EXEC_OPTIONS, ...options },
    onEvent: sink,
  });
  return {
    executionId,
    done,
    cancel: () => cancelExecution(executionId),
    close: () => closeExecution(executionId),
    fetchMore: (resultIndex, count) => fetchMore(executionId, resultIndex, count),
  };
}

/** Run a script and collect every event until `done`. */
export async function executeCollect(
  sessionId: string,
  sql: string,
  options: Partial<ExecOptions> = {},
): Promise<ExecEvent[]> {
  const events: ExecEvent[] = [];
  const h = await execute(sessionId, sql, { onEvent: (e) => events.push(e) }, options);
  await h.done;
  return events;
}

export const fetchMore = (executionId: string, resultIndex: number, count: number): Promise<FetchedRows> =>
  invoke("fetch_more", { executionId, resultIndex, count });

/** No-op if the execution already finished. */
export const cancelExecution = (executionId: string): Promise<void> => invoke("cancel", { executionId });

export const closeExecution = (executionId: string): Promise<void> => invoke("close_execution", { executionId });

// ---------------------------------------------------------------- table data / editing

export const tableData = (dsId: string, table: ObjectRef, request: TableDataRequest = {}): Promise<ResultSet> =>
  invoke("table_data", { dsId, table, request });

/**
 * Apply edits in ONE transaction. Resolves even when the transaction was rolled back:
 * check `committed` and `results[i].error` (the server's message of the failing change).
 */
export const applyChanges = (dsId: string, table: ObjectRef, changes: RowChange[]): Promise<ApplyResult> =>
  invoke("apply_changes", { dsId, table, changes });

// ---------------------------------------------------------------- export

export const defaultExportOptions = (driver: Driver = "postgres"): ExportOptions => ({
  format: "csv",
  header: true,
  nullText: "",
  delimiter: null,
  quote: '"',
  tableName: null,
  dialect: driver,
  rowsPerInsert: 1,
});

/**
 * Open the native Save dialog FROM THE BACKEND and resolve with the chosen path (`null` = cancelled).
 * Only a path returned by this function is accepted by `exportQuery` / `exportResult` (once, within five
 * minutes); any other path is refused, so the webview cannot make the backend write to an arbitrary file.
 * Do NOT use the dialog plugin's `save()` for exports any more. `suggestedName` is a file name only.
 */
export const chooseExportPath = (suggestedName?: string, format?: ExportFormat): Promise<string | null> =>
  invoke("choose_export_path", { suggestedName: suggestedName ?? null, format: format ?? null });

/** `chooseExportPath` + `exportQuery`. Resolves `null` when the user cancels the dialog. */
export async function exportQueryToFile(
  dsId: string,
  sql: string,
  options: ExportOptions,
  suggestedName?: string,
): Promise<{ path: string; rows: number } | null> {
  const path = await chooseExportPath(suggestedName, options.format);
  return path === null ? null : { path, rows: await exportQuery(dsId, sql, options, path) };
}

/** `chooseExportPath` + `exportResult`. Resolves `null` when the user cancels the dialog. */
export async function exportResultToFile(
  result: Pick<ResultSet, "columns" | "rows">,
  options: ExportOptions,
  suggestedName?: string,
): Promise<{ path: string; rows: number } | null> {
  const path = await chooseExportPath(suggestedName, options.format);
  return path === null ? null : { path, rows: await exportResult(result, options, path) };
}

/**
 * Run `sql` and stream EVERY row to `path`. Returns the row count. `path` MUST come from `chooseExportPath`
 * (the backend refuses any other path); prefer `exportQueryToFile`.
 */
export const exportQuery = (dsId: string, sql: string, options: ExportOptions, path: string): Promise<number> =>
  invoke("export_query", { dsId, sql, options, path });

/** Same as `exportQuery` but returns the text (for the clipboard). */
export const exportQueryToString = (dsId: string, sql: string, options: ExportOptions): Promise<string> =>
  invoke("export_query_to_string", { dsId, sql, options });

/**
 * Write an in-memory result set (what the grid shows) to `path`. Returns the row count. `path` MUST come
 * from `chooseExportPath` (the backend refuses any other path); prefer `exportResultToFile`.
 */
export const exportResult = (result: Pick<ResultSet, "columns" | "rows">, options: ExportOptions, path: string): Promise<number> =>
  invoke("export_result", { result: { hasMore: false, totalHint: null, ...result }, options, path });

/** Format an in-memory result set as text (for the clipboard). */
export const exportToString = (result: Pick<ResultSet, "columns" | "rows">, options: ExportOptions): Promise<string> =>
  invoke("export_to_string", { result: { hasMore: false, totalHint: null, ...result }, options });

// ---------------------------------------------------------------- SQL splitter (same as the backend)

export const splitStatements = (sql: string, driver: Driver): Promise<Statement[]> =>
  invoke("split_statements", { sql, driver });

/** Statement under the caret (`caretUtf16` = CodeMirror offset), or null for empty text. */
export const statementAt = (sql: string, caretUtf16: number, driver: Driver): Promise<Statement | null> =>
  invoke("statement_at", { sql, caretUtf16, driver });

// ---------------------------------------------------------------- history

/** Newest first. History entries are added automatically by `execute`. */
export const historyList = (dsId: string | null = null, offset = 0, limit = 200): Promise<HistoryEntry[]> =>
  invoke("history_list", { dsId, offset, limit });

/** Case-insensitive substring search in the SQL text, newest first. */
export const historySearch = (text: string, dsId: string | null = null, limit = 200): Promise<HistoryEntry[]> =>
  invoke("history_search", { text, dsId, limit });

export const historyClear = (): Promise<void> => invoke("history_clear");

// ---------------------------------------------------------------- UI state (layout, open consoles, ...)

/** `null` when the key was never set. Values are any JSON. */
export const getUiState = <T = unknown>(key: string): Promise<T | null> => invoke("get_ui_state", { key });

/** Debounced write (~400 ms) to ui-state.json; flushed on exit. */
export const setUiState = (key: string, value: unknown): Promise<void> => invoke("set_ui_state", { key, value });

/** Force the pending ui-state write now. */
export const flushUiState = (): Promise<void> => invoke("flush_ui_state");

// ---------------------------------------------------------------- consoles (per data source .sql files)

/** Names without extension, "console" first, then "console_1", "console_2", ... */
export const listConsoles = (dsId: string): Promise<string[]> => invoke("list_consoles", { dsId });

export const readConsole = (dsId: string, name: string): Promise<string> => invoke("read_console", { dsId, name });

export const writeConsole = (dsId: string, name: string, text: string): Promise<void> =>
  invoke("write_console", { dsId, name, text });

/** Creates an empty console file: "console", then "console_1", "console_2", ... Returns the name. */
export const createConsole = (dsId: string): Promise<string> => invoke("create_console", { dsId });

export const deleteConsole = (dsId: string, name: string): Promise<void> => invoke("delete_console", { dsId, name });

export const renameConsole = (dsId: string, from: string, to: string): Promise<void> =>
  invoke("rename_console", { dsId, from, to });
