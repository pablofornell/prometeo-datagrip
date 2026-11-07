/** Pure logic of the Import Data dialog: format presets, type names, auto mapping, DDL / INSERT previews, messages. */
import type { Driver, ImportColumnMap, ImportFormat, ImportResult, InferredType } from "../../api/db";

// ---------------------------------------------------------------- format

export type FormatKind = "csv" | "tsv" | "semicolon" | "pipe" | "custom";

export const FORMAT_OPTIONS: { value: FormatKind; label: string; delimiter: string }[] = [
  { value: "csv", label: "CSV", delimiter: "," },
  { value: "tsv", label: "TSV", delimiter: "\t" },
  { value: "semicolon", label: "CSV (semicolon)", delimiter: ";" },
  { value: "pipe", label: "Pipe-separated", delimiter: "|" },
  { value: "custom", label: "Custom delimiter", delimiter: "" },
];

/** The preset a delimiter belongs to (`custom` for any other). */
export function formatKindOf(delimiter: string): FormatKind {
  return FORMAT_OPTIONS.find((f) => f.value !== "custom" && f.delimiter === delimiter)?.value ?? "custom";
}

export const ENCODINGS = ["UTF-8", "ISO-8859-1"];

/** Short description for the preview header (`format: CSV`). */
export function formatLabel(f: ImportFormat): string {
  const k = formatKindOf(f.delimiter);
  return k === "custom" ? `delimiter '${f.delimiter}'` : FORMAT_OPTIONS.find((o) => o.value === k)!.label;
}

// ---------------------------------------------------------------- types

/** The SQL type a new column of an inferred type gets (same table as `sql_type` in crates/dbcore/src/import.rs). */
export function sqlTypeFor(d: Driver, t: InferredType): string {
  switch (t) {
    case "double":
      return d === "postgres" ? "double precision" : "double";
    case "timestamp":
      return d === "postgres" ? "timestamp" : "datetime";
    default:
      return t;
  }
}

/** Types offered for a new column. */
export const TYPE_CHOICES: Record<Driver, string[]> = {
  postgres: ["text", "integer", "bigint", "double precision", "numeric", "boolean", "date", "timestamp", "timestamptz", "varchar(255)", "uuid", "jsonb"],
  mysql: ["text", "int", "bigint", "double", "decimal(18,4)", "boolean", "date", "datetime", "varchar(255)", "json"],
  sqlite: ["text", "integer", "double", "numeric", "boolean", "date", "datetime", "blob"],
};

// ---------------------------------------------------------------- names

/** `import-sample.csv` -> `import_sample`: a table name for a file. */
export function tableNameForFile(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, "");
  const name = stem.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!name) return "imported_data";
  return /^\d/.test(name) ? "t_" + name : name;
}

