/**
 * Editable query results, like DataGrip: a console result becomes editable when it is a plain
 * `SELECT ... FROM one_table ...` and the table's primary key (or a unique key) is fully in the result.
 *
 *  - The table: PostgreSQL reports it per column (`ColumnMeta.tableRef`); MySQL / SQLite do not, so the statement is
 *    parsed (`title.singleTable`). The statement must be a single-table select in every dialect, because a PG
 *    self-join reports the same `tableRef` for both sides.
 *  - Confirmed with the table's metadata (`introspect`): it must be a real table (not a view), and its key columns
 *    decide which results can be edited.
 *  - A result column is editable (and may be part of the key) only when it is a plain reference to that table column:
 *    `col`, `t.col`, `col as col`, or a `*` expansion. The select list is parsed (`selectItems`) because matching by
 *    output name alone let `select customer_id as id` (or `id + 1 as id`) be taken for the key `id`, and the UPDATE hit
 *    another row. `ColumnMeta` carries only the table, not the column it came from.
 *  - The user's SQL is never rewritten. PG `ctid` / SQLite `rowid` locators exist only in `table_data`, so a result
 *    of a table without PK / unique key stays read-only (the table editor edits those).
 */
import { introspect } from "../../api/db";
import type { ColumnMeta, DataSource, TreeNode } from "../../api/types";
import { lex } from "../../components/editor/lexer";
import type { EditTarget } from "../output/edit";
import { singleTable } from "./title";

/** Words that make a result not a 1:1 view of the table's rows. */
const SHAPE_BREAKERS = new Set(["distinct", "group", "having", "over", "window", "union", "intersect", "except", "into"]);

/**
 * Whether the select list only has plain columns. PostgreSQL tells expression columns apart by their missing
 * `tableRef`; for MySQL / SQLite a function call in the select list (`max(id) as id`) could be taken for a column,
 * so any call disqualifies the result.
 */
export function plainSelect(sql: string, dialect: DataSource["driver"]): boolean {
  const toks = lex(sql, dialect)
    .filter((t) => t.kind !== "comment")
    .map((t) => ({ ...t, text: sql.slice(t.from, t.to) }));
  let depth = 0;
  let inList = true;
  for (const t of toks) {
    if (t.text === "(") {
      depth++;
      if (inList && dialect !== "postgres") return false;
    } else if (t.text === ")") depth--;
    else if (t.kind === "word" && depth === 0) {
      const w = t.text.toLowerCase();
      if (SHAPE_BREAKERS.has(w)) return false;
      if (w === "from") inList = false;
    }
  }
  return true;
}

const lower = (s: string) => s.toLowerCase();

/** One entry of a select list: `*` / `t.*`, a plain column reference (with its alias) or any other expression. */
export type SelectItem = { star: true } | { star: false; column: string | null; alias: string | null };

const unq = (s: string): string => {
  const q = s[0];
  if (q === '"' || q === "`") return s.slice(1, -1).replaceAll(q + q, q);
  if (q === "[") return s.slice(1, -1);
  return s;
};

/**
 * The select list of `select ... from ...` split into items, or null when it cannot be read.
 * `column` is the referenced column name for `col`, `t.col`, `s.t.col` (null for an expression); `alias` the
 * `as x` / bare alias, null without one.
 */
