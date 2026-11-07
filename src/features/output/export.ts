/** Export / copy of a result: the Export Data dialog (file, clipboard) and the quick copy of the Options menu. */
import { type ExportFormat, type ExportOptions, defaultExportOptions, exportQueryToString, exportToString, isTauri } from "../../api/db";
import { notify } from "../../components/ui";
import { type ExportSource, openExportDialog } from "../table/exportData";
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

/** What the Export Data dialog exports for a result tab: its loaded rows, or its statement again when it has more. */
function exportSource(tab: ResultTab, host: OutputHost): ExportSource {
  return {
    dsId: host.dsId,
    label: tab.title(),
    sql: tab.sql,
    options: optionsFor(tab, host, tab.extractor()),
    loaded: () => ({ columns: tab.meta, rows: tab.rows, complete: !tab.hasMore() }),
    onOptions: (o) => tab.setExtractor(o.format),
  };
}

/** The grid's Export Data button: the Export Data dialog (extractor, options, preview, output file). */
export function exportResultData(tab: ResultTab, host: OutputHost): void {
  openExportDialog(exportSource(tab, host));
}

/** `grid.export` without a target: Export Data to File of the selected result of the output. False when none. */
export function exportCurrentResult(): boolean {
  const out = currentOutput();
  const tab = out?.current();
  if (!out?.host || !tab) return false;
  exportResultData(tab, out.host);
  return true;
}
