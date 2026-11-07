// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const saved = [{ id: "a", name: "pg", driver: "postgres" }];
vi.mock("../../api/db", () => ({ listDataSources: async () => saved }));

import { dsInfo, loadDataSources, requireDriver, setDataSourceList } from "./ds";

describe("data source cache of the table / DDL / export views", () => {
  it("knows a data source added after the first load as soon as the explorer reloads its list", async () => {
    await loadDataSources();
    expect(dsInfo("a")?.driver).toBe("postgres");
    expect(dsInfo("b")).toBeUndefined();
    await expect(requireDriver("b")).rejects.toThrow("no longer exists");
    // Data Sources dialog > OK: the explorer reloads; `loadDataSources()` alone would keep answering with the old list
    setDataSourceList([...saved, { id: "b", name: "my", driver: "mysql" }] as never);
    expect(dsInfo("b")?.driver).toBe("mysql");
    expect(await requireDriver("b")).toBe("mysql");
  });
  it("a deleted data source is gone", () => {
    setDataSourceList([]);
    expect(dsInfo("a")).toBeUndefined();
  });
});
