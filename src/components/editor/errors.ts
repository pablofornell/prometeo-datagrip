import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, hoverTooltip } from "@codemirror/view";
import { docAnalysis } from "./highlight";
import { configField, errorsField } from "./state";
import { errorPos } from "./stripe";

const wave = Decoration.mark({ class: "cm-sql-error-wave" });

/** The range underlined for an error: the token at the reported position. */
function errorRange(view: { state: import("@codemirror/state").EditorState }, from: number, position?: number): { from: number; to: number } | null {
  const doc = view.state.doc;
  const pos = Math.min(doc.length, position && position > 0 ? from + position - 1 : from);
  if (!position) return null; // no position reported: gutter mark + stripe only
  const a = docAnalysis(doc, view.state.field(configField).dialect);
  for (const t of a.tokens) {
    if (t.from <= pos && pos < t.to && t.kind !== "comment") return { from: t.from, to: t.to };
    if (t.from > pos) break;
  }
  return pos < doc.length ? { from: pos, to: pos + 1 } : null;
}

const decorations = EditorView.decorations.compute([errorsField, "doc"], (state): DecorationSet => {
  const errs = state.field(errorsField);
  if (!errs.length) return Decoration.none;
  const ranges: { from: number; to: number }[] = [];
  for (const e of errs) {
    const r = errorRange({ state }, e.statementFrom, e.position);
    if (r) ranges.push(r);
  }
  ranges.sort((a, b) => a.from - b.from);
  const b = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const r of ranges) {
    if (r.from < last) continue;
    b.add(r.from, r.to, wave);
    last = r.to;
  }
  return b.finish();
});

const tooltip = hoverTooltip(
  (view, pos) => {
    for (const e of view.state.field(errorsField)) {
      const r = errorRange(view, e.statementFrom, e.position);
      const to = e.statementTo ?? r?.to ?? e.statementFrom;
      const within = r ? pos >= r.from && pos <= r.to : pos >= e.statementFrom && pos <= to;
      if (!within) continue;
      return {
        pos: r?.from ?? errorPos(view, e.statementFrom, e.position),
        end: r?.to,
        above: false,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-error-tip";
          dom.textContent = e.message;
          return { dom };
        },
      };
    }
    return null;
  },
  { hoverTime: 300 },
);

export function errorExtension(): Extension {
  return [decorations, tooltip];
}
