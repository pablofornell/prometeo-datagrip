/**
 * Index mapping of the transposed ("View as > Transpose") layout. Pure functions, no DOM.
 *
 * All grid state (selection, edits, copy) stays in *logical* coordinates: `r` = display row (a record),
 * `c` = visible column position. Only drawing and hit testing go through the *screen* axes:
 *   normal:     vertical index `v` = r, horizontal index `h` = c
 *   transposed: vertical index `v` = c, horizontal index `h` = r
 * so a rectangular logical selection is a rectangle in both layouts.
 */
import type { CellPos } from "./types";

export interface ScreenPos {
  /** Index along the vertical axis (fixed row height). */
  v: number;
  /** Index along the horizontal axis (variable widths, see `X`). */
  h: number;
}

export const toScreen = (transposed: boolean, r: number, c: number): ScreenPos => (transposed ? { v: c, h: r } : { v: r, h: c });
export const toLogical = (transposed: boolean, v: number, h: number): CellPos => (transposed ? { r: h, c: v } : { r: v, c: h });

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pixel rectangle (inside the data area) of the logical block rows `r0..r1` x columns `c0..c1`.
 * `X` = prefix sums of the horizontal axis (length n + 1).
 */
export function cellRect(transposed: boolean, X: ArrayLike<number>, rowH: number, r0: number, r1: number, c0: number, c1: number): PxRect {
  const h0 = transposed ? r0 : c0;
  const h1 = transposed ? r1 : c1;
  const v0 = transposed ? c0 : r0;
  const v1 = transposed ? c1 : r1;
  const last = X.length - 1;
  const x = X[Math.min(h0, last)];
  return { x, y: v0 * rowH, w: X[Math.min(h1 + 1, last)] - x, h: (v1 - v0 + 1) * rowH };
}

/** Index `i` with `X[i] <= x < X[i + 1]`, or -1 outside `[0, X[n])`. Binary search (the axis can hold 100k+ entries). */
export function indexAt(X: ArrayLike<number>, x: number): number {
  const n = X.length - 1;
  if (n <= 0 || x < 0 || x >= X[n]) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (X[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Window `[lo, hi]` of axis entries intersecting pixels `[x0, x1]` (hi < lo when empty). */
export function windowOf(X: ArrayLike<number>, x0: number, x1: number): [number, number] {
  const n = X.length - 1;
  if (n <= 0) return [0, -1];
  const at = (x: number) => (x <= 0 ? 0 : x >= X[n] ? n - 1 : indexAt(X, x));
  return [at(x0), Math.max(at(x0), at(x1))];
}

/** Width of a transposed record column: `chars` glyphs + padding (measured on DataGrip: 17 chars -> 150px, 10 -> 94px). */
export const recordWidth = (chars: number, charW = 8) => Math.round(chars * charW + 14);

/** Prefix sums of per-entry widths. */
export function prefixSums(widths: ArrayLike<number>): Float64Array {
  const X = new Float64Array(widths.length + 1);
  for (let i = 0; i < widths.length; i++) X[i + 1] = X[i] + widths[i];
  return X;
}
