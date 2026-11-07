// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TreeNode } from "../../api/types";
import { parseSqliteTable, tableFromNodes } from "./load";
import { alterTablePlan } from "./sqlgen";
import { cloneTable } from "./model";
import { alterSchemaPlan, createObjectPlan, newObject, validateObject } from "./objects";

const node = (kind: TreeNode["kind"], name: string, hint: string | null, extra: Record<string, unknown>): TreeNode => ({
  id: name,
  kind,
  name,
  hint,
  path: [],
  hasChildren: false,
  extra,
});

describe("parseSqliteTable", () => {
  it("finds column and table checks, autoincrement and options", () => {
    const sql = `CREATE TABLE orders(id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT CHECK(status IN ('new','paid (x)')), total NUMERIC(10,2), CONSTRAINT pos CHECK (total >= 0)) WITHOUT ROWID;`;
    const t = parseSqliteTable(sql);
    expect(t.autoincrement).toBe(true);
    expect(t.options).toBe("WITHOUT ROWID");
    expect(t.checks).toEqual([
      { name: "", expr: "status IN ('new','paid (x)')" },
      { name: "pos", expr: "total >= 0" },
    ]);
  });
  it("warns about what a rebuild loses", () => {
    expect(parseSqliteTable("create table t(a text collate nocase)").warnings).toHaveLength(1);
  });
});

describe("tableFromNodes", () => {
  it("reads a PostgreSQL table so that an unchanged copy produces no statements", () => {
    const t = tableFromNodes(
      "postgres",
      "shop",
      "orders",
      { comment: "Orders" },
      {
        columns: [
          node("column", "id", "integer", { dataType: "integer", nullable: false, default: null, identity: "d", generated: null, comment: "" }),
          node("column", "name", "varchar(100)", { dataType: "character varying(100)", nullable: true, default: "'x'::character varying", comment: "n" }),
          node("column", "total", "integer", { dataType: "integer", nullable: true, default: "(1 + 1)", generated: "s", comment: "" }),
        ],
        keys: [node("primaryKey", "orders_pkey", "(id)", { columns: ["id"] })],
        fks: [node("foreignKey", "fk", null, { columns: ["id"], refSchema: "shop", refTable: "c", refColumns: ["id"], definition: "FOREIGN KEY (id) REFERENCES shop.c(id) ON UPDATE CASCADE ON DELETE SET NULL" })],
        indexes: [
          node("index", "orders_pkey", null, { unique: true, primary: true, columns: "id", method: "btree", definition: "CREATE UNIQUE INDEX orders_pkey ON shop.orders USING btree (id)" }),
          node("index", "ix", null, { unique: false, columns: "lower((name)::text), id", method: "btree", definition: "CREATE INDEX ix ON shop.orders USING btree (lower((name)::text), id)" }),
          node("index", "part", null, { unique: false, columns: "id", method: "btree", definition: "CREATE INDEX part ON shop.orders USING btree (id) WHERE (id > 5)" }),
        ],
        checks: [node("check", "ck", null, { definition: "CHECK ((id > 0)) NOT VALID" })],
      },
    );
    expect(t.columns.map((c) => [c.name, c.type, c.identity, c.generated, c.default])).toEqual([
      ["id", "integer", "BY DEFAULT", "", ""],
      ["name", "varchar(100)", "", "", "'x'::character varying"],
      ["total", "integer", "", "(1 + 1)", ""],
    ]);
    expect(t.fks[0]).toMatchObject({ onUpdate: "CASCADE", onDelete: "SET NULL" });
    expect(t.indexes.map((i) => [i.name, i.columns, i.locked])).toEqual([
      ["ix", ["lower((name)::text)", "id"], false],
      ["part", ["id"], true],
    ]);
    expect(t.checks[0].expr).toBe("(id > 0)");
    expect(alterTablePlan("postgres", t, cloneTable(t)).statements).toEqual([]);
  });

  it("reads a MySQL table: literal defaults are quoted, auto_increment and on update kept", () => {
    const t = tableFromNodes(
      "mysql",
      "demo",
      "t",
      {},
      {
        columns: [
          node("column", "id", "int", { dataType: "int", nullable: false, default: null, extra: "auto_increment" }),
          node("column", "s", "varchar(10)", { dataType: "varchar(10)", nullable: true, default: "it's", extra: "" }),
          node("column", "n", "int", { dataType: "int", nullable: true, default: "5", extra: "" }),
          node("column", "ts", "timestamp", { dataType: "timestamp", nullable: false, default: "CURRENT_TIMESTAMP", extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP" }),
        ],
        keys: [node("primaryKey", "PRIMARY", "(id)", { columns: ["id"] }), node("uniqueKey", "uq", "(s)", { columns: ["s"] })],
        fks: [],
        indexes: [node("index", "PRIMARY", null, { unique: true, primary: true, columns: "id" }), node("index", "uq", null, { unique: true, columns: "s" })],
        checks: [],
      },
    );
    expect(t.columns.map((c) => c.default)).toEqual(["", "'it''s'", "5", "CURRENT_TIMESTAMP"]);
    expect(t.columns[0].autoIncrement).toBe(true);
    expect(t.columns[3].onUpdate).toBe("CURRENT_TIMESTAMP");
    expect(t.indexes).toEqual([]);
    expect(alterTablePlan("mysql", t, cloneTable(t)).statements).toEqual([]);
  });
});

describe("objects", () => {
  it("creates a view, a sequence, a schema and a database", () => {
    const view = { ...newObject("view", "shop", "postgres"), query: "select 1;", comment: "v" };
    expect(createObjectPlan("postgres", view).statements).toEqual(["create view shop.view_name as\nselect 1;", "comment on view shop.view_name is 'v';"]);
    const seq = { ...newObject("sequence", "shop", "postgres"), start: "10", increment: "5", cycle: true };
    expect(createObjectPlan("postgres", seq).statements[0]).toBe("create sequence shop.sequence_name\n    increment by 5\n    start with 10\n    cycle;");
    expect(createObjectPlan("postgres", newObject("schema", "", "postgres")).statements).toEqual(["create schema schema_name;"]);
    expect(createObjectPlan("mysql", newObject("schema", "", "mysql")).statements).toEqual(["create database database_name;"]);
    expect(createObjectPlan("sqlite", { ...newObject("view", "main", "sqlite"), query: "select 1" }).statements).toEqual(["create view view_name as\nselect 1;"]);
    expect(createObjectPlan("postgres", { ...newObject("materializedView", "s", "postgres"), query: "select 1" }).statements[0]).toBe("create materialized view s.view_name as\nselect 1;");
  });
  it("validates and alters a schema", () => {
    expect(validateObject(newObject("view", "s", "postgres"))).toEqual(["The query is empty"]);
    expect(validateObject({ ...newObject("sequence", "s", "postgres"), start: "x" })).toEqual(["Start must be an integer"]);
    const o = { ...newObject("schema", "", "postgres"), name: "a" };
    expect(alterSchemaPlan("postgres", o, { ...o, name: "b", comment: "c" }).statements).toEqual(["alter schema a rename to b;", "comment on schema b is 'c';"]);
  });
});
