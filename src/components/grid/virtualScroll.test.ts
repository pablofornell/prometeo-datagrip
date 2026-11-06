// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SCROLL_CAP, logicalPos, logicalShift, scrollExtent, scrollPos } from "./virtualScroll";

const ROW_H = 27;

describe("virtual scroll scaling", () => {
  it("does nothing below the cap", () => {
    const total = 100_000 * ROW_H;
    expect(scrollExtent(total)).toBe(total);
    expect(logicalPos(12345, total, 800)).toBe(12345);
    expect(scrollPos(12345, total, 800)).toBe(12345);
    expect(logicalShift(12345, total, 800)).toBe(0);
  });

  it("caps the extent of 1.3M rows (35M px, past the 2^25 px layout limit of WebKit and Blink)", () => {
    const total = 1_300_000 * ROW_H;
    expect(total).toBeGreaterThan(2 ** 25);
    expect(scrollExtent(total)).toBe(SCROLL_CAP);
  });

  it("reaches both ends of the data", () => {
    const total = 1_300_000 * ROW_H;
    const view = 855;
    const maxP = SCROLL_CAP - view; // scrollHeight - clientHeight
    expect(logicalPos(0, total, view)).toBe(0);
    // the last logical px is visible at the bottom of the visible area at the end of the scroll range
    expect(logicalPos(maxP, total, view) + view).toBeCloseTo(total, 3);
    // the last row is the last thing shown
    expect(Math.floor((logicalPos(maxP, total, view) + view - 1) / ROW_H)).toBe(1_299_999);
  });

  it("maps back and forth", () => {
    const total = 300_000 * 150; // 300k transposed records, 150px each
    const view = 1500;
    for (const p of [0, 1, 777_777, 7_500_000, SCROLL_CAP - view]) expect(scrollPos(logicalPos(p, total, view), total, view)).toBeCloseTo(p, 6);
    for (const L of [0, 1_000_001, 20_000_000, total - view]) expect(logicalPos(scrollPos(L, total, view), total, view)).toBeCloseTo(L, 6);
  });

  it("keeps drawn positions small: logical - shift stays within the scroller", () => {
    const total = 1_300_000 * ROW_H;
    const view = 855;
    for (const p of [0, 3_000_000, 9_999_999, SCROLL_CAP - view]) {
      const L = logicalPos(p, total, view);
      const y = L - logicalShift(p, total, view); // top of the first visible row in scroller coordinates
      expect(y).toBeCloseTo(p, 6);
      expect(y + view).toBeLessThanOrEqual(SCROLL_CAP + 1e-6);
    }
  });

  it("moves slower than the scrollbar by the same ratio everywhere", () => {
    const total = 1_300_000 * ROW_H;
    const view = 855;
    const d1 = logicalPos(1000, total, view) - logicalPos(0, total, view);
    const d2 = logicalPos(9_001_000, total, view) - logicalPos(9_000_000, total, view);
    expect(d1).toBeCloseTo(d2, 6);
    expect(d1).toBeGreaterThan(1000);
  });
});
