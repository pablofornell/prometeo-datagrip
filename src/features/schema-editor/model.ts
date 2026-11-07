/**
 * Model of the Modify Table / New Table dialog: the structure of a table as the user edits it
 * (columns, keys, foreign keys, indexes, checks). The generator (`sqlgen.ts`) turns the difference between the
 * loaded table and the edited one into DDL. Items keep a `uid`: that is how a rename is told from a drop + add.
 */
import type { Driver } from "../../api/types";

export type { Driver };

export interface ColumnDef {
  uid: string;
  name: string;
  /** SQL type as written: `varchar(100)`, `numeric(10,2)`, `int unsigned`. */
  type: string;
  notNull: boolean;
  /** Default as an SQL expression (`0`, `'abc'`, `now()`); empty = none. */
  default: string;
  comment: string;
  /** Generation expression (generated column); empty = a plain column. */
  generated: string;
  generatedStored: boolean;
  /** PostgreSQL identity column. */
  identity: "" | "ALWAYS" | "BY DEFAULT";
  /** MySQL `auto_increment`, SQLite `autoincrement` (of a single-column integer primary key). */
  autoIncrement: boolean;
  /** MySQL `on update current_timestamp`. */
  onUpdate: string;
  /** MySQL collation when it differs from the table default (kept when the column is redefined). */
  collation: string;
}

export interface KeyDef {
  uid: string;
  name: string;
  primary: boolean;
  columns: string[];
  /** `uid` of the column behind each entry of `columns` ("" for none): see `bindColumnRefs`. */
  columnUids?: string[];
}

export interface FkDef {
  uid: string;
  name: string;
  columns: string[];
  /** `uid` of the column behind each entry of `columns`. */
  columnUids?: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface IndexDef {
  uid: string;
  name: string;
  unique: boolean;
  /** Column names or (PostgreSQL / SQLite) expressions. */
  columns: string[];
  /** `uid` of the column behind each entry of `columns` ("" for an expression). */
  columnUids?: string[];
  /** PostgreSQL access method (`btree`, `hash`, ...); empty = default. */
  method: string;
  /** An index the dialog cannot rebuild faithfully (partial, INCLUDE): it can be dropped, not edited. */
  locked?: boolean;
  /** `create index ...` of the index as the server has it (used for locked indexes). */
  definition?: string;
}

export interface CheckDef {
  uid: string;
  name: string;
  expr: string;
}

export interface TableDef {
  schema: string;
  name: string;
  comment: string;
  /** PostgreSQL owner / tablespace. */
  owner: string;
  tablespace: string;
  columns: ColumnDef[];
  keys: KeyDef[];
  fks: FkDef[];
  indexes: IndexDef[];
  checks: CheckDef[];
  /** SQLite: `without rowid` / `strict` after the closing parenthesis of the original table. */
  sqliteOptions: string;
  /** SQLite: statements of the triggers of the table (dropped with it, recreated after a rebuild). */
  triggers: string[];
  /** MySQL: default collation of the table. */
  tableCollation: string;
  /** Things a rebuild cannot keep (SQLite): shown under the preview. */
  warnings: string[];
}

export const FK_ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] as const;

let counter = 0;
export const newUid = (): string => `u${++counter}`;

export function newColumn(over: Partial<ColumnDef> = {}): ColumnDef {
  return {
    uid: newUid(),
    name: "",
    type: "",
    notNull: false,
    default: "",
    comment: "",
    generated: "",
    generatedStored: true,
    identity: "",
    autoIncrement: false,
    onUpdate: "",
    collation: "",
    ...over,
  };
}

export const newKey = (over: Partial<KeyDef> = {}): KeyDef => ({ uid: newUid(), name: "", primary: false, columns: [], ...over });
export const newFk = (over: Partial<FkDef> = {}): FkDef => ({
  uid: newUid(),
  name: "",
  columns: [],
  refSchema: "",
  refTable: "",
  refColumns: [],
  onUpdate: "NO ACTION",
  onDelete: "NO ACTION",
  ...over,
});
export const newIndex = (over: Partial<IndexDef> = {}): IndexDef => ({ uid: newUid(), name: "", unique: false, columns: [], method: "", ...over });
export const newCheck = (over: Partial<CheckDef> = {}): CheckDef => ({ uid: newUid(), name: "", expr: "", ...over });

export function emptyTable(schema: string, name = "table_name"): TableDef {
  return {
    schema,
    name,
    comment: "",
    owner: "",
    tablespace: "",
    columns: [],
    keys: [],
    fks: [],
    indexes: [],
    checks: [],
    sqliteOptions: "",
    triggers: [],
    tableCollation: "",
    warnings: [],
  };
}

