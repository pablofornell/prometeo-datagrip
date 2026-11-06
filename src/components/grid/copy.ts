/**
 * "Copy as" formatters (TSV is the DataGrip default for Ctrl+C). Pure functions, no DOM.
 * Input is a rectangular block of already-selected cells: `columns[j]` describes `rows[i][j]`.
 */
import { classifyType, editText, isBinaryCell, isDefaultCell } from "./format";
import type { Cell, CopyFormat } from "./types";

export interface CopyColumn {
  name: string;
  typeName: string;
}

export interface CopyOptions {
  /** Target table for SQL INSERT output (`schema.table`). */
  tableName?: string;
  /** Text for NULL in TSV/CSV/Markdown (JSON/SQL always use null/NULL). Default: empty. */
  nullText?: string;
  /** Include the header row (TSV/CSV; Markdown always has one). Default false for TSV (like DataGrip), true for CSV. */
  header?: boolean;
}

function plain(v: Cell, nullText: string): string {
  if (v === null || v === undefined) return nullText;
  if (isDefaultCell(v)) return "<default>";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isBinaryCell(v)) return "0x" + v.$bin;
  return editText(v).replace(/\s*\n\s*/g, " ");
}

function quoteIfNeeded(s: string, special: RegExp): string {
  return special.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function formatTsv(columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  const nul = o.nullText ?? "";
  const lines: string[] = [];
  if (o.header) lines.push(columns.map((c) => quoteIfNeeded(c.name, /[\t\r\n"]/)).join("\t"));
  for (const r of rows) lines.push(r.map((v) => quoteIfNeeded(plain(v, nul), /[\t\r\n"]/)).join("\t"));
  return lines.join("\n");
}

export function formatCsv(columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  const nul = o.nullText ?? "";
  const lines: string[] = [];
  if (o.header ?? true) lines.push(columns.map((c) => quoteIfNeeded(c.name, /[,\r\n"]/)).join(","));
  for (const r of rows) lines.push(r.map((v) => quoteIfNeeded(plain(v, nul), /[,\r\n"]/)).join(","));
  return lines.join("\n");
}

const NUM_TOKEN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function jsonValue(v: Cell, numeric: boolean): string {
  if (v === null || v === undefined) return "null";
  if (isDefaultCell(v)) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return numeric && NUM_TOKEN.test(v) ? v : JSON.stringify(v);
  if (isBinaryCell(v)) return JSON.stringify("0x" + v.$bin);
  return JSON.stringify(v);
}

export function formatJson(columns: CopyColumn[], rows: Cell[][]): string {
  const numeric = columns.map((c) => classifyType(c.typeName) === "number");
  const names = columns.map((c) => JSON.stringify(c.name));
  const objs = rows.map((r) => "  {\n" + r.map((v, j) => `    ${names[j]}: ${jsonValue(v, numeric[j])}`).join(",\n") + "\n  }");
  return objs.length ? "[\n" + objs.join(",\n") + "\n]" : "[]";
}

function ident(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"';
}

function qualified(name: string): string {
  return name.split(".").map(ident).join(".");
}

function sqlValue(v: Cell, numeric: boolean): string {
  if (v === null || v === undefined) return "NULL";
  if (isDefaultCell(v)) return "DEFAULT";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return numeric && NUM_TOKEN.test(v) ? v : "'" + v.replace(/'/g, "''") + "'";
  if (isBinaryCell(v)) return "X'" + v.$bin + "'";
  return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
}

export function formatSqlInsert(columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  const table = qualified(o.tableName || "table_name");
  const cols = columns.map((c) => ident(c.name)).join(", ");
  const numeric = columns.map((c) => classifyType(c.typeName) === "number");
  return rows
    .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, j) => sqlValue(v, numeric[j])).join(", ")});`)
    .join("\n");
}

export function formatMarkdown(columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  const nul = o.nullText ?? "";
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const head = "| " + columns.map((c) => esc(c.name)).join(" | ") + " |";
  const align = "| " + columns.map((c) => (classifyType(c.typeName) === "number" ? "---:" : "---")).join(" | ") + " |";
  const body = rows.map((r) => "| " + r.map((v) => esc(plain(v, nul))).join(" | ") + " |");
  return [head, align, ...body].join("\n");
}

export function formatRows(format: CopyFormat, columns: CopyColumn[], rows: Cell[][], o: CopyOptions = {}): string {
  switch (format) {
    case "tsv":
      return formatTsv(columns, rows, o);
    case "csv":
      return formatCsv(columns, rows, o);
    case "json":
      return formatJson(columns, rows);
    case "sql":
      return formatSqlInsert(columns, rows, o);
    case "markdown":
      return formatMarkdown(columns, rows, o);
  }
}

export const COPY_FORMAT_LABELS: Record<CopyFormat, string> = {
  tsv: "TSV",
  csv: "CSV",
  json: "JSON",
  sql: "SQL INSERT",
  markdown: "Markdown",
};
