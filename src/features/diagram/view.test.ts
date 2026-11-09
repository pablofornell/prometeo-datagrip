import { describe, expect, it } from "vitest";
import { layoutDiagram } from "./layout";
import { buildDiagram, type DiagramInputObject, type DiagramOptions } from "./model";
import { resolvePalette } from "./palette";
import { renderDiagramSvg } from "./svg";
import { fitView } from "./view";

const opts: DiagramOptions = { columns: "all", showTypes: true };

const obj = (name: string): DiagramInputObject => ({
  schema: "shop",
  name,
  kind: "table",
  columns: [{ name: "id", typeName: "bigint", isPk: true }],
});

/** Corners of `bounds` after the fit transform, in stage coordinates. */
const corners = (b: { x: number; y: number; width: number; height: number }, v: { zoom: number; tx: number; ty: number }) => ({
  left: v.tx + b.x * v.zoom,
  top: v.ty + b.y * v.zoom,
  right: v.tx + (b.x + b.width) * v.zoom,
  bottom: v.ty + (b.y + b.height) * v.zoom,
});

describe("fitView", () => {
  it("puts the whole padded box inside the stage and centers it", () => {
    const bounds = { x: -48, y: -76, width: 600, height: 400 };
    const stage = { width: 1000, height: 700 };
    const v = fitView(bounds, stage)!;
    const c = corners(bounds, v);
    expect(c.left).toBeGreaterThanOrEqual(0);
    expect(c.top).toBeGreaterThanOrEqual(0);
    expect(c.right).toBeLessThanOrEqual(stage.width);
    expect(c.bottom).toBeLessThanOrEqual(stage.height);
    expect(c.left).toBeCloseTo(stage.width - c.right, 6);
    expect(c.top).toBeCloseTo(stage.height - c.bottom, 6);
  });

  it("never zooms in past 2x", () => {
    const v = fitView({ x: 0, y: 0, width: 10, height: 10 }, { width: 1000, height: 1000 })!;
    expect(v.zoom).toBeLessThanOrEqual(2);
  });

  it("clamps to the minimum zoom for a huge diagram", () => {
    const v = fitView({ x: 0, y: 0, width: 100000, height: 100000 }, { width: 800, height: 600 })!;
    expect(v.zoom).toBe(0.1);
  });

  it("returns null when the stage or the bounds are empty", () => {
    expect(fitView({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
    expect(fitView({ x: 0, y: 0, width: 0, height: 0 }, { width: 800, height: 600 })).toBeNull();
  });

  it("agrees with the bounds the SVG emits as its viewBox", () => {
    const model = buildDiagram([obj("orders"), obj("customers"), obj("products")], opts);
    const layout = layoutDiagram(model);
    const svg = renderDiagramSvg(model, layout, { columns: "all", showTypes: true }, resolvePalette(() => ""));
    const m = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
    expect(m).not.toBeNull();
    const bounds = { x: Number(m![1]), y: Number(m![2]), width: Number(m![3]), height: Number(m![4]) };
    const stage = { width: 900, height: 600 };
    const v = fitView(bounds, stage)!;
    const c = corners(bounds, v);
    expect(c.left).toBeGreaterThanOrEqual(-1e-9);
    expect(c.top).toBeGreaterThanOrEqual(-1e-9);
    expect(c.right).toBeLessThanOrEqual(stage.width + 1e-9);
    expect(c.bottom).toBeLessThanOrEqual(stage.height + 1e-9);
    expect(c.left).toBeCloseTo(stage.width - c.right, 6);
    expect(c.top).toBeCloseTo(stage.height - c.bottom, 6);
  });
});
