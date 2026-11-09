/**
 * The object Find Usages looks for, for an explorer node. Kept apart from `find.ts` (which needs the explorer module
 * API) so the explorer's own menu can import it without a cycle.
 */
import type { ObjectRef } from "../../api/db";
import { type NodeData, objectRefOf } from "../explorer/model";

/** Node kinds that other objects can refer to: tables, views, sequences, synonyms, packages, routines and columns. */
const FIND_KINDS: readonly string[] = ["table", "view", "materializedView", "sequence", "synonym", "package", "routine", "function", "procedure", "column"];

/** The reference Find Usages uses for the node, or null when its kind has no usages to show (indexes, keys, folders, ...). */
export function usageTargetOf(d: NodeData): ObjectRef | null {
  if (!FIND_KINDS.includes(d.kind)) return null;
  if (d.kind === "column" && !d.extra.table) return null;
  return objectRefOf(d);
}
