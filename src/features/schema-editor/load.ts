/**
 * Loads the structure of a table into the dialog's model: the folders of the explorer tree (`introspect`) plus a few
 * catalog queries for what the tree does not carry (owner, tablespace, generated columns, SQLite's original SQL).
 */
import { type Cell, type TreeNode, closeSession, executeCollect, introspect, openSession } from "../../api/db";
import {
  type CheckDef,
  type ColumnDef,
  type Driver,
  type FkDef,
  type IndexDef,
  type KeyDef,
  type TableDef,
  newCheck,
  newColumn,
  newFk,
  newIndex,
  newKey,
  splitTop,
} from "./model";
import { literal } from "./sqlgen";

/** Where the dialog works: a data source, its dialect and the schema (with the explorer path of the schema). */
export interface EditorCtx {
  dsId: string;
  dsName: string;
  driver: Driver;
  schema: string;
  /** Backend path of the schema node (`[db, schema]` PostgreSQL, `[schema]` MySQL / SQLite). */
  schemaPath: string[];
}

export const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

/** Runs read-only catalog queries on one session. Rows of the first result set of each query. */
export async function queryRows(dsId: string, queries: string[]): Promise<Cell[][][]> {
  const session = await openSession(dsId);
  try {
    const out: Cell[][][] = [];
    for (const q of queries) {
      const events = await executeCollect(session, q);
      const err = events.find((e) => e.kind === "error");
      if (err && err.kind === "error") throw new Error(err.message);
      const rs = events.find((e) => e.kind === "resultset");
      out.push(rs && rs.kind === "resultset" ? rs.rows : []);
    }
    return out;
  } finally {
    void closeSession(session).catch(() => {});
  }
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

// ---------------------------------------------------------------- SQLite: what the pragmas do not tell

/** Index of the `)` that closes the `(` at `open` (quotes and nested parentheses skipped); -1 if unbalanced. */
function closingParen(s: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "[") quote = "]";
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

export interface SqliteTableSql {
  checks: { name: string; expr: string }[];
  autoincrement: boolean;
  options: string;
  warnings: string[];
}

/** Checks (column and table level), `autoincrement`, `without rowid` / `strict` of a `create table` statement. */
export function parseSqliteTable(sql: string): SqliteTableSql {
  const open = sql.indexOf("(");
  const close = open < 0 ? -1 : closingParen(sql, open);
  const out: SqliteTableSql = { checks: [], autoincrement: /\bautoincrement\b/i.test(sql), options: "", warnings: [] };
  if (open < 0 || close < 0) return out;
  const tail = sql.slice(close + 1).replace(/;\s*$/, "").trim();
  if (/^(without\s+rowid|strict)(\s*,\s*(without\s+rowid|strict))?$/i.test(tail)) out.options = tail;
  for (const def of splitTop(sql.slice(open + 1, close))) {
    const m = /(?:\bconstraint\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s+)?\bcheck\s*\(/i.exec(def);
    if (!m) continue;
    const start = m.index + m[0].length - 1;
    const end = closingParen(def, start);
    if (end < 0) continue;
    out.checks.push({ name: (m[1] ?? "").replace(/^["`[]|["`\]]$/g, ""), expr: def.slice(start + 1, end).trim() });
  }
  if (/\bcollate\b/i.test(sql)) out.warnings.push("COLLATE clauses of columns are not kept by a rebuild.");
  if (/\bon\s+conflict\b/i.test(sql)) out.warnings.push("ON CONFLICT clauses are not kept by a rebuild.");
  return out;
}

// ---------------------------------------------------------------- tree nodes -> model

/** `CHECK ((price > 0)) NOT VALID` -> `(price > 0)`. */
function checkExpr(def: string): string {
  const m = /^\s*CHECK\s*\(/i.exec(def);
  if (!m) return def.trim();
  const open = m[0].length - 1;
  const close = closingParen(def, open);
  return close < 0 ? def.trim() : def.slice(open + 1, close).trim();
}

function pgAction(def: string, what: "UPDATE" | "DELETE"): string {
  const m = new RegExp(`ON ${what} (NO ACTION|RESTRICT|CASCADE|SET NULL|SET DEFAULT)`, "i").exec(def);
  return m ? m[1].toUpperCase() : "NO ACTION";
}

const MY_NUMERIC = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year)\b/i;

function mysqlDefaultOf(extra: Record<string, unknown>, type: string): string {
  const v = extra.default;
  if (v == null) return "";
  const text = String(v);
  if (/DEFAULT_GENERATED/i.test(str(extra.extra))) return text;
  if (MY_NUMERIC.test(type) && /^-?\d+(\.\d+)?$/.test(text)) return text;
  return literal("mysql", text);
}

function columnOf(driver: Driver, tn: TreeNode): ColumnDef {
  const ex = tn.extra as Record<string, unknown>;
  const type = tn.hint ?? str(ex.dataType);
  const c = newColumn({ name: tn.name, type, notNull: ex.nullable === false, comment: str(ex.comment) });
  if (driver === "postgres") {
    const id = str(ex.identity);
    c.identity = id === "a" ? "ALWAYS" : id === "d" ? "BY DEFAULT" : "";
    if (str(ex.generated)) c.generated = str(ex.default) || "?";
    else c.default = str(ex.default);
  } else if (driver === "mysql") {
    const extra = str(ex.extra);
    c.default = mysqlDefaultOf(ex, type);
    c.autoIncrement = /auto_increment/i.test(extra);
    const on = /on update (\S+)/i.exec(extra);
    c.onUpdate = on ? on[1] : "";
    const g = /(STORED|VIRTUAL) GENERATED/i.exec(extra);
    if (g) {
      c.generated = "?";
      c.generatedStored = g[1].toUpperCase() === "STORED";
      c.default = "";
    }
  } else {
    c.default = str(ex.default);
    if (ex.generated) c.generated = "?";
  }
  return c;
}

export interface TableNodes {
  columns: TreeNode[];
  keys: TreeNode[];
  fks: TreeNode[];
  indexes: TreeNode[];
  checks: TreeNode[];
}

/** Builds the model from the nodes of the folders (exported for the tests). */
export function tableFromNodes(driver: Driver, schema: string, name: string, tableExtra: Record<string, unknown>, n: TableNodes): TableDef {
  const keys: KeyDef[] = n.keys.map((k) =>
    newKey({
      // SQLite constraints have no names (the tree numbers them)
      name: driver === "sqlite" ? "" : k.name,
      primary: k.kind === "primaryKey",
      columns: strs(k.extra.columns),
    }),
  );
  const keyNames = new Set(n.keys.map((k) => k.name));
  const fks: FkDef[] = n.fks.map((f) => {
    const def = str(f.extra.definition);
    return newFk({
      name: driver === "sqlite" ? "" : f.name,
      columns: strs(f.extra.columns),
      refSchema: str(f.extra.refSchema),
      refTable: str(f.extra.refTable),
      refColumns: strs(f.extra.refColumns),
      onUpdate: driver === "postgres" ? pgAction(def, "UPDATE") : str(f.extra.onUpdate).toUpperCase() || "NO ACTION",
      onDelete: driver === "postgres" ? pgAction(def, "DELETE") : str(f.extra.onDelete).toUpperCase() || "NO ACTION",
    });
  });
  const indexes: IndexDef[] = n.indexes
    // the index behind a primary / unique key is part of the key
    .filter((i) => !i.extra.primary && !keyNames.has(i.name))
    .map((i) => {
      const def = str(i.extra.definition);
      const locked = driver === "postgres" ? /\b(where|include)\b/i.test(def.replace(/'[^']*'/g, "")) : !!i.extra.partial;
      return newIndex({
        name: i.name,
        unique: !!i.extra.unique,
        columns: splitTop(str(i.extra.columns)),
        method: driver === "postgres" ? str(i.extra.method) : "",
        locked,
        definition: locked ? def : undefined,
      });
    });
  const checks: CheckDef[] = n.checks.map((c) => newCheck({ name: c.name, expr: driver === "mysql" ? str(c.extra.definition) : checkExpr(str(c.extra.definition)) }));
  const t: TableDef = {
    schema,
    name,
    comment: str(tableExtra.comment),
    owner: "",
    tablespace: "",
    columns: n.columns.map((c) => columnOf(driver, c)),
    keys,
    fks,
    indexes,
    checks,
    sqliteOptions: "",
    triggers: [],
    tableCollation: "",
    warnings: [],
  };
  if (driver === "sqlite") for (const c of t.columns) c.autoIncrement = false;
  return t;
}

// ---------------------------------------------------------------- loading

/** The explorer path of a table of the schema. */
export const tablePath = (ctx: EditorCtx, name: string): string[] => [...ctx.schemaPath, "tables", name];

export async function loadTable(ctx: EditorCtx, name: string, tableExtra: Record<string, unknown> = {}): Promise<TableDef> {
  const base = tablePath(ctx, name);
  const kids = (sub: string): Promise<TreeNode[]> => introspect(ctx.dsId, [...base, sub]).catch(() => []);
  const [columns, keys, fks, indexes, checks] = await Promise.all([kids("columns"), kids("keys"), kids("foreign_keys"), kids("indexes"), kids("checks")]);
  if (!columns.length) throw new Error(`Table ${ctx.schema}.${name} not found`);
  const t = tableFromNodes(ctx.driver, ctx.schema, name, tableExtra, { columns, keys, fks, indexes, checks });
  try {
    if (ctx.driver === "postgres") await pgExtras(ctx, t);
    else if (ctx.driver === "mysql") await mysqlExtras(ctx, t);
    else await sqliteExtras(ctx, t);
  } catch {
    /* the extras are nice to have: the dialog still works without them */
  }
  return t;
}

async function pgExtras(ctx: EditorCtx, t: TableDef): Promise<void> {
  const [[row]] = await queryRows(ctx.dsId, [
    `select pg_get_userbyid(c.relowner), coalesce(ts.spcname, '') from pg_class c join pg_namespace n on n.oid = c.relnamespace ` +
      `left join pg_tablespace ts on ts.oid = c.reltablespace where n.nspname = ${literal("postgres", ctx.schema)} and c.relname = ${literal("postgres", t.name)}`,
  ]);
  if (row) {
    t.owner = str(row[0]);
    t.tablespace = str(row[1]);
  }
}

async function mysqlExtras(ctx: EditorCtx, t: TableDef): Promise<void> {
  const [sc, tn] = [literal("mysql", ctx.schema), literal("mysql", t.name)];
  const [cols, tbl] = await queryRows(ctx.dsId, [
    `select column_name, generation_expression, collation_name from information_schema.columns where table_schema = ${sc} and table_name = ${tn}`,
    `select table_collation from information_schema.tables where table_schema = ${sc} and table_name = ${tn}`,
  ]);
  t.tableCollation = str(tbl[0]?.[0]);
  for (const r of cols) {
    const c = t.columns.find((x) => x.name === str(r[0]));
    if (!c) continue;
    if (c.generated && str(r[1])) c.generated = str(r[1]);
    c.collation = str(r[2]);
  }
}

async function sqliteExtras(ctx: EditorCtx, t: TableDef): Promise<void> {
  const [rows] = await queryRows(ctx.dsId, [
    `select type, name, sql from "${ctx.schema.replace(/"/g, '""')}".sqlite_master where tbl_name = ${literal("sqlite", t.name)} and sql is not null`,
  ]);
  const own = rows.find((r) => str(r[0]) === "table");
  if (own) {
    const info = parseSqliteTable(str(own[2]));
    t.checks = info.checks.map((c) => newCheck({ name: c.name, expr: c.expr }));
    t.sqliteOptions = info.options;
    t.warnings = info.warnings;
    const pk = t.keys.find((k) => k.primary);
    if (info.autoincrement && pk?.columns.length === 1) {
      const col = t.columns.find((c) => c.name === pk.columns[0]);
      if (col) col.autoIncrement = true;
    }
  }
  t.triggers = rows.filter((r) => str(r[0]) === "trigger").map((r) => str(r[2]));
  for (const i of t.indexes) {
    if (!i.locked) continue;
    const r = rows.find((x) => str(x[0]) === "index" && str(x[1]) === i.name);
    i.definition = r ? str(r[2]) : undefined;
  }
}

/** Names of the tables of the schema (for the target of a foreign key). */
export async function loadTableNames(ctx: EditorCtx): Promise<string[]> {
  const nodes = await introspect(ctx.dsId, [...ctx.schemaPath, "tables"]).catch(() => []);
  return nodes.map((n) => n.name);
}

/** Column names of a table of the schema. */
export async function loadColumnNames(ctx: EditorCtx, table: string): Promise<string[]> {
  const nodes = await introspect(ctx.dsId, [...tablePath(ctx, table), "columns"]).catch(() => []);
  return nodes.map((n) => n.name);
}
