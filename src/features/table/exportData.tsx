/**
 * Export Data: the dialog (`ExportDialog`) and what it does, for a grid result (the Database Output's ⤓ button), a
 * whole table (explorer `Import/Export > Export Data...`) and the table editor.
 */
import {
  type Cell,
  type ColumnMeta,
  type Driver,
  type ExportOptions,
  type ExportProgress,
  type ExportReport,
  type ObjectRef,
  defaultExportOptions,
  exportQueryToString,
  exportToString,
  isTauri,
  approveExportPath,
} from "../../api/db";
import { cancelExport, exportQueryWithProgress, exportResultWithProgress } from "../../api/tauri";
import { notify } from "../../components/ui";
import { startTask } from "../../state/status";
import { ensureConnected, loadSchemaSnapshot } from "../explorer";
import { isBinaryFormat, primaryKeyColumns, replacedNotice, truncatedNotice } from "../output/extractors";
import { errText, requireDriver, writeClipboard } from "./ds";
import { mountDialog } from "./dialogs";
import { EXPORT_FORMATS, ExportDialog, type ExportPath, type ExportTarget, exportFileBase } from "./Popups";
import { limitedSql, qualifiedName, selectSql } from "./sql";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const PREVIEW_ROWS = 10;
const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

/** What an Export Data dialog exports: a query, or rows that are already loaded (a grid result). */
export interface ExportSource {
  dsId: string;
  /** `Source:` field (`main.orders`). */
  label: string;
  /** The statement of the whole result; it runs again when `loaded` does not hold every row. */
  sql: string;
  options: ExportOptions;
  /** The rows of the grid (read when needed); `complete`: there are no more rows to fetch. */
  loaded?: () => { columns: ColumnMeta[]; rows: Cell[][]; complete: boolean };
  /** The `LIMIT`ed query of the preview, when there are no loaded rows. Default: `<sql>` limited to 10 rows in the dialect of the data source. */
  previewSql?: string;
  /** The dialog was left with these options (the grid remembers the extractor). */
  onOptions?: (o: ExportOptions) => void;
  /** The export was done (rows written / copied). */
  onDone?: () => void;
}

/** The preview of a binary format (an Excel workbook has no text to show). */
const BINARY_PREVIEW = "No text preview: an Excel workbook is a binary file. It holds the same rows, with a bold header row that is frozen and filtered.";

/** The text of the first rows, in `o`. */
export async function exportPreview(src: ExportSource, o: ExportOptions): Promise<string> {
  if (isBinaryFormat(o.format)) return BINARY_PREVIEW;
  const l = src.loaded?.();
  if (l) return exportToString({ columns: l.columns, rows: l.rows.slice(0, PREVIEW_ROWS) }, o);
  return exportQueryToString(src.dsId, src.previewSql ?? limitedSql(await requireDriver(src.dsId), src.sql, PREVIEW_ROWS), o);
}

/** Text of the whole result in `o` (runs the query again when not every row is loaded). */
export async function exportText(src: ExportSource, o: ExportOptions): Promise<string> {
  const l = src.loaded?.();
  return l?.complete ? exportToString({ columns: l.columns, rows: l.rows }, o) : exportQueryToString(src.dsId, src.sql, o);
}

/** Copies the whole result to the clipboard. */
export async function copyExport(src: ExportSource, o: ExportOptions): Promise<void> {
  const fmt = EXPORT_FORMATS.find((f) => f.value === o.format) ?? EXPORT_FORMATS[0];
  if (isBinaryFormat(o.format)) {
    notify({ kind: "error", title: "Cannot copy the data", body: `${fmt.label} is a binary file: export it to a file instead.` });
    return;
  }
  try {
    await writeClipboard(await exportText(src, o));
    notify({ kind: "success", title: "Copied to the clipboard", body: `${fmt.label} of ${src.label}`, timeout: 4000 });
    src.onDone?.();
  } catch (e) {
    notify({ kind: "error", title: "Export failed", body: errText(e) });
  }
}

/**
 * Writes the whole result to the dialog's output file. While it runs, a status bar task shows the rows written and
 * its Cancel stops it, also a query that has not returned a row yet (the backend then removes the partial file and leaves a file it was to replace as it was).
 */
