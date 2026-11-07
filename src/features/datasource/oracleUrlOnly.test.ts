// @vitest-environment node
/** Oracle's "URL only" connection type keeps the User / Password fields, and typing a URL feeds Service / SID. */
import { describe, expect, it, vi } from "vitest";

const sent: Record<string, unknown>[] = [];
vi.mock("../../api/db", () => ({
  listDataSources: async () => [],
  saveDataSource: async (c: unknown) => c,
  deleteDataSource: async () => {},
  testConnection: async (c: Record<string, unknown>) => (sent.push(c), { ok: true, serverVersion: null, message: "", elapsedMs: 1 }),
  setUiState: async () => {},
  getUiState: async () => null,
}));
vi.mock("./events", () => ({ emitDataSourcesChanged: () => {} }));
vi.mock("../console/txguard", () => ({ confirmEndTransactions: async () => true }));

import { configFromForm } from "./model";
import { createSession } from "./session";

describe("Oracle URL only", () => {
  it("a plain jdbc URL plus the User field gives a config with the user", () => {
    const s = createSession();
    s.addNew("oracle");
    s.setOracleConnType("url");
    s.setUrl("jdbc:oracle:thin:@//127.0.0.1:15219/FREEPDB1");
    s.setField("user", "demo");
    const f = s.current()!.form;
    expect(f.connType).toBe("url");
    const cfg = configFromForm(f, null);
    expect(cfg.user).toBe("demo");
    expect(cfg.urlOverride).toBe("oracle://127.0.0.1:15219/FREEPDB1");
  });

  it("a password typed in URL only mode is sent with Test Connection / Save", async () => {
    const s = createSession();
    s.addNew("oracle");
    s.setOracleConnType("url");
    s.setPassword("prometeo");
    s.setField("user", "demo");
    await s.test();
    expect(sent.at(-1)).toMatchObject({ user: "demo", password: "prometeo" });
  });

  it("typing a URL updates the Service / SID fields, in either connection type", () => {
    const s = createSession();
    s.addNew("oracle");
    s.setOracleConnType("url");
    s.setUrl("jdbc:oracle:thin:@10.0.0.5:1522:ORCL");
    let f = s.current()!.form;
    expect([f.host, f.port, f.database, f.options.oracleConnType]).toEqual(["10.0.0.5", "1522", "ORCL", "sid"]);
    s.setUrl("jdbc:oracle:thin:@//db:1521/FREEPDB1");
    f = s.current()!.form;
    expect([f.host, f.port, f.database, f.options.oracleConnType]).toEqual(["db", "1521", "FREEPDB1", undefined]);
    s.setOracleConnType("service");
    expect(s.current()!.form.url).toBe("jdbc:oracle:thin:@//db:1521/FREEPDB1");
  });

  it("credentials typed in the URL fill User and Password", () => {
    const s = createSession();
    s.addNew("oracle");
    s.setUrl("jdbc:oracle:thin:demo/prometeo@//h:1521/svc");
    const d = s.current()!;
    expect(d.form.user).toBe("demo");
    expect(d.password.value).toBe("prometeo");
    expect(d.form.database).toBe("svc");
  });
});
