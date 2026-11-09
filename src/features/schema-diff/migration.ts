/**
 * Migration script "make B like A": the SQL that changes schema B until it matches schema A, for the DBMS of the two
 * schemas (Oracle syntax first, then PostgreSQL, MySQL and SQLite). Pure: the caller passes the `CREATE TABLE` text of
 * the tables that exist only in A (`get_ddl`, unqualified), and runs the script in a console of B's data source.
 *
 * Rules:
 * - statements run by phase: drop what is replaced or removed, create tables, add / change columns, add keys and checks,
 *   add foreign keys, create indexes, views, sequences, then the drops of objects that exist only in B;
 * - a DROP of an object that exists only in B is commented out unless `includeDrops`. A DROP that only makes room for
 *   a changed key, index or view is kept active: the object is created again right after it;
 * - a foreign key of B that refers to a key the script replaces is dropped first and added again after the keys;
 * - a new table is created from its DDL without its foreign keys, which are added after all the tables; the keys and
 *   indexes of the DDL are not repeated;
 * - a constraint whose name the system made up is matched by its definition and added without a name; a change of the
 *   state only is an ENABLE / DISABLE (Oracle) or a VALIDATE (PostgreSQL), not a drop and a create;
 * - the statements carry no schema qualifier; the header makes B's schema the current one;
 * - what cannot be written as plain SQL here is a note: SQLite changes to columns and keys (a table rebuild), routine
 *   bodies (copy them from A), column positions (not migrated), DDL missing for a table of A.
 */
import type { CompareCheck, CompareColumn, CompareForeignKey, CompareIndex, CompareKey, CompareRoutine, CompareSequence, CompareTable, CompareView, Driver, SchemaModel } from "../../api/types";
import {
  DEFAULT_DIFF_OPTIONS,
  type DiffOptions,
  type Pair,
  checkDefinition,
  columnChanges,
  foreignKeyDefinition,
  indexDefinition,
  isEnabled,
  keyDefinition,
  nameKey,
  normDefault,
  normType,
  pairBy,
  pairItems,
  routineChanged,
  routineKey,
  routineLabel,
  sequenceChanges,
  viewChanges,
} from "./diff";

export interface MigrationOptions {
  /** Keep the DROP statements active (default: commented out). */
  includeDrops: boolean;
}

export interface MigrationStatement {
  /** Order of the statement (see the phases in the module comment). */
  phase: number;
  /** Comment line written above the statement: the object and what is done to it. */
  comment: string;
  sql: string;
  /** Drops an object that exists only in B: commented out unless `includeDrops`. */
  destructive: boolean;
}

export interface MigrationPlan {
  driver: Driver;
  /** Statements run first (the current schema of the script). */
  header: string[];
  statements: MigrationStatement[];
  /** Lines written as comments: what the script does not do and why. */
  notes: string[];
}

/** Phases of the script, in the order they run. */
export const PHASE = {
  create: 0,
  replace: 1,
  columns: 2,
  keys: 3,
  foreignKeys: 4,
  indexes: 5,
  views: 6,
  sequences: 7,
  drops: 8,
} as const;

const DIALECT_NAME: Record<Driver, string> = { oracle: "Oracle", postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite" };

/** Quotes an identifier of the dialect (names keep their case). */
const q = (d: Driver, n: string): string => (d === "mysql" ? `\`${n.replace(/`/g, "``")}\`` : `"${n.replace(/"/g, '""')}"`);

/** The kinds of constraint: the ones with a drop and a state. */
type ConstraintKind = "primaryKey" | "unique" | "check" | "foreignKey";

const NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * The DEFAULT text of a column as SQL. MySQL and SQLite send a literal default raw (without quotes): one that is not a
 * number is quoted, its single quotes doubled (MySQL also escapes its backslashes; SQLite has no escapes).
 */
function defaultText(d: Driver, c: CompareColumn): string | null {
  if (c.default === null) return null;
  if ((d === "mysql" || d === "sqlite") && c.defaultKind === "literal" && !NUMBER.test(c.default)) {
    const body = d === "mysql" ? c.default.replace(/\\/g, "\\\\") : c.default;
    return `'${body.replace(/'/g, "''")}'`;
  }
  return c.default;
}

/** Column definition `name type [DEFAULT x] [NOT NULL]`; null for generated and identity columns (written by hand). */
function columnDefinition(d: Driver, c: CompareColumn, notNull = !c.nullable): string | null {
  if (c.extra !== null) return null;
  let s = `${q(d, c.name)} ${c.dataType}`;
  const dflt = defaultText(d, c);
  if (dflt !== null) s += ` DEFAULT ${dflt}`;
  if (notNull) s += " NOT NULL";
  return s;
}

