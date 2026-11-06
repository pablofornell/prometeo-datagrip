/**
 * Local filter: per-column value filter (the header funnel). Pure functions, no DOM.
 * A filter is the set of allowed value keys of a column; a row passes when every filtered column holds an allowed key.
 */
import { compareKeys } from "./format";

/** Key of SQL NULL (cannot collide with a text value). */
export const NULL_KEY = "\u0000null";

export interface ValueCount {
  key: string;
  count: number;
}

/** Distinct values of a column with their row counts: NULL first, then values sorted (numbers numerically). */
export function countValues(n: number, keyAt: (i: number) => string | undefined, limit = 2000): { values: ValueCount[]; truncated: boolean } {
  const counts = new Map<string, number>();
  let truncated = false;
  for (let i = 0; i < n; i++) {
    const k = keyAt(i);
    if (k === undefined) continue;
    const c = counts.get(k);
    if (c !== undefined) counts.set(k, c + 1);
    else if (counts.size < limit) counts.set(k, 1);
    else truncated = true;
  }
  const num = (s: string) => (s !== "" && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);
  const values = [...counts].map(([key, count]) => ({ key, count }));
  values.sort((a, b) => {
    if (a.key === NULL_KEY) return b.key === NULL_KEY ? 0 : -1;
    if (b.key === NULL_KEY) return 1;
    const na = num(a.key);
    const nb = num(b.key);
    return compareKeys(na ?? a.key, nb ?? b.key);
  });
  return { values, truncated };
}

/** Number of rows (of `n`) passing every column filter. */
export function countMatches(n: number, filters: Map<number, Set<string>>, keyOf: (row: number, col: number) => string | undefined): number {
  let out = 0;
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (const [col, allowed] of filters) {
      const k = keyOf(i, col);
      if (k === undefined || !allowed.has(k)) {
        ok = false;
        break;
      }
    }
    if (ok) out++;
  }
  return out;
}
