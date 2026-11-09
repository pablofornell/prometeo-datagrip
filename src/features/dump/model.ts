/** Dump to SQL File: option defaults and checks, file name, progress and result texts. Pure (no UI, no IPC). */
import type { DumpOptions, DumpProgress, DumpResult, Driver } from "../../api/db";

/** The options of the dialog before the user changes them (the backend's `DumpOptions::default()`). */
export function defaultDumpOptions(): DumpOptions {
  return {
    data: true,
    dropIfExists: false,
    includeViews: true,
    includeSequences: true,
    includeRoutines: false,
    targetSchema: null,
    batchSize: 500,
    includeDdl: true,
    commitEvery: 0,
  };
}

/** Rows per INSERT: a whole number from 1 to 100000 (`null` when the text is not one). */
export function parseBatchSize(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 100000 ? n : null;
}

/** Rows per commit: a whole number from 0 (only at the end) to 1000000 (`null` when the text is not one). */
export function parseCommitEvery(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,7}$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 1000000 ? n : null;
}

/** The options as the backend takes them: an empty target schema is `null` (the dumped schema); `tables` when given. */
export function normalizeDumpOptions(o: DumpOptions, tables?: string[]): DumpOptions {
  const target = o.targetSchema?.trim() ?? "";
  return { ...o, targetSchema: target === "" ? null : target, ...(tables ? { tables } : {}) };
}

/** Why the options cannot be dumped (`null` when they can). */
export function dumpOptionsProblem(o: DumpOptions): string | null {
  if (o.includeDdl === false && !o.data) return "Choose Structure, Data or both.";
  // the INSERT settings only matter when rows are written (their fields are disabled otherwise)
  if (o.data && (!Number.isInteger(o.batchSize) || o.batchSize < 1 || o.batchSize > 100000)) {
    return "Rows per INSERT must be a whole number from 1 to 100000.";
  }
  if (o.data && o.commitEvery !== undefined && (!Number.isInteger(o.commitEvery) || o.commitEvery < 0 || o.commitEvery > 1000000)) {
    return "Commit every N rows must be a whole number from 0 to 1000000.";
  }
  const target = o.targetSchema?.trim() ?? "";
  if (target.length > 128) return "The target schema name is longer than 128 characters.";
  if (/[\u0000-\u001f\u007f]/.test(target)) return "The target schema name contains control characters.";
  return null;
}

/** `sales` -> `sales.sql`; characters that do not belong in a file name become `_`. */
export function dumpFileName(schema: string): string {
  const base = schema.trim().replace(/[^\w.-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  return `${base || "dump"}.sql`;
}

/** Which routines the option means for the driver: PostgreSQL dumps triggers only. */
export function routinesLabel(driver: Driver): string {
  return driver === "postgres" ? "Triggers" : "Routines and triggers";
}

/** A progress event's phase as a short sentence for the dialog. */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "schema":
      return "Reading the schema";
    case "tables":
      return "Writing tables";
    case "data":
      return "Writing rows";
    case "indexes":
      return "Writing indexes";
    case "foreign keys":
      return "Writing foreign keys";
    case "views":
      return "Writing views";
    case "routines":
      return "Writing routines and triggers";
    default:
      return phase;
  }
}

/** `1234567` -> `1,234,567`. */
export function groupDigits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Share of the tables written, 0..1 (0 while the total is not known). */
export function dumpFraction(p: DumpProgress): number {
  if (!(p.tablesTotal > 0)) return 0;
  return Math.min(1, Math.max(0, p.tablesDone / p.tablesTotal));
}

/** `Dumping orders (2 of 5) — 1,234 rows` while a table is written; `Writing tables: table 3 of 12, 1,234 rows` between tables. */
export function dumpProgressText(p: DumpProgress): string {
  const rows = `${groupDigits(p.rows)} ${p.rows === 1 ? "row" : "rows"}`;
  if (p.table) return `Dumping ${p.table} (${p.tablesDone} of ${p.tablesTotal}) — ${rows}`;
  const table = p.tablesTotal > 0 ? `table ${p.tablesDone} of ${p.tablesTotal}` : `${p.tablesDone} tables`;
  return `${phaseLabel(p.phase)}: ${table}, ${rows}`;
}

/** `sales`, or `3 tables of sales` when only some of its tables are dumped (the dialog's Source line). */
export function dumpScopeText(schema: string, tables?: string[]): string {
  if (!tables) return schema;
  return `${tables.length} ${tables.length === 1 ? "table" : "tables"} of ${schema}`;
}

/** `3 tables, 1,234 rows` (the notification of a finished dump). */
export function dumpResultText(r: Pick<DumpResult, "tables" | "rows">): string {
  return `${r.tables} ${r.tables === 1 ? "table" : "tables"}, ${groupDigits(r.rows)} ${r.rows === 1 ? "row" : "rows"}`;
}
