// @vitest-environment node
/** The Test Connection result is dropped when the settings it describes change. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/db", () => ({
  listDataSources: async () => [],
  saveDataSource: async (c: unknown) => c,
  deleteDataSource: async () => {},
  testConnection: async () => ({ ok: true, serverVersion: "PostgreSQL 16.1", message: "", elapsedMs: 3 }),
  setUiState: async () => {},
  getUiState: async () => null,
}));
vi.mock("./events", () => ({ emitDataSourcesChanged: () => {} }));
vi.mock("../console/txguard", () => ({ confirmEndTransactions: async () => true }));

import { createSession } from "./session";

describe("resetTest", () => {
  it("forgets the result and the last good DBMS info", async () => {
    const s = createSession();
    s.addNew("postgres");
    await s.test();
    expect(s.current()!.test.state).toBe("done");
    expect(s.current()!.test.lastOk?.version).toBe("PostgreSQL 16.1");
    s.resetTest(s.selectedKey()!);
    expect(s.current()!.test).toEqual({ state: "idle" });
  });
});
