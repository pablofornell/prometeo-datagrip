// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { NodeData } from "./model";
import { canRenameNode, quoteIdent, renameSqlOf } from "./rename";

const node = (driver: NodeData["driver"], kind: NodeData["kind"], name: string, extra: Record<string, unknown> = {}): NodeData => ({
  dsId: "d",
  kind,
  name,
  path: [],
  extra,
  driver,
});

describe("quoteIdent", () => {
  it("double quotes for PostgreSQL / SQLite, backticks for MySQL, embedded quotes doubled", () => {
    expect(quoteIdent("postgres", 'we"ird')).toBe('"we""ird"');
    expect(quoteIdent("sqlite", "t")).toBe('"t"');
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
  });
});

describe("renameSqlOf", () => {
  it("PostgreSQL table: schema-qualified old name, bare new name", () => {
    expect(renameSqlOf(node("postgres", "table", "Order Items", { schema: "shop" }), 'new"name')).toBe('ALTER TABLE "shop"."Order Items" RENAME TO "new""name"');
  });
  it("PostgreSQL column, constraint, trigger, function", () => {
    const ex = { schema: "s", table: "t" };
    expect(renameSqlOf(node("postgres", "column", "a", ex), "b")).toBe('ALTER TABLE "s"."t" RENAME COLUMN "a" TO "b"');
    expect(renameSqlOf(node("postgres", "foreignKey", "fk1", ex), "fk2")).toBe('ALTER TABLE "s"."t" RENAME CONSTRAINT "fk1" TO "fk2"');
    expect(renameSqlOf(node("postgres", "trigger", "trg", ex), "trg2")).toBe('ALTER TRIGGER "trg" ON "s"."t" RENAME TO "trg2"');
    expect(renameSqlOf(node("postgres", "function", "f", { schema: "s", signature: "integer, text" }), "g")).toBe('ALTER FUNCTION "s"."f"(integer, text) RENAME TO "g"');
    expect(renameSqlOf(node("postgres", "schema", "old"), "new")).toBe('ALTER SCHEMA "old" RENAME TO "new"');
  });
  it("MySQL: backticks, RENAME TABLE keeps the database, no schema rename", () => {
    expect(renameSqlOf(node("mysql", "table", "t`x", { schema: "demo" }), "u")).toBe("RENAME TABLE `demo`.`t``x` TO `demo`.`u`");
    expect(renameSqlOf(node("mysql", "column", "a", { schema: "demo", table: "t" }), "b")).toBe("ALTER TABLE `demo`.`t` RENAME COLUMN `a` TO `b`");
    expect(renameSqlOf(node("mysql", "index", "i", { schema: "demo", table: "t" }), "j")).toBe("ALTER TABLE `demo`.`t` RENAME INDEX `i` TO `j`");
    expect(renameSqlOf(node("mysql", "schema", "demo"), "x")).toBeNull();
  });
  it("SQLite renames tables and columns only", () => {
    expect(renameSqlOf(node("sqlite", "table", "orders", { schema: "main" }), "o2")).toBe('ALTER TABLE "main"."orders" RENAME TO "o2"');
    expect(renameSqlOf(node("sqlite", "column", "a", { schema: "main", table: "orders" }), "b")).toBe('ALTER TABLE "main"."orders" RENAME COLUMN "a" TO "b"');
    expect(renameSqlOf(node("sqlite", "index", "i", { schema: "main", table: "orders" }), "j")).toBeNull();
  });
  it("canRenameNode: data sources always, synthetic (unnamed) constraints never", () => {
    expect(canRenameNode(node("postgres", "dataSource", "pg"))).toBe(true);
    expect(canRenameNode({ ...node("sqlite", "primaryKey", "key #1"), synthetic: true })).toBe(false);
    expect(canRenameNode(node("sqlite", "view", "v"))).toBe(false);
  });
});

describe("Oracle", () => {
  it("renames tables, columns, indexes and constraints; views and sequences only rename in the own schema (not offered)", () => {
    expect(renameSqlOf(node("oracle", "table", "EMP", { schema: "DEMO" }), "STAFF")).toBe('ALTER TABLE "DEMO"."EMP" RENAME TO "STAFF"');
    expect(renameSqlOf(node("oracle", "column", "ENAME", { schema: "DEMO", table: "EMP" }), "NAME")).toBe('ALTER TABLE "DEMO"."EMP" RENAME COLUMN "ENAME" TO "NAME"');
    expect(renameSqlOf(node("oracle", "index", "EMP_IX", { schema: "DEMO" }), "EMP_IX2")).toBe('ALTER INDEX "DEMO"."EMP_IX" RENAME TO "EMP_IX2"');
    expect(renameSqlOf(node("oracle", "foreignKey", "EMP_FK", { schema: "DEMO", table: "EMP" }), "EMP_FK2")).toBe('ALTER TABLE "DEMO"."EMP" RENAME CONSTRAINT "EMP_FK" TO "EMP_FK2"');
    expect(renameSqlOf(node("oracle", "view", "V", { schema: "DEMO" }), "W")).toBeNull();
    expect(renameSqlOf(node("oracle", "sequence", "S", { schema: "DEMO" }), "T")).toBeNull();
    expect(renameSqlOf(node("oracle", "schema", "DEMO"), "X")).toBeNull();
  });
});
