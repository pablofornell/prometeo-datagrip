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
}

export interface FkDef {
  uid: string;
  name: string;
  columns: string[];
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
