/**
 * Pure helpers of the compare view: which object a row of the difference tree belongs to, the reference that fetches
 * its DDL, and the labels of the toolbar. No I/O.
 */
import type { CompareRoutine, NodeKind, ObjectRef } from "../../api/types";
import type { DiffFilter, DiffNode, DiffStatus } from "./diff";
import { routineLabel } from "./diff";

/** One side of a compare: a schema of a data source (PostgreSQL schema, MySQL database, SQLite `main`, Oracle owner). */
export interface SchemaRef {
  dsId: string;
  schema: string;
}

/** The kinds of node that are objects of their own (their DDL is shown); the others belong to one. */
export const OBJECT_KINDS: ReadonlySet<DiffNode["kind"]> = new Set<DiffNode["kind"]>(["table", "view", "sequence", "routine"]);

/** The node of an object, or the object a column / key / check / foreign key / index belongs to. */
export function owningObject(root: DiffNode, id: string): DiffNode | undefined {
  const path: DiffNode[] = [];
  const find = (n: DiffNode): boolean => {
    path.push(n);
    if (n.id === id) return true;
    for (const c of n.children) if (find(c)) return true;
    path.pop();
    return false;
  };
  if (!find(root)) return undefined;
  for (let i = path.length - 1; i >= 0; i--) {
    if (OBJECT_KINDS.has(path[i].kind)) return path[i];
  }
  return undefined;
}

/** A node of the tree by its id (the root included). */
export function nodeById(root: DiffNode, id: string): DiffNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    const hit = nodeById(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/** Ids of every node below the root (the rows a flat filter view expands). */
export function allIds(root: DiffNode): string[] {
  const out: string[] = [];
  const walk = (n: DiffNode) => {
    out.push(n.id);
    n.children.forEach(walk);
  };
  root.children.forEach(walk);
  return out;
}

const ROUTINE_KIND: Record<string, NodeKind> = {
  FUNCTION: "function",
  PROCEDURE: "procedure",
  PACKAGE: "package",
  "PACKAGE BODY": "package",
  TRIGGER: "trigger",
};

/**
 * The reference that `get_ddl` takes for an object node on one side, or null when the object is missing there.
 * Routines need the model object (its signature, for PostgreSQL overloads and the table of a trigger).
 */
export function objectRefOf(node: DiffNode, side: "left" | "right", schema: string, routine?: CompareRoutine): ObjectRef | null {
  const name = side === "left" ? node.leftName : node.rightName;
  if (name === null) return null;
  switch (node.kind) {
    case "table":
      return { schema, name, kind: "table" };
    case "view":
      return { schema, name, kind: "view" };
    case "sequence":
      return { schema, name, kind: "sequence" };
    case "routine": {
      if (!routine) return null;
      const kind = ROUTINE_KIND[routine.kind] ?? "routine";
      return kind === "trigger"
        ? { schema, name, kind, table: routine.signature || null }
        : { schema, name, kind, signature: routine.signature || null };
    }
    default:
      return null;
  }
}

/** The routine of a model that a routine node stands for (matched by its label). */
export function routineOf(routines: readonly CompareRoutine[], node: DiffNode): CompareRoutine | undefined {
  return routines.find((r) => routineLabel(r) === node.name);
}

export const STATUS_LABEL: Record<DiffStatus, string> = {
  same: "same",
  onlyA: "only in A",
  onlyB: "only in B",
  changed: "changed",
};

export const FILTER_LABEL: Record<DiffFilter, string> = {
  all: "All",
  differences: "Differences",
  leftOnly: "Only in A",
  rightOnly: "Only in B",
};

export const FILTERS: DiffFilter[] = ["all", "differences", "leftOnly", "rightOnly"];

/** The short text of the summary line: `3 only in A, 2 only in B, 5 changed` (`no differences` when there are none). */
export function summaryText(s: { onlyA: number; onlyB: number; changed: number }): string {
  const parts = [
    s.onlyA ? `${s.onlyA} only in A` : "",
    s.onlyB ? `${s.onlyB} only in B` : "",
    s.changed ? `${s.changed} changed` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no differences";
}

/** The text of a changed row in the tree: its change lines, or the status when there are none. */
export function changeText(n: DiffNode): string {
  if (n.changes.length) return n.changes.join("; ");
  return n.status === "same" ? "" : STATUS_LABEL[n.status];
}
