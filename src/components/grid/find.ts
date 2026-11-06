/**
 * "Find on Current Page" (Ctrl+F): text matcher and next / previous traversal. Pure functions, no DOM.
 */
import type { CellPos } from "./types";

export interface FindOptions {
  matchCase: boolean;
  regex: boolean;
  /** Whole words only (`\b...\b`). */
  words: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = { matchCase: false, regex: false, words: false };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compiled regular expression of the query, or an error message for an invalid regex; null for an empty query. */
export function compileQuery(query: string, o: FindOptions): RegExp | string | null {
  if (!query) return null;
  let src = o.regex ? query : escapeRe(query);
  if (o.words) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, o.matchCase ? "" : "i");
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid regular expression";
  }
}

/** Cell text predicate; null when the query is empty or invalid. */
export function makeMatcher(query: string, o: FindOptions): ((text: string) => boolean) | null {
  const re = compileQuery(query, o);
  if (re === null || typeof re === "string") return null;
  return (text) => re.test(text);
}

export interface FindArgs {
  nRows: number;
  nCols: number;
  /** Starting cell (excluded unless `includeStart`); null = from the first / last cell. */
  start: CellPos | null;
  dir: 1 | -1;
  /** Traverse screen rows first (transposed layout: cells of one column are consecutive). */
  transposed: boolean;
  textAt: (r: number, c: number) => string;
  match: (text: string) => boolean;
  includeStart?: boolean;
  /** Continue from the opposite end when the end is reached (default true). */
  wrap?: boolean;
}

/** Linear visual order index of a cell. */
export const orderIndex = (transposed: boolean, nRows: number, nCols: number, r: number, c: number) => (transposed ? c * nRows + r : r * nCols + c);
export const orderCell = (transposed: boolean, nRows: number, nCols: number, i: number): CellPos =>
  transposed ? { r: i % nRows, c: Math.floor(i / nRows) } : { r: Math.floor(i / nCols), c: i % nCols };

/** Next (dir 1) or previous (dir -1) matching cell in visual reading order, or null. */
export function findNextMatch(a: FindArgs): CellPos | null {
  const { nRows, nCols, dir, transposed } = a;
  const total = nRows * nCols;
  if (total <= 0) return null;
  const wrap = a.wrap ?? true;
  let i: number;
  let steps = total;
  if (a.start) {
    const s = orderIndex(transposed, nRows, nCols, a.start.r, a.start.c);
    i = a.includeStart ? s : s + dir;
    if (a.includeStart) steps = total;
    else steps = total - 1;
  } else {
    i = dir === 1 ? 0 : total - 1;
  }
  for (let k = 0; k < steps; k++, i += dir) {
    if (i < 0 || i >= total) {
      if (!wrap) return null;
      i = (i + total) % total;
    }
    const p = orderCell(transposed, nRows, nCols, i);
    if (a.match(a.textAt(p.r, p.c))) return p;
  }
  return null;
}