export const quoteIdent = (d: Driver, s: string): string =>
  d === "mysql" ? "`" + s.replace(/`/g, "``") + "`" : '"' + s.replace(/"/g, '""') + '"';

export const qualifiedName = (d: Driver, schema: string | null, name: string): string =>
  schema ? `${quoteIdent(d, schema)}.${quoteIdent(d, name)}` : quoteIdent(d, name);

// ---------------------------------------------------------------- mapping

/** A row of the Mapping table. `from`: `auto`, `skip` or the index of a file column. */
export interface MapRow {
  name: string;
  type: string;
  from: "auto" | "skip" | number;
}

/**
 * The file column each table column reads by default: the one with the same name (case-insensitive); when no
 * name matches at all, the file columns in order. `null`: no file column.
 */
export function autoMatch(tableColumns: string[], fileColumns: string[]): (number | null)[] {
  const byName = tableColumns.map((t) => {
    const i = fileColumns.findIndex((f) => f.toLowerCase() === t.toLowerCase());
    return i < 0 ? null : i;
  });
  if (byName.some((i) => i !== null)) return byName;
  return tableColumns.map((_, i) => (i < fileColumns.length ? i : null));
}

/** Rows for an existing table (`columns` with their types). */
export function existingRows(columns: { name: string; type: string }[]): MapRow[] {
  return columns.map((c) => ({ name: c.name, type: c.type, from: "auto" }));
}

/** Rows for a new table: one column per file column (`auto` reads the file column at the same position). */
export function newRows(d: Driver, file: { name: string; inferredType: InferredType }[]): MapRow[] {
  return file.map((c) => ({ name: c.name, type: sqlTypeFor(d, c.inferredType), from: "auto" }));
}

/** The file column a row reads (`null` = none), resolving `auto`. */
export function sourceOf(rows: MapRow[], i: number, fileColumns: string[], isNew: boolean): number | null {
  const r = rows[i];
  if (r.from === "skip") return null;
  if (r.from !== "auto") return r.from;
  if (isNew) return i < fileColumns.length ? i : null;
  return autoMatch(rows.map((x) => x.name), fileColumns)[i];
}

/** What the request sends: skipped columns of a new table are not created at all. */
export function requestColumns(rows: MapRow[], fileColumns: string[], isNew: boolean): ImportColumnMap[] {
  const cols = rows.map((r, i) => ({ name: r.name.trim(), type: r.type.trim(), source: sourceOf(rows, i, fileColumns, isNew) }));
  return isNew ? cols.filter((c) => c.source !== null) : cols;
}

/** Why the mapping cannot be imported, or `null`. */
export function mappingProblem(rows: MapRow[], fileColumns: string[], isNew: boolean, table: string): string | null {
  if (!table.trim()) return "The table name is empty";
  const cols = requestColumns(rows, fileColumns, isNew);
  if (!cols.some((c) => c.source !== null)) return "No column is mapped to a column of the file";
  const names = new Set<string>();
  for (const c of cols) {
    if (!c.name) return "A column has no name";
    if (isNew && !c.type) return `Column ${c.name} has no type`;
    const k = c.name.toLowerCase();
    if (names.has(k)) return `Column ${c.name} appears twice`;
    names.add(k);
  }
  return null;
}

// ---------------------------------------------------------------- SQL previews

/** `create table ...` as the import runs it (same layout as `create_table_sql` in import.rs). */
export function createTableSql(d: Driver, schema: string | null, table: string, cols: { name: string; type: string }[]): string {
  const lines = cols.map((c) => `    ${quoteIdent(d, c.name)} ${c.type}`);
  return `create table ${qualifiedName(d, schema, table)} (\n${lines.join(",\n")}\n)`;
}

/** The statement an import of rows runs for each batch (values elided). */
export function insertSql(d: Driver, schema: string | null, table: string, cols: string[]): string {
  return `insert into ${qualifiedName(d, schema, table)} (${cols.map((c) => quoteIdent(d, c)).join(", ")})\nvalues (${cols.map(() => "?").join(", ")})`;
}

// ---------------------------------------------------------------- messages

export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Text of the balloon that reports an import. */
export function resultMessage(r: ImportResult, table: string): { kind: "success" | "warning" | "error"; title: string; body: string } {
  const firstErrors = r.errors
    .slice(0, 5)
    .map((e) => `Row ${e.row}: ${e.message}`)
    .join("\n");
  const more = r.failed > Math.min(5, r.errors.length) ? `\nand ${plural(r.failed - Math.min(5, r.errors.length), "more error")}` : "";
  const file = r.errorFile ? `\nErrors were written to ${r.errorFile}` : r.errorFileError ? `\n${r.errorFileError}` : "";
  if (r.cancelled) return { kind: "warning", title: "Import cancelled", body: `Nothing was imported to ${table}.` };
  if (r.rolledBack)
    return {
      kind: "error",
      title: "Import failed",
      body: `${plural(r.failed, "row")} could not be imported, so nothing was imported to ${table}.\n${firstErrors}${more}${file}`,
    };
  if (r.failed > 0)
    return {
      kind: "warning",
      title: "Import finished with errors",
      body: `${plural(r.imported, "row")} imported to ${table}, ${plural(r.failed, "row")} failed.\n${firstErrors}${more}${file}`,
    };
  return { kind: "success", title: "Import finished", body: `${plural(r.imported, "row")} imported to ${table}` };
}
