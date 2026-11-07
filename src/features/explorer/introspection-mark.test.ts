// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tasks } from "../../state/status";

// the explorer core only needs the status bar tasks here: keep the appearance modules (document.head, style sheets) out
vi.mock("../../state/settings", () => ({ settings: {}, updateSettings: () => {}, DEFAULT_SETTINGS: {} }));
vi.mock("../../state/theme", () => ({ theme: () => "dark", themePref: () => "dark", setThemePref: () => {} }));

let core: typeof import("./core");

beforeAll(async () => {
  const doc = { activeElement: null, querySelector: () => null, addEventListener: () => {}, documentElement: { style: { setProperty: () => {} }, setAttribute: () => {}, removeAttribute: () => {}, dataset: {} } };
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined, document: doc, setTimeout: (...a: Parameters<typeof setTimeout>) => globalThis.setTimeout(...a), clearTimeout: (id?: number) => globalThis.clearTimeout(id) };
  core = await import("./core");
}, 60_000);
afterEach(() => vi.useRealTimers());

/** Titles of the visible status bar tasks (a plain load shows up after its 300 ms delay). */
const titles = () => {
  vi.advanceTimersByTime(300);
  return tasks().map((t) => t.title);
};

describe("full introspection mark", () => {
  it("names the task of the loads that follow a Refresh, once", () => {
    vi.useFakeTimers();
    core.markFullIntrospection("ds-x");
    const a = core.beginIntrospection("ds-x");
    expect(titles()[0]).toMatch(/^Performing complete introspection/);
    a.end();
    const b = core.beginIntrospection("ds-x");
    expect(titles()[0]).toMatch(/^Loading/);
    b.end();
  });

  it("a stale 2 s timer does not delete a newer mark", () => {
    vi.useFakeTimers();
    core.markFullIntrospection("ds-y", 0);
    vi.advanceTimersByTime(1500);
    core.markFullIntrospection("ds-y", 0); // marked again: its own 2 s start now
    vi.advanceTimersByTime(1000); // the first timer fires here (t = 2 s), the second mark is only 1 s old
    const t = core.beginIntrospection("ds-y");
    expect(titles().at(-1)).toMatch(/^Performing complete introspection/);
    t.end();
    vi.advanceTimersByTime(5000);
    const u = core.beginIntrospection("ds-y");
    expect(titles().at(-1)).toMatch(/^Loading/);
    u.end();
  });
});
