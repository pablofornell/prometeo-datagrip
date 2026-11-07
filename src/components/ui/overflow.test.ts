// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fitCount } from "./overflow-fit";

describe("fitCount", () => {
  const w = [22, 22, 22, 22, 22]; // five buttons, 4px gaps: 5 * 22 + 4 * 4 = 126 px

  it("keeps everything when it fits (no » button needed)", () => {
    expect(fitCount(w, 4, 126, 26)).toBe(5);
    expect(fitCount(w, 4, 400, 26)).toBe(5);
  });

  it("cuts from the right and leaves room for the » button", () => {
    // 100 px: 3 buttons (3 * 26 = 78) + » (26) = 104 > 100, so 2 buttons (52) + 26 = 78
    expect(fitCount(w, 4, 100, 26)).toBe(2);
    expect(fitCount(w, 4, 104, 26)).toBe(3);
  });

  it("can keep nothing", () => {
    expect(fitCount(w, 4, 10, 26)).toBe(0);
    expect(fitCount([], 4, 0, 26)).toBe(0);
  });
});
