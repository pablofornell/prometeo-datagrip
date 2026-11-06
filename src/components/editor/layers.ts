import { type Extension } from "@codemirror/state";
import { type EditorView, RectangleMarker, layer } from "@codemirror/view";
import { layerBase } from "./frame";

/** Caret row: full-width band on the line of every caret, painted below the selection layer. */
const caretRow = layer({
  above: false,
  class: "cm-caretrow-layer",
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged,
  markers(view: EditorView) {
    const base = layerBase(view);
    const rect = view.contentDOM.getBoundingClientRect();
    const out: RectangleMarker[] = [];
    const seen = new Set<number>();
    for (const r of view.state.selection.ranges) {
      const line = view.state.doc.lineAt(r.head);
      if (seen.has(line.number)) continue;
      seen.add(line.number);
      const b = view.lineBlockAt(line.from);
      out.push(new RectangleMarker("cm-caretrow", rect.left - base.left, b.top + view.documentTop - base.top, rect.width, b.height));
    }
    return out;
  },
});

/** Right margin guide at column 120. */
const rightMargin = layer({
  above: true,
  class: "cm-margin-layer",
  update: (u) => u.geometryChanged || u.docChanged || u.viewportChanged,
  markers(view: EditorView) {
    const base = layerBase(view);
    const rect = view.contentDOM.getBoundingClientRect();
    const x = rect.left - base.left + 2 + 120 * Math.round(view.defaultCharacterWidth * 10) / 10;
    return [new RectangleMarker("cm-margin-line", x, 0, 1, Math.max(view.contentHeight, view.scrollDOM.clientHeight))];
  },
});

export function editorLayers(): Extension {
  return [caretRow, rightMargin];
}