/** The statements that make the header: the current schema of the script. */
function headerOf(d: Driver, schema: string): string[] {
  switch (d) {
    case "oracle":
      return [`ALTER SESSION SET CURRENT_SCHEMA = ${q(d, schema)};`];
    case "postgres":
      return [`SET search_path TO ${q(d, schema)};`];
    case "mysql":
      return [`USE ${q(d, schema)};`];
    case "sqlite":
      return [];
  }
}

function addColumnSql(d: Driver, t: string, c: CompareColumn): string | null {
  // Oracle and PostgreSQL refuse a NOT NULL column without a default on a table that has rows: the column is added
  // nullable, and the NOT NULL is written as a comment for the person who fills the column first
  const todo = !c.nullable && c.default === null && (d === "oracle" || d === "postgres");
  const def = columnDefinition(d, c, !c.nullable && !todo);
  if (!def) return null;
  const add = d === "oracle" ? `ALTER TABLE ${q(d, t)} ADD (${def});` : `ALTER TABLE ${q(d, t)} ADD COLUMN ${def};`;
  if (!todo) return add;
  const fill =
    d === "oracle"
      ? `ALTER TABLE ${q(d, t)} MODIFY (${q(d, c.name)} NOT NULL);`
      : `ALTER TABLE ${q(d, t)} ALTER COLUMN ${q(d, c.name)} SET NOT NULL;`;
  return `${add}\n-- TODO: fill the column, then:\n-- ${fill}`;
}

/**
 * Changes a column of B to the definition of A, with only the attributes that differ. Oracle: one `MODIFY` (its NULL
 * and NOT NULL clauses only when the nullability differs). PostgreSQL: one statement per attribute. MySQL: one
 * `MODIFY COLUMN` with the full definition.
 */
function modifyColumnSql(d: Driver, t: string, colName: string, from: CompareColumn, to: CompareColumn): string[] | null {
  if (d === "sqlite" || from.extra !== null || to.extra !== null) return null;
  const T = q(d, t);
  const C = q(d, colName);
  const typeChanged = normType(from.dataType) !== normType(to.dataType);
  const nullChanged = from.nullable !== to.nullable;
  const defaultChanged = normDefault(d, from.default) !== normDefault(d, to.default);
  if (!typeChanged && !nullChanged && !defaultChanged) return [];
  if (d === "oracle") {
    const parts = [
      typeChanged ? from.dataType : "",
      defaultChanged ? `DEFAULT ${from.default ?? "NULL"}` : "",
      nullChanged ? (from.nullable ? "NULL" : "NOT NULL") : "",
    ].filter(Boolean);
    return [`ALTER TABLE ${T} MODIFY (${C} ${parts.join(" ")});`];
  }
  if (d === "mysql") {
    const def = columnDefinition(d, from);
    return def ? [`ALTER TABLE ${T} MODIFY COLUMN ${def};`] : null;
  }
  const out: string[] = [];
  if (typeChanged) out.push(`ALTER TABLE ${T} ALTER COLUMN ${C} TYPE ${from.dataType};`);
  if (nullChanged) out.push(`ALTER TABLE ${T} ALTER COLUMN ${C} ${from.nullable ? "DROP" : "SET"} NOT NULL;`);
  if (defaultChanged) {
    out.push(from.default === null ? `ALTER TABLE ${T} ALTER COLUMN ${C} DROP DEFAULT;` : `ALTER TABLE ${T} ALTER COLUMN ${C} SET DEFAULT ${from.default};`);
  }
  return out;
}

/** Oracle refuses to drop a column of a composite key or foreign key without its constraints (`CASCADE CONSTRAINTS`). */
const dropColumnSql = (d: Driver, t: string, c: string, cascade: boolean): string =>
  d === "oracle" && cascade ? `ALTER TABLE ${q(d, t)} DROP (${q(d, c)}) CASCADE CONSTRAINTS;` : `ALTER TABLE ${q(d, t)} DROP COLUMN ${q(d, c)};`;

/**
 * The state clause of a constraint that is added: Oracle `DISABLE`; PostgreSQL `NOT VALID` for a check or a foreign key
 * that is not validated. Empty for an enabled constraint.
 */
function stateClause(d: Driver, kind: ConstraintKind, enabled: boolean): string {
  if (enabled) return "";
  if (d === "oracle") return " DISABLE";
  return d === "postgres" && (kind === "check" || kind === "foreignKey") ? " NOT VALID" : "";
}

/** The statement that switches a constraint whose definition is the same: Oracle ENABLE / DISABLE, PostgreSQL VALIDATE. */
function stateSql(d: Driver, t: string, kind: ConstraintKind | "index", name: string, enabled: boolean): string | null {
  if (!name) return null;
  if (d === "oracle") return `ALTER TABLE ${q(d, t)} ${enabled ? "ENABLE" : "DISABLE"} CONSTRAINT ${q(d, name)};`;
  if (d === "postgres" && enabled && (kind === "check" || kind === "foreignKey")) {
    return `ALTER TABLE ${q(d, t)} VALIDATE CONSTRAINT ${q(d, name)};`;
  }
  return null;
}

