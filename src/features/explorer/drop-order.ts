/**
 * Order of a multi-object "Drop…": which objects go first, and how a cycle of foreign keys among the dropped tables is
 * dropped. Pure (no DOM, no state): the plan in actions.ts feeds it the tree and the schema snapshot.
 */
import type { Driver, SnapshotObject } from "../../api/db";
import { type ExplorerKind, TABLE_CHILD, TABLE_LIKE } from "./model";

/**
 * Where a kind goes in a multi-drop: the parts of a table first, then the views and the other objects, then the tables
 * (in their foreign-key order, see `tableDropGroups`), and the sequences last: a column default may use one.
 */
export const dropRank = (kind: ExplorerKind): number =>
  kind === "sequence" ? 4 : kind === "table" ? 3 : TABLE_CHILD.includes(kind) ? 0 : TABLE_LIKE.includes(kind) ? 1 : 2;

/**
 * The selected tables of one schema in drop order: a table goes after every table that references it (the referencing
 * one owns the foreign key). `names` are in tree order; the result holds indices into `names`, groups in drop order and
 * each group in tree order. Tables that reference each other in a cycle form one group (they cannot be ordered);
 * a table that references itself is no cycle. A reference to a table outside `names` or outside `schema` is ignored.
 */
export function tableDropGroups(names: readonly string[], schema: string, objects: readonly SnapshotObject[]): number[][] {
  const index = new Map<string, number>();
  names.forEach((name, i) => index.set(name, i));
  const owner = new Map<string, SnapshotObject>();
  for (const o of objects) if (o.schema === schema) owner.set(o.name, o);

  // refs[i]: the selected tables table i references (i must be dropped before them)
  const refs = names.map(() => new Set<number>());
  names.forEach((name, i) => {
    for (const fk of owner.get(name)?.foreignKeys ?? []) {
      const j = fk.refSchema === schema ? index.get(fk.refTable) : undefined;
      if (j !== undefined && j !== i) refs[i].add(j);
    }
  });

  // reach[i]: every table reachable from i through references; i and j are in one cycle when each reaches the other
  const reach = names.map((_, i) => {
    const seen = new Set<number>();
    const stack = [...refs[i]];
    while (stack.length) {
      const j = stack.pop()!;
      if (seen.has(j)) continue;
      seen.add(j);
      stack.push(...refs[j]);
    }
    return seen;
  });

  const groupOf = new Array<number>(names.length).fill(-1);
  const groups: number[][] = [];
  for (let i = 0; i < names.length; i++) {
    if (groupOf[i] >= 0) continue;
    const members = [i];
    for (let j = i + 1; j < names.length; j++) if (groupOf[j] < 0 && reach[i].has(j) && reach[j].has(i)) members.push(j);
    for (const m of members) groupOf[m] = groups.length;
    groups.push(members);
  }

  // after[g]: the groups g references (g goes first); pending[g]: the groups that still reference g (they go first)
  const after = groups.map(() => new Set<number>());
  const pending = groups.map(() => 0);
  groups.forEach((members, g) => {
    for (const i of members) {
      for (const j of refs[i]) {
        const h = groupOf[j];
        if (h !== g && !after[g].has(h)) {
          after[g].add(h);
          pending[h]++;
        }
      }
    }
  });

  // Kahn's algorithm; among the ready groups the first in tree order goes next (groups are numbered by their first member)
  const out: number[][] = [];
  const done = groups.map(() => false);
  while (out.length < groups.length) {
    let next = groups.findIndex((_, g) => !done[g] && pending[g] === 0);
    if (next < 0) next = done.indexOf(false); // unreachable: the groups form a DAG; never drop a table silently
    done[next] = true;
    out.push(groups[next]);
    for (const h of after[next]) pending[h]--;
  }
  return out;
}

/**
 * The statements that drop one group of tables, given each table's own `DROP TABLE` statement in tree order.
 * A group of one is its own statement. A group that is a cycle:
 * - Oracle: each table with `CASCADE CONSTRAINTS` (the foreign keys that point at the tables go with them);
 * - PostgreSQL and MySQL: one `DROP TABLE a, b` (the server checks the references among the tables of one statement);
 * - SQLite has no multi-table DROP: one by one (with foreign keys on, the first drop of a cycle can fail while rows
 *   still reference the table: the error is shown, nothing is dropped silently).
 */
export function groupDropStatements(driver: Driver, drops: readonly string[]): string[] {
  if (drops.length < 2) return [...drops];
  if (driver === "oracle") return drops.map((s) => `${s} CASCADE CONSTRAINTS`);
  if (driver === "postgres" || driver === "mysql") return [`DROP TABLE ${drops.map((s) => s.replace(/^DROP TABLE /, "")).join(", ")}`];
  return [...drops];
}
