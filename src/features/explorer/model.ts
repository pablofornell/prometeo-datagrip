/** Node model of the Database Explorer: tree item shape, icon / hint / label rules, object references. */
import type { Driver, NodeKind, ObjectRef, TreeNode } from "../../api/db";
import type { TreeItem } from "../../components/ui";
import { LOCAL } from "./icons";

export type ExplorerKind = NodeKind | "loading" | "error";

export interface NodeData {
  dsId: string;
  kind: ExplorerKind;
  name: string;
  /** Path to pass to `introspect` (empty for a data source). */
  path: string[];
  extra: Record<string, any>;
  driver: Driver;
  parentId?: string;
  /** Kind of the table / view this node belongs to (columns, keys, indexes, ... and their folders). */
  ownerKind?: NodeKind;
  /** Icon key (`x:` = explorer-local, else shared kit name). */
  icon?: string;
  /** Auto-numbered name ("key #1"): drawn small and gray like DataGrip. */
  synthetic?: boolean;
}

export interface ENode extends TreeItem {
  data: NodeData;
  children?: ENode[];
}

/** What the module API hands out for the selected node. */
export interface ExplorerNodeInfo {
  id: string;
  dsId: string;
  kind: NodeKind;
  name: string;
  label: string;
  path: string[];
  extra: Record<string, any>;
  objectRef: ObjectRef | null;
}

export const TABLE_LIKE: ExplorerKind[] = ["table", "view", "materializedView"];
export const ROUTINE_LIKE: ExplorerKind[] = ["routine", "function", "procedure"];
/** Nodes that live inside a table / view (their DDL and data editor are the table's). */
export const TABLE_CHILD: ExplorerKind[] = ["column", "primaryKey", "uniqueKey", "foreignKey", "index", "check", "trigger"];

export const FOLDER_OF_KIND: Partial<Record<NodeKind, string>> = {
  table: "tables",
  view: "views",
  materializedView: "materialized_views",
  routine: "routines",
  function: "routines",
  procedure: "routines",
  sequence: "sequences",
  column: "columns",
  primaryKey: "keys",
  uniqueKey: "keys",
  foreignKey: "foreign_keys",
  index: "indexes",
  check: "checks",
  trigger: "triggers",
};

// ---------------------------------------------------------------- icons

const NODE_ICON: Partial<Record<ExplorerKind, string>> = {
  database: "dg/database",
  schema: "dg/schema",
  folder: LOCAL + "object-group",
  table: "dg/table",
  view: "data-schema",
  materializedView: "dg/materialized-view",
  primaryKey: "dg/gold-key",
  uniqueKey: "dg/grey-key",
  foreignKey: "dg/blue-key",
  index: "dg/index",
  check: "dg/check-constraint",
  trigger: "dg/trigger",
  routine: "dg/routine",
  function: "dg/function",
  procedure: "dg/procedure",
  sequence: "dg/sequence",
  role: "dg/role",
  tablespace: "dg/database",
  extension: "dg/package",
  user: "dg/user",
  error: "error",
};

export interface ColumnContext {
  fk: Set<string>;
  uq: Set<string>;
  idx: Set<string>;
}

/** Column icon: key badge (PK gold, FK blue, both, unique grey) x NOT NULL dot x index stripe. */
export function columnIcon(tn: TreeNode, ctx?: ColumnContext): string {
  const name = tn.name;
  const pk = !!tn.extra.isPk;
  const fk = !!ctx?.fk.has(name);
  const uq = !!ctx?.uq.has(name);
  const idx = !!ctx?.idx.has(name);
  const dot = tn.extra.nullable === false;
  const key = pk && fk ? "gold-blue-key" : pk ? "gold-key" : fk ? "blue-key" : null;
  if (!key && uq && !idx && !dot) return LOCAL + "col-grey-key";
  return LOCAL + "col" + (key ? "-" + key : "") + (dot ? "-dot" : "") + (idx ? "-index" : "");
}

export function iconOf(kind: ExplorerKind, tn?: TreeNode, ctx?: ColumnContext): string | undefined {
  if (kind === "column") return tn ? columnIcon(tn, ctx) : LOCAL + "col";
  if (kind === "index" && tn?.extra.unique && !tn.extra.primary) return "dg/index-unique";
  // `Server Objects` / `Database Objects`
  if (kind === "folder" && tn?.extra.group) return tn.extra.folder === "$server" ? "dg/server-objects-group" : "dg/database-objects-group";
  return NODE_ICON[kind];
}

/** Icon of an editor tab / status crumb for an object. */
export function tabIconOf(kind: ExplorerKind): string {
  return iconOf(TABLE_CHILD.includes(kind) ? "table" : kind) ?? "dg/table";
}

// ---------------------------------------------------------------- hints and labels

const ELLIPSIS = "…";

function columnHint(tn: TreeNode): string {
  const type = tn.hint ?? (tn.extra.dataType as string | undefined) ?? "";
  const def = tn.extra.default;
  if (def == null || def === "") return type;
  const s = String(def);
  const t = s.length > 20 ? s.slice(0, 18) + ELLIPSIS + (s.endsWith(")") ? ")" : "") : s;
  return `${type} = ${t}`;
}

