/**
 * Pure helpers of the table data editor: identifier quoting, the `select * from ...` behind the view,
 * ORDER BY <-> header sort, column-filter conditions, the pending-changes SQL preview and the mapping of
 * grid changes to dbcore `RowChange`s (with the hidden row locators of tables without a primary key).
 */
import type { Cell as ApiCell, ColumnMeta, Driver, ObjectRef, RowChange } from "../../api/types";
// direct module paths: the grid barrel pulls in the Solid components (not loadable in the node test environment)
import { classifyType, isBinaryCell, isDefaultCell } from "../../components/grid/format";
import type { Cell, GridChange, SortSpec } from "../../components/grid/types";

const SIMPLE_IDENT = /^[a-z_][a-z0-9_$]*$/;

export function quoteIdent(driver: Driver, name: string): string {
  return driver === "mysql" ? "`" + name.replace(/`/g, "``") + "`" : '"' + name.replace(/"/g, '""') + '"';
}

/** `schema.table`, both parts quoted when needed (`always`: quote every part). */
export function qualifiedName(driver: Driver, ref: Pick<ObjectRef, "schema" | "name">, always = false): string {
  const q = (s: string) => (always || !SIMPLE_IDENT.test(s) ? quoteIdent(driver, s) : s);
  return ref.schema ? `${q(ref.schema)}.${q(ref.name)}` : q(ref.name);
}

/** The query behind the table editor, as exported (`select * from <table> where ... order by ...`). */
export function selectSql(driver: Driver, ref: ObjectRef, where: string, orderBy: string, quoteAll = true): string {
  let sql = "select * from " + qualifiedName(driver, ref, quoteAll);
  if (where.trim()) sql += " where " + where.trim();
  if (orderBy.trim()) sql += " order by " + orderBy.trim();
  return sql;
}

/**
 * The query behind a table editor page as DataGrip logs it: `SELECT t.* FROM sales.clients t LIMIT 501` (one more
 * row than the page, to know whether there is a next page). `all` has no LIMIT.
 */
export function tableQuerySql(driver: Driver, ref: ObjectRef, where: string, orderBy: string, pageSize: number | "all", page: number): string {
  let sql = `SELECT t.* FROM ${qualifiedName(driver, ref)} t`;
  if (where.trim()) sql += " WHERE " + where.trim();
  if (orderBy.trim()) sql += " ORDER BY " + orderBy.trim();
  if (pageSize !== "all") {
    sql += ` LIMIT ${pageSize + 1}`;
    if (page > 0) sql += ` OFFSET ${page * pageSize}`;
  }
  return sql;
}

// ---------------------------------------------------------------- ORDER BY <-> header sort

/** `"name" desc, id` for the header sort state. */
export function sortToOrderBy(driver: Driver, columns: { name: string }[], sort: SortSpec[]): string {
  return sort
    .filter((s) => columns[s.col])
    .map((s) => quoteIdent(driver, columns[s.col].name) + (s.dir === "desc" ? " desc" : ""))
    .join(", ");
}

/** Header sort state of a plain `col [asc|desc], ...` list; anything else (expressions, nulls first...) gives `[]`. */
export function orderByToSort(orderBy: string, columns: { name: string }[]): SortSpec[] {
  const text = orderBy.trim();
  if (!text) return [];
  const out: SortSpec[] = [];
  for (const part of splitTop(text)) {
    const m = /^\s*(?:(?:"[^"]*"|`[^`]*`|\w+)\s*\.\s*)?("(?:[^"]|"")*"|`(?:[^`]|``)*`|[\w$]+)\s*(asc|desc)?\s*$/i.exec(part);
    if (!m) return [];
    let name = m[1];
    if (name[0] === '"' || name[0] === "`") name = name.slice(1, -1).replace(name[0] + name[0], name[0]);
    let col = columns.findIndex((c) => c.name === name);
    if (col < 0) col = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    if (col < 0) return [];
    out.push({ col, dir: m[2]?.toLowerCase() === "desc" ? "desc" : "asc" });
  }
  return out;
}

/** Splits on top-level commas (outside quotes and parentheses). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = "";
  let cur = "";
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------- literals and column filter

/**
 * `'...'` string literal. MySQL reads `\` inside it as an escape (`'C:\temp'` is a TAB), so it is doubled there;
 * PostgreSQL (standard_conforming_strings) and SQLite take it literally.
 */
export function quoteString(driver: Driver | undefined, v: string): string {
  const s = driver === "mysql" ? v.replace(/\\/g, "\\\\") : v;
  return "'" + s.replace(/'/g, "''") + "'";
}

/** SQL literal of a cell (preview and filter conditions). */
export function literal(v: Cell, typeName: string, driver?: Driver): string {
  if (v === null || v === undefined) return "null";
  if (isDefaultCell(v)) return "DEFAULT";
  const kind = classifyType(typeName);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") {
    if (kind === "number" && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return v.trim();
    if (kind === "bool" && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase();
    return quoteString(driver, v);
  }
  if (isBinaryCell(v)) return "'\\x" + v.$bin + "'";
  return quoteString(driver, JSON.stringify(v));
}

export type FilterOp = "=" | "<>" | "<" | ">" | "<=" | ">=" | "like" | "not like" | "is null" | "is not null";

export const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: "=", label: "=" },
  { value: "<>", label: "<>" },
  { value: "<", label: "<" },
  { value: ">", label: ">" },
  { value: "<=", label: "<=" },
  { value: ">=", label: ">=" },
  { value: "like", label: "like" },
  { value: "not like", label: "not like" },
  { value: "is null", label: "is null" },
  { value: "is not null", label: "is not null" },
];

/** `"col" = 5` for the column filter popup. */
export function buildCondition(driver: Driver, col: ColumnMeta, op: FilterOp, value: string): string {
  const name = quoteIdent(driver, col.name);
  if (op === "is null" || op === "is not null") return `${name} ${op}`;
  const kind = classifyType(col.typeName);
  let lit: string;
  if (op === "like" || op === "not like") lit = quoteString(driver, value);
  else if ((kind === "number" || kind === "bool") && value.trim() !== "" && literal(value, col.typeName)[0] !== "'") lit = literal(value, col.typeName);
  else lit = quoteString(driver, value);
  return `${name} ${op} ${lit}`;
}

/** Appends `cond` to an existing WHERE text with AND. */
export function appendCondition(where: string, cond: string): string {
  const w = where.trim();
  if (!w) return cond;
  return /\b(or)\b/i.test(w) ? `(${w}) and ${cond}` : `${w} and ${cond}`;
}

// ---------------------------------------------------------------- pending changes -> RowChange

const ORDER: Record<GridChange["kind"], number> = { delete: 0, update: 1, insert: 2 };

/**
 * Grid changes in the order DataGrip applies and previews them (DELETE, UPDATE, INSERT), as dbcore `RowChange`s.
 * Without a primary key (`locatorOf` given) update / delete carry the hidden locator of the row at `change.row`
 * (index in the row source) and `key` is dropped.
 * Throws if the original row of an update / delete is not known (its page was evicted).
 */
export function toRowChanges(
  changes: GridChange[],
  columns: { name: string; isPk?: boolean }[],
  locatorOf?: (row: number) => Cell | undefined,
): RowChange[] {
  const hasPk = columns.some((c) => c.isPk);
  return [...changes]
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
    .map<RowChange>((c) => {
      if (c.kind === "insert") return { kind: "insert", values: c.values as Record<string, ApiCell> };
      if (Object.keys(c.key).length === 0) throw new Error("The original row is no longer loaded. Reload the page and repeat the change.");
      const out: RowChange = { kind: c.kind, key: c.key as Record<string, ApiCell> };
      if (c.kind === "update") out.values = c.values as Record<string, ApiCell>;
      if (!hasPk && locatorOf) {
        const loc = locatorOf(c.row);
        if (loc !== undefined) {
          out.rowLocator = loc as ApiCell;
          delete out.key;
        }
      }
      return out;
    });
}

// ---------------------------------------------------------------- preview

/** The statements Submit would run, formatted like DataGrip's "Preview Pending Changes" popup. */
export function previewSql(driver: Driver, ref: ObjectRef, columns: ColumnMeta[], changes: GridChange[]): string {
  const table = qualifiedName(driver, ref);
  const id = (s: string) => (SIMPLE_IDENT.test(s) ? s : quoteIdent(driver, s));
  const typeOf = (name: string) => columns.find((c) => c.name === name)?.typeName ?? "";
  const where = (key: Record<string, Cell>) =>
    Object.entries(key)
      .map(([k, v]) => (v === null || v === undefined ? `${id(k)} is null` : `${id(k)} = ${literal(v, typeOf(k), driver)}`))
      .join(" AND ");
  const out: string[] = [];
  for (const c of [...changes].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])) {
    const entries = Object.entries(c.values);
    if (c.kind === "delete") out.push(`DELETE\nFROM ${table}\nWHERE ${where(c.key)};`);
    else if (c.kind === "update")
      out.push(`UPDATE ${table}\nSET ${entries.map(([k, v]) => `${id(k)} = ${literal(v, typeOf(k), driver)}`).join(",\n    ")}\nWHERE ${where(c.key)};`);
    else if (entries.length === 0) out.push(`INSERT INTO ${table}\nDEFAULT VALUES;`);
    else out.push(`INSERT INTO ${table} (${entries.map(([k]) => id(k)).join(", ")})\nVALUES (${entries.map(([k, v]) => literal(v, typeOf(k), driver)).join(", ")});`);
  }
  return out.join("\n\n");
}
