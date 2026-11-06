// @vitest-environment node
/**
 * The schema selector popup saves a VIEW filter. It used to save `options.visibleSchemas` through `saveDataSource`;
 * options are part of the backend's connection fingerprint, so every save reconnected the data source and dropped its
 * sessions with their open transactions (reviewer's probe: appst). Here the backend fake reconnects exactly like that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Cfg {
  id: string;
  name: string;
  color: string | null;
  options: Record<string, string>;
  [k: string]: unknown;
}
const be = {
  saved: { id: "d1", name: "pg", color: null, host: "h", options: {} } as Cfg,
  sessions: new Map<string, "idle" | "active">(),
  saves: 0,
  disconnects: 0,
};
/** src-tauri `connection_fingerprint`: everything but name, color and password. */
const fingerprint = (c: Cfg) => {
  const { name: _n, color: _c, password: _p, ...rest } = c as Record<string, unknown>;
  return JSON.stringify(rest);
};

vi.mock("../../api/db", () => ({
  saveDataSource: vi.fn(async (c: Cfg) => {
    be.saves++;
    if (fingerprint(c) !== fingerprint(be.saved)) be.sessions.clear(); // reconnect: every session and its transaction die
    be.saved = c;
    return c;
  }),
  disconnect: vi.fn(async () => void be.disconnects++),
  setUiState: vi.fn(async () => {}),
  getUiState: vi.fn(async () => null),
  listDataSources: vi.fn(async () => [be.saved]),
  sessionTxStatus: vi.fn(async (sid: string) => {
    if (!be.sessions.has(sid)) throw new Error(`Session '${sid}' does not exist`);
    return be.sessions.get(sid);
  }),
}));

const reload = vi.fn(async () => {});
vi.mock("./core", () => ({ dsOf: () => undefined, rawIntrospect: async () => [], reloadDataSources: () => reload() }));

import { sessionTxStatus } from "../../api/db";
import { resetVisibleSchemasCache } from "../../state/schema-filter";
import { visibleSchemas, isSchemaVisible } from "../datasource/schemas";
import { save, visibleSchemasOption } from "./schemaFilter";

const ds = () => ({ ...be.saved, driver: "postgres", database: "postgres", hasPassword: false, passwordStorage: "none" }) as never;

beforeEach(() => {
  resetVisibleSchemasCache();
  be.saved = { id: "d1", name: "pg", color: null, host: "h", options: {} };
  be.sessions = new Map([["s1", "active"]]);
  be.saves = be.disconnects = 0;
  reload.mockClear();
});

describe("saving the schema selector during an open transaction", () => {
  it("does not reconnect: the session and its transaction survive", async () => {
    const value = visibleSchemasOption(
      [{ name: "postgres", items: [{ path: ["postgres", "public"], name: "public", system: false }, { path: ["postgres", "sales"], name: "sales", system: false }] }],
      new Set(["postgres\u0001sales"]),
    );
    expect(value).toBe(JSON.stringify([["postgres", "sales"]]));

    await save(ds(), value);

    expect(be.saves).toBe(0); // the config is not even written
    expect(be.disconnects).toBe(0);
    expect(await sessionTxStatus("s1")).toBe("active");
    expect(reload).toHaveBeenCalledTimes(1); // the tree is rebuilt from the new filter
    expect(visibleSchemas(ds())).toEqual([["postgres", "sales"]]);
    expect(isSchemaVisible(ds(), ["postgres", "public"])).toBe(false);
  });

  it("back to the default view, and over a legacy options.visibleSchemas", async () => {
    be.saved = { ...be.saved, options: { visibleSchemas: JSON.stringify([["postgres", "old"]]) } };
    expect(visibleSchemas(ds())).toEqual([["postgres", "old"]]); // migrated read
    await save(ds(), undefined);
    expect(visibleSchemas(ds())).toBeNull();
    expect(be.saves).toBe(0);
    expect(await sessionTxStatus("s1")).toBe("active");
  });

  it("the fake backend really reconnects on an options change (the old code path)", async () => {
    const { saveDataSource } = await import("../../api/db");
    await saveDataSource({ ...be.saved, options: { visibleSchemas: "[]" } } as never);
    await expect(sessionTxStatus("s1")).rejects.toThrow(/does not exist/);
  });
});
