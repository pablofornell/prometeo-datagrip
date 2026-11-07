/**
 * Editor split layout: a binary tree of panes (leaves) divided by splitters. Pure functions on immutable trees, so the
 * model is independent of the tab kinds and easy to test; the tab store (tabs.ts) owns the live state.
 *
 * "right" = the two children sit side by side (vertical divider, DataGrip "Split Right");
 * "down"  = one above the other (horizontal divider, "Split Down").
 */
export type SplitDir = "right" | "down";

export type PaneTree =
  | { kind: "leaf"; pane: string }
  | { kind: "split"; id: string; dir: SplitDir; a: PaneTree; b: PaneTree };

export const leaf = (pane: string): PaneTree => ({ kind: "leaf", pane });

/** Panes in reading order (left to right / top to bottom). */
export function leaves(t: PaneTree): string[] {
  return t.kind === "leaf" ? [t.pane] : [...leaves(t.a), ...leaves(t.b)];
}

/** Replaces the leaf `pane` by a split holding it (first) and `newPane` (second, right / below). */
export function splitLeaf(t: PaneTree, pane: string, dir: SplitDir, newPane: string, splitId: string): PaneTree {
  if (t.kind === "leaf") return t.pane === pane ? { kind: "split", id: splitId, dir, a: t, b: leaf(newPane) } : t;
  const a = splitLeaf(t.a, pane, dir, newPane, splitId);
  const b = a === t.a ? splitLeaf(t.b, pane, dir, newPane, splitId) : t.b;
  return a === t.a && b === t.b ? t : { ...t, a, b };
}

/** Removes the leaf `pane`; its sibling takes the place of the parent split. `null` when it was the only pane. */
export function removeLeaf(t: PaneTree, pane: string): PaneTree | null {
  if (t.kind === "leaf") return t.pane === pane ? null : t;
  const a = removeLeaf(t.a, pane);
  const b = removeLeaf(t.b, pane);
  if (a === null) return b;
  if (b === null) return a;
  return a === t.a && b === t.b ? t : { ...t, a, b };
}

/** The pane Move Tab to Opposite Group targets: the next pane in reading order, wrapping around (null: single pane). */
export function oppositePane(t: PaneTree, pane: string): string | null {
  const l = leaves(t);
  if (l.length < 2) return null;
  const i = l.indexOf(pane);
  return l[(i + 1) % l.length];
}

/** Ids of the split nodes. */
export function splitIds(t: PaneTree): string[] {
  return t.kind === "leaf" ? [] : [t.id, ...splitIds(t.a), ...splitIds(t.b)];
}

export function hasPane(t: PaneTree, pane: string): boolean {
  return leaves(t).includes(pane);
}
