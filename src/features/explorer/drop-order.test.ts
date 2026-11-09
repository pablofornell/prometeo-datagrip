// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SnapshotObject } from "../../api/db";
import { dropRank, groupDropStatements, tableDropGroups } from "./drop-order";

/** A snapshot table of schema `s` with foreign keys to `refs` (names in schema `s` unless `refSchema` is given). */
const table = (name: string, refs: string[] = [], refSchema = "s"): SnapshotObject => ({
  schema: "s",
  name,
  kind: "table",
  columns: [],
  foreignKeys: refs.map((r) => ({ name: `fk_${name}_${r}`, columns: ["x"], refSchema, refTable: r, refColumns: ["id"] })),
});

/** The names of the groups in drop order, one group per array: `[["child"], ["parent"]]`. */
const orderOf = (names: string[], objects: SnapshotObject[]): string[][] => tableDropGroups(names, "s", objects).map((g) => g.map((i) => names[i]));

describe("dropRank", () => {
  it("drops the parts of a table first, then views, other objects and tables, and sequences last", () => {
    const kinds = ["sequence", "table", "view", "column", "function"] as const;
    const ranks = Object.fromEntries(kinds.map((k) => [k, dropRank(k)]));
    expect(ranks.column).toBeLessThan(ranks.view);
    expect(ranks.view).toBeLessThan(ranks.function);
    expect(ranks.function).toBeLessThan(ranks.table);
    expect(ranks.table).toBeLessThan(ranks.sequence);
  });
});

describe("tableDropGroups", () => {
  it("keeps the tree order of tables without references between them", () => {
    expect(orderOf(["a", "b", "c"], [table("a"), table("b"), table("c")])).toEqual([["a"], ["b"], ["c"]]);
  });

  it("drops a referencing (child) table before the table it references (parent), whatever the tree order", () => {
    expect(orderOf(["parent", "child"], [table("parent"), table("child", ["parent"])])).toEqual([["child"], ["parent"]]);
  });

  it("orders a chain of references: each table before the one it references", () => {
    const objects = [table("a", ["b"]), table("b", ["c"]), table("c")];
    expect(orderOf(["c", "b", "a"], objects)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("drops a table with two parents before both of them", () => {
    const objects = [table("p1"), table("p2"), table("child", ["p1", "p2"])];
    expect(orderOf(["p1", "p2", "child"], objects)).toEqual([["child"], ["p1"], ["p2"]]);
  });

  it("keeps a cycle together as one group, in tree order, and puts the tables that reference it first", () => {
    const objects = [table("x", ["y"]), table("y", ["x"]), table("z", ["x"])];
    expect(tableDropGroups(["x", "y", "z"], "s", objects)).toEqual([[2], [0, 1]]);
  });

  it("treats a table that references itself as no cycle", () => {
    expect(orderOf(["t", "u"], [table("t", ["t"]), table("u")])).toEqual([["t"], ["u"]]);
  });

  it("ignores references to tables that are not selected or live in another schema", () => {
    expect(orderOf(["parent", "child"], [table("parent"), table("child", ["outside"])])).toEqual([["parent"], ["child"]]);
    expect(orderOf(["parent", "child"], [table("parent"), table("child", ["parent"], "elsewhere")])).toEqual([["parent"], ["child"]]);
  });

  it("uses the references of the snapshot objects of the same schema only", () => {
    const foreign: SnapshotObject = { ...table("child", ["parent"]), schema: "elsewhere" };
    expect(orderOf(["parent", "child"], [table("parent"), foreign])).toEqual([["parent"], ["child"]]);
  });

  it("returns every index exactly once when the snapshot has no foreign keys", () => {
    const groups = tableDropGroups(["a", "b"], "s", []);
    expect(groups.flat().sort()).toEqual([0, 1]);
  });
});

describe("groupDropStatements", () => {
  const drops = ['DROP TABLE "s"."a"', 'DROP TABLE "s"."b"'];

  it("a single table keeps its own statement, on every DBMS", () => {
    for (const driver of ["oracle", "postgres", "mysql", "sqlite"] as const) {
      expect(groupDropStatements(driver, ['DROP TABLE "s"."a"'])).toEqual(['DROP TABLE "s"."a"']);
    }
  });

  it("Oracle drops each table of a cycle with CASCADE CONSTRAINTS", () => {
    expect(groupDropStatements("oracle", drops)).toEqual(['DROP TABLE "s"."a" CASCADE CONSTRAINTS', 'DROP TABLE "s"."b" CASCADE CONSTRAINTS']);
  });

  it("PostgreSQL drops a cycle in one DROP TABLE statement, without CASCADE", () => {
    expect(groupDropStatements("postgres", drops)).toEqual(['DROP TABLE "s"."a", "s"."b"']);
  });

  it("MySQL drops a cycle in one DROP TABLE statement with backquoted names", () => {
    expect(groupDropStatements("mysql", ["DROP TABLE `s`.`a`", "DROP TABLE `s`.`b`"])).toEqual(["DROP TABLE `s`.`a`, `s`.`b`"]);
  });

  it("SQLite has no multi-table DROP: one statement per table", () => {
    expect(groupDropStatements("sqlite", ['DROP TABLE "a"', 'DROP TABLE "b"'])).toEqual(['DROP TABLE "a"', 'DROP TABLE "b"']);
  });
});
