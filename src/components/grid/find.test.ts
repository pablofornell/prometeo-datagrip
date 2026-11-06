// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_FIND_OPTIONS, compileQuery, findNextMatch, makeMatcher, orderCell, orderIndex } from "./find";
import { NULL_KEY, countMatches, countValues } from "./localFilter";
import { computeAggregates, formatStat } from "./aggregates";

describe("find matcher", () => {
  it("is case-insensitive substring by default", () => {
    const m = makeMatcher("er1", DEFAULT_FIND_OPTIONS)!;
    expect(m("user10@example.com")).toBe(true);
    expect(m("USER10")).toBe(true);
    expect(m("user2")).toBe(false);
  });
  it("honours match case, whole words and regex", () => {
    expect(makeMatcher("Ab", { ...DEFAULT_FIND_OPTIONS, matchCase: true })!("xaby")).toBe(false);
    expect(makeMatcher("ab", { ...DEFAULT_FIND_OPTIONS, words: true })!("x ab y")).toBe(true);
    expect(makeMatcher("ab", { ...DEFAULT_FIND_OPTIONS, words: true })!("xaby")).toBe(false);
    expect(makeMatcher("a.c", { ...DEFAULT_FIND_OPTIONS, regex: true })!("abc")).toBe(true);
    expect(makeMatcher("a.c", DEFAULT_FIND_OPTIONS)!("abc")).toBe(false); // literal dot
  });
  it("returns null for an empty query and an error for a broken regex", () => {
    expect(makeMatcher("", DEFAULT_FIND_OPTIONS)).toBeNull();
    expect(typeof compileQuery("(", { ...DEFAULT_FIND_OPTIONS, regex: true })).toBe("string");
    expect(makeMatcher("(", { ...DEFAULT_FIND_OPTIONS, regex: true })).toBeNull();
  });
});

describe("find traversal", () => {
  // 3 rows x 3 columns, text = "rc"
  const textAt = (r: number, c: number) => `${r}${c}`;
  const base = { nRows: 3, nCols: 3, textAt, transposed: false } as const;
  it("walks row-major in the normal layout and column-major when transposed", () => {
    const m = (t: string) => t === "12" || t === "21" || t === "01";
    expect(findNextMatch({ ...base, start: null, dir: 1, match: m })).toEqual({ r: 0, c: 1 });
    expect(findNextMatch({ ...base, start: { r: 0, c: 1 }, dir: 1, match: m })).toEqual({ r: 1, c: 2 });
    // transposed order: column 1 (rows 0..2) comes before column 2
    expect(findNextMatch({ ...base, transposed: true, start: { r: 0, c: 1 }, dir: 1, match: m })).toEqual({ r: 2, c: 1 });
    expect(findNextMatch({ ...base, transposed: true, start: { r: 2, c: 1 }, dir: 1, match: m })).toEqual({ r: 1, c: 2 });
  });
  it("goes backwards, wraps and can stop at the ends", () => {
    const m = (t: string) => t === "01" || t === "21";
    expect(findNextMatch({ ...base, start: { r: 0, c: 1 }, dir: -1, match: m })).toEqual({ r: 2, c: 1 });
    expect(findNextMatch({ ...base, start: { r: 2, c: 1 }, dir: 1, match: m })).toEqual({ r: 0, c: 1 });
    expect(findNextMatch({ ...base, start: { r: 2, c: 1 }, dir: 1, match: m, wrap: false })).toBeNull();
  });
  it("includes the start cell on request and ignores it otherwise", () => {
    const only = (t: string) => t === "11";
    expect(findNextMatch({ ...base, start: { r: 1, c: 1 }, dir: 1, match: only })).toBeNull();
    expect(findNextMatch({ ...base, start: { r: 1, c: 1 }, dir: 1, match: only, includeStart: true })).toEqual({ r: 1, c: 1 });
  });
  it("order index round-trips", () => {
    for (const t of [false, true]) {
      for (let i = 0; i < 12; i++) {
        const p = orderCell(t, 4, 3, i);
        expect(orderIndex(t, 4, 3, p.r, p.c)).toBe(i);
      }
    }
  });
});

describe("local filter helpers", () => {
  it("counts distinct values, NULL first, numbers numerically", () => {
    const data = ["10", "9", NULL_KEY, "9", "b", "a", NULL_KEY, "9"];
    const { values } = countValues(data.length, (i) => data[i]);
    expect(values.map((v) => v.key)).toEqual([NULL_KEY, "9", "10", "a", "b"]);
    expect(values.find((v) => v.key === "9")!.count).toBe(3);
  });
  it("limits the distinct values", () => {
    const { values, truncated } = countValues(10, (i) => String(i), 4);
    expect(values.length).toBe(4);
    expect(truncated).toBe(true);
  });
  it("counts rows passing every filter", () => {
    const rows = [
      ["ES", "x"],
      ["FR", "x"],
      ["ES", "y"],
    ];
    const f = new Map([
      [0, new Set(["ES"])],
      [1, new Set(["x"])],
    ]);
    expect(countMatches(3, f, (i, c) => rows[i][c])).toBe(1);
  });
});

describe("aggregates", () => {
  it("computes the statistics of the numeric cells", () => {
    const a = computeAggregates([1, 2, 3, 10], 5, 2, 3);
    expect(a).toMatchObject({ rows: 2, cols: 3, count: 5, countNums: 4, sum: 16, min: 1, max: 10, avg: 4, median: 2.5 });
    expect(a.coefficientOfVariation).toBeCloseTo(Math.sqrt(((9 + 4 + 1 + 36) / 3)) / 4, 6);
  });
  it("reports missing values like DataGrip", () => {
    const a = computeAggregates([], 1, 1, 1);
    expect(a.sum).toBe(0);
    expect(formatStat(a.max)).toBe("Not enough values");
    expect(formatStat(2.5)).toBe("2.5");
    expect(formatStat(16)).toBe("16");
    expect(computeAggregates([5], 1, 1, 1).coefficientOfVariation).toBeNull();
  });
});
