/**
 * Difference tree of two schema models (`SchemaModel`, from the backend's `schema_model`): objects only in A, only in B,
 * or changed, down to columns, keys, checks, foreign keys, indexes, view and routine text. Pure: no I/O.
 *
 * Matching: names are compared with `nameKey` (case-insensitive for MySQL and for Oracle's unquoted names). With
 * `ignoreConstraintNames` the keys, checks, foreign keys and indexes are matched by their definition, not their name.
 * `migration.ts` reuses the pairing and the change rules exported here, so the script and the tree never disagree.
 */
import type {
  CompareCheck,
  CompareColumn,
  CompareForeignKey,
  CompareIndex,
  CompareKey,
  CompareRoutine,
  CompareSequence,
  CompareTable,
  CompareView,
  Driver,
  SchemaModel,
} from "../../api/types";

export type DiffStatus = "same" | "onlyA" | "onlyB" | "changed";

export type DiffKind = "schema" | "table" | "column" | "primaryKey" | "unique" | "check" | "foreignKey" | "index" | "view" | "sequence" | "routine";

export interface DiffNode {
  /** Path of the node (`schema/table:EMP/column:ID`), unique within the tree. */
  id: string;
  kind: DiffKind;
  /** Name shown: A's, or B's when the object exists only in B (a constraint without a name shows its definition). */
  name: string;
  status: DiffStatus;
  /** One line per difference, e.g. `type VARCHAR2(50) -> VARCHAR2(80)`. Empty when the object is in one side only. */
  changes: string[];
  /** The object's name in A and in B; null when it is missing on that side. */
  leftName: string | null;
  rightName: string | null;
  children: DiffNode[];
}