export const cloneTable = (t: TableDef): TableDef => JSON.parse(JSON.stringify(t)) as TableDef;

// ---------------------------------------------------------------- column references by uid
//
// Keys, foreign keys and indexes list their columns by name (that is what the generator writes), next to it
// `columnUids` says which column each name stands for. While the user types a new name for a column the names are
// ambiguous for a moment (`name2` -> `name` -> `name3`, with another column called `name`): the uid is what tells
// whose reference an entry is, so a rename or a removal follows the uid, never the name.

type Refs = { columns: string[]; columnUids?: string[] };

/** Fills the uids that are missing (names of columns of the table; anything else is an expression). */
export function bindColumnRefs(t: TableDef): void {
  const byName = new Map<string, string>();
  for (const c of t.columns) if (!byName.has(c.name)) byName.set(c.name, c.uid);
  const bind = (r: Refs) => {
    const have = r.columnUids ?? [];
    r.columnUids = r.columns.map((n, i) => have[i] || byName.get(n) || "");
  };
  t.keys.forEach(bind);
  t.fks.forEach(bind);
  t.indexes.forEach(bind);
}

/** Renames a column and the entries of keys, foreign keys and indexes that stand for it. */
export function renameColumnRefs(t: TableDef, uid: string, name: string): void {
  bindColumnRefs(t);
  const c = t.columns.find((x) => x.uid === uid);
  if (!c) return;
  c.name = name;
  const swap = (r: Refs) => (r.columns = r.columns.map((n, i) => (r.columnUids?.[i] === uid ? name : n)));
  t.keys.forEach(swap);
  t.fks.forEach(swap);
  t.indexes.forEach(swap);
}

/** Removes a column; keys and indexes lose the entry (and go when empty), foreign keys on it go. */
export function removeColumnRefs(t: TableDef, uid: string): void {
  bindColumnRefs(t);
  t.columns = t.columns.filter((c) => c.uid !== uid);
  const strip = (r: Refs) => {
    const keep = r.columns.map((_, i) => r.columnUids?.[i] !== uid);
    r.columns = r.columns.filter((_, i) => keep[i]);
    r.columnUids = (r.columnUids ?? []).filter((_, i) => keep[i]);
  };
  t.keys.forEach(strip);
  t.keys = t.keys.filter((k) => k.columns.length > 0);
  t.indexes.forEach(strip);
  t.indexes = t.indexes.filter((i) => i.columns.length > 0);
  t.fks = t.fks.filter((f) => !f.columnUids?.includes(uid));
}

/** Sets the column list of a key / foreign key / index to `names`, keeping the uid of the entries that stay. */
export function setColumnRefs(t: TableDef, list: "keys" | "fks" | "indexes", uid: string, names: string[]): void {
  bindColumnRefs(t);
  const item = (t[list] as (Refs & { uid: string })[]).find((x) => x.uid === uid);
  if (!item) return;
  const known = new Map(item.columns.map((n, i) => [n, item.columnUids?.[i] ?? ""]));
  const byName = new Map<string, string>();
  for (const c of t.columns) if (!byName.has(c.name)) byName.set(c.name, c.uid);
  item.columnUids = names.map((n) => known.get(n) || byName.get(n) || "");
  item.columns = names;
}

/** The types offered by the Data Type combo of each dialect. */
export const TYPES: Record<Driver, string[]> = {
  postgres: [
    "bigint",
    "bigserial",
    "bit",
    "boolean",
    "bytea",
    "char",
    "cidr",
    "date",
    "double precision",
    "inet",
    "integer",
    "interval",
    "json",
    "jsonb",
    "macaddr",
    "money",
    "numeric",
    "real",
    "serial",
    "smallint",
    "smallserial",
    "text",
    "time",
    "timestamp",
    "timestamptz",
    "tsvector",
    "uuid",
    "varchar",
    "xml",
  ],
  mysql: [
    "bigint",
    "binary",
    "bit",
    "blob",
    "char",
    "date",
    "datetime",
    "decimal",
    "double",
    "enum",
    "float",
    "int",
    "json",
    "longblob",
    "longtext",
    "mediumblob",
    "mediumint",
    "mediumtext",
    "set",
    "smallint",
    "text",
    "time",
    "timestamp",
    "tinyblob",
    "tinyint",
    "tinytext",
    "varbinary",
    "varchar",
    "year",
  ],
  sqlite: ["blob", "boolean", "date", "datetime", "integer", "numeric", "real", "text", "varchar"],
};

export const PG_INDEX_METHODS = ["btree", "hash", "gist", "spgist", "gin", "brin"];

/** Splits `a, lower(b), c` on the commas outside parentheses and quotes. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
