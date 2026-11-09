import { describe, expect, it } from "vitest";
import { buildDiagram, type DiagramInputObject, type DiagramOptions } from "./model";
import { layoutDiagram } from "./layout";

const opts: DiagramOptions = { columns: "all", showTypes: true };

const obj = (schema: string, name: string, ncols = 3, fks: DiagramInputObject["foreignKeys"] = []): DiagramInputObject => ({
  schema,
  name,
  kind: "table",
  columns: Array.from({ length: ncols }, (_, i) => ({ name: `col_${i}`, typeName: "varchar(40)", isPk: i === 0 })),
  foreignKeys: fks,
});

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe("layoutDiagram", () => {
  it("is deterministic for the same model", () => {
    const objects = [obj("s", "parent"), obj("s", "child", 3, [{ name: "fk", columns: ["col_1"], refSchema: "s", refTable: "parent", refColumns: ["col_0"] }]), obj("s", "orphan")];
    const a = layoutDiagram(buildDiagram(objects, opts));
    const b = layoutDiagram(buildDiagram([...objects].reverse(), opts));
    expect(a.nodes.map((n) => `${n.x},${n.y}`)).toEqual(b.nodes.map((n) => `${n.x},${n.y}`));
  });

  it("places referenced tables to the left of the tables that reference them", () => {
    const m = buildDiagram([obj("s", "parent"), obj("s", "child", 3, [{ name: "fk", columns: ["col_1"], refSchema: "s", refTable: "parent", refColumns: ["col_0"] }])], opts);
    const l = layoutDiagram(m);
    const parent = l.nodes.find((n) => n.index === m.nodes.findIndex((x) => x.name === "parent"))!;
    const child = l.nodes.find((n) => n.index === m.nodes.findIndex((x) => x.name === "child"))!;
    expect(parent.x + parent.width).toBeLessThan(child.x);
  });

  it("handles reference cycles without failing", () => {
    const a = obj("s", "a", 3, [{ name: "fk", columns: ["col_1"], refSchema: "s", refTable: "b", refColumns: ["col_0"] }]);
    const b = obj("s", "b", 3, [{ name: "fk", columns: ["col_1"], refSchema: "s", refTable: "a", refColumns: ["col_0"] }]);
    const l = layoutDiagram(buildDiagram([a, b], opts));
    expect(l.nodes).toHaveLength(2);
    expect(Number.isFinite(l.width)).toBe(true);
  });

  it("lays out 300 tables without overlap in under 200ms", () => {
    const objects: DiagramInputObject[] = [];
    for (let i = 0; i < 300; i++) {
      const fks: DiagramInputObject["foreignKeys"] = [];
      if (i > 0) fks.push({ name: `fk_${i}`, columns: ["col_1"], refSchema: "s", refTable: `t_${i - 1}`, refColumns: ["col_0"] });
      if (i > 1) fks.push({ name: `fk2_${i}`, columns: ["col_2"], refSchema: "s", refTable: `t_${Math.floor(i / 2)}`, refColumns: ["col_0"] });
      objects.push(obj("s", `t_${i}`, 4, fks));
    }
    const model = buildDiagram(objects, opts);
    const start = performance.now();
    const layout = layoutDiagram(model);
    const elapsed = performance.now() - start;

    expect(layout.nodes).toHaveLength(300);
    expect(elapsed).toBeLessThan(200);

    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        expect(overlaps(layout.nodes[i], layout.nodes[j]), `nodes ${i} and ${j} overlap`).toBe(false);
      }
    }
  });

  it("packs isolated tables into a grid without overlap", () => {
    const objects = Array.from({ length: 9 }, (_, i) => obj("s", `iso_${i}`));
    const l = layoutDiagram(buildDiagram(objects, opts));
    expect(l.nodes).toHaveLength(9);
    for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) expect(overlaps(l.nodes[i], l.nodes[j])).toBe(false);
  });
});
