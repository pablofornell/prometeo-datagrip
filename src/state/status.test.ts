import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregatorText, areaOf, startTask, tasks } from "./status";

afterEach(() => vi.useRealTimers());

describe("background tasks", () => {
  it("lists a task until it is done and keeps the order", () => {
    const a = startTask("Performing complete introspection (SQLite)");
    const b = startTask("Connecting to x");
    expect(tasks().map((t) => t.title)).toEqual(["Performing complete introspection (SQLite)", "Connecting to x"]);
    a.progress(0.5);
    expect(tasks()[0].progress).toBe(0.5);
    a.done();
    a.done(); // idempotent
    expect(tasks().map((t) => t.title)).toEqual(["Connecting to x"]);
    b.title("Connecting to y");
    expect(tasks()[0].title).toBe("Connecting to y");
    b.done();
    expect(tasks()).toEqual([]);
  });

  it("shows a delayed task only if it is still running after the delay", () => {
    vi.useFakeTimers();
    const quick = startTask("quick", { delayMs: 300 });
    const slow = startTask("slow", { delayMs: 300 });
    expect(tasks()).toEqual([]);
    vi.advanceTimersByTime(200);
    quick.done();
    vi.advanceTimersByTime(200);
    expect(tasks().map((t) => t.title)).toEqual(["slow"]);
    slow.done();
    expect(tasks()).toEqual([]);
  });
});

describe("aggregatorText", () => {
  const num = (count: number, sum: number, min = 0, max = 0) => ({ count, sum, min, max });
  it("follows DataGrip's wording", () => {
    expect(aggregatorText({ cells: 1, numeric: null }, "SUM")).toBe("No aggregator selected");
    expect(aggregatorText({ cells: 3, numeric: null }, "SUM")).toBe("SUM: Not enough values");
    expect(aggregatorText({ cells: 3, numeric: num(3, 6, 1, 3) }, "SUM")).toBe("SUM: 6");
    expect(aggregatorText({ cells: 3, numeric: num(3, 6, 1, 3) }, "AVG")).toBe("AVG: 2");
    expect(aggregatorText({ cells: 3, numeric: num(3, 6, 1, 3) }, "COUNT")).toBe("COUNT: 3");
    expect(aggregatorText({ cells: 3, numeric: num(3, 6, 1, 3) }, "MAX")).toBe("MAX: 3");
    expect(aggregatorText({ cells: 3, numeric: num(3, 6, 1, 3) }, "MIN")).toBe("MIN: 1");
  });
  it("rounds floating point noise", () => {
    expect(aggregatorText({ cells: 2, numeric: num(2, 0.1 + 0.2) }, "SUM")).toBe("SUM: 0.3");
  });
});

describe("areaOf", () => {
  const el = (sel: Record<string, unknown>) => ({ closest: (s: string) => sel[s] ?? null }) as unknown as Element;
  it("tells the grid, the editor and the explorer apart", () => {
    expect(areaOf(el({ ".dgg": {} }))).toBe("grid");
    expect(areaOf(el({ "[data-editor-area]": {} }))).toBe("editor");
    expect(areaOf(el({ "[data-toolwindow]": { dataset: { toolwindow: "explorer" } } }))).toBe("explorer");
    expect(areaOf(el({ "[data-toolwindow]": { dataset: { toolwindow: "output" } } }))).toBe("editor");
    expect(areaOf(el({}))).toBeUndefined();
  });
});
