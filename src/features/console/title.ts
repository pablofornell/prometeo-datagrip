/**
 * Name of a result tab (DataGrip's "main.customers" / "postgres.sales.invoices"). The table comes from the column
 * metadata when the backend reports it (`ColumnMeta.tableRef`, PostgreSQL); otherwise (MySQL, SQLite) it is read
 * from the statement itself when that is a plain `SELECT ... FROM table [alias] [WHERE|ORDER BY|LIMIT ...]`
 * without joins, subqueries or set operations.
 */
import type { Dialect } from "../../components/editor";
import { lex } from "../../components/editor/lexer";
import type { ColumnMeta } from "../../api/types";

const END = new Set(["where", "order", "limit", "offset", "fetch", "for", "window"]);
const SET_OPS = new Set(["union", "intersect", "except", "minus", "with"]);

const unquote = (s: string): string => {
  const q = s[0];
  if (q === '"' || q === "`") return s.slice(1, -1).replaceAll(q + q, q);
  if (q === "[") return s.slice(1, -1);
  return s;
};

/** Parts (`[schema, table]` or `[table]` ...) of the single table a SELECT reads, or null. */
export function singleTable(sql: string, dialect: Dialect): string[] | null {
  const toks = lex(sql, dialect)
    .filter((t) => t.kind !== "comment")
    .map((t) => ({ ...t, text: sql.slice(t.from, t.to) }));
  if (!toks.length || toks[0].text.toLowerCase() !== "select") return null;
  let depth = 0;
  let from = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.text === "(") depth++;
    else if (t.text === ")") depth--;
    else if (t.kind === "word") {
      const w = t.text.toLowerCase();
      if (SET_OPS.has(w)) return null;
      if (depth === 0 && w === "from") {
        if (from >= 0) return null;
        from = i;
      }
    }
  }
  if (from < 0) return null;
  let i = from + 1;
  const parts: string[] = [];
  for (;;) {
    const t = toks[i];
    if (!t || (t.kind !== "word" && t.kind !== "qident")) return null;
    parts.push(unquote(t.text));
    i++;
    if (toks[i]?.text === ".") i++;
    else break;
  }
  if (toks[i]?.text.toLowerCase() === "as") i++;
  else if (toks[i] && (toks[i].kind === "word" || toks[i].kind === "qident") && !END.has(toks[i].text.toLowerCase())) {
    const w = toks[i].text.toLowerCase();
    if (["join", "inner", "left", "right", "full", "cross", "natural", "group", "having", "union"].includes(w)) return null;
  }
  // optional alias
  if (toks[i] && (toks[i].kind === "word" || toks[i].kind === "qident") && !END.has(toks[i].text.toLowerCase())) i++;
  const rest = toks[i];
  if (!rest || rest.text === ";") return parts;
  return rest.kind === "word" && END.has(rest.text.toLowerCase()) ? parts : null;
}

/**
 * Parts (`[schema, table]`) of the single table a result comes from: the one table the columns report
 * (expression columns, which report none, are ignored), or null when they report several (a join).
 * Falls back to parsing the statement when no column reports a table.
 */
export function resultTable(meta: Pick<ColumnMeta, "tableRef">[], sql: string, dialect: Dialect): string[] | null {
  const refs = new Set(meta.map((c) => c.tableRef).filter((r): r is string => !!r));
  if (refs.size > 1) return null;
  if (refs.size === 1) {
    const ref = [...refs][0];
    const dot = ref.indexOf(".");
    return dot < 0 ? [ref] : [ref.slice(0, dot), ref.slice(dot + 1)];
  }
  return singleTable(sql, dialect);
}

/** DataGrip's tab name: `postgres.sales.invoices` (PG), `demo.orders` (MySQL), `main.customers` (SQLite). */
export function qualifiedTitle(parts: string[], dialect: Dialect, database: string, schema: string | null): string {
  const p = [...parts];
  if (dialect === "postgres") {
    if (p.length === 1) p.unshift(schema ?? "public");
    if (p.length === 2) p.unshift(database);
  } else if (p.length === 1) p.unshift(dialect === "sqlite" ? "main" : (schema ?? database));
  return p.join(".");
}
