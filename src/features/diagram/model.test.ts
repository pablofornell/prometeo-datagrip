import { describe, expect, it } from "vitest";
import { buildDiagram, measureTable, nodeKey, prunePositions, visibleColumns, type DiagramInputObject, type DiagramOptions } from "./model";

const opts: DiagramOptions = { columns: "all", showTypes: true };

const obj = (schema: string, name: string, cols: string[] = [], fks: DiagramInputObject["foreignKeys"] = []): DiagramInputObject => ({
  schema,
  name,
  kind: "table",
  columns: cols.map((c) => ({ name: c, typeName: "integer", isPk: c === "id" })),
  foreignKeys: fks,
});

describe("buildDiagram", () => {
  it("sorts nodes by (schema, name) and assigns dense indices", () => {
    const m = buildDiagram([obj("b", "t2"), obj("a", "t1"), obj("b", "t1")], opts);
    expect(m.nodes.map((n) => `${n.schema}.${n.name}`)).toEqual(["a.t1", "b.t1", "b.t2"]);
    expect(m.nodes.map((n) => n.index)).toEqual([0, 1, 2]);
  });

  it("builds edges parent->child and marks referencing columns as FK", () => {
    const m = buildDiagram(
      [
        obj("s", "parent", ["id"]),
        obj("s", "child", ["id", "parent_id"], [{ name: "fk1", columns: ["parent_id"], refSchema: "s", refTable: "parent", refColumns: ["id"] }]),
      ],
      opts,
    );
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0]).toMatchObject({ from: m.nodes.findIndex((n) => n.name === "child"), to: m.nodes.findIndex((n) => n.name === "parent") });
    const child = m.nodes.find((n) => n.name === "child")!;
    expect(child.columns.find((c) => c.name === "parent_id")!.isFk).toBe(true);
  });

  it("handles composite foreign keys (several columns on one edge)", () => {
    const m = buildDiagram(
      [
        obj("s", "parent", ["a", "b"]),
        obj("s", "child", ["x", "y"], [{ name: "fk2", columns: ["x", "y"], refSchema: "s", refTable: "parent", refColumns: ["a", "b"] }]),
      ],
      opts,
    );
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0].columns).toEqual(["x", "y"]);
    expect(m.edges[0].refColumns).toEqual(["a", "b"]);
  });

  it("flags a self-reference without duplicating nodes", () => {
    const m = buildDiagram([obj("s", "t", ["id", "pid"], [{ name: "fk", columns: ["pid"], refSchema: "s", refTable: "t", refColumns: ["id"] }])], opts);
    expect(m.nodes).toHaveLength(1);
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0].self).toBe(true);
  });

  it("marks columns of an FK whose target is outside the selection but draws no edge", () => {
    const m = buildDiagram([obj("s", "child", ["id", "other_id"], [{ name: "fk", columns: ["other_id"], refSchema: "elsewhere", refTable: "parent", refColumns: ["id"] }])], opts);
    expect(m.edges).toHaveLength(0);
    expect(m.nodes[0].columns.find((c) => c.name === "other_id")!.isFk).toBe(true);
  });

  it("treats a missing foreignKeys field as empty", () => {
    const m = buildDiagram([{ schema: "s", name: "t", kind: "table", columns: [{ name: "id", typeName: "int", isPk: true }] }], opts);
    expect(m.edges).toHaveLength(0);
    expect(m.nodes).toHaveLength(1);
  });

  it("keys nodes by schema and name, independently of their index", () => {
    const m = buildDiagram([obj("b", "t2"), obj("a", "t1")], opts);
    expect(m.nodes.map((n) => n.key)).toEqual([nodeKey("a", "t1"), nodeKey("b", "t2")]);
    expect(m.nodes[1].key).toBe(nodeKey("b", "t2"));
  });

  it("does not mix up names that contain dots", () => {
    expect(nodeKey("a.b", "c")).not.toBe(nodeKey("a", "b.c"));
  });
});

describe("prunePositions", () => {
  it("drops dragged positions of tables that no longer exist", () => {
    const positions = new Map([
      ["a.t1", { x: 1, y: 2 }],
      ["gone.t", { x: 3, y: 4 }],
    ]);
    const out = prunePositions(positions, [{ key: "a.t1" }]);
    expect([...out.keys()]).toEqual(["a.t1"]);
    expect(out.get("a.t1")).toEqual({ x: 1, y: 2 });
  });

  it("returns the same map when every table still exists", () => {
    const positions = new Map([["a.t1", { x: 1, y: 2 }]]);
    expect(prunePositions(positions, [{ key: "a.t1" }])).toBe(positions);
  });
});

describe("visibleColumns / measureTable", () => {
  const cols = () =>
    [
      { name: "id", typeName: "bigint", isPk: true, isFk: false },
      { name: "parent_id", typeName: "bigint", isPk: false, isFk: true },
      { name: "note", typeName: "text", isPk: false, isFk: false },
    ] as const;

  it("filters keys-only and none", () => {
    expect(visibleColumns(cols(), "all")).toHaveLength(3);
    expect(visibleColumns(cols(), "keys").map((c) => c.name)).toEqual(["id", "parent_id"]);
    expect(visibleColumns(cols(), "none")).toHaveLength(0);
  });

  it("measures deterministically and shrinks the box when types are hidden", () => {
    const withTypes = measureTable("long_table_name", cols(), opts);
    const noTypes = measureTable("long_table_name", cols(), { ...opts, showTypes: false });
    expect(noTypes.width).toBeLessThan(withTypes.width);
    expect(noTypes.height).toBe(withTypes.height);
  });
});