export interface DiffOptions {
  /** Columns in another position are the same (default). Positions are never migrated: Oracle and MySQL need a rebuild. */
  ignoreColumnOrder: boolean;
  /** Constraints and indexes are matched by definition, not by name. */
  ignoreConstraintNames: boolean;
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = { ignoreColumnOrder: true, ignoreConstraintNames: false };

/** What the tree shows: everything, only the differences, or the objects of one side. */
export type DiffFilter = "all" | "differences" | "leftOnly" | "rightOnly";

/**
 * The key an object's name is matched by. MySQL names are case-insensitive. Oracle stores unquoted names in upper
 * case, so an upper-case name matches its other-case spelling only when it is unquoted (has no lower case letter).
 */
export function nameKey(driver: Driver, name: string): string {
  if (driver === "mysql") return name.toLowerCase();
  if (driver === "oracle") return /[a-z]/.test(name) ? name : name.toUpperCase();
  return name;
}

/** Objects of one kind paired across the two sides: `left` / `right` missing when the object is on one side only. */
export interface Pair<T> {
  key: string;
  left?: T;
  right?: T;
}

/**
 * Pairs the items of two lists by `key`. Items with the same key pair in order (so a definition that occurs twice on
 * one side pairs with each occurrence). Left items come first in their order, then the right-only ones.
 */
export function pairBy<T>(left: readonly T[], right: readonly T[], key: (x: T) => string): Pair<T>[] {
  const pool = new Map<string, T[]>();
  for (const y of right) {
    const k = key(y);
    const queue = pool.get(k);
    if (queue) queue.push(y);
    else pool.set(k, [y]);
  }
  const pairs: Pair<T>[] = left.map((x) => {
    const k = key(x);
    return { key: k, left: x, right: pool.get(k)?.shift() };
  });
  for (const [k, queue] of pool) for (const y of queue) pairs.push({ key: k, right: y });
  return pairs;
}

/** Status of a paired object from its own changes and its children. */
export function pairStatus<T>(p: Pair<T>, changed: boolean): DiffStatus {
  if (p.left && !p.right) return "onlyA";
  if (!p.left && p.right) return "onlyB";
  return changed ? "changed" : "same";
}

/**
 * Pairs the constraints / indexes of one table. With names kept they pair by name; with `ignoreConstraintNames` by
 * definition. Paired items are "changed" when the definitions differ (by name pairing only).
 */
export function pairItems<T>(
  driver: Driver,
  left: readonly T[],
  right: readonly T[],
  spec: { name: (x: T) => string; definition: (x: T) => string },
  opts: DiffOptions,
): Pair<T>[] {
  const key = opts.ignoreConstraintNames ? spec.definition : (x: T) => nameKey(driver, spec.name(x));
  return pairBy(left, right, key);
}

// ---------------------------------------------------------------- definitions and change rules

/** White space collapsed, trimmed. */
const squash = (t: string): string => t.split(/\s+/).filter(Boolean).join(" ");

/** Type text as compared: case and white space do not matter. */
export const normType = (t: string): string => squash(t).toLowerCase();

/** Text of a view or routine as compared: white space collapsed, trailing `;` ignored. */
export const normText = (t: string): string => squash(t).replace(/;$/, "").trim();

const cols = (c: readonly string[]): string => `(${c.join(", ")})`;

export const keyDefinition = (k: CompareKey): string => cols(k.columns);

export const checkDefinition = (c: CompareCheck): string => squash(c.expression);

export function foreignKeyDefinition(f: CompareForeignKey): string {
  const ref = `${f.refSchema ? `${f.refSchema}.` : ""}${f.refTable}${cols(f.refColumns)}`;
  const onDelete = f.onDelete && f.onDelete !== "NO ACTION" ? ` on delete ${f.onDelete.toLowerCase()}` : "";
  return `${cols(f.columns)} references ${ref}${onDelete}`;
}

export function indexDefinition(i: CompareIndex): string {
  const method = i.method ? ` ${i.method}` : "";
  const where = i.predicate ? ` where ${i.predicate}` : "";
  return `${i.unique ? "unique " : ""}${cols(i.columns)}${method}${where}`;
}

/** The changes of a column, except its position (see `DiffOptions.ignoreColumnOrder`). */
export function columnChanges(l: CompareColumn, r: CompareColumn): string[] {
  const out: string[] = [];
  if (normType(l.dataType) !== normType(r.dataType)) out.push(`type ${l.dataType} -> ${r.dataType}`);
  if (l.nullable !== r.nullable) out.push(`nullable ${l.nullable ? "NULL" : "NOT NULL"} -> ${r.nullable ? "NULL" : "NOT NULL"}`);
  if ((l.default ?? null) !== (r.default ?? null)) out.push(`default ${showDefault(l.default)} -> ${showDefault(r.default)}`);
  if ((l.extra ?? "") !== (r.extra ?? "")) out.push(`extra ${l.extra ?? "none"} -> ${r.extra ?? "none"}`);
  return out;
}

const showDefault = (d: string | null): string => (d === null ? "none" : d);

export function viewChanges(l: CompareView, r: CompareView): string[] {
  const out: string[] = [];
  if (normText(l.definition) !== normText(r.definition)) out.push("text differs");
  if (l.materialized !== r.materialized) out.push(`${l.materialized ? "materialized" : "plain"} -> ${r.materialized ? "materialized" : "plain"}`);
  return out;
}

export function sequenceChanges(l: CompareSequence, r: CompareSequence): string[] {
  const out: string[] = [];
  const field = (name: string, a: string, b: string) => {
    if (a !== b) out.push(`${name} ${a} -> ${b}`);
  };
  field("increment", l.incrementBy, r.incrementBy);
  field("min value", l.minValue, r.minValue);
  field("max value", l.maxValue, r.maxValue);
  field("cycle", String(l.cycle), String(r.cycle));
  field("cache", l.cacheSize, r.cacheSize);
  return out;
}

/** Routines pair by kind, name and signature (overloads, the table of a trigger). */
export const routineKey = (driver: Driver, r: CompareRoutine): string => `${r.kind}|${nameKey(driver, r.name)}|${r.signature}`;

export const routineChanged = (l: CompareRoutine, r: CompareRoutine): boolean => l.sourceHash !== r.sourceHash;

// ---------------------------------------------------------------- tree

const node = (
  kind: DiffKind,
  id: string,
  name: string,
  status: DiffStatus,
  changes: string[],
  children: DiffNode[],
  leftName: string | null,
  rightName: string | null,
): DiffNode => ({ id, kind, name, status, changes, children, leftName, rightName });

/** A unique id among the siblings: the base, then `base#2`, `base#3`, ... */
function claimId(seen: Set<string>, base: string): string {
  let id = base;
  for (let n = 2; seen.has(id); n++) id = `${base}#${n}`;
  seen.add(id);
  return id;
}

const statusOfChildren = (changes: string[], children: DiffNode[]): DiffStatus =>
  changes.length > 0 || children.some((c) => c.status !== "same") ? "changed" : "same";

interface ItemSpec<T> {
  kind: DiffKind;
  name: (x: T) => string;
  definition: (x: T) => string;
}

/** The nodes of a list of constraints or indexes (keys, checks, foreign keys, indexes). */
function itemNodes<T>(parentId: string, driver: Driver, left: readonly T[], right: readonly T[], spec: ItemSpec<T>, opts: DiffOptions): DiffNode[] {
  const seen = new Set<string>();
  return pairItems(driver, left, right, spec, opts).map((p) => {
    const sample = (p.left ?? p.right) as T;
    const label = spec.name(sample) || spec.definition(sample);
    const id = claimId(seen, `${parentId}/${spec.kind}:${label}`);
    const leftName = p.left ? spec.name(p.left) : null;
    const rightName = p.right ? spec.name(p.right) : null;
    if (!p.left || !p.right) {
      return node(spec.kind, id, label, pairStatus(p, false), [], [], leftName, rightName);
    }
    const ld = spec.definition(p.left);
    const rd = spec.definition(p.right);
    const changes = ld === rd ? [] : [`definition ${ld} -> ${rd}`];
    return node(spec.kind, id, label, changes.length ? "changed" : "same", changes, [], leftName, rightName);
  });
}

function columnNodes(parentId: string, driver: Driver, left: readonly CompareColumn[], right: readonly CompareColumn[], opts: DiffOptions): DiffNode[] {
  const key = (c: CompareColumn) => nameKey(driver, c.name);
  // the position among the columns both sides have: a column added in the middle does not move the others
  const rightKeys = new Set(right.map(key));
  const leftKeys = new Set(left.map(key));
  const rankL = new Map(left.filter((c) => rightKeys.has(key(c))).map((c, i) => [key(c), i] as const));
  const rankR = new Map(right.filter((c) => leftKeys.has(key(c))).map((c, i) => [key(c), i] as const));
  const seen = new Set<string>();
  return pairBy(left, right, key).map((p) => {
    const sample = (p.left ?? p.right) as CompareColumn;
    const id = claimId(seen, `${parentId}/column:${sample.name}`);
    if (!p.left || !p.right) {
      return node("column", id, sample.name, pairStatus(p, false), [], [], p.left?.name ?? null, p.right?.name ?? null);
    }
    const changes = columnChanges(p.left, p.right);
    if (!opts.ignoreColumnOrder && rankL.get(p.key) !== rankR.get(p.key)) {
      changes.push(`position ${(rankL.get(p.key) ?? 0) + 1} -> ${(rankR.get(p.key) ?? 0) + 1}`);
    }
    return node("column", id, p.left.name, changes.length ? "changed" : "same", changes, [], p.left.name, p.right.name);
  });
}

const KEY_SPEC = (kind: "primaryKey" | "unique"): ItemSpec<CompareKey> => ({ kind, name: (k) => k.name, definition: keyDefinition });
const CHECK_SPEC: ItemSpec<CompareCheck> = { kind: "check", name: (c) => c.name, definition: checkDefinition };
const FK_SPEC: ItemSpec<CompareForeignKey> = { kind: "foreignKey", name: (f) => f.name, definition: foreignKeyDefinition };
const INDEX_SPEC: ItemSpec<CompareIndex> = { kind: "index", name: (i) => i.name, definition: indexDefinition };

function tableNode(l: CompareTable | undefined, r: CompareTable | undefined, driver: Driver, opts: DiffOptions, parentId: string): DiffNode {
  const sample = (l ?? r) as CompareTable;
  const id = claimId(new Set(), `${parentId}/table:${sample.name}`);
  const children = [
    ...columnNodes(id, driver, l?.columns ?? [], r?.columns ?? [], opts),
    ...itemNodes(id, driver, l?.primaryKey ? [l.primaryKey] : [], r?.primaryKey ? [r.primaryKey] : [], KEY_SPEC("primaryKey"), opts),
    ...itemNodes(id, driver, l?.unique ?? [], r?.unique ?? [], KEY_SPEC("unique"), opts),
    ...itemNodes(id, driver, l?.checks ?? [], r?.checks ?? [], CHECK_SPEC, opts),
    ...itemNodes(id, driver, l?.foreignKeys ?? [], r?.foreignKeys ?? [], FK_SPEC, opts),
    ...itemNodes(id, driver, l?.indexes ?? [], r?.indexes ?? [], INDEX_SPEC, opts),
  ];
  const status = l && r ? statusOfChildren([], children) : l ? "onlyA" : "onlyB";
  return node("table", id, sample.name, status, [], children, l?.name ?? null, r?.name ?? null);
}

const byName = (a: DiffNode, b: DiffNode): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The difference tree of `a` (left) against `b` (right). The root's children: tables, views, sequences, routines. */
export function diffSchemas(a: SchemaModel, b: SchemaModel, opts: DiffOptions = DEFAULT_DIFF_OPTIONS): DiffNode {
  const driver = a.driver;
  const tables = pairBy(a.tables, b.tables, (t) => nameKey(driver, t.name))
    .map((p) => tableNode(p.left, p.right, driver, opts, "schema"))
    .sort(byName);

  const viewSeen = new Set<string>();
  const views = pairBy(a.views, b.views, (v) => nameKey(driver, v.name))
    .map((p) => {
      const sample = (p.left ?? p.right) as CompareView;
      const id = claimId(viewSeen, `schema/view:${sample.name}`);
      if (!p.left || !p.right) return node("view", id, sample.name, pairStatus(p, false), [], [], p.left?.name ?? null, p.right?.name ?? null);
      const changes = viewChanges(p.left, p.right);
      return node("view", id, p.left.name, changes.length ? "changed" : "same", changes, [], p.left.name, p.right.name);
    })
    .sort(byName);

  const seqSeen = new Set<string>();
  const sequences = pairBy(a.sequences, b.sequences, (s) => nameKey(driver, s.name))
    .map((p) => {
      const sample = (p.left ?? p.right) as CompareSequence;
      const id = claimId(seqSeen, `schema/sequence:${sample.name}`);
      if (!p.left || !p.right) return node("sequence", id, sample.name, pairStatus(p, false), [], [], p.left?.name ?? null, p.right?.name ?? null);
      const changes = sequenceChanges(p.left, p.right);
      return node("sequence", id, p.left.name, changes.length ? "changed" : "same", changes, [], p.left.name, p.right.name);
    })
    .sort(byName);

  const routineSeen = new Set<string>();
  const routines = pairBy(a.routines, b.routines, (r) => routineKey(driver, r))
    .map((p) => {
      const sample = (p.left ?? p.right) as CompareRoutine;
      const label = routineLabel(sample);
      const id = claimId(routineSeen, `schema/routine:${sample.kind}:${label}`);
      if (!p.left || !p.right) return node("routine", id, label, pairStatus(p, false), [], [], p.left ? p.left.name : null, p.right ? p.right.name : null);
      const changes = routineChanged(p.left, p.right) ? ["source differs"] : [];
      return node("routine", id, label, changes.length ? "changed" : "same", changes, [], p.left.name, p.right.name);
    })
    .sort(byName);

  const children = [...tables, ...views, ...sequences, ...routines];
  const changes: string[] = a.driver === b.driver ? [] : [`DBMS ${a.driver} -> ${b.driver}`];
  return node("schema", "schema", `${a.schema} -> ${b.schema}`, statusOfChildren(changes, children), changes, children, a.schema, b.schema);
}

/** The label of a routine: `FUNCTION name`, a PostgreSQL overload `name(integer)`, a trigger `name on table`. */
export function routineLabel(r: CompareRoutine): string {
  if (r.kind === "TRIGGER") return r.signature ? `${r.name} on ${r.signature}` : r.name;
  return r.signature ? `${r.name}(${r.signature})` : r.name;
}

// ---------------------------------------------------------------- views of the tree

/** Counts of the nodes below the root, by status (`same` nodes are not counted). */
export interface DiffSummary {
  onlyA: number;
  onlyB: number;
  changed: number;
}

export function summarize(root: DiffNode): DiffSummary {
  const out: DiffSummary = { onlyA: 0, onlyB: 0, changed: 0 };
  const walk = (n: DiffNode) => {
    if (n.status === "onlyA") out.onlyA++;
    else if (n.status === "onlyB") out.onlyB++;
    else if (n.status === "changed") out.changed++;
    n.children.forEach(walk);
  };
  root.children.forEach(walk);
  return out;
}

const matches = (n: DiffNode, f: DiffFilter): boolean => {
  switch (f) {
    case "all":
      return true;
    case "differences":
      return n.status !== "same";
    case "leftOnly":
      return n.status === "onlyA";
    case "rightOnly":
      return n.status === "onlyB";
  }
};

/**
 * The tree restricted to the nodes that match `filter`, plus their ancestors (a changed table stays when one of its
 * columns matches). The root is always kept.
 */
export function filterDiff(root: DiffNode, filter: DiffFilter): DiffNode {
  const prune = (n: DiffNode): DiffNode | null => {
    const children = n.children.map(prune).filter((c): c is DiffNode => c !== null);
    if (!matches(n, filter) && children.length === 0) return null;
    return { ...n, children };
  };
  return { ...root, children: root.children.map(prune).filter((c): c is DiffNode => c !== null) };
}

/** The rows a tree view shows: the nodes below the root, depth first, the children of collapsed nodes left out. */
export function visibleRows(root: DiffNode, expanded: ReadonlySet<string>): { node: DiffNode; depth: number }[] {
  const rows: { node: DiffNode; depth: number }[] = [];
  const walk = (n: DiffNode, depth: number) => {
    rows.push({ node: n, depth });
    if (expanded.has(n.id)) n.children.forEach((c) => walk(c, depth + 1));
  };
  root.children.forEach((c) => walk(c, 0));
  return rows;
}
