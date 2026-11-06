/**
 * Scroll scaling for very long axes (rows of a huge result, records of a transposed one). Pure functions, no DOM.
 *
 * Browsers cannot scroll an unbounded extent: WebKit / Blink clamp layout at 2^25 px (33.5M, about 1.24M rows of 27px),
 * and paint positions beyond 2^24 px (16.7M) are float32 with 2px steps (rows jitter). Past `SCROLL_CAP` the scroller is
 * only `SCROLL_CAP` px long and the real scroll position `p` maps proportionally to the *logical* position `L` (the data
 * coordinate at the top / left of the visible data area): `L = p * (total - view) / (SCROLL_CAP - view)`, so both ends stay
 * reachable. Cells are positioned at `logical - (L - p)`, which keeps every number near the scroll position.
 * Below the cap nothing changes (`L = p`).
 */

/** Longest scroll extent used, in px. Below 2^24 so every position is exact in float32. */
export const SCROLL_CAP = 15_000_000;

/** Length of the scroll extent of an axis of `total` logical px. */
export const scrollExtent = (total: number) => Math.min(total, SCROLL_CAP);

/** Logical position at the start of the visible area for real scroll position `p` (`view` = visible px of the axis). */
export function logicalPos(p: number, total: number, view: number): number {
  if (total <= SCROLL_CAP) return p;
  const maxP = SCROLL_CAP - view;
  if (maxP <= 0 || total <= view) return 0;
  return (Math.min(Math.max(p, 0), maxP) * (total - view)) / maxP;
}

/** Real scroll position that shows logical position `L` at the start of the visible area (inverse of `logicalPos`). */
export function scrollPos(L: number, total: number, view: number): number {
  if (total <= SCROLL_CAP) return L;
  const maxP = SCROLL_CAP - view;
  if (maxP <= 0 || total <= view) return 0;
  return (Math.min(Math.max(L, 0), total - view) * maxP) / (total - view);
}

/** Distance to subtract from logical coordinates to get coordinates in the scroller (0 below the cap). */
export const logicalShift = (p: number, total: number, view: number) => (total <= SCROLL_CAP ? 0 : logicalPos(p, total, view) - p);
