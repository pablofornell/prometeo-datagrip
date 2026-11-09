import { describe, expect, it } from "vitest";
import { SCROLL_CAP } from "../virtualScroll";
import { rowWindow, visibleRows } from "./window";

describe("visibleRows", () => {
  it("draws the rows of the viewport plus an overscan on each side", () => {
    // 18 px rows, 180 px viewport (10 rows), scrolled to row 100
    expect(visibleRows(1800, 180, 18, 10_000, 2)).toEqual({ first: 98, end: 112 });
    expect(visibleRows(0, 180, 18, 10_000, 2)).toEqual({ first: 0, end: 12 });
  });

  it("clamps to the rows that exist", () => {
    expect(visibleRows(0, 180, 18, 3, 2)).toEqual({ first: 0, end: 3 });
    expect(visibleRows(99_999, 180, 18, 5, 2)).toEqual({ first: 5, end: 5 });
    expect(visibleRows(0, 180, 18, 0)).toEqual({ first: 0, end: 0 });
  });
});

describe("rowWindow", () => {
  it("is a plain window for a short list (no shift, spacer = the list)", () => {
    expect(rowWindow(0, 180, 18, 1000, 2)).toEqual({ first: 0, end: 12, shift: 0, height: 18_000 });
    expect(rowWindow(1800, 180, 18, 1000, 2)).toEqual({ first: 98, end: 112, shift: 0, height: 18_000 });
  });

  it("caps the spacer and keeps the last rows reachable for a very long list", () => {
    const count = 2_000_000; // a 32 MB value in 16-byte rows
    const view = 180;
    const rowPx = 18;
    const total = count * rowPx;
    expect(total).toBeGreaterThan(SCROLL_CAP);
    const end = rowWindow(SCROLL_CAP - view, view, rowPx, count);
    expect(end.height).toBe(SCROLL_CAP);
    expect(end.end).toBe(count);
    // the last visible row sits inside the scroller, not beyond it
    const lastTop = (count - 1) * rowPx - end.shift;
    expect(lastTop).toBeGreaterThanOrEqual(0);
    expect(lastTop).toBeLessThanOrEqual(SCROLL_CAP);
    const top = rowWindow(0, view, rowPx, count);
    expect(top).toMatchObject({ first: 0, shift: 0 });
  });
});
