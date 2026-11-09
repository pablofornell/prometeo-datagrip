/** The data extractors (output formats) of the grid: the "Data Extractors" popup, Copy As and the Export Data dialog. */
import type { ExportEncoding, ExportFormat, SnapshotObject } from "../../api/types";
import type { MenuItem } from "../../components/ui";

export interface Extractor {
  id: ExportFormat;
  label: string;
  ext: string;
  mime: string;
  section: "Built-in" | "CSV" | "Other";
  /** A binary file: written to a file only (no clipboard, no text preview). */
  binary?: true;
}

export const EXTRACTORS: Extractor[] = [
  { id: "sqlInsert", label: "SQL Inserts", ext: "sql", mime: "application/sql", section: "Built-in" },
  { id: "sqlUpdate", label: "SQL Updates", ext: "sql", mime: "application/sql", section: "Built-in" },
  { id: "whereClause", label: "Where Clause", ext: "sql", mime: "application/sql", section: "Built-in" },
  { id: "csv", label: "CSV", ext: "csv", mime: "text/csv", section: "CSV" },
  { id: "tsv", label: "TSV", ext: "tsv", mime: "text/tab-separated-values", section: "CSV" },
  { id: "csvPipe", label: "Pipe-separated", ext: "csv", mime: "text/csv", section: "CSV" },
  { id: "csvSemicolon", label: "Semicolon-separated", ext: "csv", mime: "text/csv", section: "CSV" },
  { id: "xlsx", label: "Excel (xlsx)", ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", section: "Other", binary: true },
  { id: "html", label: "HTML", ext: "html", mime: "text/html", section: "Other" },
  { id: "json", label: "JSON", ext: "json", mime: "application/json", section: "Other" },
  { id: "jsonLines", label: "JSON Lines", ext: "jsonl", mime: "application/x-ndjson", section: "Other" },
  { id: "markdown", label: "Markdown", ext: "md", mime: "text/markdown", section: "Other" },
  { id: "pretty", label: "Pretty", ext: "txt", mime: "text/plain", section: "Other" },
  { id: "xml", label: "XML", ext: "xml", mime: "application/xml", section: "Other" },
];

/** Toolbar label of the extractor (`SQL` for the INSERT / UPDATE ones, as in DataGrip). */
export const extractorLabel = (f: ExportFormat): string => (f === "sqlInsert" || f === "sqlUpdate" ? "SQL" : (EXTRACTORS.find((x) => x.id === f)?.label ?? "CSV"));

/** Is `f` a binary file format (Excel): it cannot go to the clipboard nor be shown as text. */
export const isBinaryFormat = (f: ExportFormat): boolean => EXTRACTORS.some((x) => x.id === f && x.binary === true);

/** The extractors that can go to the clipboard (every text format; the binary ones are for a file). */
export const CLIPBOARD_EXTRACTORS: Extractor[] = EXTRACTORS.filter((x) => !x.binary);

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

/** Charsets of the Export Data dialog (the file's encoding; the clipboard and the preview are always UTF-8). */
export const EXPORT_CHARSETS: { value: ExportEncoding; label: string }[] = [
  { value: "utf8", label: "UTF-8" },
  { value: "utf8Bom", label: "UTF-8 with BOM" },
  { value: "windows1252", label: "Windows-1252" },
  { value: "utf16Le", label: "UTF-16LE" },
];

/** The notice after an export that wrote `?` for characters Windows-1252 cannot hold; `""` when none did. */
export function replacedNotice(replaced: number): string {
  if (replaced <= 0) return "";
  const one = replaced === 1;
  return `${replaced} ${one ? "character was" : "characters were"} replaced with "?" (not in Windows-1252)`;
}

/** The notice after an Excel export that cut `cut` cells to the length an Excel cell holds; `""` when none was. */
export function truncatedNotice(cut: number): string {
  if (cut <= 0) return "";
  const one = cut === 1;
  return `${cut} ${one ? "cell was" : "cells were"} cut to the 32,767 characters an Excel cell holds`;
}

/**
 * The primary key columns of the table `ref` in `objects` (the tables of a schema snapshot). `null` when the table
 * has none or is not in the snapshot (a view, another schema): the backend then picks the key itself.
 */
export function primaryKeyColumns(objects: SnapshotObject[], ref: { schema?: string | null; name: string }): string[] | null {
  const table = objects.find((o) => o.kind === "table" && o.name === ref.name && (!ref.schema || o.schema === ref.schema));
  const columns = table?.columns.filter((c) => c.isPk).map((c) => c.name) ?? [];
  return columns.length > 0 ? columns : null;
}
