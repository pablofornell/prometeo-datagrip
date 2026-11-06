// @vitest-environment node
/** Data Sources dialog > Schemas tab: Apply stores the filter in the UI state and never reconnects the data source. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = {
  id: "d1", name: "pg", driver: "postgres", host: "localhost", port: 5432, database: "postgres", user: "u", file: "",
  urlOverride: null, options: {} as Record<string, string>, color: null, readOnly: false, hasPassword: false, passwordStorage: "none",
};
const api = {
  save: vi.fn(async (c: unknown) => ({ ...saved, ...(c as object) })),
  confirm: vi.fn(async () => true),
};
vi.mock("../../api/db", () => ({
  listDataSources: async () => [saved],
  saveDataSource: (c: unknown) => api.save(c),
  deleteDataSource: async () => {},
  testConnection: async () => ({}),
  setUiState: async () => {},
  getUiState: async () => null,
}));
vi.mock("./events", () => ({ emitDataSourcesChanged: () => {} }));
vi.mock("../console/txguard", () => ({ confirmEndTransactions: () => api.confirm() }));

import { resetVisibleSchemasCache } from "../../state/schema-filter";
import { visibleSchemas } from "./schemas";
import { createSession } from "./session";

beforeEach(() => {
  resetVisibleSchemasCache();
  api.save.mockClear();
  api.confirm.mockClear();
});

describe("Apply in the Data Sources dialog", () => {
  it("a changed schema filter alone neither saves the data source nor asks about transactions", async () => {
    const s = createSession();
    await s.load("d1");
    s.setOption("visibleSchemas", JSON.stringify([["postgres", "sales"]]));
    expect(s.hasChanges()).toBe(true);

    expect(await s.apply()).toBe(true);

    expect(api.save).not.toHaveBeenCalled(); // no save_data_source: the backend keeps its connection and sessions
    expect(api.confirm).not.toHaveBeenCalled();
    expect(visibleSchemas({ id: "d1", options: {} })).toEqual([["postgres", "sales"]]);
    expect(s.hasChanges()).toBe(false);
  });

  it("a renamed data source is saved, without the reconnect question", async () => {
    const s = createSession();
    await s.load("d1");
    s.setField("name", "renamed");
    expect(await s.apply()).toBe(true);
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.confirm).not.toHaveBeenCalled();
  });

  it("a changed host is saved only after the transactions question, and never carries the filter", async () => {
    const s = createSession();
    await s.load("d1");
    s.setField("host", "db2");
    s.setOption("visibleSchemas", JSON.stringify([["postgres", "sales"]]));
    expect(await s.apply()).toBe(true);
    expect(api.confirm).toHaveBeenCalledTimes(1);
    const sent = api.save.mock.calls[0][0] as { options: Record<string, string> };
    expect(sent.options.visibleSchemas).toBeUndefined();
    expect(visibleSchemas({ id: "d1", options: {} })).toEqual([["postgres", "sales"]]);
  });

  it("a cancelled question keeps everything as it was", async () => {
    api.confirm.mockResolvedValueOnce(false);
    const s = createSession();
    await s.load("d1");
    s.setField("host", "db2");
    expect(await s.apply()).toBe(false);
    expect(api.save).not.toHaveBeenCalled();
  });
});
