// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ColumnMeta } from "../../api/types";

vi.mock("../../state/settings", () => ({ settings: { gridPageSize: 500 } }));
vi.mock("../../state/tabs", () => ({ activeTab: () => undefined }));
import { ConsoleOutput, ResultTab, partialMessage } from "./model";

const meta: ColumnMeta[] = [{ name: "id", typeName: "int4", nullable: false, isPk: true, tableRef: null }];
const rows = Array.from({ length: 500 }, (_, i) => [i]);
const tab = (fetchMore: () => Promise<unknown>) =>
  new ResultTab(meta, rows.slice(), true, "t", "select * from big", 0, async () => ({ fetchMore, close: async () => {} }) as never, 500);

describe("a result whose paging stream is gone", () => {
  it("shows the error instead of silently pretending that the 500 rows are everything", async () => {
    const t = tab(() => Promise.reject(new Error("result set is closed")));
    const log: [string, string][] = [];
    t.log = (k, x) => void log.push([k, x]);
    await t.loadMore(5000);
    expect(t.hasMore()).toBe(false);
    expect(t.partial()).toMatch(/only the first 500 rows are shown/);
    expect(t.partial()).toMatch(/not the complete result/);
    expect(log).toHaveLength(1);
    expect(log[0][0]).toBe("error");
    expect(log[0][1]).toContain("result set was closed");
  });
  it("reports other fetch errors with the server message", async () => {
    const t = tab(() => Promise.reject(new Error("connection reset")));
    await t.loadMore(5000);
    expect(t.partial()).toContain("connection reset");
    expect(t.fetchError).toBe("connection reset");
  });
  it("a result closed by a newer statement says so (detach)", () => {
    const t = tab(async () => ({ rows: [], hasMore: false }));
    const log: string[] = [];
    t.log = (_k, x) => void log.push(x);
    t.detach();
    expect(t.hasMore()).toBe(false);
    expect(t.partial()).toMatch(/only the first 500 rows/);
    expect(log).toHaveLength(1);
  });
  it("a silent detach is announced later, unless the tab was replaced meanwhile", () => {
    const kept = tab(async () => ({ rows: [], hasMore: false }));
    kept.detach(undefined, true);
    expect(kept.partial()).toBeNull();
    kept.announce();
    expect(kept.partial()).toMatch(/only the first 500 rows/);
    const replaced = tab(async () => ({ rows: [], hasMore: false }));
    replaced.detach(undefined, true);
    replaced.close();
    replaced.announce();
    expect(replaced.partial()).toBeNull();
  });
  it("a complete result is not flagged when it is detached", () => {
    const t = new ResultTab(meta, [[1]], false, "t", "select 1", 0, async () => ({}) as never, 500);
    t.detach();
    expect(t.partial()).toBeNull();
  });
  it("loads more rows normally", async () => {
    const t = tab(async () => ({ rows: [[500], [501]], hasMore: false }));
    await t.loadMore(5000);
    expect(t.rowCount()).toBe(502);
    expect(t.partial()).toBeNull();
  });
  it("has a message for a closed stream", () => {
    expect(partialMessage("result set is closed", 1234)).toContain("1,234");
  });  it("closing a tab releases its rows (a closed 100k-row result must not stay reachable)", () => {
    const t = tab(async () => ({ rows: [], hasMore: false }));
    t.gridApi = {} as never;
    t.close();
    expect(t.rows).toHaveLength(0);
    expect(t.gridApi).toBeUndefined();
  });
});

describe("the pending result tab of a running statement", () => {
  const done = (title: string) => new ResultTab(meta, [[1]], false, title, "select 1", 0, async () => ({}) as never, 500);
  const pending = (title: string) => new ResultTab([], [], false, title, "select pg_sleep(30)", 0, async () => ({}) as never, 500);
  const setup = () => {
    const out = new ConsoleOutput("c1", "postgres");
    const old = done("old");
    const pinned = done("pinned");
    pinned.setPinned(true);
    out.addResult(pinned, { first: true });
    out.addResult(old, { first: false });
    out.select(old.id);
    return { out, old, pinned };
  };
  it("replaces the unpinned tabs at once, without closing them", () => {
    const { out, old, pinned } = setup();
    const p = pending("pg_sleep");
    out.showPending(p);
    expect(out.results().map((r) => r.id)).toEqual([pinned.id, p.id]);
    expect(out.selected()).toBe(p.id);
    expect(p.loading()).toBe(true);
    expect(old.closed).toBe(false);
  });
  it("brings the earlier results back when the statement fails or returns no rows", () => {
    const { out, old, pinned } = setup();
    out.showPending(pending("x"));
    out.clearPending();
    expect(out.results().map((r) => r.id)).toEqual([pinned.id, old.id]);
    expect(out.selected()).toBe(old.id);
  });
  it("a result that arrives afterwards replaces the unpinned tabs as usual", () => {
    const { out, old, pinned } = setup();
    out.showPending(pending("x"));
    out.clearPending();
    const real = done("real");
    out.addResult(real, { first: true });
    expect(out.results().map((r) => r.id)).toEqual([pinned.id, real.id]);
    expect(old.closed).toBe(true);
    expect(out.selected()).toBe(real.id);
  });
  it("Reload keeps the position of the tab it replaces", () => {
    const { out, old, pinned } = setup();
    const p = pending("x");
    out.showPending(p, pinned);
    expect(out.results().map((r) => r.id)).toEqual([p.id, old.id]);
    expect(p.pinned()).toBe(true);
    out.clearPending();
    expect(out.results().map((r) => r.id)).toEqual([pinned.id, old.id]);
  });
  it("closing the pending tab is the same as the statement ending without rows", () => {
    const { out, old } = setup();
    const p = pending("x");
    out.showPending(p);
    out.closeResult(p.id);
    expect(out.results().map((r) => r.id)).toContain(old.id);
    expect(out.selected()).toBe(old.id);
  });
});

describe("the running clock", () => {
  it("counts while a statement runs and stops at the end", async () => {
    vi.useFakeTimers();
    try {
      const out = new ConsoleOutput("c2", "sqlite");
      expect(out.elapsed()).toBe(0);
      out.setRunning(true);
      await vi.advanceTimersByTimeAsync(1300);
      expect(out.elapsed()).toBeGreaterThanOrEqual(1200);
      out.setRunning(false);
      const stopped = out.elapsed();
      await vi.advanceTimersByTimeAsync(1000);
      expect(out.elapsed()).toBe(stopped);
      out.setRunning(true);
      expect(out.elapsed()).toBe(0);
      out.setRunning(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("dispose stops the clock of a console removed while a statement runs", async () => {
    vi.useFakeTimers();
    try {
      const out = new ConsoleOutput("c3", "sqlite");
      out.setRunning(true);
      expect(vi.getTimerCount()).toBe(1);
      out.dispose();
      expect(vi.getTimerCount()).toBe(0);
      expect(out.running()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
