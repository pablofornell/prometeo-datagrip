import { describe, expect, it } from "vitest";
import { timeText } from "./model";

describe("timeText", () => {
  it("shows only the time for today", () => {
    const t = new Date(2026, 10, 7, 9, 5).getTime();
    expect(timeText(t, new Date(2026, 10, 7, 18, 0).getTime())).toBe("09:05");
  });
  it("adds the date for another day", () => {
    const t = new Date(2026, 10, 5, 12, 55).getTime();
    expect(timeText(t, new Date(2026, 10, 7, 18, 0).getTime())).toBe("Nov 5, 12:55");
  });
});