function addKeySql(d: Driver, t: string, kind: "primaryKey" | "unique", k: CompareKey): string | null {
  if (d === "sqlite") return null;
  // MySQL names every primary key PRIMARY and does not take a name for it
  const named = k.name && !k.generatedName && !(d === "mysql" && kind === "primaryKey") ? ` CONSTRAINT ${q(d, k.name)}` : "";
  const cols = k.columns.map((c) => q(d, c)).join(", ");
  return `ALTER TABLE ${q(d, t)} ADD${named} ${kind === "primaryKey" ? "PRIMARY KEY" : "UNIQUE"} (${cols})${stateClause(d, kind, isEnabled(k))};`;
}

function addCheckSql(d: Driver, t: string, c: CompareCheck): string | null {
  if (d === "sqlite") return null;
  const named = c.name && !c.generatedName ? ` CONSTRAINT ${q(d, c.name)}` : "";
  return `ALTER TABLE ${q(d, t)} ADD${named} CHECK (${c.expression})${stateClause(d, "check", isEnabled(c))};`;
}

function addForeignKeySql(d: Driver, t: string, f: CompareForeignKey): string | null {
  if (d === "sqlite" || f.refColumns.length === 0) return null;
  // Oracle takes CASCADE and SET NULL only (NO ACTION is its default)
  let onDelete = f.onDelete === "NO ACTION" ? "" : ` ON DELETE ${f.onDelete}`;
  if (d === "oracle") {
    if (f.onDelete === "RESTRICT" || f.onDelete === "NO ACTION") onDelete = "";
    else if (f.onDelete === "SET DEFAULT") return null;
  }
  const named = f.name && !f.generatedName ? ` CONSTRAINT ${q(d, f.name)}` : "";
  const ref = `${f.refSchema ? `${q(d, f.refSchema)}.` : ""}${q(d, f.refTable)}`;
  const cols = f.columns.map((c) => q(d, c)).join(", ");
  const refCols = f.refColumns.map((c) => q(d, c)).join(", ");
  return `ALTER TABLE ${q(d, t)} ADD${named} FOREIGN KEY (${cols}) REFERENCES ${ref} (${refCols})${onDelete}${stateClause(d, "foreignKey", isEnabled(f))};`;
}

/** Drops a key, check or foreign key by its name (MySQL has its own statement per kind). */
function dropConstraintSql(d: Driver, t: string, kind: ConstraintKind, name: string): string | null {
  if (d === "sqlite") return null;
  const T = q(d, t);
  if (kind === "primaryKey" && d !== "postgres") return `ALTER TABLE ${T} DROP PRIMARY KEY;`;
  if (!name) return null;
  const N = q(d, name);
  if (d === "mysql") {
    switch (kind) {
      case "unique":
        return `ALTER TABLE ${T} DROP INDEX ${N};`;
      case "check":
        return `ALTER TABLE ${T} DROP CHECK ${N};`;
      case "foreignKey":
        return `ALTER TABLE ${T} DROP FOREIGN KEY ${N};`;
      default:
        return null;
    }
  }
  return `ALTER TABLE ${T} DROP CONSTRAINT ${N};`;
}

function createIndexSql(d: Driver, t: string, i: CompareIndex): string | null {
  if (d === "sqlite" && i.columns.includes("(expression)")) return null;
  // an index needs a name to be created (Oracle): one whose name the system made up is written by hand
  if (!i.name || i.generatedName) return null;
  const using = d === "postgres" && i.method && i.method !== "btree" ? ` USING ${i.method}` : "";
  const cols = i.columns
    .map((c, n) => {
      const text = /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(c) ? q(d, c) : c;
      return i.descending?.[n] ? `${text} DESC` : text;
    })
    .join(", ");
  const where = i.predicate ? ` WHERE ${i.predicate}` : "";
  const kind = i.unique ? "UNIQUE " : d === "oracle" && i.bitmap ? "BITMAP " : "";
  return `CREATE ${kind}INDEX ${q(d, i.name)} ON ${q(d, t)}${using} (${cols})${where};`;
}

function dropIndexSql(d: Driver, t: string, name: string): string | null {
  if (!name) return null;
  return d === "mysql" ? `DROP INDEX ${q(d, name)} ON ${q(d, t)};` : `DROP INDEX ${q(d, name)};`;
}

