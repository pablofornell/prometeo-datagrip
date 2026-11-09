import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import type { AppInfo, DumpOptions, DumpProgress, DumpResult, ExportOptions, ExportProgress, ExportReport, ResultSet, ScriptOptions, ScriptProgress, ScriptSummary } from "./types";

export type { AppInfo } from "./types";

/** True when running inside the Tauri webview (false in a plain browser). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Browser-only mock handlers, keyed by command name. */
export type MockHandler = (args?: Record<string, unknown>) => unknown | Promise<unknown>;

/** Handlers registered at runtime; they win over the built-in mock in `./mock.ts`. */
const mocks: Record<string, MockHandler> = {};

let builtin: Promise<Record<string, MockHandler>> | undefined;
/** The built-in mock (fake "shop@localhost" data source, ...) is only loaded outside Tauri. */
const loadBuiltin = () => (builtin ??= import("./mock").then((m) => m.mockHandlers));

/** Register or override a mock handler used when running outside Tauri. */
export function registerMock(cmd: string, handler: MockHandler): void {
  mocks[cmd] = handler;
}

/**
 * Typed `invoke` that falls back to the mock in a plain browser. Rejections carry the
 * server message as a plain string, like Tauri does for `Result<_, String>` commands.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    return tauriInvoke<T>(cmd, args);
  }
  const mock = mocks[cmd] ?? (await loadBuiltin())[cmd];
  if (!mock) {
    throw new Error(`No browser mock registered for command "${cmd}"`);
  }
  return (await mock(args)) as T;
}

export const appInfo = (): Promise<AppInfo> => invoke<AppInfo>("app_info");

/** Opens the log folder (`<data dir>/logs`) in the OS file manager (Help > Open Log Folder). */
export async function openLogFolder(): Promise<void> {
  if (!isTauri()) return;
  const { dataDir } = await appInfo();
  await openPath(`${dataDir}/logs`);
}

// ---------------------------------------------------------------- export to a file, with progress and cancel

/** The progress sink of a command: a Tauri `Channel`, or a plain object in a browser (no file is written there). */
function progressSink(onProgress?: (p: ExportProgress) => void): { onmessage: (p: ExportProgress) => void } {
  const sink: { onmessage: (p: ExportProgress) => void } = isTauri() ? new Channel<ExportProgress>() : { onmessage: () => {} };
  sink.onmessage = (p) => onProgress?.(p);
  return sink;
}

/**
 * Stream every row of `sql` to `path` (a path from `chooseExportPath`). `exportId` (any unique string) lets
 * `cancelExport` stop it; `onProgress` gets the rows written at most every 100 ms or 1000 rows, and once at the end. Resolves with the report.
 */
export const exportQueryWithProgress = (
  dsId: string,
  sql: string,
  options: ExportOptions,
  path: string,
  exportId: string,
  onProgress?: (p: ExportProgress) => void,
): Promise<ExportReport> => invoke("export_query", { dsId, sql, options, path, exportId, onProgress: progressSink(onProgress) });

/** Write an in-memory result set to `path` (a path from `chooseExportPath`); the other arguments as `exportQueryWithProgress`. */
export const exportResultWithProgress = (
  result: Pick<ResultSet, "columns" | "rows">,
  options: ExportOptions,
  path: string,
  exportId: string,
  onProgress?: (p: ExportProgress) => void,
): Promise<ExportReport> =>
  invoke("export_result", { result: { hasMore: false, totalHint: null, ...result }, options, path, exportId, onProgress: progressSink(onProgress) });

/** Stops the export `exportId`; it fails and leaves no file behind. A no-op once it ended. */
export const cancelExport = (exportId: string): Promise<void> => invoke("cancel_export", { exportId });

// ---------------------------------------------------------------- SQL dump to a file, with progress and cancel

/**
 * Dump the objects of `schema` (PostgreSQL schema, MySQL database, SQLite `main`) to `path`, a file from
 * `chooseExportPath(name, "sqlInsert")`. `dumpId` (any unique string) lets `cancelDump` stop it; `onProgress` gets
 * one event per phase and per data batch. Resolves with `cancelled: true` when it was stopped (no file is left).
 */
export function dumpSchema(
  dsId: string,
  schema: string,
  options: DumpOptions,
  path: string,
  dumpId: string,
  onProgress?: (p: DumpProgress) => void,
): Promise<DumpResult> {
  const sink: { onmessage: (p: DumpProgress) => void } = isTauri() ? new Channel<DumpProgress>() : { onmessage: () => {} };
  sink.onmessage = (p) => onProgress?.(p);
  return invoke("dump_schema", { dsId, schema, options, path, dumpId, progress: sink });
}

/** Stops the dump `dumpId`. A no-op once it ended. */
export const cancelDump = (dumpId: string): Promise<void> => invoke("cancel_dump", { dumpId });

/**
 * Opens the folder of a file that a finished dump of this session wrote ("Open Folder"). The backend refuses any
 * other path, so this is not a general reveal.
 */
export const openDumpFolder = (path: string): Promise<void> => invoke("open_dump_folder", { path });

// ---------------------------------------------------------------- SQL script file (run a .sql file on a data source)

/**
 * Run the script file `path` on a data source, in `schema` when given. `path` must be a file the user granted (picked
 * with `chooseOpenFiles`, or inside an attached folder or the scratches). `scriptId` (any unique string) lets
 * `cancelScript` stop it; `onProgress` gets an event about every 100 ms. Resolves with the summary: statement errors
 * are in it (`failed`, `firstError`), not a rejection.
 */
export function runSqlFile(
  dsId: string,
  scriptId: string,
  schema: string | null | undefined,
  path: string,
  options: ScriptOptions,
  onProgress?: (p: ScriptProgress) => void,
): Promise<ScriptSummary> {
  const sink: { onmessage: (p: ScriptProgress) => void } = isTauri() ? new Channel<ScriptProgress>() : { onmessage: () => {} };
  sink.onmessage = (p) => onProgress?.(p);
  return invoke("run_sql_file", { dsId, scriptId, schema: schema ?? null, path, opts: options, onProgress: sink });
}

/** Stops the script `scriptId`: the statement in progress is interrupted. A no-op once it ended. */
export const cancelScript = (scriptId: string): Promise<void> => invoke("cancel_script", { scriptId });
