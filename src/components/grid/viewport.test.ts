// @vitest-environment node
import { describe, expect, it } from "vitest";
import { measuredViewport } from "./viewport";
import { prefixSums, windowOf } from "./transpose";

// the table editor's customers table: id 124px, email 228px, name 160px, vip 134px, created_at 266px
const X = prefixSums([124, 228, 160, 134, 266]);
const GUTTER = 32;
const OVERSCAN = 280;
const colWindow = (viewW: number) => windowOf(X, -OVERSCAN, viewW - GUTTER + OVERSCAN);

describe("viewport measurement", () => {
  it("a hidden pane (0 x 0) keeps the last real size", () => {
    const real = { w: 1180, h: 480 };
    expect(measuredViewport(0, 0, real)).toBe(real);
    expect(measuredViewport(0, 480, real)).toBe(real);
    expect(measuredViewport(1180, 0, real)).toBe(real);
  });

  it("a displayed pane replaces the size", () => {
    expect(measuredViewport(900, 300, { w: 800, h: 600 })).toEqual({ w: 900, h: 300 });
  });

  it("windowing a hidden pane's size would cut the columns from the third on (the blank cells)", () => {
    const hidden = colWindow(0);
    const shown = colWindow(1180);
    expect(hidden).toEqual([0, 1]);
    expect(shown[1]).toBe(4);
    // the size the grid windows on after the fix
    const v = measuredViewport(0, 0, { w: 1180, h: 480 });
    expect(colWindow(v.w)).toEqual(shown);
  });
});