/** `CREATE OR REPLACE VIEW` (SQLite: drop, then create). A replaced materialized view is dropped first. */
function viewSql(d: Driver, v: CompareView, replace: boolean): string[] {
  const N = q(d, v.name);
  const create = v.materialized
    ? `CREATE MATERIALIZED VIEW ${N} AS ${v.definition};`
    : d === "sqlite"
      ? `CREATE VIEW ${N} AS ${v.definition};`
      : `CREATE OR REPLACE VIEW ${N} AS ${v.definition};`;
  if (!replace || (d !== "sqlite" && !v.materialized)) return [create];
  return [`DROP ${v.materialized ? "MATERIALIZED " : ""}VIEW ${d === "sqlite" ? "IF EXISTS " : ""}${N};`, create];
}

const dropViewSql = (d: Driver, v: CompareView): string => `DROP ${v.materialized ? "MATERIALIZED " : ""}VIEW ${q(d, v.name)};`;

/** `CREATE` or `ALTER SEQUENCE` with the options the model has (Oracle and PostgreSQL only). */
function sequenceSql(d: Driver, verb: "CREATE" | "ALTER", s: CompareSequence): string | null {
  const cache = Number(s.cacheSize) || 0;
  if (d === "oracle") {
    const c = cache > 1 ? `CACHE ${cache}` : "NOCACHE";
    return `${verb} SEQUENCE ${q(d, s.name)} INCREMENT BY ${s.incrementBy} MINVALUE ${s.minValue} MAXVALUE ${s.maxValue} ${s.cycle ? "CYCLE" : "NOCYCLE"} ${c};`;
  }
  if (d === "postgres") {
    return `${verb} SEQUENCE ${q(d, s.name)} INCREMENT BY ${s.incrementBy} MINVALUE ${s.minValue} MAXVALUE ${s.maxValue} ${s.cycle ? "CYCLE" : "NO CYCLE"} CACHE ${Math.max(1, cache)};`;
  }
  return null;
}

function dropRoutineSql(d: Driver, r: CompareRoutine): string | null {
  if (r.kind === "TRIGGER") {
    return d === "postgres" && r.signature ? `DROP TRIGGER ${q(d, r.name)} ON ${q(d, r.signature)};` : `DROP TRIGGER ${q(d, r.name)};`;
  }
  if (d === "postgres") return `DROP ${r.kind === "PROCEDURE" ? "PROCEDURE" : "FUNCTION"} ${q(d, r.name)}(${r.signature});`;
  return `DROP ${r.kind} ${q(d, r.name)};`;
}

/** Tables that exist only in A: their `CREATE TABLE` text is needed (the caller fetches it with `get_ddl`). */
export function tablesToCreate(a: SchemaModel, b: SchemaModel): string[] {
  return pairBy(a.tables, b.tables, (t) => nameKey(a.driver, t.name))
    .filter((p) => p.left && !p.right)
    .map((p) => (p.left as CompareTable).name);
}

/** The key of `tablesToCreate` entries in the DDL map passed to `planMigration`. */
export const tableDdlKey = (name: string): string => `table:${name}`;

// ---------------------------------------------------------------- DDL text of a new table

