import { describe, expect, it } from "vitest";
import { daysIn, formatDateParts, parseDateParts, wrap } from "./dateparts";

describe("date parts", () => {
  it("parses a timestamp with fractional seconds and keeps them", () => {
    const p = parseDateParts("2026-11-06 12:55:08.316831", "datetime")!;
    expect([p.y, p.mo, p.d, p.h, p.mi, p.s, p.frac]).toEqual([2026, 11, 6, 12, 55, 8, ".316831"]);
    expect(formatDateParts({ ...p, h: 7 }, "datetime")).toBe("2026-11-06 07:55:08.316831");
  });
  it("keeps the T separator and the zone", () => {
    const p = parseDateParts("2026-01-02T03:04:05+02", "datetime")!;
    expect(p.sep).toBe("T");
    expect(p.tz).toBe("+02");
    expect(formatDateParts(p, "datetime")).toBe("2026-01-02T03:04:05+02");
  });
  it("parses dates and times alone", () => {
    expect(formatDateParts(parseDateParts("2026-2-3", "date")!, "date")).toBe("2026-02-03");
    expect(formatDateParts(parseDateParts("9:05", "time")!, "time")).toBe("09:05:00");
    expect(parseDateParts("2026-02-03 10:00", "date")).toBeNull();
    expect(parseDateParts("nope", "datetime")).toBeNull();
    expect(parseDateParts("2026-13-01", "date")).toBeNull();
  });
  it("clamps the day to the month", () => {
    const p = parseDateParts("2026-01-31", "date")!;
    expect(formatDateParts({ ...p, mo: 2 }, "date")).toBe("2026-02-28");
    expect(daysIn(2028, 2)).toBe(29);
  });
  it("wraps spinner values", () => {
    expect(wrap(24, 0, 23)).toBe(0);
    expect(wrap(-1, 0, 59)).toBe(59);
  });
});
