/** The data extractors (output formats) of the grid: the "Data Extractors" popup, Copy As and the Export Data dialog. */
import type { ExportFormat } from "../../api/types";
import type { MenuItem } from "../../components/ui";

export interface Extractor {
  id: ExportFormat;
  label: string;
  ext: string;
  mime: string;
  section: "Built-in" | "CSV" | "Other";
}

export const EXTRACTORS: Extractor[] = [
  { id: "sqlInsert", label: "SQL Inserts", ext: "sql", mime: "application/sql", section: "Built-in" },
  { id: "sqlUpdate", label: "SQL Updates", ext: "sql", mime: "application/sql", section: "Built-in" },
  { id: "whereClause", label: "Where Clause", ext: "sql", mime: "application/sql", section: "Built-in" },
  { id: "csv", label: "CSV", ext: "csv", mime: "text/csv", section: "CSV" },
  { id: "tsv", label: "TSV", ext: "tsv", mime: "text/tab-separated-values", section: "CSV" },
  { id: "csvPipe", label: "Pipe-separated", ext: "csv", mime: "text/csv", section: "CSV" },
  { id: "csvSemicolon", label: "Semicolon-separated", ext: "csv", mime: "text/csv", section: "CSV" },
  { id: "html", label: "HTML", ext: "html", mime: "text/html", section: "Other" },
  { id: "json", label: "JSON", ext: "json", mime: "application/json", section: "Other" },
  { id: "jsonLines", label: "JSON Lines", ext: "jsonl", mime: "application/x-ndjson", section: "Other" },
  { id: "markdown", label: "Markdown", ext: "md", mime: "text/markdown", section: "Other" },
  { id: "pretty", label: "Pretty", ext: "txt", mime: "text/plain", section: "Other" },
  { id: "xml", label: "XML", ext: "xml", mime: "application/xml", section: "Other" },
];

/** Toolbar label of the extractor (`SQL` for the INSERT / UPDATE ones, as in DataGrip). */
export const extractorLabel = (f: ExportFormat): string => (f === "sqlInsert" || f === "sqlUpdate" ? "SQL" : (EXTRACTORS.find((x) => x.id === f)?.label ?? "CSV"));

/** Rows of the `Data Extractors` popup (open it with the title `Data Extractors`): the sections `Built-in` / `CSV` / `Other`, the current one checked. */
export function extractorMenuItems(current: ExportFormat, pick: (f: ExportFormat) => void): MenuItem[] {
  const items: MenuItem[] = [];
  for (const section of ["Built-in", "CSV", "Other"] as const) {
    if (items.length) items.push({ type: "separator" });
    items.push({ type: "header", label: section });
    for (const x of EXTRACTORS.filter((e) => e.section === section)) items.push({ label: x.label, checked: x.id === current, run: () => pick(x.id) });
  }
  return items;
}