export async function exportToFile(src: ExportSource, o: ExportOptions, out: ExportPath): Promise<void> {
  const fmt = EXPORT_FORMATS.find((f) => f.value === o.format) ?? EXPORT_FORMATS[0];
  let cancelled = false;
  try {
    if (!isTauri()) {
      // a browser has no file system: download it (an Excel workbook is built by the desktop app)
      if (isBinaryFormat(o.format)) throw new Error(`${fmt.label} export needs the desktop app`);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([await exportText(src, o)], { type: fmt.mime }));
      a.download = out.path.split("/").pop() || `export.${fmt.ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      src.onDone?.();
      return;
    }
    // a path the save dialog returned (or the dialog's own check approved) is allowed already; a typed one that
    // reaches this point without that check (not from the dialog) is approved by the backend or refused
    const path = out.path;
    if (!out.chosen) {
      const why = await approveExportPath(path, o.format);
      if (why) throw new Error(why);
    }
    const l = src.loaded?.();
    const id = newId();
    const task = startTask(`Exporting ${src.label}…`, {
      cancel: () => {
        cancelled = true;
        void cancelExport(id).catch(() => {});
      },
    });
    const progress = (p: ExportProgress) => {
      task.title(`Exporting ${src.label}… ${plural(p.rowsWritten, "row")}`);
      if (p.total) task.progress(p.rowsWritten / p.total);
    };
    let report: ExportReport;
    try {
      report = l?.complete
        ? await exportResultWithProgress({ columns: l.columns, rows: l.rows }, o, path, id, progress)
        : await exportQueryWithProgress(src.dsId, src.sql, o, path, id, progress);
    } finally {
      task.done();
    }
    const notes = [replacedNotice(report.unmappable), truncatedNotice(report.truncated)].filter(Boolean).join(". ");
    notify({ kind: "success", title: "Export finished", body: `${plural(report.rows, "row")} exported to ${path}${notes ? `. ${notes}` : ""}`, timeout: 6000 });
    src.onDone?.();
  } catch (e) {
    if (cancelled) notify({ kind: "info", title: "Export cancelled", body: `${src.label}: nothing was written.`, timeout: 6000 });
    else notify({ kind: "error", title: "Export failed", body: errText(e) });
  }
}

/** Opens the Export Data dialog of `src`. */
export function openExportDialog(src: ExportSource): void {
  mountDialog((close) => (
    <ExportDialog
      options={src.options}
      source={src.label}
      fileBase={exportFileBase(src.label)}
      preview={(o) => exportPreview(src, o)}
      onClose={close}
      onExport={(o, target, out) => {
        close();
        src.onOptions?.(o);
        void (target === "file" ? exportToFile(src, o, out) : copyExport(src, o));
      }}
    />
  ));
}

/** The primary key of a table: the key of its SQL UPDATE / WHERE export (`null`: none, the backend picks one). */
async function tableKeyColumns(dsId: string, ref: ObjectRef): Promise<string[] | null> {
  return primaryKeyColumns(await loadSchemaSnapshot(dsId, ref.schema ?? null), ref);
}

/** Streams every row of `select * from <table> [where] [order by]` to a file or the clipboard. */
export async function exportTableQuery(
  dsId: string,
  ref: ObjectRef,
  driver: Driver,
  options: ExportOptions,
  target: ExportTarget,
  out: ExportPath,
  filter: { where?: string; orderBy?: string } = {},
): Promise<void> {
  const o: ExportOptions = { ...options, keyColumns: options.keyColumns ?? (await tableKeyColumns(dsId, ref)) };
  const src: ExportSource = { dsId, label: qualifiedName(driver, ref), sql: selectSql(driver, ref, filter.where ?? "", filter.orderBy ?? ""), options: o };
  await (target === "file" ? exportToFile(src, o, out) : copyExport(src, o));
}

/** `grid.export` with `{ dsId, objectRef }`: the Export Data dialog; exports the whole table. */
export async function openTableExport(dsId: string, ref: ObjectRef): Promise<void> {
  let driver: Driver;
  try {
    driver = await requireDriver(dsId);
    await ensureConnected(dsId);
  } catch (e) {
    notify({ kind: "error", title: "Cannot export the data", body: errText(e) });
    return;
  }
  const options: ExportOptions = { ...defaultExportOptions(driver), tableName: qualifiedName(driver, ref), keyColumns: await tableKeyColumns(dsId, ref) };
  openExportDialog({ dsId, label: qualifiedName(driver, ref), sql: selectSql(driver, ref, "", ""), options });
}