function fkHint(hint: string): string {
  return hint.replace(/\s*->\s*([^\s(]+)\s*\(/, " → $1 (");
}

function checkHint(def: string): string {
  let s = def.trim().replace(/^CHECK\s*/i, "");
  if (!s.startsWith("(")) s = `(${s})`;
  return s.length > 26 ? s.slice(0, 22) + ELLIPSIS + ")" : s;
}

const TYPE_FIRST_WORDS = new Set(["double", "character", "timestamp", "time", "bit", "national", "interval", "long", "unsigned"]);

/** "(cid integer, name text): numeric" -> "(cid: integer, name: text): numeric" (DataGrip's signature style). */
function routineHint(hint: string): string {
  const m = /^\((.*)\)(.*)$/.exec(hint);
  if (!m) return hint;
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of m[1]) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() || args.length) args.push(cur);
  const out = args.map((a) => {
    const t = a.trim();
    const sp = t.indexOf(" ");
    if (sp < 0) return t;
    const first = t.slice(0, sp);
    if (/^(IN|OUT|INOUT|VARIADIC)$/i.test(first) || TYPE_FIRST_WORDS.has(first.toLowerCase())) return t;
    return `${first}: ${t.slice(sp + 1)}`;
  });
  return `(${out.join(", ")})${m[2]}`;
}

/** Objects whose comment is shown as a hover tooltip (never as an inline hint, like DataGrip). */
const COMMENTED: ReadonlySet<NodeKind> = new Set(["database", "schema", "table", "view", "materializedView"]);

export function commentOf(tn: TreeNode): string | undefined {
  if (!COMMENTED.has(tn.kind)) return undefined;
  // SQLite reports the database file as the "comment" of a schema; MySQL reports "VIEW" for views
  const c = typeof tn.extra.comment === "string" ? tn.extra.comment : tn.extra.file || tn.kind === "database" ? undefined : tn.hint;
  const t = c?.trim();
  return !t || (tn.kind === "view" && t === "VIEW") ? undefined : t;
}

export function hintOf(tn: TreeNode): string | undefined {
  if (COMMENTED.has(tn.kind)) return undefined;
  switch (tn.kind) {
    case "column":
      return columnHint(tn) || undefined;
    case "foreignKey":
      return tn.hint ? fkHint(tn.hint) : undefined;
    case "check":
      return tn.hint ? checkHint(tn.hint) : undefined;
    case "function":
    case "procedure":
    case "routine":
      return tn.hint ? routineHint(tn.hint) : undefined;
    default:
      return tn.hint ?? undefined;
  }
}

/** SQLite has no constraint names: DataGrip numbers them ("key #1", "foreign-key #1", "check #1"). */
export function syntheticLabel(kind: NodeKind, driver: Driver, index: number): string | undefined {
  if (driver !== "sqlite") return undefined;
  switch (kind) {
    case "primaryKey":
    case "uniqueKey":
      return `key #${index}`;
    case "foreignKey":
      return `foreign-key #${index}`;
    case "check":
      return `check #${index}`;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- object references

export function objectRefOf(d: NodeData): ObjectRef | null {
  const ex = d.extra;
  switch (d.kind) {
    case "database":
      return { schema: null, name: d.name, kind: "database" };
    case "schema":
      return { schema: d.name, name: d.name, kind: "schema" };
    case "table":
    case "view":
    case "materializedView":
    case "sequence":
      return { schema: ex.schema ?? null, name: d.name, kind: d.kind };
    case "routine":
    case "function":
    case "procedure":
      return { schema: ex.schema ?? null, name: d.name, kind: d.kind, signature: ex.signature ?? null };
    case "column":
    case "primaryKey":
    case "uniqueKey":
    case "foreignKey":
    case "index":
    case "check":
    case "trigger":
      return { schema: ex.schema ?? null, name: d.name, kind: d.kind, table: ex.table ?? null };
    default:
      return null;
  }
}

/** The table / view a node belongs to (or is), as an object reference. */
export function tableRefOf(d: NodeData): ObjectRef | null {
  if (TABLE_LIKE.includes(d.kind)) return objectRefOf(d);
  if (TABLE_CHILD.includes(d.kind) && d.extra.table)
    return { schema: d.extra.schema ?? null, name: d.extra.table, kind: d.ownerKind ?? "table" };
  return null;
}

/** DDL is shown for these; children of a table show the table's DDL. */
export function ddlRefOf(d: NodeData): ObjectRef | null {
  const t = tableRefOf(d);
  if (t) return t;
  switch (d.kind) {
    case "sequence":
    case "routine":
    case "function":
    case "procedure":
      return objectRefOf(d);
    default:
      return null;
  }
}

/** Text of "Copy Reference": the qualified name, like DataGrip's `schema.table.column`. */
export function referenceOf(d: NodeData): string {
  const ex = d.extra;
  switch (d.kind) {
    case "dataSource":
    case "database":
    case "schema":
      return d.name;
    case "column":
    case "primaryKey":
    case "uniqueKey":
    case "foreignKey":
    case "index":
    case "check":
    case "trigger":
      return [ex.schema, ex.table, d.name].filter(Boolean).join(".");
    case "folder":
      return [ex.schema, ex.table, d.name].filter(Boolean).join(".");
    default:
      return [ex.schema, d.name].filter(Boolean).join(".");
  }
}

export const encodeSeg = (s: string) => s.replace(/%/g, "%25").replace(/\//g, "%2F");

/** Node id of a backend path (same encoding as dbcore's `node_id`). */
export const nodeIdOf = (dsId: string, path: string[]) => [dsId, ...path.map(encodeSeg)].join("/");
