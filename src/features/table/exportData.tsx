/**
 * Export Data: the dialog (`ExportDialog`) and what it does, for a grid result (the Database Output's ⤓ button), a
 * whole table (explorer `Import/Export > Export Data...`) and the table editor.
 */
import {
  type Cell,
  type ColumnMeta,
  type Driver,
  type ExportOptions,
  type ObjectRef,
  defaultExportOptions,
  exportQuery,
  exportQueryToString,
  exportResult,
  exportToString,
  isTauri,
  resolveExportPath,
} from "../../api/db";
import { notify } from "../../components/ui";
import { ensureConnected } from "../explorer";
import { dsInfo, errText, loadDataSources, writeClipboard } from "./ds";
import { mountDialog } from "./dialogs";
import { EXPORT_FORMATS, ExportDialog, type ExportPath, type ExportTarget, exportFileBase } from "./Popups";
import { qualifiedName, selectSql } from "./sql";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const PREVIEW_ROWS = 10;

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
  /** The `LIMIT`ed query of the preview, when there are no loaded rows. Default: `<sql> limit 10`. */
  previewSql?: string;
  /** The dialog was left with these options (the grid remembers the extractor). */
  onOptions?: (o: ExportOptions) => void;
  /** The export was done (rows written / copied). */
  onDone?: () => void;
}

/** The text of the first rows, in `o`. */
export async function exportPreview(src: ExportSource, o: ExportOptions): Promise<string> {
  const l = src.loaded?.();
  if (l) return exportToString({ columns: l.columns, rows: l.rows.slice(0, PREVIEW_ROWS) }, o);
  return exportQueryToString(src.dsId, src.previewSql ?? `${src.sql} limit ${PREVIEW_ROWS}`, o);
}

/** Text of the whole result in `o` (runs the query again when not every row is loaded). */
export async function exportText(src: ExportSource, o: ExportOptions): Promise<string> {
  const l = src.loaded?.();
  return l?.complete ? exportToString({ columns: l.columns, rows: l.rows }, o) : exportQueryToString(src.dsId, src.sql, o);
}

/** Copies the whole result to the clipboard. */
export async function copyExport(src: ExportSource, o: ExportOptions): Promise<void> {
  const fmt = EXPORT_FORMATS.find((f) => f.value === o.format) ?? EXPORT_FORMATS[0];
  try {
    await writeClipboard(await exportText(src, o));
    notify({ kind: "success", title: "Copied to the clipboard", body: `${fmt.label} of ${src.label}`, timeout: 4000 });
    src.onDone?.();
  } catch (e) {
    notify({ kind: "error", title: "Export failed", body: errText(e) });
  }
}

/** Writes the whole result to the dialog's output file. */
export async function exportToFile(src: ExportSource, o: ExportOptions, out: ExportPath): Promise<void> {
  const fmt = EXPORT_FORMATS.find((f) => f.value === o.format) ?? EXPORT_FORMATS[0];
  try {
    if (!isTauri()) {
      // a browser has no file system: download it
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([await exportText(src, o)], { type: fmt.mime }));
      a.download = out.path.split("/").pop() || `export.${fmt.ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      src.onDone?.();
      return;
    }
    // a path the save dialog returned is allowed already; a typed one is approved by the backend or goes through the dialog
    const path = out.chosen ? out.path : await resolveExportPath(out.path, o.format);
    if (!path) return; // the dialog was cancelled
    const l = src.loaded?.();
    const rows = l?.complete ? await exportResult({ columns: l.columns, rows: l.rows }, o, path) : await exportQuery(src.dsId, src.sql, o, path);
    notify({ kind: "success", title: "Export finished", body: `${plural(rows, "row")} exported to ${path}`, timeout: 6000 });
    src.onDone?.();
  } catch (e) {
    notify({ kind: "error", title: "Export failed", body: errText(e) });
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
  const src: ExportSource = { dsId, label: qualifiedName(driver, ref), sql: selectSql(driver, ref, filter.where ?? "", filter.orderBy ?? ""), options };
  await (target === "file" ? exportToFile(src, options, out) : copyExport(src, options));
}

/** `grid.export` with `{ dsId, objectRef }`: the Export Data dialog; exports the whole table. */
export async function openTableExport(dsId: string, ref: ObjectRef): Promise<void> {
  try {
    await loadDataSources();
    await ensureConnected(dsId);
  } catch (e) {
    notify({ kind: "error", title: "Cannot export the data", body: errText(e) });
    return;
  }
  const driver = dsInfo(dsId)?.driver ?? "postgres";
  const options: ExportOptions = { ...defaultExportOptions(driver), tableName: qualifiedName(driver, ref) };
  openExportDialog({ dsId, label: qualifiedName(driver, ref), sql: selectSql(driver, ref, "", ""), options });
}
