/** Export / copy of a result: file (save dialog), clipboard, browser download fallback. */
import {
  type ExportFormat,
  type ExportOptions,
  defaultExportOptions,
  exportQuery,
  exportQueryToString,
  exportResult,
  exportToString,
  isTauri,
} from "../../api/db";
import { notify } from "../../components/ui";
import { type OutputHost, type ResultTab, currentOutput } from "./model";

export const FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: "csv", label: "CSV", ext: "csv" },
  { id: "tsv", label: "TSV", ext: "tsv" },
  { id: "json", label: "JSON", ext: "json" },
  { id: "sqlInsert", label: "SQL Inserts", ext: "sql" },
  { id: "markdown", label: "Markdown", ext: "md" },
];

export const formatLabel = (f: ExportFormat): string => (f === "sqlInsert" ? "SQL" : (FORMATS.find((x) => x.id === f)?.label ?? "CSV"));

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

function optionsFor(tab: ResultTab, host: OutputHost, format: ExportFormat): ExportOptions {
  return {
    ...defaultExportOptions(host.driver),
    format,
    tableName: tab.meta.find((c) => c.tableRef)?.tableRef ?? "result",
  };
}

export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Text of the whole result in `format`. Re-runs the query when not every row is loaded. */
async function resultText(tab: ResultTab, host: OutputHost, format: ExportFormat): Promise<string> {
  const o = optionsFor(tab, host, format);
  return tab.hasMore() ? exportQueryToString(host.dsId, tab.sql, o) : exportToString({ columns: tab.meta, rows: tab.rows }, o);
}

export async function copyResult(tab: ResultTab, host: OutputHost, format: ExportFormat): Promise<void> {
  try {
    await copyText(await resultText(tab, host, format));
    notify({ kind: "info", title: "Copied to the clipboard", body: `Result as ${formatLabel(format)}` });
  } catch (e) {
    notify({ kind: "error", title: "Cannot copy the result", body: errText(e) });
  }
}

/** Export Data to File...: save dialog in the app, download in a plain browser. */
export async function exportResultToFile(tab: ResultTab, host: OutputHost, format: ExportFormat): Promise<void> {
  const fmt = FORMATS.find((f) => f.id === format)!;
  const name = `${tab.title().replace(/[^\w.-]+/g, "_")}.${fmt.ext}`;
  try {
    if (!isTauri()) {
      const text = await resultText(tab, host, format);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: name, filters: [{ name: fmt.label, extensions: [fmt.ext] }] });
    if (!path) return;
    const o = optionsFor(tab, host, format);
    const n = tab.hasMore() ? await exportQuery(host.dsId, tab.sql, o, path) : await exportResult({ columns: tab.meta, rows: tab.rows }, o, path);
    notify({ kind: "info", title: "Export finished", body: `${n.toLocaleString("en-US")} rows exported to ${path}` });
  } catch (e) {
    notify({ kind: "error", title: "Export failed", body: errText(e) });
  }
}

/** `grid.export` without a target: Export Data to File of the selected result of the output. False when none. */
export function exportCurrentResult(): boolean {
  const out = currentOutput();
  const tab = out?.current();
  if (!out?.host || !tab) return false;
  void exportResultToFile(tab, out.host, tab.extractor());
  return true;
}
