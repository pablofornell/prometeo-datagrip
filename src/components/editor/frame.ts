import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { type EditorView, type LayerMarker, RectangleMarker, layer } from "@codemirror/view";
import { docAnalysis } from "./highlight";
import { configField } from "./state";
import { statementIndexAt } from "./split";
import type { Range } from "./types";

/** Range filled with translucent green while the Statements chooser is open (CONSOLE_RANGE_TO_EXECUTE). */
export const setPreview = StateEffect.define<Range | null>();

export const previewField = StateField.define<Range | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setPreview)) return e.value;
    if (v && tr.docChanged) return null;
    return v;
  },
});

/** The statement the caret is in, or null when the caret is in blank space / a comment only. */
export function currentStatementRange(view: EditorView): Range | null {
  const state = view.state;
  const sel = state.selection.main;
  const cfg = state.field(configField);
  const a = docAnalysis(state.doc, cfg.dialect);
  const i = statementIndexAt(a.statements, sel.head);
  if (i === null) return null;
  const st = a.statements[i];
  // inside the statement or right at its delimiter; blank lines between statements show no frame
  if (sel.head < st.start || sel.head > st.fullEnd) return null;
  return { from: st.start, to: st.end };
}

export function layerBase(view: EditorView): { left: number; top: number } {
  const r = view.scrollDOM.getBoundingClientRect();
  return { left: r.left - view.scrollDOM.scrollLeft, top: r.top - view.scrollDOM.scrollTop };
}

function xAt(view: EditorView, pos: number, base: { left: number }): number {
  const c = view.coordsAtPos(pos);
  if (c) return c.left - base.left;
  const line = view.state.doc.lineAt(pos);
  const cl = view.contentDOM.getBoundingClientRect().left - base.left;
  return cl + 2 + (pos - line.from) * view.defaultCharacterWidth;
}

class FrameMarker implements LayerMarker {
  constructor(readonly pts: number[][]) {}
  eq(o: LayerMarker): boolean {
    return o instanceof FrameMarker && JSON.stringify(o.pts) === JSON.stringify(this.pts);
  }
  draw(): HTMLElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    this.fill(svg);
    return svg as unknown as HTMLElement;
  }
  update(dom: HTMLElement): boolean {
    this.fill(dom as unknown as SVGElement);
    return true;
  }
  private fill(svg: SVGElement): void {
    const xs = this.pts.map((p) => p[0]);
    const ys = this.pts.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs)) - 1;
    const y0 = Math.floor(Math.min(...ys)) - 1;
    const w = Math.ceil(Math.max(...xs)) - x0 + 2;
    const h = Math.ceil(Math.max(...ys)) - y0 + 2;
    svg.setAttribute("class", "cm-stmt-frame");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("style", `left:${x0}px;top:${y0}px`);
    let path = this.pts.map((p, i) => `${i ? "L" : "M"}${p[0] - x0} ${p[1] - y0}`).join(" ");
    path += " Z";
    svg.innerHTML = `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1" shape-rendering="crispEdges"/>`;
  }
}

/**
 * Outline polygon of a multi-line text range, like IntelliJ's boxed effect: the first line starts
 * at the range start, following lines at the left margin, every line but the last runs to the
 * widest line end, and the last ends at the range end. Edges are drawn inside the pixel boxes.
 */
function frameMarkers(view: EditorView): readonly LayerMarker[] {
  const cfg = view.state.field(configField);
  if (!cfg.statementFrame) return [];
  const r = currentStatementRange(view);
  if (!r) return [];
  const doc = view.state.doc;
  const base = layerBase(view);
  const l0 = doc.lineAt(r.from);
  const l1 = doc.lineAt(r.to);
  const top = (pos: number): number => view.lineBlockAt(pos).top + view.documentTop - base.top;
  const bottom = (pos: number): number => view.lineBlockAt(pos).bottom + view.documentTop - base.top;
  const left = xAt(view, l0.from, base);
  const sx = xAt(view, r.from, base);
  const ex = xAt(view, r.to, base);
  let right = Math.max(sx, ex);
  if (l0.number !== l1.number) {
    for (let n = l0.number; n <= l1.number; n++) {
      const ln = doc.line(n);
      const end = n === l1.number ? r.to : ln.to;
      right = Math.max(right, xAt(view, end, base));
    }
  }
  // the document's text origin is the same for every line
  const t0 = top(l0.from);
  const b1 = bottom(l1.from);
  let pts: number[][];
  if (l0.number === l1.number) {
    pts = [
      [sx + 0.5, t0 + 0.5],
      [ex - 0.5, t0 + 0.5],
      [ex - 0.5, b1 - 0.5],
      [sx + 0.5, b1 - 0.5],
    ];
  } else {
    const t1 = top(doc.line(l0.number + 1).from);
    const bPrev = bottom(doc.line(l1.number - 1).from);
    pts = [
      [sx + 0.5, t0 + 0.5],
      [right - 0.5, t0 + 0.5],
      [right - 0.5, bPrev - 0.5],
      [ex - 0.5, bPrev - 0.5],
      [ex - 0.5, b1 - 0.5],
      [left + 0.5, b1 - 0.5],
      [left + 0.5, t1 - 0.5],
      [sx + 0.5, t1 - 0.5],
    ];
  }
  return [new FrameMarker(pts)];
}

export const statementFrame = layer({
  above: true,
  class: "cm-stmt-frame-layer",
  update(u) {
    return (
      u.docChanged ||
      u.selectionSet ||
      u.viewportChanged ||
      u.geometryChanged ||
      u.startState.field(configField) !== u.state.field(configField)
    );
  },
  markers: frameMarkers,
});

export const previewFill = layer({
  above: false,
  class: "cm-stmt-fill-layer",
  update(u) {
    return u.docChanged || u.viewportChanged || u.geometryChanged || u.startState.field(previewField) !== u.state.field(previewField);
  },
  markers(view) {
    const p = view.state.field(previewField);
    if (!p) return [];
    return RectangleMarker.forRange(view, "cm-stmt-fill", EditorSelection.range(p.from, p.to));
  },
});
