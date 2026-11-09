/**
 * Which rows of a long list the value viewer draws for a scroll position. Pure functions, no DOM.
 * Very long lists (a 32 MB value is 2M hex rows) use the scroll scaling of `../virtualScroll.ts`.
 */
import { logicalPos, logicalShift, scrollExtent } from "../virtualScroll";

/** Row height of the value viewer's lists, in px. */
export const VALUE_ROW_PX = 18;

/**
 * The rows to draw for a logical scroll position: `first` (inclusive) to `end` (exclusive), with `overscan` rows on each
 * side so a fast scroll does not show blanks. `count` rows of `rowPx` pixels in a viewport of `viewPx` pixels.
 */
export function visibleRows(scrollTop: number, viewPx: number, rowPx: number, count: number, overscan = 8): { first: number; end: number } {
  if (count <= 0 || rowPx <= 0) return { first: 0, end: 0 };
  const top = Math.max(0, Math.floor(scrollTop / rowPx));
  const shown = Math.ceil(Math.max(0, viewPx) / rowPx);
  const first = Math.min(count, Math.max(0, top - overscan));
  const end = Math.min(count, top + shown + overscan);
  return { first, end: Math.max(first, end) };
}

/**
 * What a scroller of `count` rows shows at the real scroll position `scrollTop` (a viewport of `viewPx`): the rows
 * `first` to `end` (exclusive), the `height` of the spacer that gives the scroller its extent, and the `shift` to
 * subtract from a row's own top (`index * rowPx`) to place it inside the scroller.
 */
export function rowWindow(scrollTop: number, viewPx: number, rowPx: number, count: number, overscan = 8): { first: number; end: number; shift: number; height: number } {
  const total = count * rowPx;
  const { first, end } = visibleRows(logicalPos(scrollTop, total, viewPx), viewPx, rowPx, count, overscan);
  return { first, end, shift: logicalShift(scrollTop, total, viewPx), height: scrollExtent(total) };
}
