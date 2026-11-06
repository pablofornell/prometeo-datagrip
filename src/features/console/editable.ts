/**
 * Editable query results, like DataGrip: a console result becomes editable when it is a plain
 * `SELECT ... FROM one_table ...` and the table's primary key (or a unique key) is fully in the result.
 *
 *  - The table: PostgreSQL reports it per column (`ColumnMeta.tableRef`); MySQL / SQLite do not, so the statement is
 *    parsed (`title.singleTable`). The statement must be a single-table select in every dialect, because a PG
 *    self-join reports the same `tableRef` for both sides.
 *  - Confirmed with the table's metadata (`introspect`): it must be a real table (not a view), and its key columns
 *    decide which results can be edited.
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
    const inResult = new Set(meta.filter((c) => ds.driver !== "postgres" || c.tableRef).map((c) => c.name));
    // the primary key first, then unique keys
    const candidates = [...keys.filter((k) => k.kind === "primaryKey"), ...keys.filter((k) => k.kind === "uniqueKey")];
    const key = candidates
      .map((k) => (k.extra.columns as string[] | undefined) ?? [])
      .find((cols) => cols.length > 0 && cols.every((c) => inResult.has(c) && byName.has(c)));
    if (!key) return null;

    const editable = meta.map((c) => {
      const col = byName.get(c.name);
      return !!col && inResult.has(c.name) && !isGenerated(col);
    });
    return { table: { schema: node.extra.schema ?? sch, name: node.name, kind: "table" }, key, editable };
  } catch {
    return null;
  }
}