export function selectItems(sql: string, dialect: DataSource["driver"]): SelectItem[] | null {
  const toks = lex(sql, dialect)
    .filter((t) => t.kind !== "comment")
    .map((t) => ({ ...t, text: sql.slice(t.from, t.to) }));
  if (!toks.length || toks[0].text.toLowerCase() !== "select") return null;
  const groups: (typeof toks)[] = [[]];
  let depth = 0;
  for (const t of toks.slice(1)) {
    if (t.text === "(" || t.text === "[") depth++;
    else if (t.text === ")" || t.text === "]") depth--;
    if (depth === 0 && t.kind === "word" && lower(t.text) === "from") break;
    if (depth === 0 && t.text === ",") groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  if (depth !== 0) return null;
  const isName = (k: string) => k === "word" || k === "qident";
  const parse = (g: typeof toks): SelectItem | null => {
    const expr: SelectItem = { star: false, column: null, alias: null };
    if (!g.length) return null;
    let i = 0;
    const parts: string[] = [];
    for (;;) {
      const t = g[i];
      if (!t) return expr;
      if (t.text === "*") return i === g.length - 1 ? { star: true } : expr;
      if (!isName(t.kind)) return expr;
      parts.push(unq(t.text));
      i++;
      if (g[i]?.text === ".") i++;
      else break;
    }
    const column = parts[parts.length - 1];
    const rest = g.slice(i);
    if (rest.length === 0) return { star: false, column, alias: null };
    if (rest.length === 2 && lower(rest[0].text) === "as" && isName(rest[1].kind)) return { star: false, column, alias: unq(rest[1].text) };
    if (rest.length === 1 && isName(rest[0].kind)) return { star: false, column, alias: unq(rest[0].text) };
    return expr;
  };
  const items: SelectItem[] = [];
  for (const g of groups) {
    const it = parse(g);
    if (!it) return null;
    items.push(it);
  }
  return items;
}

/** `[schema, table]` or `[table]` of the table the result comes from, or null (join, expression only, ...). */
export function tableOf(meta: Pick<ColumnMeta, "tableRef">[], sql: string, dialect: DataSource["driver"]): string[] | null {
  if (!plainSelect(sql, dialect)) return null;
  const parsed = singleTable(sql, dialect);
  if (!parsed) return null;
  const refs = new Set(meta.map((c) => c.tableRef).filter((r): r is string => !!r));
  if (refs.size > 1) return null;
  if (refs.size === 0) return parsed;
  const ref = [...refs][0];
  const dot = ref.indexOf(".");
  const parts = dot < 0 ? [ref] : [ref.slice(0, dot), ref.slice(dot + 1)];
  // a view reports its base table: the statement names another relation, so the rows are not the table's
  return lower(parts[parts.length - 1]) === lower(parsed[parsed.length - 1]) ? parts : null;
}

const isGenerated = (n: TreeNode): boolean => {
  const x = n.extra;
  if (typeof x.generated === "string") return x.generated !== "";
  if (typeof x.generated === "boolean") return x.generated;
  return typeof x.extra === "string" && /generated/i.test(x.extra);
};

/** What `schemaChange` reads out of a statement. */
export interface SchemaChange {
  /** The schema the statement selects when the text says it unambiguously (`USE x`, `SET search_path TO x`), else null. */
  schema: string | null;
  /**
   * PostgreSQL: the value list of `SET search_path` / `SET SCHEMA` exactly as written (`"$user", public`), which is
   * what a reopened session must run again (`SET search_path TO <searchPath>`); null when the statement resets it
   * (`DEFAULT`, `RESET`, `DISCARD ALL`). Absent for MySQL `USE`.
   */
  searchPath?: string | null;
}

/**
 * Whether a statement switches the session's schema: `{ schema, searchPath? }` (`schema` is null when it cannot be
 * read from the text: `"$user", public` and `pg_temp, public` do not select a schema called `$user` / `pg_temp`, the
 * server knows which one `current_schema()` is), or null when the statement does not touch it. Only the START of the
 * statement counts: `update t set ...` and `select 'use x'` do not (a regex over the whole script took them for `SET`
 * / `USE`).
 */
export function schemaChange(stmt: string, dialect: DataSource["driver"]): SchemaChange | null {
  if (dialect === "sqlite") return null;
  const all = lex(stmt, dialect)
    .filter((t) => t.kind !== "comment")
    .map((t) => ({ kind: t.kind, from: t.from, to: t.to, text: stmt.slice(t.from, t.to) }));
  const toks = all.slice(0, 8);
  const w = (i: number) => (toks[i]?.kind === "word" ? lower(toks[i].text) : "");
  const name = (i: number): string | null => {
    const t = toks[i];
    if (!t) return null;
    if (t.kind === "string") return t.text.slice(1, -1).replaceAll("''", "'");
    if (t.kind === "word" || t.kind === "qident") return lower(t.text) === "default" ? null : unq(t.text);
    return null;
  };
  if (dialect === "mysql") return w(0) === "use" ? { schema: name(1) } : null;
  if (w(0) === "discard" && w(1) === "all") return { schema: null, searchPath: null };
  if (w(0) === "reset" && (w(1) === "search_path" || w(1) === "all")) return { schema: null, searchPath: null };
  if (w(0) !== "set") return null;
  let i = 1;
  if (w(i) === "local") return null; // reverts when the transaction ends
  if (w(i) === "session") i++;
  // the values after `TO` / `=` / `SCHEMA`, up to the closing `;`
  const values = (from: number) => {
    let rest = all.slice(from);
    while (rest.length && rest[rest.length - 1].text === ";") rest = rest.slice(0, -1);
    return rest;
  };
  const change = (from: number): SchemaChange => {
    const v = values(from);
    if (v.length === 0) return { schema: null };
    if (v.length === 1 && v[0].kind === "word" && lower(v[0].text) === "default") return { schema: null, searchPath: null };
    const text = stmt.slice(v[0].from, v[v.length - 1].to);
    const one = v.length === 1 ? name(from) : null; // a list picks its schema on the server
    const special = one !== null && /^(\$user|pg_temp(_\d+)?|pg_catalog)$/i.test(one);
    return { schema: special ? null : one, searchPath: text };
  };
  if (w(i) === "schema") return change(i + 1);
  if (w(i) === "search_path" && (w(i + 1) === "to" || toks[i + 1]?.text === "=")) return change(i + 2);
  return null;
}

/**
 * For each result column the table column it is a plain reference to (same name, no renaming alias, no expression),
 * or null. Returns null as a whole when the select list does not line up with the result (then nothing is editable).
 * `tableColumns` expands the `*` items.
 */
export function plainSources(items: SelectItem[] | null, tableColumns: string[], names: string[]): (string | null)[] | null {
  if (!items) return null;
  const stars = items.filter((i) => i.star).length;
  if (names.length !== items.length - stars + stars * tableColumns.length) return null;
  const out: (string | null)[] = [];
  for (const it of items) {
    if (it.star) {
      for (const c of tableColumns) {
        if (names[out.length] !== c) return null;
        out.push(c);
      }
      continue;
    }
    if (it.column === null) {
      out.push(null); // an expression, whatever it is called
      continue;
    }
    const name = names[out.length];
    if (lower(it.alias ?? it.column) !== lower(name)) return null; // the list does not match the result
    const col = tableColumns.find((c) => c === it.column) ?? tableColumns.find((c) => lower(c) === lower(it.column!));
    // `customer_id as id`: the output name is not the column it is built from
    out.push(col !== undefined && lower(it.column) === lower(name) ? col : null);
  }
  return out;
}

/**
 * What the grid may edit in a console result, or null when it must stay read-only (also when the metadata cannot be
 * read). `schema` is the console's current schema, for statements that do not qualify the table.
 */
export async function resolveEdit(ds: DataSource, meta: ColumnMeta[], sql: string, schema: string | null): Promise<EditTarget | null> {
  try {
    if (ds.readOnly || meta.length === 0) return null;
    // duplicate names (a.id, b.id) cannot be mapped back to a column
    if (new Set(meta.map((c) => c.name)).size !== meta.length) return null;
    const parts = tableOf(meta, sql, ds.driver);
    if (!parts) return null;
    const name = parts[parts.length - 1];
    const sch = parts.length >= 2 ? parts[parts.length - 2] : ds.driver === "sqlite" ? "main" : (schema ?? (ds.driver === "postgres" ? "public" : ds.database));
    if (!sch) return null;
    const base = ds.driver === "postgres" ? [ds.database, sch] : [sch];

    const tables = await introspect(ds.id, [...base, "tables"]);
    const node = tables.find((t) => t.name === name) ?? tables.find((t) => lower(t.name) === lower(name));
    if (!node) return null; // a view, a materialized view or unknown
    const [columns, keys] = await Promise.all([introspect(ds.id, [...node.path, "columns"]), introspect(ds.id, [...node.path, "keys"])]);

    const byName = new Map(columns.map((c) => [c.name, c]));
    // which result columns are plain references to a column of the table (aliases / expressions are not)
    const sources = plainSources(selectItems(sql, ds.driver), columns.map((c) => c.name), meta.map((c) => c.name));
    if (!sources) return null;
    const isPlain = (i: number) => sources[i] !== null && sources[i] === meta[i].name && (ds.driver !== "postgres" || !!meta[i].tableRef);
    const inResult = new Set(meta.filter((_, i) => isPlain(i)).map((c) => c.name));
    // the primary key first, then unique keys
    const candidates = [...keys.filter((k) => k.kind === "primaryKey"), ...keys.filter((k) => k.kind === "uniqueKey")];
    const key = candidates
      .map((k) => (k.extra.columns as string[] | undefined) ?? [])
      .find((cols) => cols.length > 0 && cols.every((c) => inResult.has(c) && byName.has(c)));
    if (!key) return null;

    const editable = meta.map((c, i) => {
      const col = byName.get(c.name);
      return !!col && isPlain(i) && !isGenerated(col);
    });
    return { table: { schema: node.extra.schema ?? sch, name: node.name, kind: "table" }, key, editable };
  } catch {
    return null;
  }
}
