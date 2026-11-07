/**
 * DDL generation of the Modify Table / New Table dialog (pure functions, no I/O).
 *
 *   createTablePlan(driver, table)            `create table ...` + indexes + comments
 *   alterTablePlan(driver, loaded, edited)    the `alter table ...` statements of the difference
 *
 * PostgreSQL, MySQL and Oracle alter in place (Oracle: `add (...)`, `modify (...)`, `rename column`; its DDL commits by itself). SQLite cannot alter most things: the plan is then the table rebuild
 * (create `<t>_dg_tmp`, copy, drop, rename, recreate indexes and triggers) with the pragmas around it.
 */
import {
  type CheckDef,
  type ColumnDef,
  type Driver,
  type FkDef,
  type IndexDef,
  type KeyDef,
  type TableDef,
} from "./model";
import { isKeyword } from "./keywords";
import { type Rewrite, indexColumnsStart, rewriteColumns, triggerName } from "./sqliteRefs";

export interface Plan {
  /** Run before the transaction (SQLite pragmas). */
  pre: string[];
  statements: string[];
  /** Run after the transaction, also when it failed. */
  post: string[];
  /** PostgreSQL and SQLite run the statements in one transaction (MySQL and Oracle DDL commits by itself). */
  transactional: boolean;
  warnings: string[];
  /** The change cannot be made: the dialog refuses OK and shows this. */
  error?: string;
}

export const planStatements = (p: Plan): string[] => [...p.pre, ...p.statements, ...p.post];
export const planText = (p: Plan): string => planStatements(p).join("\n");
export const planIsEmpty = (p: Plan): boolean => p.statements.length === 0;

// ---------------------------------------------------------------- quoting