/** `text` with the inside of its quoted parts and comments replaced by `_` (same length): searches see the SQL only. */
const maskQuoted = (text: string): string =>
  text.replace(/--[^\n]*|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`/g, (m) => m.replace(/[^\n]/g, "_"));

/** Index of the parenthesis that closes the one at `open` (in masked text), or -1. */
function closeOf(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The [start, end) ranges of the items of a masked list, split at its top-level commas. */
function topLevelItems(masked: string): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, masked.length]);
  return out;
}

/** A table line `[constraint x] foreign key ...`. */
const FOREIGN_KEY_ITEM = /^\s*(constraint\s+\S+\s+)?foreign\s+key\b/i;
/** The `[constraint x] references ...` that PostgreSQL writes under a column. */
const INLINE_REFERENCES = /\s+(constraint\s+\S+\s+)?references\s/i;
/** An item of the list that is a table constraint, not a column. */
const NOT_A_COLUMN = /^\s*(constraint|primary|unique|check|exclude)\b/i;

/**
 * The `CREATE TABLE` text without its foreign keys: they are added after every table exists (see `planMigration`).
 * A table line `[constraint x] foreign key ...` goes; the `references` that PostgreSQL writes under a column is cut
 * from the column. Text without foreign keys is returned as it is (Oracle's DDL has none).
 */
export function stripForeignKeys(ddl: string): string {
  const masked = maskQuoted(ddl);
  const open = masked.indexOf("(");
  const close = open < 0 ? -1 : closeOf(masked, open);
  if (close < 0) return ddl;
  const body = ddl.slice(open + 1, close);
  const bodyMasked = masked.slice(open + 1, close);
  let changed = false;
  const kept: string[] = [];
  for (const [s, e] of topLevelItems(bodyMasked)) {
    const item = body.slice(s, e);
    const itemMasked = bodyMasked.slice(s, e);
    if (FOREIGN_KEY_ITEM.test(itemMasked)) {
      changed = true;
      continue;
    }
    const inline = INLINE_REFERENCES.exec(itemMasked);
    if (inline && !NOT_A_COLUMN.test(itemMasked)) {
      changed = true;
      kept.push(item.slice(0, inline.index));
      continue;
    }
    kept.push(item);
  }
  if (!changed) return ddl;
  const trailing = /\s*$/.exec(body)?.[0] ?? "";
  const newBody = `${kept.join(",").replace(/\s*$/, "")}${trailing}`;
  return `${ddl.slice(0, open + 1)}${newBody}${ddl.slice(close)}`;
}

// ---------------------------------------------------------------- planning helpers

type Add = (phase: number, comment: string, sql: string, destructive?: boolean) => void;

/** The columns of a key of B that a foreign key may refer to: the same set of columns. */
const sameColumns = (d: Driver, x: readonly string[], y: readonly string[]): boolean =>
  x.length === y.length && x.every((c) => y.some((e) => nameKey(d, e) === nameKey(d, c)));

/** Oracle refuses to drop a column of a composite key or foreign key, or one that a foreign key of B refers to. */
function columnInConstraint(b: SchemaModel, t: CompareTable, col: string): boolean {
  const d = b.driver;
  const k = nameKey(d, col);
  const has = (cols: readonly string[]) => cols.some((c) => nameKey(d, c) === k);
  const composite = (cols: readonly string[]) => cols.length > 1 && has(cols);
  const keys = [t.primaryKey, ...t.unique].filter((x): x is CompareKey => x !== null);
  if (keys.some((x) => composite(x.columns)) || t.foreignKeys.some((f) => composite(f.columns))) return true;
  return b.tables.some(
    (o) => o.foreignKeys.some((f) => !f.refSchema && nameKey(d, f.refTable) === nameKey(d, t.name) && has(f.refColumns)),
  );
}

/** Tables in the order their DROP statements run: a table that refers to another one goes first. */
function dropOrder(d: Driver, tables: readonly CompareTable[]): CompareTable[] {
  const byKey = new Map(tables.map((t) => [nameKey(d, t.name), t] as const));
  const parentsFirst: CompareTable[] = [];
  const seen = new Set<string>();
  const visit = (t: CompareTable) => {
    const k = nameKey(d, t.name);
    if (seen.has(k)) return;
    seen.add(k);
    for (const f of t.foreignKeys) {
      const parent = f.refSchema ? undefined : byKey.get(nameKey(d, f.refTable));
      if (parent) visit(parent);
    }
    parentsFirst.push(t);
  };
  tables.forEach(visit);
  return parentsFirst.reverse();
}

/** The keys of one kind of a table: its primary key, or its unique constraints. */
const keysOf = (t: CompareTable, kind: "primaryKey" | "unique"): CompareKey[] =>
  kind === "primaryKey" ? (t.primaryKey ? [t.primaryKey] : []) : t.unique;

/** How keys pair: by name, unless the name was made up by the system (then by definition). */
const KEY_ITEM = {
  name: (k: CompareKey) => k.name,
  definition: keyDefinition,
  generated: (k: CompareKey) => k.generatedName === true,
};

/** A key of B that the script replaces: it is dropped, and created again when A has it. */
interface ReplacedKey {
  /** The table of the key, by `nameKey`. */
  table: string;
  columns: string[];
  label: string;
}

/** The keys of B that the script replaces (changed, or only in B), in tables that exist on both sides. */
function replacedKeys(a: SchemaModel, b: SchemaModel, opts: DiffOptions): ReplacedKey[] {
  const d = b.driver;
  const out: ReplacedKey[] = [];
  for (const p of pairBy(a.tables, b.tables, (t) => nameKey(d, t.name))) {
    if (!p.left || !p.right) continue;
    for (const kind of ["primaryKey", "unique"] as const) {
      for (const kp of pairItems(d, keysOf(p.left, kind), keysOf(p.right, kind), KEY_ITEM, opts)) {
        if (!kp.right) continue;
        if (kp.left && keyDefinition(kp.left) === keyDefinition(kp.right)) continue;
        const label = kind === "primaryKey" ? `primary key ${keyDefinition(kp.right)}` : `unique ${keyDefinition(kp.right)}`;
        out.push({ table: nameKey(d, p.right.name), columns: kp.right.columns, label });
      }
    }
  }
  return out;
}

/** What the changes of one table need from the plan. */
interface TableCtx {
  d: Driver;
  opts: DiffOptions;
  b: SchemaModel;
  /** Foreign keys of B dropped before a key they refer to is replaced. */
  preDropped: ReadonlySet<CompareForeignKey>;
  add: Add;
  unsupported: (comment: string) => void;
}

/** How one kind of constraint or index is compared and written. */
interface ItemSpec<X> {
  kind: ConstraintKind | "index";
  name: (x: X) => string;
  definition: (x: X) => string;
  generated: (x: X) => boolean;
  enabled: (x: X) => boolean;
  label: (x: X) => string;
  phase: number;
  add: (x: X) => string | null;
  drop: (x: X) => string | null;
  preDropped?: (x: X) => boolean;
}

/** The statements of one table that exists on both sides. Names of existing objects are B's, definitions A's. */
function tableChanges(l: CompareTable, r: CompareTable, ctx: TableCtx): void {
  const { d, add, unsupported } = ctx;
  const T = r.name;
  const where = `table ${T}`;

  // columns
  for (const p of pairBy(l.columns, r.columns, (c) => nameKey(d, c.name))) {
    if (p.left && !p.right) {
      const sql = addColumnSql(d, T, p.left);
      if (sql) add(PHASE.columns, `${where}: add column ${p.left.name}`, sql);
      else unsupported(`${where}: add column ${p.left.name}`);
    } else if (!p.left && p.right) {
      const cascade = d === "oracle" && columnInConstraint(ctx.b, r, p.right.name);
      add(PHASE.drops, `${where}: drop column ${p.right.name} (only in B)`, dropColumnSql(d, T, p.right.name, cascade), true);
    } else if (p.left && p.right && columnChanges(p.left, p.right, d).length > 0) {
      const sqls = modifyColumnSql(d, T, p.right.name, p.left, p.right);
      if (sqls) for (const sql of sqls) add(PHASE.columns, `${where}: change column ${p.right.name}`, sql);
      else unsupported(`${where}: change column ${p.right.name}`);
    }
  }

  // keys, checks, foreign keys and indexes: a changed one is dropped (phase replace) and created again
  const items = <X>(lefts: X[], rights: X[], spec: ItemSpec<X>) => {
    const pairs = pairItems(d, lefts, rights, spec, ctx.opts) as Pair<X>[];
    // an item of B that only has another name in A (same definition) is replaced: its drop makes room, it is not removed
    const leftOnly = new Set(pairs.filter((p) => p.left && !p.right).map((p) => spec.definition(p.left as X)));
    for (const p of pairs) {
      const sample = (p.left ?? p.right) as X;
      const label = `${where}: ${spec.label(sample)}`;
      if (p.left && !p.right) {
        const sql = spec.add(p.left);
        if (sql) add(spec.phase, `${where}: add ${spec.label(p.left)}`, sql);
        else unsupported(`${where}: add ${spec.label(p.left)}`);
      } else if (!p.left && p.right) {
        if (spec.preDropped?.(p.right)) continue;
        const sql = spec.drop(p.right);
        const makesRoom = leftOnly.has(spec.definition(p.right));
        if (sql) add(PHASE.replace, makesRoom ? `${label} (replaced: same definition in A under another name)` : `${label} (only in B)`, sql, !makesRoom);
        else unsupported(`${label} (only in B): drop`);
      } else if (p.left && p.right) {
        const left = p.left;
        const right = p.right;
        if (spec.preDropped?.(right)) {
          // dropped before the key it refers to was replaced: it is created again
          const sql = spec.add(left);
          if (sql) add(spec.phase, `${label}: add again after the key is replaced`, sql);
          else unsupported(`${label}: add again`);
          continue;
        }
        const defChanged = spec.definition(left) !== spec.definition(right);
        const stateChanged = spec.enabled(left) !== spec.enabled(right);
        if (!defChanged && !stateChanged) continue;
        if (!defChanged) {
          const sql = stateSql(d, T, spec.kind, spec.name(right), spec.enabled(left));
          if (sql) {
            add(spec.phase, `${label}: ${spec.enabled(left) ? "enable" : "disable"}`, sql);
            continue;
          }
        }
        const dropSql = spec.drop(right);
        const addSql = spec.add(left);
        if (dropSql) add(PHASE.replace, `${label}: replace`, dropSql);
        else unsupported(`${label}: drop before it is created again`);
        if (addSql) add(spec.phase, `${label}: replace`, addSql);
        else unsupported(`${label}: replace`);
      }
    }
  };

  const keySpec = (kind: "primaryKey" | "unique"): ItemSpec<CompareKey> => ({
    kind,
    name: (k) => k.name,
    definition: keyDefinition,
    generated: (k) => k.generatedName === true,
    enabled: isEnabled,
    label: (k) =>
      kind === "primaryKey" ? `primary key ${keyDefinition(k)}` : `unique ${k.generatedName ? keyDefinition(k) : k.name || keyDefinition(k)}`,
    phase: PHASE.keys,
    add: (k) => addKeySql(d, T, kind, k),
    drop: (k) => dropConstraintSql(d, T, kind, k.name),
  });
  items<CompareKey>(keysOf(l, "primaryKey"), keysOf(r, "primaryKey"), keySpec("primaryKey"));
  items<CompareKey>(keysOf(l, "unique"), keysOf(r, "unique"), keySpec("unique"));
  items<CompareCheck>(l.checks, r.checks, {
    kind: "check",
    name: (c) => c.name,
    definition: checkDefinition,
    generated: (c) => c.generatedName === true,
    enabled: isEnabled,
    label: (c) => `check ${c.generatedName ? checkDefinition(c) : c.name || checkDefinition(c)}`,
    phase: PHASE.keys,
    add: (c) => addCheckSql(d, T, c),
    drop: (c) => dropConstraintSql(d, T, "check", c.name),
  });
  items<CompareForeignKey>(l.foreignKeys, r.foreignKeys, {
    kind: "foreignKey",
    name: (f) => f.name,
    definition: foreignKeyDefinition,
    generated: (f) => f.generatedName === true,
    enabled: isEnabled,
    label: (f) => `foreign key ${f.generatedName ? foreignKeyDefinition(f) : f.name || foreignKeyDefinition(f)}`,
    phase: PHASE.foreignKeys,
    add: (f) => addForeignKeySql(d, T, f),
    drop: (f) => dropConstraintSql(d, T, "foreignKey", f.name),
    preDropped: (f) => ctx.preDropped.has(f),
  });
  items<CompareIndex>(l.indexes, r.indexes, {
    kind: "index",
    name: (i) => i.name,
    definition: indexDefinition,
    generated: (i) => i.generatedName === true,
    enabled: () => true,
    label: (i) => `index ${i.generatedName ? indexDefinition(i) : i.name || indexDefinition(i)}`,
    phase: PHASE.indexes,
    add: (i) => createIndexSql(d, T, i),
    drop: (i) => dropIndexSql(d, T, i.name),
  });
}

/**
 * The migration plan that makes B like A. `sourceDdl` maps `tableDdlKey(name)` to the `CREATE TABLE` text of the tables
 * that exist only in A. The objects of A are compared with the same rules as the difference tree (`diffSchemas`).
 */
export function planMigration(a: SchemaModel, b: SchemaModel, diffOpts: DiffOptions = DEFAULT_DIFF_OPTIONS, sourceDdl: ReadonlyMap<string, string> = new Map()): MigrationPlan {
  const d = b.driver;
  if (a.driver !== b.driver) {
    return {
      driver: d,
      header: [],
      statements: [],
      notes: [`${a.schema} is on ${DIALECT_NAME[a.driver]} and ${b.schema} on ${DIALECT_NAME[b.driver]}: no migration script between two DBMS.`],
    };
  }
  const statements: MigrationStatement[] = [];
  const notes: string[] = [];
  const add: Add = (phase, comment, sql, destructive = false) => statements.push({ phase, comment, sql, destructive });
  const unsupported = (comment: string) =>
    notes.push(`${comment}: not generated for ${DIALECT_NAME[d]}${d === "sqlite" ? " (SQLite changes this only by rebuilding the table)" : ""}; write it by hand`);
  const key = (name: string) => nameKey(d, name);

  // ---- foreign keys of B that refer to a key the script replaces: dropped first, added again after the keys
  const preDropped = new Set<CompareForeignKey>();
  if (d !== "sqlite") {
    for (const r of replacedKeys(a, b, diffOpts)) {
      for (const t of b.tables) {
        for (const f of t.foreignKeys) {
          if (f.refSchema || preDropped.has(f) || key(f.refTable) !== r.table || !sameColumns(d, f.refColumns, r.columns)) continue;
          const name = f.name || foreignKeyDefinition(f);
          const sql = dropConstraintSql(d, t.name, "foreignKey", f.name);
          if (sql) {
            add(PHASE.replace, `table ${t.name}: foreign key ${name} (dropped before ${r.label} is replaced)`, sql);
            preDropped.add(f);
          } else unsupported(`table ${t.name}: foreign key ${name} (drop before ${r.label} is replaced)`);
        }
      }
    }
  }

  // ---- tables
  const createTable = (t: CompareTable) => {
    const ddl = sourceDdl.get(tableDdlKey(t.name));
    if (!ddl || !ddl.trim()) {
      notes.push(`table ${t.name}: the DDL of A is missing; create the table by hand`);
      return;
    }
    // SQLite keeps its foreign keys in the DDL (they are not added here)
    const text = d === "sqlite" ? ddl.trim() : stripForeignKeys(ddl.trim()).trim();
    add(PHASE.create, `table ${t.name}: create (from A)`, text.endsWith(";") ? text : `${text};`);
    if (d === "sqlite") return;
    for (const f of t.foreignKeys) {
      const label = `table ${t.name}: foreign key ${f.name || foreignKeyDefinition(f)}`;
      const sql = addForeignKeySql(d, t.name, f);
      if (sql) add(PHASE.foreignKeys, label, sql);
      else unsupported(label);
    }
  };
  const onlyB: CompareTable[] = [];
  const ctx: TableCtx = { d, opts: diffOpts, b, preDropped, add, unsupported };
  for (const p of pairBy(a.tables, b.tables, (t) => key(t.name))) {
    if (p.left && !p.right) createTable(p.left);
    else if (!p.left && p.right) onlyB.push(p.right);
    else if (p.left && p.right) tableChanges(p.left, p.right, ctx);
  }
  for (const t of dropOrder(d, onlyB)) {
    add(PHASE.drops, `table ${t.name}: only in B`, d === "oracle" ? `DROP TABLE ${q(d, t.name)} CASCADE CONSTRAINTS;` : `DROP TABLE ${q(d, t.name)};`, true);
  }

  // ---- views
  for (const p of pairBy(a.views, b.views, (v) => key(v.name))) {
    if (p.left && !p.right) for (const sql of viewSql(d, p.left, false)) add(PHASE.views, `view ${p.left.name}: create`, sql);
    else if (!p.left && p.right) add(PHASE.drops, `view ${p.right.name}: only in B`, dropViewSql(d, p.right), true);
    else if (p.left && p.right && viewChanges(p.left, p.right).length > 0) {
      for (const sql of viewSql(d, p.left, true)) add(PHASE.views, `view ${p.right.name}: replace`, sql);
    }
  }

  // ---- sequences
  for (const p of pairBy(a.sequences, b.sequences, (s) => key(s.name))) {
    if (p.left && !p.right) {
      const sql = sequenceSql(d, "CREATE", p.left);
      if (sql) add(PHASE.sequences, `sequence ${p.left.name}: create`, sql);
      else unsupported(`sequence ${p.left.name}`);
    } else if (!p.left && p.right) {
      if (d === "oracle" || d === "postgres") add(PHASE.drops, `sequence ${p.right.name}: only in B`, `DROP SEQUENCE ${q(d, p.right.name)};`, true);
    } else if (p.left && p.right && sequenceChanges(p.left, p.right).length > 0) {
      const sql = sequenceSql(d, "ALTER", p.left);
      if (sql) add(PHASE.sequences, `sequence ${p.right.name}: alter`, sql);
      else unsupported(`sequence ${p.right.name}`);
    }
  }

  // ---- routines: the source is not generated; drops are
  for (const p of pairBy(a.routines, b.routines, (r) => routineKey(d, r))) {
    if (p.left && !p.right) notes.push(`routine ${routineLabel(p.left)}: only in A; create it from A's source`);
    else if (!p.left && p.right) {
      const sql = dropRoutineSql(d, p.right);
      if (sql) add(PHASE.drops, `routine ${routineLabel(p.right)}: only in B`, sql, true);
    } else if (p.left && p.right && routineChanged(p.left, p.right)) {
      notes.push(`routine ${routineLabel(p.left)}: changed; replace it with A's source (not generated)`);
    }
  }

  return { driver: d, header: headerOf(d, b.schema), statements, notes };
}

