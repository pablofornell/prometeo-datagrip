/** Aggregates tab of the side panel: statistics over the selected cells. Pure functions. */

export interface Aggregates {
  rows: number;
  cols: number;
  /** Non-NULL cells. */
  count: number;
  /** Numeric cells. */
  countNums: number;
  sum: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  median: number | null;
  /** Standard deviation / mean (needs 2+ numbers and a non-zero mean). */
  coefficientOfVariation: number | null;
}

export function computeAggregates(nums: number[], count: number, rows: number, cols: number): Aggregates {
  const n = nums.length;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of nums) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  let median: number | null = null;
  if (n) {
    const s = [...nums].sort((a, b) => a - b);
    median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  const avg = n ? sum / n : null;
  let cv: number | null = null;
  if (n >= 2 && avg !== null && avg !== 0) {
    let ss = 0;
    for (const v of nums) ss += (v - avg) * (v - avg);
    cv = Math.sqrt(ss / (n - 1)) / Math.abs(avg);
  }
  return { rows, cols, count, countNums: n, sum, min: n ? min : null, max: n ? max : null, avg, median, coefficientOfVariation: cv };
}

/** Shortest decimal text of a statistic (at most 6 decimals). */
export function formatStat(v: number | null): string {
  if (v === null) return "Not enough values";
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1e6) / 1e6);
}
