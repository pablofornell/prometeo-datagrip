import { describe, expect, it } from "vitest";
import { buildDiagram, type DiagramInputObject, type DiagramOptions } from "./model";
import { layoutDiagram } from "./layout";
import { diagramBounds, renderDiagramSvg, type DiagramPalette } from "./svg";

const opts: DiagramOptions = { columns: "all", showTypes: true };

const palette: DiagramPalette = {
  background: "#191a1c",
  nodeBg: "#1f2024",
  nodeBorder: "#33353b",
  headerBg: "#26282c",
  headerFg: "#d1d3d9",
  viewHeaderBg: "#233558",
  viewFg: "#d1d3d9",
  text: "#bcbec4",
  typeText: "#73767c",
  pk: "#e0bb65",
  fk: "#56a8f5",
  edge: "#73767c",
  edgeLabel: "#9fa2a8",
  selection: "#3871e1",
  rowLine: "#323438",
  fontMono: '"JetBrains Mono", monospace',
  fontUi: '"Inter", sans-serif',
};

const obj = (schema: string, name: string, fks: DiagramInputObject["foreignKeys"] = []): DiagramInputObject => ({
  schema,
  name,
  kind: "table",
  columns: [{ name: "id", typeName: "bigint", isPk: true }],
  foreignKeys: fks,
});

const render = (objects: DiagramInputObject[], selected?: number) => {
  const model = buildDiagram(objects, opts);
  return renderDiagramSvg(model, layoutDiagram(model), { columns: "all", showTypes: true, selected: selected ?? null }, palette);
};

describe("renderDiagramSvg", () => {
  it("is a self-contained svg that contains every table", () => {
    const objects = [obj("shop", "orders"), obj("shop", "customers"), obj("shop", "products")];
    const svg = render(objects);
    expect(svg).toContain("<svg xmlns=");
    for (const o of objects) expect(svg).toContain(o.name);
    for (let i = 0; i < objects.length; i++) expect(svg).toContain(`data-table-id="${i}"`);
  });

  it("escapes XML-significant characters in table and column names", () => {
    const svg = render([{ schema: "s", name: "a<b>&c", kind: "table", columns: [{ name: "x\"y", typeName: "text", isPk: false }] }]);
    expect(svg).toContain("a&lt;b&gt;&amp;c");
    expect(svg).toContain("x&quot;y");
    expect(svg).not.toContain("a<b>&c");
  });

  it("draws the selected node with the selection border", () => {
    const objects = [obj("shop", "orders"), obj("shop", "customers")];
    const plain = render(objects);
    const selected = render(objects, 1);
    expect(selected).toContain(`stroke="${palette.selection}"`);
    expect(selected).not.toBe(plain);
  });

  it("emits concrete font stacks (an exported file cannot resolve CSS variables)", () => {
    const svg = render([obj("shop", "orders")]);
    expect(svg).toContain('font-family="&quot;JetBrains Mono&quot;, monospace"');
    expect(svg).toContain('font-family="&quot;Inter&quot;, sans-serif"');
    expect(svg).not.toContain("var(--dg-font");
  });

  it("bakes the same padded bounds into width / height / viewBox that Fit zooms to", () => {
    const model = buildDiagram([obj("shop", "orders"), obj("shop", "customers")], opts);
    const layout = layoutDiagram(model);
    const b = diagramBounds(layout);
    const svg = renderDiagramSvg(model, layout, { columns: "all", showTypes: true }, palette);
    expect(svg).toContain(`width="${b.width}" height="${b.height}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}"`);
  });

  it("moves bounds with a dragged position", () => {
    const model = buildDiagram([obj("shop", "orders")], opts);
    const layout = layoutDiagram(model);
    const base = diagramBounds(layout);
    const key = model.nodes[0].key;
    const moved = diagramBounds(layout, new Map([[key, { x: 500, y: 400 }]]));
    expect(moved.width).toBeGreaterThan(base.width);
    expect(moved.height).toBeGreaterThan(base.height);
    const left = diagramBounds(layout, new Map([[key, { x: -500, y: 0 }]]));
    expect(left.x).toBeLessThan(base.x);
  });
});
