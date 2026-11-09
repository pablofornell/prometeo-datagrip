/**
 * Pure SVG renderer for the database diagram. Produces a self-contained `<svg>` string (background, edges with
 * crow's-foot notation, and one box per table/view with a header, key markers and column rows) from the model +
 * layout + a resolved colour palette, so the export string does not depend on the DOM or the theme at all.
 */
import type { NodeKind } from "../../api/types";
import { DGM, type ColumnsMode, type DiagramModel, type DiagramNode, visibleColumns } from "./model";
import type { LayoutResult } from "./layout";

export interface DiagramPalette {
  background: string;
  nodeBg: string;
  nodeBorder: string;
  headerBg: string;
  headerFg: string;
  viewHeaderBg: string;
  viewFg: string;
  text: string;
  typeText: string;
  pk: string;
  fk: string;
  edge: string;
  edgeLabel: string;
  selection: string;
  rowLine: string;
  /** Concrete monospace stack (resolved from the theme): the export cannot resolve `var(...)`. */
  fontMono: string;
  /** Concrete UI stack for the table name and edge labels. */
  fontUi: string;
}

export interface DiagramRenderOptions {
  columns: ColumnsMode;
  showTypes: boolean;
  /** Highlighted node index, or null. */
  selected?: number | null;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const num = (v: number): string => (Math.round(v * 100) / 100).toString();

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The padded box of the whole diagram (the SVG's width / height / viewBox, and the box Fit zooms to). */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Margin baked around the diagram in the exported SVG. */
export const DIAGRAM_PAD = 48;
/** Room above a table for the self-reference loop label. */
export const SELF_LOOP_HEADROOM = 28;

const isView = (kind: NodeKind): boolean => kind === "view" || kind === "materializedView";

/** A small table glyph for the header (self-contained, not the icon set). */
function glyph(kind: NodeKind, x: number, y: number, color: string): string {
  const view = isView(kind);
  const head = `<rect x="${num(x)}" y="${num(y + 1.5)}" width="10" height="7" rx="1.2" stroke="${color}" stroke-width="1.1" fill="none"/>`;
  const line = `<line x1="${num(x)}" y1="${num(y + 4)}" x2="${num(x + 10)}" y2="${num(y + 4)}" stroke="${color}" stroke-width="1"/>`;
  if (!view) return head + line;
  // views: an extra top edge hint (two stacked bars)
  return head + `<line x1="${num(x + 1)}" y1="${num(y + 3)}" x2="${num(x + 9)}" y2="${num(y + 3)}" stroke="${color}" stroke-width="0.8"/>` + line;
}

/** A PK/FK key marker: a ring plus a shaft. */
function keyGlyph(cx: number, cy: number, color: string): string {
  return (
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="3" fill="none" stroke="${color}" stroke-width="1.3"/>` +
    `<path d="M${num(cx + 2.4)} ${num(cy + 2.4)} L${num(cx + 5.6)} ${num(cy + 5.6)}" stroke="${color}" stroke-width="1.3" fill="none"/>`
  );
}

function nodeSvg(node: DiagramNode, x: number, y: number, opts: DiagramRenderOptions, p: DiagramPalette, dimmed: boolean): string {
  const w = node.width;
  const h = node.height;
  const view = isView(node.kind);
  const headerBg = view ? p.viewHeaderBg : p.headerBg;
  const headerFg = view ? p.viewFg : p.headerFg;
  const border = opts.selected === node.index ? p.selection : p.nodeBorder;
  const header = `M0 5 Q0 0 5 0 H${num(w - 5)} Q${num(w)} 0 ${num(w)} 5 V${DGM.headerH} H0 Z`;
  const vis = visibleColumns(node.columns, opts.columns);

  let rows = "";
  vis.forEach((c, j) => {
    const top = DGM.headerH + j * DGM.rowH;
    const cy = top + DGM.rowH / 2;
    if (c.isPk) rows += keyGlyph(DGM.padX + 5, cy, p.pk);
    else if (c.isFk) rows += keyGlyph(DGM.padX + 5, cy, p.fk);
    rows += `<text x="${num(DGM.padX + DGM.iconW)}" y="${num(cy + 4)}" font-family="${esc(p.fontMono)}" font-size="12" fill="${p.text}">${esc(c.name)}</text>`;
    if (opts.showTypes) rows += `<text x="${num(w - DGM.padX)}" y="${num(cy + 4)}" text-anchor="end" font-family="${esc(p.fontMono)}" font-size="12" fill="${p.typeText}">${esc(c.typeName)}</text>`;
    if (j < vis.length - 1) rows += `<line x1="4" y1="${num(top + DGM.rowH)}" x2="${num(w - 4)}" y2="${num(top + DGM.rowH)}" stroke="${p.rowLine}" stroke-width="1"/>`;
  });

  const name = `<text x="${num(DGM.padX + DGM.iconW)}" y="${num(DGM.headerH / 2 + 4)}" font-family="${esc(p.fontUi)}" font-size="12.5" font-weight="600" fill="${headerFg}"${view ? ' font-style="italic"' : ""}>${esc(node.name)}</text>`;

  return (
    `<g class="dg-diagram-node" data-table-id="${node.index}" opacity="${dimmed ? 0.32 : 1}" transform="translate(${num(x)} ${num(y)})">` +
    `<rect x="0" y="0" width="${num(w)}" height="${num(h)}" rx="5" fill="${p.nodeBg}" stroke="${border}" stroke-width="${opts.selected === node.index ? 1.6 : 1}"/>` +
    `<path d="${header}" fill="${headerBg}"/>` +
    glyph(node.kind, DGM.padX, DGM.headerH / 2 - 5, headerFg) +
    name +
    `<line x1="0" y1="${DGM.headerH}" x2="${num(w)}" y2="${DGM.headerH}" stroke="${border}" stroke-width="1" opacity="0.6"/>` +
    rows +
    `</g>`
  );
}

/** Connection points of an edge: the referenced table (parent) on one side, the referencing table (child) on the other. */
function edgePoints(from: Rect, to: Rect): { p1: { x: number; y: number }; p2: { x: number; y: number } } {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const tx = to.x + to.w / 2;
  const ty = to.y + to.h / 2;
  if (Math.abs(cx - tx) >= Math.abs(cy - ty)) {
    if (cx >= tx) {
      return { p1: { x: to.x + to.w, y: ty }, p2: { x: from.x, y: cy } };
    }
    return { p1: { x: to.x, y: ty }, p2: { x: from.x + from.w, y: cy } };
  }
  if (cy >= ty) {
    return { p1: { x: tx, y: to.y + to.h }, p2: { x: cx, y: from.y } };
  }
  return { p1: { x: tx, y: to.y }, p2: { x: cx, y: from.y + from.h } };
}

/** A "one" tick at the parent end, perpendicular to the line. */
function oneTick(p: { x: number; y: number }, a: number, len: number, color: string): string {
  const perp = a + Math.PI / 2;
  const dx = Math.cos(perp) * len;
  const dy = Math.sin(perp) * len;
  return `<line x1="${num(p.x - dx)}" y1="${num(p.y - dy)}" x2="${num(p.x + dx)}" y2="${num(p.y + dy)}" stroke="${color}" stroke-width="1.2"/>`;
}

/** A crow's foot (the "many" side) at the child end. */
function crowFoot(p: { x: number; y: number }, a: number, len: number, color: string): string {
  return [a, a + Math.PI / 6, a - Math.PI / 6]
    .map((ang) => `<line x1="${num(p.x)}" y1="${num(p.y)}" x2="${num(p.x + Math.cos(ang) * len)}" y2="${num(p.y + Math.sin(ang) * len)}" stroke="${color}" stroke-width="1.2"/>`)
    .join("");
}

function edgeSvg(from: Rect, to: Rect, label: string, self: boolean, p: DiagramPalette): string {
  if (self) {
    const cx = from.x + from.w / 2;
    const top = from.y;
    const d = `M${num(cx - 8)} ${num(top)} C${num(cx - 24)} ${num(top - 28)}, ${num(cx + 24)} ${num(top - 28)}, ${num(cx + 8)} ${num(top)}`;
    return (
      `<g class="dg-diagram-edge" data-edge-self="1">` +
      `<path d="${d}" stroke="${p.edge}" stroke-width="1.2" fill="none"/>` +
      crowFoot({ x: cx + 8, y: top }, Math.atan2(1, 0), 8, p.edge) +
      oneTick({ x: cx - 8, y: top }, Math.PI, 8, p.edge) +
      `<text x="${num(cx)}" y="${num(top - 30)}" text-anchor="middle" font-family="${esc(p.fontUi)}" font-size="11" fill="${p.edgeLabel}">${esc(label)}</text>` +
      `</g>`
    );
  }
  const { p1, p2 } = edgePoints(from, to);
  const a = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const ly = my - 8;
  return (
    `<g class="dg-diagram-edge">` +
    `<path d="M${num(p1.x)} ${num(p1.y)} L${num(p2.x)} ${num(p2.y)}" stroke="${p.edge}" stroke-width="1.2" fill="none"/>` +
    oneTick(p1, a, 8, p.edge) +
    crowFoot(p2, a, 9, p.edge) +
    `<text x="${num(mx)}" y="${num(ly)}" text-anchor="middle" font-family="${esc(p.fontUi)}" font-size="11" fill="${p.edgeLabel}" stroke="${p.background}" stroke-width="3" paint-order="stroke">${esc(label)}</text>` +
    `</g>`
  );
}

/**
 * The padded box of the diagram: node bounds, the self-loop headroom above every table, plus `DIAGRAM_PAD` on all
 * sides. `renderDiagramSvg` emits exactly this as width / height / viewBox, and Fit zooms to it.
 */
export function diagramBounds(layout: LayoutResult, positions?: ReadonlyMap<string, { x: number; y: number }>): Bounds {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const n of layout.nodes) {
    const pos = positions?.get(n.key);
    const x = pos?.x ?? n.x;
    const y = pos?.y ?? n.y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y - SELF_LOOP_HEADROOM);
    maxX = Math.max(maxX, x + n.width);
    maxY = Math.max(maxY, y + n.height);
  }
  return { x: minX - DIAGRAM_PAD, y: minY - DIAGRAM_PAD, width: maxX - minX + DIAGRAM_PAD * 2, height: maxY - minY + DIAGRAM_PAD * 2 };
}

export function renderDiagramSvg(
  model: DiagramModel,
  layout: LayoutResult,
  opts: DiagramRenderOptions,
  palette: DiagramPalette,
  positions?: ReadonlyMap<string, { x: number; y: number }>,
): string {
  const rectOf = (i: number): Rect => {
    const n = layout.nodes[i];
    const pos = positions?.get(n.key);
    return { x: pos?.x ?? n.x, y: pos?.y ?? n.y, w: n.width, h: n.height };
  };

  // Spotlight: when a node is selected, tables with no direct edge to/from it are dimmed.
  const related = new Set<number>();
  if (opts.selected != null) {
    for (const e of model.edges) {
      if (e.from === opts.selected) related.add(e.to);
      else if (e.to === opts.selected) related.add(e.from);
    }
  }

  const bounds = diagramBounds(layout, positions);
  const viewX = bounds.x;
  const viewY = bounds.y;
  const W = bounds.width;
  const H = bounds.height;

  const edges = model.edges
    .map((e) => edgeSvg(rectOf(e.from), rectOf(e.to), e.label, e.self, palette))
    .join("");
  const nodes = model.nodes
    .map((nd) => {
      const r = rectOf(nd.index);
      const dimmed = opts.selected != null && opts.selected !== nd.index && !related.has(nd.index);
      return nodeSvg(nd, r.x, r.y, opts, palette, dimmed);
    })
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(W)}" height="${num(H)}" viewBox="${num(viewX)} ${num(viewY)} ${num(W)} ${num(H)}">` +
    `<rect x="${num(viewX)}" y="${num(viewY)}" width="${num(W)}" height="${num(H)}" fill="${palette.background}"/>` +
    edges +
    nodes +
    `</svg>`
  );
}
