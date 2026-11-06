/** Export Data of a whole table (explorer context menu `grid.export`, the table editor's export button). */
import { type Driver, type ExportOptions, type ObjectRef, defaultExportOptions, exportQuery, exportQueryToString, isTauri } from "../../api/db";
import { notify } from "../../components/ui";
import { ensureConnected } from "../explorer";
import { dsInfo, errText, loadDataSources, writeClipboard } from "./ds";
import { mountDialog } from "./dialogs";
import { EXPORT_FORMATS, ExportDialog, type ExportTarget } from "./Popups";
import { qualifiedName, selectSql } from "./sql";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Streams every row of `select * from <table> [where] [order by]` to a file (save dialog) or the clipboard. */
export async function exportTableQuery(
  dsId: string,
  ref: ObjectRef,
  driver: Driver,
  options: ExportOptions,
  target: ExportTarget,
  filter: { where?: string; orderBy?: string } = {},
): Promise<void> {
  const sql = selectSql(driver, ref, filter.where ?? "", filter.orderBy ?? "");
  const fmt = EXPORT_FORMATS.find((f) => f.value === options.format) ?? EXPORT_FORMATS[0];
  try {
    if (target === "file") {
      const name = `${ref.name}.${fmt.ext}`;
      let path: string | null = name;
      if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        path = await save({ defaultPath: name, filters: [{ name: fmt.label, extensions: [fmt.ext] }] });
      }
      if (!path) return;
      const n = await exportQuery(dsId, sql, options, path);
      notify({ kind: "success", title: "Export finished", body: `${plural(n, "row")} exported to ${path}`, timeout: 6000 });
    } else {
      const text = await exportQueryToString(dsId, sql, options);
      await writeClipboard(text);
      notify({ kind: "success", title: "Copied to the clipboard", body: `${fmt.label} of the whole table`, timeout: 4000 });
    }
  } catch (e) {
    notify({ kind: "error", title: "Export failed", body: errText(e) });
  }
}

/** `grid.export` with `{ dsId, objectRef }`: format chooser, then the save dialog; exports the whole table. */
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
  mountDialog((close) => (
    <ExportDialog
      options={options}
      target="file"
      onClose={close}
      onExport={(o, t) => {
        close();
        void exportTableQuery(dsId, ref, driver, o, t);
      }}
    />
  ));
}
