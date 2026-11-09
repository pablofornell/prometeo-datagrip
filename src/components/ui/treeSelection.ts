/**
 * Selection model of the multi-select `Tree` (pure functions over plain data: no DOM, no Solid, unit-tested in node).
 *
 * A selection is the set of selected row ids, the anchor (where Shift extends from) and the lead (the caret row: the
 * one `onSelect` reports and the focus outline is drawn on). Invariant: the lead and the anchor are selected, or both
 * are null when nothing is selected. `order` is the ids of the visible rows, top to bottom.
 */
export interface TreeSelection {
  readonly ids: ReadonlySet<string>;
  readonly anchor: string | null;
  readonly lead: string | null;
}

export const NO_SELECTION: TreeSelection = { ids: new Set(), anchor: null, lead: null };

/** A plain click or an arrow key: exactly this row (nothing for null). */
export function singleSelection(id: string | null): TreeSelection {
  return id === null ? NO_SELECTION : { ids: new Set([id]), anchor: id, lead: id };
}

/** Ctrl+click: adds the row or removes it. The clicked row becomes the anchor and the lead; removing the lead moves both to a remaining row. */
export function toggleSelection(sel: TreeSelection, id: string): TreeSelection {
  if (!sel.ids.has(id)) return { ids: new Set([...sel.ids, id]), anchor: id, lead: id };
  const ids = new Set(sel.ids);
  ids.delete(id);
  if (ids.size === 0) return NO_SELECTION;
  const last = [...ids][ids.size - 1];
  const lead = sel.lead !== null && ids.has(sel.lead) ? sel.lead : last;
  const anchor = sel.anchor !== null && ids.has(sel.anchor) ? sel.anchor : lead;
  return { ids, anchor, lead };
}

/**
 * Shift+click and Shift+arrows: the rows from the anchor to `id` (both included) become the selection. The anchor
 * stays where it is, the lead moves to `id`. Without an anchor in `order` it is a plain selection of `id`.
 */
export function rangeSelection(sel: TreeSelection, order: readonly string[], id: string): TreeSelection {
  const j = order.indexOf(id);
  const a = sel.anchor === null ? -1 : order.indexOf(sel.anchor);
  if (j < 0 || a < 0) return singleSelection(id);
  const [lo, hi] = a <= j ? [a, j] : [j, a];
  return { ids: new Set(order.slice(lo, hi + 1)), anchor: order[a], lead: id };
}

/** Ctrl+A: every visible row. The anchor and the lead keep their rows when those are visible, else the first row. */
export function selectAll(sel: TreeSelection, order: readonly string[]): TreeSelection {
  if (order.length === 0) return sel;
  const shown = new Set(order);
  const keep = (id: string | null): string => (id !== null && shown.has(id) ? id : order[0]);
  return { ids: shown, anchor: keep(sel.anchor), lead: keep(sel.lead) };
}

/**
 * Drops the selected rows that are no longer shown: collapsed away, filtered out, or deleted by a refresh (`hidden`).
 * A lead or anchor that is hidden moves to the nearest shown ancestor (`shownAncestor`), which becomes selected, as
 * when a collapse takes the selection with it. Returns `sel` itself when nothing it holds is hidden.
 */
export function dropHidden(
  sel: TreeSelection,
  hidden: (id: string) => boolean,
  shownAncestor: (id: string) => string | undefined,
): TreeSelection {
  if (![...sel.ids].some(hidden)) return sel;
  const ids = new Set([...sel.ids].filter((id) => !hidden(id)));
  const moved = (id: string): string | null => shownAncestor(id) ?? null;
  let lead = sel.lead !== null && hidden(sel.lead) ? moved(sel.lead) : sel.lead;
  if (lead === null && ids.size) lead = [...ids][0];
  const anchor = sel.anchor !== null && hidden(sel.anchor) ? (moved(sel.anchor) ?? lead) : sel.anchor;
  if (lead !== null) ids.add(lead);
  if (anchor !== null) ids.add(anchor);
  if (ids.size === 0) return NO_SELECTION;
  return { ids, anchor: anchor ?? lead, lead };
}

/** The selected ids in `order` (the rows that are not shown come last, in the order they were selected). */
export function orderedIds(sel: TreeSelection, order: readonly string[]): string[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  const at = (id: string) => pos.get(id) ?? order.length;
  return [...sel.ids].sort((a, b) => at(a) - at(b));
}
