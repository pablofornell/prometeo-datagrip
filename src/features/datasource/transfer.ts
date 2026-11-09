/**
 * Export / import of data sources (DataGrip's "Export Data Sources" / "Import from file / clipboard").
 *
 * The file is JSON with a format id and a version. It never holds a password or token, only `hasPassword`;
 * an imported data source that had one asks for it the next time it connects. Writing and reading go through
 * the backend with paths from the native save / open dialogs (`chooseExportPath`, `choose_open_json`): the
 * webview cannot make the backend touch any other file.
 */
import { chooseExportPath } from "../../api/db";
import { invoke } from "../../api/tauri";
import type { DataSourceImportSummary } from "../../api/types";

/** Name proposed in the save dialog. */
export const EXPORT_FILE_NAME = "data-sources.json";

/** Save dialog + write. Resolves `null` when the user cancels; else the path and the number of data sources written. */
export async function exportDataSources(ids?: string[]): Promise<{ path: string; count: number } | null> {
  const path = await chooseExportPath(EXPORT_FILE_NAME, "json");
  if (!path) return null;
  const count = await invoke<number>("export_data_sources", { ids: ids?.length ? ids : null, path });
  return { path, count };
}

/** Open dialog + import. Resolves `null` when the user cancels. */
export async function importDataSourcesFromFile(): Promise<DataSourceImportSummary | null> {
  const path = await invoke<string | null>("choose_open_json");
  if (!path) return null;
  return invoke<DataSourceImportSummary>("import_data_sources", { path });
}

/** Import the export text found on the clipboard. */
export async function importDataSourcesFromClipboard(): Promise<DataSourceImportSummary> {
  const text = await readClipboard();
  if (!text.trim()) throw new Error("The clipboard is empty.");
  return invoke<DataSourceImportSummary>("import_data_sources_text", { text });
}

async function readClipboard(): Promise<string> {
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return (await readText()) ?? "";
  } catch {
    /* not in the desktop app: the web clipboard */
  }
  return navigator.clipboard.readText();
}

export interface ImportReport {
  kind: "info" | "warning" | "error";
  title: string;
  body: string;
}

const list = (names: string[], max = 6): string => (names.length > max ? [...names.slice(0, max), `and ${names.length - max} more`] : names).join(", ");

/** The notification that tells the user what an import did: what was created, renamed, needs a password, was skipped. */
export function describeImport(s: DataSourceImportSummary): ImportReport {
  const n = s.imported.length;
  if (!n) {
    return {
      kind: s.skipped.length ? "error" : "info",
      title: "Nothing imported",
      body: s.skipped.length ? `No data source could be read: ${s.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")}` : "The file has no data sources.",
    };
  }
  const lines = [`Imported ${n} data source${n === 1 ? "" : "s"}: ${list(s.imported.map((x) => x.name))}.`];
  const renamed = s.imported.filter((x) => x.renamed);
  if (renamed.length) lines.push(`Renamed because the name was taken: ${list(renamed.map((x) => `${x.originalName} to ${x.name}`))}.`);
  const needs = s.imported.filter((x) => x.needsPassword);
  if (needs.length) lines.push(`Passwords are never exported: enter one for ${list(needs.map((x) => x.name))}.`);
  const remote = s.imported.filter((x) => x.remotePaths?.length);
  if (remote.length) lines.push(`Network paths found, check that you trust them before connecting: ${list(remote.map((x) => `${x.name} (${x.remotePaths.join(", ")})`))}.`);
  if (s.skipped.length) lines.push(`Skipped ${s.skipped.length}: ${s.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")}.`);
  return { kind: s.skipped.length || needs.length || remote.length ? "warning" : "info", title: "Data sources imported", body: lines.join(" ") };
}
