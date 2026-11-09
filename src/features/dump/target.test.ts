import { describe, expect, it } from "vitest";
import type { NodeData } from "../explorer/model";
import { dumpTargetOf, dumpTargetOfSelection } from "./target";

/** An explorer node of `kind` on `driver`; only the fields the dump targets read are meaningful. */
const node = (kind: string, driver: NodeData["driver"], name = "shop", extra: Record<string, unknown> = {}, dsId = "ds1"): NodeData =>
  ({ dsId, kind, name, path: [], extra, driver }) as unknown as NodeData;

describe("dump targets of explorer nodes", () => {
  it("is a PostgreSQL or SQLite schema node's own schema", () => {
    expect(dumpTargetOf(node("schema", "postgres", "sales"))).toEqual({ dsId: "ds1", schema: "sales", driver: "postgres" });
    expect(dumpTargetOf(node("schema", "sqlite", "main"))).toEqual({ dsId: "ds1", schema: "main", driver: "sqlite" });
  });

  it("is an Oracle user (schema) node's own schema", () => {
    expect(dumpTargetOf(node("schema", "oracle", "DEMO", { system: false }))).toEqual({ dsId: "ds1", schema: "DEMO", driver: "oracle" });
  });

  it("is a MySQL database node's database", () => {
    expect(dumpTargetOf(node("database", "mysql", "shop"))).toEqual({ dsId: "ds1", schema: "shop", driver: "mysql" });
    expect(dumpTargetOf(node("database", "postgres", "shop"))).toBeNull();
  });

  it("is the main database of a SQLite data source", () => {
    expect(dumpTargetOf(node("dataSource", "sqlite", "lite"))).toEqual({ dsId: "ds1", schema: "main", driver: "sqlite" });
    expect(dumpTargetOf(node("dataSource", "postgres", "pg"))).toBeNull();
    expect(dumpTargetOf(node("dataSource", "mysql", "my"))).toBeNull();
    expect(dumpTargetOf(node("dataSource", "oracle", "ora"))).toBeNull();
  });

  it("is the tables of the schema a table node lives in, when that schema is known and not a system one", () => {
    const sales = node("schema", "postgres", "sales");
    expect(dumpTargetOf(node("table", "postgres", "orders", { schema: "sales" }), sales)).toEqual({
      dsId: "ds1",
      schema: "sales",
      driver: "postgres",
      tables: ["orders"],
    });
    const demo = node("schema", "oracle", "DEMO", { system: false });
    expect(dumpTargetOf(node("table", "oracle", "ORDERS", { schema: "DEMO" }), demo)).toEqual({
      dsId: "ds1",
      schema: "DEMO",
      driver: "oracle",
      tables: ["ORDERS"],
    });
    const shop = node("database", "mysql", "shop");
    expect(dumpTargetOf(node("table", "mysql", "items", { schema: "shop" }), shop)).toEqual({
      dsId: "ds1",
      schema: "shop",
      driver: "mysql",
      tables: ["items"],
    });
  });

  it("is nothing for a table without a known owner, or one in a system schema or under a data source", () => {
    const orders = node("table", "postgres", "orders", { schema: "shop" });
    expect(dumpTargetOf(orders)).toBeNull();
    expect(dumpTargetOf(orders, node("schema", "postgres", "pg_catalog", { system: true }))).toBeNull();
    expect(dumpTargetOf(node("table", "oracle", "AUDIT_LOG", { schema: "SYS" }), node("schema", "oracle", "SYS", { system: true }))).toBeNull();
    expect(dumpTargetOf(orders, node("dataSource", "postgres", "pg"))).toBeNull();
  });

  it("is nothing for system schemas (Oracle-maintained users included) and the object nodes", () => {
    expect(dumpTargetOf(node("schema", "oracle", "SYSTEM", { system: true }))).toBeNull();
    expect(dumpTargetOf(node("schema", "postgres", "pg_catalog", { system: true }))).toBeNull();
    expect(dumpTargetOf(node("database", "mysql", "mysql", { system: true }))).toBeNull();
    expect(dumpTargetOf(node("view", "postgres", "v", { schema: "shop" }), node("schema", "postgres", "shop"))).toBeNull();
    expect(dumpTargetOf(node("folder", "postgres", "tables"))).toBeNull();
  });
});

describe("dump target of a selection", () => {
  const sales = node("schema", "postgres", "sales");
  const table = (name: string, schema = "sales", owner = node("schema", "postgres", schema), dsId = "ds1") => ({
    data: node("table", "postgres", name, { schema }, dsId),
    owner,
  });

  it("is the target of the one selected node", () => {
    expect(dumpTargetOfSelection([{ data: sales }])).toEqual(dumpTargetOf(sales));
    expect(dumpTargetOfSelection([table("orders")])).toEqual({ dsId: "ds1", schema: "sales", driver: "postgres", tables: ["orders"] });
    expect(dumpTargetOfSelection([])).toBeNull();
  });

  it("is the named tables of one schema when several table nodes are selected", () => {
    expect(dumpTargetOfSelection([table("orders"), table("items")])).toEqual({
      dsId: "ds1",
      schema: "sales",
      driver: "postgres",
      tables: ["orders", "items"],
    });
  });

  it("has no target across schemas, data sources or kinds", () => {
    expect(dumpTargetOfSelection([table("orders"), table("users", "hr", node("schema", "postgres", "hr"))])).toBeNull();
    expect(dumpTargetOfSelection([table("orders"), table("items", "sales", node("schema", "postgres", "sales"), "ds2")])).toBeNull();
    expect(dumpTargetOfSelection([table("orders"), { data: sales }])).toBeNull();
    expect(dumpTargetOfSelection([table("orders"), { data: node("table", "postgres", "items", { schema: "sales" }) }])).toBeNull();
  });
});
