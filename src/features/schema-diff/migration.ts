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
  keyDefinition,
  nameKey,
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

/** Column definition `name type [DEFAULT x] [NOT NULL]`; null for generated and identity columns (written by hand). */
function columnDefinition(d: Driver, c: CompareColumn): string | null {
  if (c.extra !== null) return null;
  let s = `${q(d, c.name)} ${c.dataType}`;
  if (c.default !== null) s += ` DEFAULT ${c.default}`;
  if (!c.nullable) s += " NOT NULL";
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
  const def = columnDefinition(d, c);
  if (!def) return null;
  return d === "oracle" ? `ALTER TABLE ${q(d, t)} ADD (${def});` : `ALTER TABLE ${q(d, t)} ADD COLUMN ${def};`;
}

/** Changes a column of B to the definition of A: one statement per attribute on PostgreSQL, one `MODIFY` elsewhere. */
function modifyColumnSql(d: Driver, t: string, colName: string, from: CompareColumn, to: CompareColumn): string[] | null {
  const T = q(d, t);
  const C = q(d, colName);
  if (d === "sqlite") return null;
  if (d === "oracle") {
    if (from.extra !== null) return null;
    const dflt = from.default !== null ? ` DEFAULT ${from.default}` : " DEFAULT NULL";
    return [`ALTER TABLE ${T} MODIFY (${C} ${from.dataType}${dflt}${from.nullable ? " NULL" : " NOT NULL"});`];
  }
  if (d === "mysql") {
    const def = columnDefinition(d, from);
    if (!def) return null;
    return [`ALTER TABLE ${T} MODIFY COLUMN ${def};`];
  }
  if (from.extra !== null) return null;
  const out: string[] = [];
  if (normType(from.dataType) !== normType(to.dataType)) out.push(`ALTER TABLE ${T} ALTER COLUMN ${C} TYPE ${from.dataType};`);
  if (from.nullable !== to.nullable) out.push(`ALTER TABLE ${T} ALTER COLUMN ${C} ${from.nullable ? "DROP" : "SET"} NOT NULL;`);
  if ((from.default ?? null) !== (to.default ?? null)) {
    out.push(from.default === null ? `ALTER TABLE ${T} ALTER COLUMN ${C} DROP DEFAULT;` : `ALTER TABLE ${T} ALTER COLUMN ${C} SET DEFAULT ${from.default};`);
  }
  return out;
}

const dropColumnSql = (d: Driver, t: string, c: string): string => `ALTER TABLE ${q(d, t)} DROP COLUMN ${q(d, c)};`;

function addKeySql(d: Driver, t: string, kind: "primaryKey" | "unique", k: CompareKey): string | null {
  if (d === "sqlite") return null;
  const named = k.name ? ` CONSTRAINT ${q(d, k.name)}` : "";
  const cols = k.columns.map((c) => q(d, c)).join(", ");
  return `ALTER TABLE ${q(d, t)} ADD${named} ${kind === "primaryKey" ? "PRIMARY KEY" : "UNIQUE"} (${cols});`;
}

function addCheckSql(d: Driver, t: string, c: CompareCheck): string | null {
  if (d === "sqlite") return null;
  const named = c.name ? ` CONSTRAINT ${q(d, c.name)}` : "";
  return `ALTER TABLE ${q(d, t)} ADD${named} CHECK (${c.expression});`;
}

function addForeignKeySql(d: Driver, t: string, f: CompareForeignKey): string | null {
  if (d === "sqlite" || f.refColumns.length === 0) return null;
  // Oracle takes CASCADE and SET NULL only (NO ACTION is its default)
  let onDelete = f.onDelete === "NO ACTION" ? "" : ` ON DELETE ${f.onDelete}`;
  if (d === "oracle") {
    if (f.onDelete === "RESTRICT" || f.onDelete === "NO ACTION") onDelete = "";
    else if (f.onDelete === "SET DEFAULT") return null;
  }
  const named = f.name ? ` CONSTRAINT ${q(d, f.name)}` : "";
  const ref = `${f.refSchema ? `${q(d, f.refSchema)}.` : ""}${q(d, f.refTable)}`;
  return `ALTER TABLE ${q(d, t)} ADD${named} FOREIGN KEY (${f.columns.map((c) => q(d, c)).join(", ")}) REFERENCES ${ref} (${f.refColumns.map((c) => q(d, c)).join(", ")})${onDelete};`;
}

