import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, WidgetType, gutter } from "@codemirror/view";
import { errorsField, execMarksField } from "./state";

const SVG_OK =
  '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3.5 8.6l3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_ERR =
  '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/><rect x="7.1" y="3.6" width="1.8" height="5.4" rx=".9" fill="#fff"/><circle cx="8" cy="11.4" r="1" fill="#fff"/></svg>';

class StatusMarker extends GutterMarker {
  constructor(readonly kind: "ok" | "error" | "running") {
    super();
  }
  eq(o: StatusMarker): boolean {
    return o.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const d = document.createElement("div");
    if (this.kind === "running") {
      d.className = "cm-exec-icon cm-exec-running";
      d.innerHTML = '<span class="dg-spokes"></span>';
      return d;
    }
    const ok = this.kind === "ok";
    d.className = ok ? "cm-exec-icon cm-exec-ok" : "cm-exec-icon cm-exec-err";
    d.innerHTML = ok ? SVG_OK : SVG_ERR;
    return d;
  }
}

const OK = new StatusMarker("ok");
const ERR = new StatusMarker("error");
const RUNNING = new StatusMarker("running");

/** Gutter column after the line numbers: green check / red `!` for executed statements. */
const statusGutter = gutter({
  class: "cm-status-gutter",
  lineMarker(view, line) {
    for (const m of view.state.field(execMarksField)) {
      if (m.from >= line.from && m.from <= line.to) return m.status === "ok" ? OK : m.status === "running" ? RUNNING : ERR;
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

/** Gray inline `23 ms` after the first line of an executed statement (after the `;` when it ends there). */
const hints = EditorView.decorations.compute([execMarksField], (state): DecorationSet => {
  const marks = state.field(execMarksField).filter((m) => m.ms !== undefined);
  if (!marks.length) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  const placed = marks.map((m) => {
    const line = state.doc.lineAt(Math.min(m.from, state.doc.length));
    let pos = line.to;
    if (m.to <= line.to) {
      pos = Math.min(m.to, state.doc.length);
      if (state.doc.sliceString(pos, pos + 1) === ";") pos += 1;
    }
    return { pos, ms: m.ms as number, running: m.status === "running" };
  });
  placed.sort((a, c) => a.pos - c.pos);
  let last = -1;
  for (const m of placed) {
    if (m.pos < last) continue;
    last = m.pos;
    // a running statement shows whole seconds (`4 s`), and nothing during the first one
    const text = m.running ? (m.ms >= 1000 ? `${Math.floor(m.ms / 1000)} s` : "") : formatMs(m.ms);
    if (text) b.add(m.pos, m.pos, Decoration.widget({ widget: new HintWidget(text), side: 1 }));
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
