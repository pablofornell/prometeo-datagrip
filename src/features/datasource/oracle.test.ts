// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { DataSource } from "../../api/types";
import { configFromForm, defaultForm, formFromDataSource, validate } from "./model";
import { dbmsOf } from "./drivers";

const saved = (over: Partial<DataSource> = {}): DataSource => ({
  id: "o1",
  name: "demo@localhost",
  driver: "oracle",
  host: "127.0.0.1",
  port: 15219,
  database: "FREEPDB1",
  user: "demo",
  hasPassword: true,
  passwordStorage: "keyring",
  file: "",
  urlOverride: null,
  options: { oracleConnType: "service" },
  color: null,
  readOnly: false,
  ...over,
});

describe("Oracle data source form", () => {
  it("starts with port 1521 and a service name URL", () => {
    const f = defaultForm("oracle");
    expect(f.port).toBe("1521");
    expect(f.host).toBe("localhost");
    expect(f.url).toBe("jdbc:oracle:thin:@//localhost:1521/XE");
    expect(dbmsOf("oracle")).toBe("oracle");
  });

  it("writes the service name and oracleConnType into the config", () => {
    const f = defaultForm("oracle");
    f.name = "x";
    f.user = "demo";
    f.database = "FREEPDB1";
    const cfg = configFromForm(f, null);
    expect(cfg).toMatchObject({ driver: "oracle", host: "localhost", port: 1521, database: "FREEPDB1", user: "demo", urlOverride: null });
    expect(cfg.options).toEqual({ oracleConnType: "service" });
    f.options.oracleConnType = "sid";
    expect(configFromForm(f, null).options).toEqual({ oracleConnType: "sid" });
  });

  it("URL only: converts to oracle:// and derives the connection type from the URL", () => {
    const f = formFromDataSource(saved());
    f.connType = "url";
    f.url = "jdbc:oracle:thin:@db:1522:XE";
    const cfg = configFromForm(f, "o1");
    expect(cfg.urlOverride).toBe("oracle://db:1522/XE?sid=1");
    expect(cfg).toMatchObject({ host: "db", port: 1522, database: "XE" });
    expect(cfg.options?.oracleConnType).toBe("sid");
  });

  it("reads a saved data source back (URL form shows the stored connection type)", () => {
    const f = formFromDataSource(saved({ database: "XE", options: { oracleConnType: "sid" } }));
    expect(f.url).toBe("jdbc:oracle:thin:@127.0.0.1:15219:XE");
    const g = formFromDataSource(saved({ urlOverride: "oracle://h:1521/svc" }));
    expect(g.connType).toBe("url");
    expect(g.url).toBe("jdbc:oracle:thin:@//h:1521/svc");
    expect(g.host).toBe("h");
  });

  it("the option is dropped for the other DBMS and never shows as a free property", () => {
    const f = defaultForm("postgres");
    f.options.oracleConnType = "sid";
    f.name = "pg";
    expect(configFromForm(f, null).options).toEqual({});
  });

  it("validates the service name / SID and the URL", () => {
    const f = defaultForm("oracle");
    f.name = "x";
    f.database = "";
    expect(validate(f, []).map((p) => p.message)).toEqual(["Service name is not specified"]);
    f.options.oracleConnType = "sid";
    expect(validate(f, []).map((p) => p.message)).toEqual(["SID is not specified"]);
    f.database = "XE";
    expect(validate(f, [])).toEqual([]);
    f.connType = "url";
    f.url = "jdbc:postgresql://h/d";
    expect(validate(f, [])[0].message).toMatch(/^Invalid URL: expected jdbc:oracle:thin:@\/\/host:port\/service/);
  });
});
