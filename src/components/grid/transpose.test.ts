// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cellRect, indexAt, prefixSums, recordWidth, toLogical, toScreen, windowOf } from "./transpose";

describe("transpose index mapping", () => {
  it("maps logical <-> screen both ways", () => {
    for (const t of [false, true]) {
      for (const [r, c] of [
        [0, 0],
        [5, 2],
        [99999, 29],
      ]) {
        const s = toScreen(t, r, c);
        expect(toLogical(t, s.v, s.h)).toEqual({ r, c });
      }
    }
    expect(toScreen(false, 7, 3)).toEqual({ v: 7, h: 3 });
    expect(toScreen(true, 7, 3)).toEqual({ v: 3, h: 7 });
  });

  it("swaps the axes of a rectangular selection", () => {
    const colX = prefixSums([100, 50, 80]); // normal: horizontal = columns
    expect(cellRect(false, colX, 27, 2, 4, 1, 2)).toEqual({ x: 100, y: 54, w: 130, h: 81 });
    const recX = prefixSums([150, 94, 150, 150]); // transposed: horizontal = records
    expect(cellRect(true, recX, 27, 1, 2, 0, 2)).toEqual({ x: 150, y: 0, w: 244, h: 81 });
  });

  it("clamps a block that ends past the axis", () => {
    const X = prefixSums([10, 10]);
    expect(cellRect(false, X, 27, 0, 0, 1, 5)).toEqual({ x: 10, y: 0, w: 10, h: 27 });
  });
});

describe("axis search", () => {
  const X = prefixSums([150, 94, 150, 150]);
  it("finds the entry under a pixel", () => {
    expect(indexAt(X, 0)).toBe(0);
    expect(indexAt(X, 149)).toBe(0);
    expect(indexAt(X, 150)).toBe(1);
    expect(indexAt(X, 243)).toBe(1);
    expect(indexAt(X, 244)).toBe(2);
    expect(indexAt(X, 543)).toBe(3);
    expect(indexAt(X, 544)).toBe(-1);
    expect(indexAt(X, -1)).toBe(-1);
  });
  it("windows the visible span, also far from the origin", () => {
    expect(windowOf(X, 160, 260)).toEqual([1, 2]);
    expect(windowOf(X, -50, 10)).toEqual([0, 0]);
    expect(windowOf(X, 500, 5000)).toEqual([3, 3]);
    const big = prefixSums(new Array(100000).fill(100));
    expect(windowOf(big, 5_000_050, 5_001_000)).toEqual([50000, 50010]);
    expect(windowOf(prefixSums([]), 0, 10)).toEqual([0, -1]);
  });
  it("sizes a record column like DataGrip", () => {
    expect(recordWidth(17)).toBe(150);
    expect(recordWidth(10)).toBe(94);
    expect(recordWidth(18)).toBe(158);
  });
});
