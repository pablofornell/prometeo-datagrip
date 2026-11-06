import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, WidgetType, gutter } from "@codemirror/view";
import { errorsField, execMarksField } from "./state";

const SVG_OK =
  '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3.5 8.6l3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_ERR =
  '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/><rect x="7.1" y="3.6" width="1.8" height="5.4" rx=".9" fill="#fff"/><circle cx="8" cy="11.4" r="1" fill="#fff"/></svg>';

class StatusMarker extends GutterMarker {
  constructor(readonly ok: boolean) {
    super();
  }
  eq(o: StatusMarker): boolean {
    return o.ok === this.ok;
  }
  toDOM(): HTMLElement {
    const d = document.createElement("div");
    d.className = this.ok ? "cm-exec-icon cm-exec-ok" : "cm-exec-icon cm-exec-err";
    d.innerHTML = this.ok ? SVG_OK : SVG_ERR;
    return d;
  }
}

const OK = new StatusMarker(true);
const ERR = new StatusMarker(false);

/** Gutter column after the line numbers: green check / red `!` for executed statements. */
const statusGutter = gutter({
  class: "cm-status-gutter",
  lineMarker(view, line) {
    for (const m of view.state.field(execMarksField)) {
      if (m.from >= line.from && m.from <= line.to) return m.status === "ok" ? OK : ERR;
    }
    for (const e of view.state.field(errorsField)) {
      if (e.statementFrom >= line.from && e.statementFrom <= line.to) return ERR;
    }
    return null;
  },
  lineMarkerChange: (u) => u.docChanged || u.startState.field(execMarksField) !== u.state.field(execMarksField) || u.startState.field(errorsField) !== u.state.field(errorsField),
  initialSpacer: () => OK,
});

class HintWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: HintWidget): boolean {
    return o.text === this.text;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "cm-exec-hint";
    s.textContent = this.text;
    return s;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Gray inline `23 ms` after the end of an executed statement. */
const hints = EditorView.decorations.compute([execMarksField], (state): DecorationSet => {
  const marks = state.field(execMarksField).filter((m) => m.ms !== undefined);
  if (!marks.length) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  const sorted = [...marks].sort((a, c) => a.to - c.to);
  let last = -1;
  for (const m of sorted) {
    let pos = Math.min(m.to, state.doc.length);
    if (state.doc.sliceString(pos, pos + 1) === ";") pos += 1;
    if (pos < last) continue;
    last = pos;
    b.add(pos, pos, Decoration.widget({ widget: new HintWidget(formatMs(m.ms as number)), side: 1 }));
  }
  return b.finish();
});

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function statusGutterExtension(): Extension {
  return [statusGutter, hints];
}