/** The phase-ordered script text: header, one commented line per statement, notes last. */
export function renderMigration(plan: MigrationPlan, opts: MigrationOptions, names: { from: string; to: string }): string {
  const out: string[] = [
    `-- Migration: make ${names.to} like ${names.from} (${DIALECT_NAME[plan.driver]})`,
    "-- Generated from the schema compare. Review it before you run it.",
    opts.includeDrops
      ? "-- Statements that drop objects are included."
      : "-- Statements that drop objects are commented out: uncomment them to apply them.",
    "",
    ...plan.header,
  ];
  const ordered = [...plan.statements].sort((x, y) => x.phase - y.phase);
  for (const s of ordered) {
    out.push("", `-- ${s.comment}`);
    if (s.destructive && !opts.includeDrops) out.push(...s.sql.split("\n").map((line) => `-- ${line}`));
    else out.push(s.sql);
  }
  if (plan.notes.length > 0) out.push("", ...plan.notes.map((n) => `-- NOTE: ${n}`));
  return `${out.join("\n")}\n`;
}

/** How many statements the plan has, and how many of them run (the rest are commented out for `opts`). */
export function planCounts(plan: MigrationPlan, opts: MigrationOptions): { total: number; active: number; commented: number } {
  const commented = opts.includeDrops ? 0 : plan.statements.filter((s) => s.destructive).length;
  return { total: plan.statements.length, active: plan.statements.length - commented, commented };
}