/** Drops a key, check or foreign key by its name (MySQL has its own statement per kind). */
function dropConstraintSql(d: Driver, t: string, kind: "primaryKey" | "unique" | "check" | "foreignKey", name: string): string | null {
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
  if (!i.name) return null;
  const using = d === "postgres" && i.method && i.method !== "btree" ? ` USING ${i.method}` : "";
  const cols = i.columns.map((c) => (/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(c) ? q(d, c) : c)).join(", ");
  const where = i.predicate ? ` WHERE ${i.predicate}` : "";
  return `CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${q(d, i.name)} ON ${q(d, t)}${using} (${cols})${where};`;
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
  const add = (phase: number, comment: string, sql: string, destructive = false) => statements.push({ phase, comment, sql, destructive });
  const unsupported = (comment: string) =>
    notes.push(`${comment}: not generated for ${DIALECT_NAME[d]}${d === "sqlite" ? " (SQLite changes this only by rebuilding the table)" : ""}; write it by hand`);
  const key = (name: string) => nameKey(d, name);

  // ---- tables
  for (const p of pairBy(a.tables, b.tables, (t) => key(t.name))) {
    if (p.left && !p.right) {
      const ddl = sourceDdl.get(tableDdlKey(p.left.name));
      if (ddl && ddl.trim()) add(PHASE.create, `table ${p.left.name}: create (from A)`, ddl.trim().endsWith(";") ? ddl.trim() : `${ddl.trim()};`);
      else notes.push(`table ${p.left.name}: the DDL of A is missing; create the table by hand`);
    } else if (!p.left && p.right) {
      const T = p.right.name;
      add(PHASE.drops, `table ${T}: only in B`, d === "oracle" ? `DROP TABLE ${q(d, T)} CASCADE CONSTRAINTS;` : `DROP TABLE ${q(d, T)};`, true);
    } else if (p.left && p.right) {
      tableChanges(p.left, p.right, d, diffOpts, add, unsupported);
    }
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

type Add = (phase: number, comment: string, sql: string, destructive?: boolean) => void;

/** The statements of one table that exists on both sides. Names of existing objects are B's, definitions A's. */
function tableChanges(l: CompareTable, r: CompareTable, d: Driver, opts: DiffOptions, add: Add, unsupported: (comment: string) => void): void {
  const T = r.name;
  const where = `table ${T}`;

  // columns
  for (const p of pairBy(l.columns, r.columns, (c) => nameKey(d, c.name))) {
    if (p.left && !p.right) {
      const sql = addColumnSql(d, T, p.left);
      if (sql) add(PHASE.columns, `${where}: add column ${p.left.name}`, sql);
      else unsupported(`${where}: add column ${p.left.name}`);
    } else if (!p.left && p.right) {
      add(PHASE.drops, `${where}: drop column ${p.right.name} (only in B)`, dropColumnSql(d, T, p.right.name), true);
    } else if (p.left && p.right && columnChanges(p.left, p.right).length > 0) {
      const sqls = modifyColumnSql(d, T, p.right.name, p.left, p.right);
      if (sqls) for (const sql of sqls) add(PHASE.columns, `${where}: change column ${p.right.name}`, sql);
      else unsupported(`${where}: change column ${p.right.name}`);
    }
  }

  // keys, checks, foreign keys and indexes: a changed one is dropped (phase replace) and created again
  const items = <X>(
    lefts: X[],
    rights: X[],
    spec: { name: (x: X) => string; definition: (x: X) => string; label: (x: X) => string; phase: number; add: (x: X) => string | null; drop: (x: X) => string | null },
  ) => {
    for (const p of pairItems(d, lefts, rights, spec, opts) as Pair<X>[]) {
      const sample = (p.left ?? p.right) as X;
      const label = `${where}: ${spec.label(sample)}`;
      if (p.left && !p.right) {
        const sql = spec.add(p.left);
        if (sql) add(spec.phase, `${where}: add ${spec.label(p.left)}`, sql);
        else unsupported(`${where}: add ${spec.label(p.left)}`);
      } else if (!p.left && p.right) {
        const sql = spec.drop(p.right);
        if (sql) add(PHASE.replace, `${label} (only in B)`, sql, true);
        else unsupported(`${label} (only in B): drop`);
      } else if (p.left && p.right && spec.definition(p.left) !== spec.definition(p.right)) {
        const dropSql = spec.drop(p.right);
        const addSql = spec.add(p.left);
        if (dropSql) add(PHASE.replace, `${label}: replace`, dropSql);
        else unsupported(`${label}: drop before it is created again`);
        if (addSql) add(spec.phase, `${label}: replace`, addSql);
        else unsupported(`${label}: replace`);
      }
    }
  };

  const pkName = (k: CompareKey) => k.name;
  items<CompareKey>(l.primaryKey ? [l.primaryKey] : [], r.primaryKey ? [r.primaryKey] : [], {
    name: pkName,
    definition: keyDefinition,
    label: (k) => `primary key ${keyDefinition(k)}`,
    phase: PHASE.keys,
    add: (k) => addKeySql(d, T, "primaryKey", k),
    drop: (k) => dropConstraintSql(d, T, "primaryKey", k.name),
  });
  items<CompareKey>(l.unique, r.unique, {
    name: pkName,
    definition: keyDefinition,
    label: (k) => `unique ${k.name || keyDefinition(k)}`,
    phase: PHASE.keys,
    add: (k) => addKeySql(d, T, "unique", k),
    drop: (k) => dropConstraintSql(d, T, "unique", k.name),
  });
  items<CompareCheck>(l.checks, r.checks, {
    name: (c) => c.name,
    definition: checkDefinition,
    label: (c) => `check ${c.name || checkDefinition(c)}`,
    phase: PHASE.keys,
    add: (c) => addCheckSql(d, T, c),
    drop: (c) => dropConstraintSql(d, T, "check", c.name),
  });
  items<CompareForeignKey>(l.foreignKeys, r.foreignKeys, {
    name: (f) => f.name,
    definition: foreignKeyDefinition,
    label: (f) => `foreign key ${f.name || foreignKeyDefinition(f)}`,
    phase: PHASE.foreignKeys,
    add: (f) => addForeignKeySql(d, T, f),
    drop: (f) => dropConstraintSql(d, T, "foreignKey", f.name),
  });
  items<CompareIndex>(l.indexes, r.indexes, {
    name: (i) => i.name,
    definition: indexDefinition,
    label: (i) => `index ${i.name || indexDefinition(i)}`,
    phase: PHASE.indexes,
    add: (i) => createIndexSql(d, T, i),
    drop: (i) => dropIndexSql(d, T, i.name),
  });
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