export function ident(d: Driver, name: string): string {
  // Oracle folds unquoted names to upper case: only those are written bare
  const simple = d === "postgres" ? /^[a-z_][a-z0-9_$]*$/ : d === "oracle" ? /^[A-Z][A-Z0-9_$#]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/;
  if (simple.test(name) && !isKeyword(d, name)) return name;
  return d === "mysql" ? "`" + name.replace(/`/g, "``") + "`" : '"' + name.replace(/"/g, '""') + '"';
}

/** Table name with its schema; SQLite's `main` is left out. */
export function qualified(d: Driver, schema: string, name: string): string {
  if (!schema || (d === "sqlite" && schema === "main")) return ident(d, name);
  return `${ident(d, schema)}.${ident(d, name)}`;
}

export function literal(d: Driver, s: string): string {
  const v = d === "mysql" ? s.replace(/\\/g, "\\\\") : s;
  return "'" + v.replace(/'/g, "''") + "'";
}

/** A column / index entry: a plain name is quoted, an expression stays as it is. */
function entry(d: Driver, s: string): string {
  return (d === "oracle" ? /^[A-Za-z_][A-Za-z0-9_$#]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/).test(s) ? ident(d, s) : s;
}
const cols = (d: Driver, list: string[]): string => list.map((c) => entry(d, c)).join(", ");

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const action = (a: string): string => (a && a !== "NO ACTION" ? a.toLowerCase() : "");

// ---------------------------------------------------------------- pieces

/** MySQL needs parentheses around a default that is not a literal or CURRENT_TIMESTAMP. */
function mysqlDefault(v: string): string {
  const t = v.trim();
  if (/^(-?\d+(\.\d+)?|'(?:[^']|'')*'|null|true|false|current_timestamp(\(\d*\))?|now\(\d*\)|b'[01]+'|0x[0-9a-f]+)$/i.test(t)) return t;
  if (t.startsWith("(") && t.endsWith(")")) return t;
  return `(${t})`;
}

/** Whether the whole text is one parenthesised expression: `(datetime('now'))`, not `(a) + (b)`. */
function wrapped(t: string): boolean {
  if (!t.startsWith("(") || !t.endsWith(")")) return false;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i === t.length - 1;
  }
  return false;
}

/** SQLite's `default` takes a literal, `current_*` or a parenthesised expression (`pragma table_info` gives it without them). */
const SQLITE_LITERAL = /^([+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?|0x[0-9a-f]+|'(?:[^']|'')*'|"(?:[^"]|"")*"|x'[0-9a-f]*'|null|true|false|current_(date|time|timestamp))$/i;
function sqliteDefault(v: string): string {
  const t = v.trim();
  return SQLITE_LITERAL.test(t) || wrapped(t) ? t : `(${t})`;
}

interface ColOpts {
  /** SQLite: the column is a single-column primary key written inline. */
  inlinePk?: boolean;
  /** MySQL: the column is redefined (CHANGE / MODIFY): keep a non-default collation. */
  redefine?: boolean;
  tableCollation?: string;
}

/** The part of a column definition after its name. */
function columnType(d: Driver, c: ColumnDef, o: ColOpts = {}): string {
  const parts: string[] = [];
  if (c.type.trim()) parts.push(c.type.trim());
  if (d === "postgres") {
    if (c.generated) parts.push(`generated always as (${c.generated}) stored`);
    else if (c.identity) parts.push(`generated ${c.identity.toLowerCase()} as identity`);
    if (c.default.trim() && !c.generated) parts.push(`default ${c.default.trim()}`);
    if (c.notNull) parts.push("not null");
  } else if (d === "oracle") {
    // DEFAULT, then the identity / virtual clause, then NOT NULL
    if (c.generated) parts.push(`generated always as (${c.generated}) virtual`);
    else if (c.identity) parts.push(`generated ${c.identity.toLowerCase()} as identity`);
    else if (c.default.trim()) parts.push(`default ${c.default.trim()}`);
    if (c.notNull) parts.push("not null");
  } else if (d === "mysql") {
    if (o.redefine && c.collation && c.collation !== o.tableCollation) parts.push(`collate ${c.collation}`);
    if (c.generated) parts.push(`as (${c.generated}) ${c.generatedStored ? "stored" : "virtual"}`);
    if (c.notNull) parts.push("not null");
    else if (/^(timestamp|datetime)/i.test(c.type.trim())) parts.push("null");
    if (c.default.trim() && !c.generated) parts.push(`default ${mysqlDefault(c.default)}`);
    if (c.onUpdate) parts.push(`on update ${c.onUpdate}`);
    if (c.autoIncrement) parts.push("auto_increment");
    if (c.comment) parts.push(`comment ${literal(d, c.comment)}`);
  } else {
    if (o.inlinePk) parts.push(c.autoIncrement ? "primary key autoincrement" : "primary key");
    if (c.notNull) parts.push("not null");
    if (c.default.trim() && !c.generated) parts.push(`default ${sqliteDefault(c.default)}`);
    if (c.generated) parts.push(`generated always as (${c.generated}) ${c.generatedStored ? "stored" : "virtual"}`);
  }
  return parts.join(" ");
}

const named = (d: Driver, name: string): string => (name ? `constraint ${ident(d, name)} ` : "");

function keyClause(d: Driver, k: KeyDef): string {
  if (k.primary) return `${d === "mysql" ? "" : named(d, k.name)}primary key (${cols(d, k.columns)})`;
  return `${named(d, k.name)}unique (${cols(d, k.columns)})`;
}

function fkClause(d: Driver, f: FkDef): string {
  const target = d === "sqlite" ? ident(d, f.refTable) : qualified(d, f.refSchema, f.refTable);
  let s = `${named(d, f.name)}foreign key (${cols(d, f.columns)}) references ${target} (${cols(d, f.refColumns)})`;
  if (d === "oracle") {
    // Oracle knows ON DELETE CASCADE | SET NULL only
    if (/^(CASCADE|SET NULL)$/i.test(f.onDelete)) s += ` on delete ${f.onDelete.toLowerCase()}`;
    return s;
  }
  if (action(f.onUpdate)) s += ` on update ${action(f.onUpdate)}`;
  if (action(f.onDelete)) s += ` on delete ${action(f.onDelete)}`;
  return s;
}

const checkClause = (d: Driver, c: CheckDef): string => `${named(d, c.name)}check (${c.expr.trim()})`;

function indexStmt(d: Driver, t: TableDef, i: IndexDef): string {
  if (i.locked && i.definition) return i.definition.trim().replace(/;?$/, ";");
  const using = d === "postgres" && i.method && i.method !== "btree" ? ` using ${i.method}` : "";
  const name = d === "oracle" ? qualified(d, t.schema, i.name) : ident(d, i.name);
  return `create ${i.unique ? "unique " : ""}index ${name} on ${qualified(d, t.schema, t.name)}${using} (${cols(d, i.columns)});`;
}

// ---------------------------------------------------------------- validation

/** The problems that stop OK (the first is shown). */
export function validateTable(d: Driver, t: TableDef): string[] {
  const out: string[] = [];
  if (!t.name.trim()) out.push("The table name is empty");
  const seen = new Set<string>();
  for (const c of t.columns) {
    if (!c.name.trim()) out.push("A column has no name");
    else if (seen.has(c.name.toLowerCase())) out.push(`Duplicate column name '${c.name}'`);
    seen.add(c.name.toLowerCase());
    if (!c.type.trim() && d !== "sqlite") out.push(`Column '${c.name}' has no data type`);
  }
  if (t.keys.filter((k) => k.primary).length > 1) out.push("A table can have only one primary key");
  const of = (what: string, name: string) => (name ? `${what} '${name}'` : what);
  for (const k of t.keys) if (!k.columns.length) out.push(`${of("Key", k.name)} has no columns`);
  for (const f of t.fks) {
    if (!f.columns.length) out.push(`${of("Foreign key", f.name)} has no columns`);
    else if (!f.refTable) out.push(`${of("Foreign key", f.name)} has no target table`);
    else if (f.refColumns.length !== f.columns.length) out.push(`${of("Foreign key", f.name)}: the number of target columns differs`);
  }
  for (const i of t.indexes) {
    if (!i.name.trim()) out.push("An index has no name");
    if (!i.columns.length) out.push(`${of("Index", i.name)} has no columns`);
  }
  for (const c of t.checks) if (!c.expr.trim()) out.push(`${of("Check", c.name)} has no expression`);
  return out;
}

// ---------------------------------------------------------------- create

/** The one column that SQLite writes as `<col> integer primary key [autoincrement]`. */
function sqliteInlinePk(t: TableDef): ColumnDef | undefined {
  const pk = t.keys.find((k) => k.primary);
  if (!pk || pk.columns.length !== 1) return undefined;
  const c = t.columns.find((x) => x.name === pk.columns[0]);
  return c && /^int(eger)?$/i.test(c.type.trim()) ? c : undefined;
}

function createTableStatement(d: Driver, t: TableDef): string {
  const T = qualified(d, t.schema, t.name);
  const inline = d === "sqlite" ? sqliteInlinePk(t) : undefined;
  const real = t.columns.filter((c) => c.name.trim());
  const width = Math.max(0, ...real.map((c) => ident(d, c.name).length));
  const lines: string[] = real.map((c) =>
    `${ident(d, c.name).padEnd(width)} ${columnType(d, c, { inlinePk: c === inline })}`.trimEnd(),
  );
  for (const k of t.keys) if (k.columns.length && !(inline && k.primary)) lines.push(keyClause(d, k));
  for (const f of t.fks) if (f.columns.length && f.refTable) lines.push(fkClause(d, f));
  for (const c of t.checks) if (c.expr.trim()) lines.push(checkClause(d, c));
  let s = `create table ${T}\n(\n${lines.map((l) => "    " + l).join(",\n")}${lines.length ? "\n" : ""})`;
  if (d === "mysql" && t.comment) s += ` comment = ${literal(d, t.comment)}`;
  if ((d === "postgres" || d === "oracle") && t.tablespace) s += ` tablespace ${ident(d, t.tablespace)}`;
  if (d === "sqlite" && t.sqliteOptions) s += ` ${t.sqliteOptions}`;
  return s + ";";
}

export function createTablePlan(d: Driver, t: TableDef): Plan {
  const T = qualified(d, t.schema, t.name);
  const st = [createTableStatement(d, t)];
  for (const i of t.indexes) if (i.name.trim() && i.columns.length) st.push(indexStmt(d, t, i));
  if (d === "postgres") {
    if (t.comment) st.push(`comment on table ${T} is ${literal(d, t.comment)};`);
    for (const c of t.columns) if (c.comment && c.name.trim()) st.push(`comment on column ${T}.${ident(d, c.name)} is ${literal(d, c.comment)};`);
    if (t.owner) st.push(`alter table ${T} owner to ${ident(d, t.owner)};`);
  } else if (d === "oracle") {
    if (t.comment) st.push(`comment on table ${T} is ${literal(d, t.comment)};`);
    for (const c of t.columns) if (c.comment && c.name.trim()) st.push(`comment on column ${T}.${ident(d, c.name)} is ${literal(d, c.comment)};`);
  }
  return { pre: [], statements: st, post: [], transactional: d !== "mysql" && d !== "oracle", warnings: [] };
}

// ---------------------------------------------------------------- alter

interface Diff {
  /** loaded column name -> edited column name, for the columns that exist on both sides */
  rename: Map<string, string>;
  droppedCols: ColumnDef[];
  addedCols: ColumnDef[];
  /** columns on both sides, with the loaded one */
  keptCols: { o: ColumnDef; c: ColumnDef }[];
  keys: Part<KeyDef>;
  fks: Part<FkDef>;
  indexes: Part<IndexDef>;
  checks: Part<CheckDef>;
}

/** Elements by what happens to them: gone, new, redefined (drop + add) or only renamed. */
interface Part<T> {
  dropped: T[];
  added: T[];
  changed: { o: T; c: T }[];
  renamed: { o: T; c: T }[];
}

function part<T extends { uid: string; name: string }>(o: T[], c: T[], differs: (a: T, b: T) => boolean): Part<T> {
  const byUid = new Map(o.map((x) => [x.uid, x]));
  const curUids = new Set(c.map((x) => x.uid));
  const out: Part<T> = { dropped: o.filter((x) => !curUids.has(x.uid)), added: [], changed: [], renamed: [] };
  for (const x of c) {
    const prev = byUid.get(x.uid);
    if (!prev) out.added.push(x);
    else if (differs(prev, x)) out.changed.push({ o: prev, c: x });
    else if (prev.name !== x.name) out.renamed.push({ o: prev, c: x });
  }
  return out;
}

function diffTables(orig: TableDef, cur: TableDef): Diff {
  const rename = new Map<string, string>();
  const byUid = new Map(orig.columns.map((c) => [c.uid, c]));
  const keptCols: Diff["keptCols"] = [];
  const addedCols: ColumnDef[] = [];
  for (const c of cur.columns) {
    const o = byUid.get(c.uid);
    if (o) {
      rename.set(o.name, c.name);
      keptCols.push({ o, c });
    } else addedCols.push(c);
  }
  const curUids = new Set(cur.columns.map((c) => c.uid));
  const droppedCols = orig.columns.filter((c) => !curUids.has(c.uid));
  const map = (l: string[]) => l.map((x) => rename.get(x) ?? x);
  const fkAction = (a: string) => (a || "NO ACTION").toUpperCase();
  return {
    rename,
    droppedCols,
    addedCols,
    keptCols,
    keys: part(orig.keys, cur.keys, (a, b) => a.primary !== b.primary || !same(map(a.columns), b.columns)),
    fks: part(
      orig.fks,
      cur.fks,
      (a, b) =>
        !same(map(a.columns), b.columns) ||
        a.refSchema !== b.refSchema ||
        a.refTable !== b.refTable ||
        !same(a.refColumns, b.refColumns) ||
        fkAction(a.onUpdate) !== fkAction(b.onUpdate) ||
        fkAction(a.onDelete) !== fkAction(b.onDelete),
    ),
    indexes: part(
      orig.indexes,
      cur.indexes,
      (a, b) => a.unique !== b.unique || !same(map(a.columns), b.columns) || (a.method || "btree") !== (b.method || "btree"),
    ),
    checks: part(orig.checks, cur.checks, (a, b) => norm(a.expr) !== norm(b.expr)),
  };
}

const columnChanged = (o: ColumnDef, c: ColumnDef): boolean =>
  norm(o.type) !== norm(c.type) ||
  o.notNull !== c.notNull ||
  norm(o.default) !== norm(c.default) ||
  o.comment !== c.comment ||
  o.identity !== c.identity ||
  o.autoIncrement !== c.autoIncrement ||
  o.onUpdate !== c.onUpdate;

export function alterTablePlan(d: Driver, orig: TableDef, cur: TableDef): Plan {
  if (orig.name !== cur.name) {
    // a foreign key to the table itself follows the rename (the server updates it, the dialog does not)
    const self = (f: FkDef): FkDef => (f.refTable === orig.name && (!f.refSchema || f.refSchema === orig.schema) ? { ...f, refTable: cur.name } : f);
    orig = { ...orig, fks: orig.fks.map(self) };
    cur = { ...cur, fks: cur.fks.map(self) };
  }
  const diff = diffTables(orig, cur);
  if (d === "postgres") return pgAlter(orig, cur, diff);
  if (d === "mysql") return myAlter(orig, cur, diff);
  if (d === "oracle") return oraAlter(orig, cur, diff);
  return liteAlter(orig, cur, diff);
}

// ---- PostgreSQL

function pgAlter(orig: TableDef, cur: TableDef, df: Diff): Plan {
  const d: Driver = "postgres";
  const out: string[] = [];
  let T = qualified(d, orig.schema, orig.name);
  if (orig.name !== cur.name) {
    out.push(`alter table ${T} rename to ${ident(d, cur.name)};`);
    T = qualified(d, cur.schema, cur.name);
  }
  const dropConstraint = (name: string) => out.push(`alter table ${T} drop constraint ${ident(d, name)};`);
  for (const f of [...df.fks.dropped, ...df.fks.changed.map((x) => x.o)]) dropConstraint(f.name);
  for (const c of [...df.checks.dropped, ...df.checks.changed.map((x) => x.o)]) dropConstraint(c.name);
  for (const k of [...df.keys.dropped, ...df.keys.changed.map((x) => x.o)]) dropConstraint(k.name);
  for (const i of [...df.indexes.dropped, ...df.indexes.changed.map((x) => x.o)]) out.push(`drop index ${qualified(d, orig.schema, i.name)};`);
  for (const c of df.droppedCols) out.push(`alter table ${T} drop column ${ident(d, c.name)};`);
  for (const { o, c } of df.keptCols) if (o.name !== c.name) out.push(`alter table ${T} rename column ${ident(d, o.name)} to ${ident(d, c.name)};`);
  for (const { o, c } of df.keptCols) {
    const C = `alter table ${T} alter column ${ident(d, c.name)}`;
    if (norm(o.type) !== norm(c.type)) out.push(`${C} type ${c.type.trim()};`);
    if (!c.generated && norm(o.default) !== norm(c.default)) out.push(c.default.trim() ? `${C} set default ${c.default.trim()};` : `${C} drop default;`);
    if (o.notNull !== c.notNull) out.push(`${C} ${c.notNull ? "set" : "drop"} not null;`);
    if (o.identity !== c.identity) {
      if (!c.identity) out.push(`${C} drop identity;`);
      else if (!o.identity) out.push(`${C} add generated ${c.identity.toLowerCase()} as identity;`);
      else out.push(`${C} set generated ${c.identity.toLowerCase()};`);
    }
  }
  for (const c of df.addedCols) if (c.name.trim()) out.push(`alter table ${T} add column ${`${ident(d, c.name)} ${columnType(d, c)}`.trim()};`);
  for (const k of [...df.keys.changed.map((x) => x.c), ...df.keys.added]) if (k.columns.length) out.push(`alter table ${T} add ${keyClause(d, k)};`);
  for (const f of [...df.fks.changed.map((x) => x.c), ...df.fks.added]) if (f.columns.length && f.refTable) out.push(`alter table ${T} add ${fkClause(d, f)};`);
  for (const c of [...df.checks.changed.map((x) => x.c), ...df.checks.added]) if (c.expr.trim()) out.push(`alter table ${T} add ${checkClause(d, c)};`);
  const cs = { ...cur, name: cur.name };
  for (const i of [...df.indexes.changed.map((x) => x.c), ...df.indexes.added]) if (i.name.trim() && i.columns.length) out.push(indexStmt(d, cs, i));
  for (const { o, c } of [...df.keys.renamed, ...df.fks.renamed, ...df.checks.renamed]) out.push(`alter table ${T} rename constraint ${ident(d, o.name)} to ${ident(d, c.name)};`);
  for (const { o, c } of df.indexes.renamed) out.push(`alter index ${qualified(d, orig.schema, o.name)} rename to ${ident(d, c.name)};`);
  if (orig.comment !== cur.comment) out.push(`comment on table ${T} is ${cur.comment ? literal(d, cur.comment) : "null"};`);
  for (const { o, c } of df.keptCols) if (o.comment !== c.comment) out.push(`comment on column ${T}.${ident(d, c.name)} is ${c.comment ? literal(d, c.comment) : "null"};`);
  for (const c of df.addedCols) if (c.comment && c.name.trim()) out.push(`comment on column ${T}.${ident(d, c.name)} is ${literal(d, c.comment)};`);
  if (orig.owner !== cur.owner && cur.owner) out.push(`alter table ${T} owner to ${ident(d, cur.owner)};`);
  if (orig.tablespace !== cur.tablespace && cur.tablespace) out.push(`alter table ${T} set tablespace ${ident(d, cur.tablespace)};`);
  return { pre: [], statements: out, post: [], transactional: true, warnings: [] };
}

// ---- Oracle

function oraAlter(orig: TableDef, cur: TableDef, df: Diff): Plan {
  const d: Driver = "oracle";
  const out: string[] = [];
  let T = qualified(d, orig.schema, orig.name);
  if (orig.name !== cur.name) {
    out.push(`alter table ${T} rename to ${ident(d, cur.name)};`);
    T = qualified(d, cur.schema, cur.name);
  }
  const dropConstraint = (name: string) => out.push(`alter table ${T} drop constraint ${ident(d, name)};`);
  for (const f of [...df.fks.dropped, ...df.fks.changed.map((x) => x.o)]) dropConstraint(f.name);
  for (const c of [...df.checks.dropped, ...df.checks.changed.map((x) => x.o)]) dropConstraint(c.name);
  for (const k of [...df.keys.dropped, ...df.keys.changed.map((x) => x.o)]) dropConstraint(k.name);
  for (const i of [...df.indexes.dropped, ...df.indexes.changed.map((x) => x.o)]) out.push(`drop index ${qualified(d, orig.schema, i.name)};`);
  for (const c of df.droppedCols) out.push(`alter table ${T} drop column ${ident(d, c.name)};`);
  for (const { o, c } of df.keptCols) if (o.name !== c.name) out.push(`alter table ${T} rename column ${ident(d, o.name)} to ${ident(d, c.name)};`);
  // MODIFY states only what changes: NOT NULL on a NOT NULL column (or NULL on a nullable one) is an error
  const modify: string[] = [];
  for (const { o, c } of df.keptCols) {
    const N = ident(d, c.name);
    const spec: string[] = [];
    if (norm(o.type) !== norm(c.type)) spec.push(c.type.trim());
    if (!c.generated && !c.identity && norm(o.default) !== norm(c.default)) spec.push(c.default.trim() ? `default ${c.default.trim()}` : "default null");
    if (o.notNull !== c.notNull) spec.push(c.notNull ? "not null" : "null");
    if (spec.length) modify.push(`${N} ${spec.join(" ")}`);
    if (o.identity !== c.identity) modify.push(`${N} ${c.identity ? `generated ${c.identity.toLowerCase()} as identity` : "drop identity"}`);
  }
  if (modify.length) out.push(`alter table ${T} modify (${modify.join(", ")});`);
  const added = df.addedCols.filter((c) => c.name.trim());
  if (added.length) out.push(`alter table ${T} add (${added.map((c) => `${ident(d, c.name)} ${columnType(d, c)}`.trim()).join(", ")});`);
  for (const k of [...df.keys.changed.map((x) => x.c), ...df.keys.added]) if (k.columns.length) out.push(`alter table ${T} add ${keyClause(d, k)};`);
  for (const f of [...df.fks.changed.map((x) => x.c), ...df.fks.added]) if (f.columns.length && f.refTable) out.push(`alter table ${T} add ${fkClause(d, f)};`);
  for (const c of [...df.checks.changed.map((x) => x.c), ...df.checks.added]) if (c.expr.trim()) out.push(`alter table ${T} add ${checkClause(d, c)};`);
  for (const i of [...df.indexes.changed.map((x) => x.c), ...df.indexes.added]) if (i.name.trim() && i.columns.length) out.push(indexStmt(d, cur, i));
  for (const { o, c } of [...df.keys.renamed, ...df.fks.renamed, ...df.checks.renamed]) out.push(`alter table ${T} rename constraint ${ident(d, o.name)} to ${ident(d, c.name)};`);
  for (const { o, c } of df.indexes.renamed) out.push(`alter index ${qualified(d, orig.schema, o.name)} rename to ${ident(d, c.name)};`);
  if (orig.comment !== cur.comment) out.push(`comment on table ${T} is ${literal(d, cur.comment)};`);
  for (const { o, c } of df.keptCols) if (o.comment !== c.comment) out.push(`comment on column ${T}.${ident(d, c.name)} is ${literal(d, c.comment)};`);
  for (const c of df.addedCols) if (c.comment && c.name.trim()) out.push(`comment on column ${T}.${ident(d, c.name)} is ${literal(d, c.comment)};`);
  // DDL commits by itself: there is no transaction to roll back when a statement fails
  return { pre: [], statements: out, post: [], transactional: false, warnings: [] };
}

// ---- MySQL

function myAlter(orig: TableDef, cur: TableDef, df: Diff): Plan {
  const d: Driver = "mysql";
  // One ALTER for the whole change: MySQL checks the end result, not every step (dropping and adding the primary
  // key of an auto_increment column fails as two statements), and the change is atomic. The exception is a foreign key
  // that is dropped and added again under its name: MySQL refuses that in one statement.
  const T = qualified(d, orig.schema, orig.name);
  const clauses: string[] = [];
  const out: string[] = [];
  const alter = (s: string) => clauses.push(s);
  const sameName = df.fks.changed.filter((x) => x.o.name === x.c.name).map((x) => x.o);
  if (sameName.length) out.push(`alter table ${T} ${sameName.map((f) => `drop foreign key ${ident(d, f.name)}`).join(", ")};`);
  for (const f of [...df.fks.dropped, ...df.fks.changed.filter((x) => x.o.name !== x.c.name).map((x) => x.o), ...df.fks.renamed.map((x) => x.o)]) alter(`drop foreign key ${ident(d, f.name)}`);
  for (const c of [...df.checks.dropped, ...df.checks.changed.map((x) => x.o), ...df.checks.renamed.map((x) => x.o)]) alter(`drop check ${ident(d, c.name)}`);
  for (const k of [...df.keys.dropped, ...df.keys.changed.map((x) => x.o)]) alter(k.primary ? "drop primary key" : `drop index ${ident(d, k.name)}`);
  for (const i of [...df.indexes.dropped, ...df.indexes.changed.map((x) => x.o)]) alter(`drop index ${ident(d, i.name)}`);
  for (const c of df.droppedCols) alter(`drop column ${ident(d, c.name)}`);

  // columns in the order of the edited table: add, redefine and move them one by one on a simulated column list
  const sim = orig.columns.filter((c) => !df.droppedCols.includes(c)).map((c) => c.uid);
  const kept = new Map(df.keptCols.map((x) => [x.c.uid, x]));
  const opts: ColOpts = { redefine: true, tableCollation: orig.tableCollation };
  cur.columns.forEach((c, i) => {
    const prevName = i > 0 ? cur.columns[i - 1].name : "";
    const where = i === 0 ? " first" : ` after ${ident(d, prevName)}`;
    const k = kept.get(c.uid);
    if (c.generated === "?") return;
    if (!k) {
      if (!c.name.trim()) return;
      alter(`add column ${`${ident(d, c.name)} ${columnType(d, c, { tableCollation: orig.tableCollation })}`.trim()}${i === sim.length ? "" : where}`);
      sim.splice(i, 0, c.uid);
      return;
    }
    const moved = sim[i] !== c.uid;
    const changed = k.o.name !== c.name || columnChanged(k.o, c);
    if (moved) {
      sim.splice(sim.indexOf(c.uid), 1);
      sim.splice(i, 0, c.uid);
    }
    if (!moved && !changed) return;
    const def = `${ident(d, c.name)} ${columnType(d, c, opts)}${moved ? where : ""}`;
    alter(k.o.name !== c.name ? `change column ${ident(d, k.o.name)} ${def}` : `modify column ${def}`);
  });

  for (const k of [...df.keys.changed.map((x) => x.c), ...df.keys.added]) if (k.columns.length) alter(`add ${keyClause(d, k)}`);
  for (const f of [...df.fks.changed.map((x) => x.c), ...df.fks.added, ...df.fks.renamed.map((x) => x.c)]) if (f.columns.length && f.refTable) alter(`add ${fkClause(d, f)}`);
  for (const c of [...df.checks.changed.map((x) => x.c), ...df.checks.added, ...df.checks.renamed.map((x) => x.c)]) if (c.expr.trim()) alter(`add ${checkClause(d, c)}`);
  for (const { o, c } of [...df.keys.renamed, ...df.indexes.renamed]) if (!(o as KeyDef).primary) alter(`rename index ${ident(d, o.name)} to ${ident(d, c.name)}`);
  if (orig.comment !== cur.comment) alter(`comment = ${literal(d, cur.comment)}`);
  if (orig.name !== cur.name) alter(`rename to ${qualified(d, cur.schema, cur.name)}`);
  if (clauses.length === 1) out.push(`alter table ${T} ${clauses[0]};`);
  else if (clauses.length) out.push(`alter table ${T}\n${clauses.map((c) => "    " + c).join(",\n")};`);
  for (const i of [...df.indexes.changed.map((x) => x.c), ...df.indexes.added]) if (i.name.trim() && i.columns.length) out.push(indexStmt(d, cur, i));
  return { pre: [], statements: out, post: [], transactional: false, warnings: [] };
}

// ---- SQLite

/** Whether a column of the loaded table is used by anything besides its own definition. */
function sqliteColumnUsed(orig: TableDef, name: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "i");
  return (
    orig.keys.some((k) => k.columns.includes(name)) ||
    orig.fks.some((f) => f.columns.includes(name)) ||
    orig.indexes.some((i) => i.columns.some((c) => c === name || re.test(c))) ||
    orig.checks.some((c) => re.test(c.expr))
  );
}

const SQLITE_CONSTANT = /^(-?\d+(\.\d+)?|'(?:[^']|'')*'|null|true|false|x'[0-9a-f]*')$/i;

/** The in-place statements, or null when SQLite cannot do the change with ALTER. */
function sqliteSimple(orig: TableDef, cur: TableDef, df: Diff): string[] | null {
  const d: Driver = "sqlite";
  if (df.keys.added.length || df.keys.dropped.length || df.keys.changed.length || df.keys.renamed.length) return null;
  if (df.fks.added.length || df.fks.dropped.length || df.fks.changed.length || df.fks.renamed.length) return null;
  if (df.checks.added.length || df.checks.dropped.length || df.checks.changed.length || df.checks.renamed.length) return null;
  for (const { o, c } of df.keptCols) if (columnChanged(o, c) || o.generated !== c.generated) return null;
  for (const c of df.droppedCols) if (sqliteColumnUsed(orig, c.name) || c.generated) return null;
  // new columns go to the end, in plain form
  const keptOrder = cur.columns.filter((c) => df.keptCols.some((k) => k.c.uid === c.uid)).map((c) => c.uid);
  const origOrder = orig.columns.filter((c) => !df.droppedCols.includes(c)).map((c) => c.uid);
  if (!same(keptOrder, origOrder)) return null;
  const firstNew = cur.columns.findIndex((c) => df.addedCols.includes(c));
  if (firstNew >= 0 && cur.columns.slice(firstNew).some((c) => !df.addedCols.includes(c))) return null;
  for (const c of df.addedCols) {
    if (c.generated || c.autoIncrement) return null;
    const def = c.default.trim();
    if (def && !SQLITE_CONSTANT.test(def)) return null;
    if (c.notNull && !def) return null;
  }
  const T = qualified(d, orig.schema, orig.name);
  const out: string[] = [];
  for (const i of [...df.indexes.dropped, ...df.indexes.changed.map((x) => x.o)]) out.push(`drop index ${qualified(d, orig.schema, i.name)};`);
  for (const c of df.droppedCols) out.push(`alter table ${T} drop column ${ident(d, c.name)};`);
  for (const { o, c } of df.keptCols) if (o.name !== c.name) out.push(`alter table ${T} rename column ${ident(d, o.name)} to ${ident(d, c.name)};`);
  for (const c of df.addedCols) if (c.name.trim()) out.push(`alter table ${T} add column ${`${ident(d, c.name)} ${columnType(d, c)}`.trim()};`);
  for (const { o, c } of df.indexes.renamed) {
    out.push(`drop index ${qualified(d, orig.schema, o.name)};`);
    out.push(indexStmt(d, { ...cur, name: orig.name }, c));
  }
  for (const i of [...df.indexes.changed.map((x) => x.c), ...df.indexes.added]) if (i.name.trim() && i.columns.length) out.push(indexStmt(d, { ...cur, name: orig.name }, i));
  if (orig.name !== cur.name) out.push(`alter table ${T} rename to ${ident(d, cur.name)};`);
  return out;
}

function liteAlter(orig: TableDef, cur: TableDef, df: Diff): Plan {
  const d: Driver = "sqlite";
  const simple = sqliteSimple(orig, cur, df);
  if (simple) return { pre: [], statements: simple, post: [], transactional: true, warnings: [] };

  // the DataGrip-style rebuild; it runs under the name the table has, a rename follows as a statement of its own
  // (renaming `_dg_tmp` straight to the new name would leave the foreign keys of other tables on the old name)
  const T = qualified(d, orig.schema, orig.name);
  const tmpName = `${orig.name}_dg_tmp`;
  const renamed = orig.name !== cur.name;
  const warnings = [...cur.warnings];
  const plan: Plan = { pre: [], statements: [], post: [], transactional: true, warnings };
  if (cur.columns.some((c) => c.generated === "?")) {
    plan.error = "SQLite cannot rebuild a table with generated columns here; change it with SQL in a console.";
    return plan;
  }
  plan.pre = ["pragma foreign_keys = off;", "pragma legacy_alter_table = on;"];
  plan.post = ["pragma legacy_alter_table = off;", "pragma foreign_keys = on;"];
  const st = plan.statements;
  // a foreign key of the table to itself already names the new table: it points to the old one until the rename
  const back = (f: FkDef): FkDef => (renamed && f.refTable === cur.name && (!f.refSchema || f.refSchema === cur.schema) ? { ...f, refTable: orig.name } : f);
  st.push(createTableStatement(d, { ...cur, name: tmpName, fks: cur.fks.map(back) }));
  const copy = df.keptCols.filter((k) => !k.c.generated);
  if (copy.length) st.push(`insert into ${qualified(d, cur.schema, tmpName)} (${copy.map((k) => ident(d, k.c.name)).join(", ")})\nselect ${copy.map((k) => ident(d, k.o.name)).join(", ")}\nfrom ${T};`);
  st.push(`drop table ${T};`);
  st.push(`alter table ${qualified(d, cur.schema, tmpName)} rename to ${ident(d, orig.name)};`);

  // what is recreated from its SQL follows the renamed columns
  const map = new Map<string, string | null>();
  for (const [o, c] of df.rename) if (o !== c) map.set(o, c);
  for (const c of df.droppedCols) map.set(c.name, null);
  const quote = (n: string) => ident(d, n);
  // a reference that cannot be followed is an error: recreating the statement as it is would break it later
  const note = (what: string, r: Rewrite) => {
    const names = (l: string[]) => l.map((n) => `'${n}'`).join(", ");
    if (r.loose.length) plan.error ??= `${what} mentions the column ${names(r.loose)} in a way the dialog cannot update. Drop or edit it in a console first, then change the table.`;
    if (r.gone.length) plan.error ??= `${what} uses the column ${names(r.gone)} that is dropped here. Drop or edit it in a console first, then change the table.`;
  };
  const keep = { ...cur, name: orig.name };
  for (const i of cur.indexes) {
    if (!i.name.trim() || !i.columns.length) continue;
    if (i.locked && i.definition && map.size) {
      const r = rewriteColumns(i.definition, map, quote, { bare: true, from: indexColumnsStart(i.definition) });
      note(`Index '${i.name}'`, r);
      st.push(indexStmt(d, keep, { ...i, definition: r.sql }));
    } else st.push(indexStmt(d, keep, i));
  }
  for (const t of orig.triggers) {
    const r = map.size ? rewriteColumns(t, map, quote) : { sql: t, loose: [], gone: [] };
    if (map.size) note(`Trigger '${triggerName(t)}'`, r);
    const sql = r.sql.trim();
    st.push(sql.endsWith(";") ? sql : sql + ";");
  }
  if (renamed) {
    // with the legacy behaviour off the server also updates the foreign keys, triggers and views that name the table
    st.push("pragma legacy_alter_table = off;");
    st.push(`alter table ${T} rename to ${ident(d, cur.name)};`);
  }
  return plan;
}
