/**
 * Live inspections: syntax errors and unresolved names, computed from the lexer / semantic pass a short time
 * after the last edit. They feed the wavy underline, the hover tooltips, the inspection widget, the error
 * stripe and F2 / Shift+F2 (next / previous problem).
 */
import { type EditorState, EditorSelection, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, hoverTooltip } from "@codemirror/view";
import { docAnalysis, LARGE_DOC } from "./highlight";
import { intentionsAt, intentionHostFacet } from "./intentions";
import { analyzeStatement } from "./semantic";
import { configField, errorsField, type Problem, problemsField, setConfig, setProblems } from "./state";
import { syntaxProblems } from "./syntax";

/** Pause after the last edit before the inspections run. */
export const INSPECT_DELAY = 300;
/** Above this size the inspections are off (they would run over the whole script after every pause). */
const INSPECT_MAX = 400_000;

/** Every problem of the document (pure: used by the plugin and by tests). */
export function computeProblems(state: EditorState): Problem[] {
  const doc = state.doc;
  if (state.readOnly || doc.length > INSPECT_MAX || doc.length > LARGE_DOC) return [];
  const cfg = state.field(configField);
  const a = docAnalysis(doc, cfg.dialect);
  const out: Problem[] = [];
  const toks = a.tokens;
  let ti = 0;
  for (const st of a.statements) {
    while (ti < toks.length && toks[ti].from < st.start) ti++;
    const begin = ti;
    while (ti < toks.length && toks[ti].from < st.fullEnd) ti++;
    const own = toks.slice(begin, ti);
    for (const p of syntaxProblems(a.text, own)) out.push({ ...p, kind: "syntax" });
    for (const u of analyzeStatement(a.text, own, cfg.index, cfg.dialect, cfg.implicit).unresolved) out.push({ from: u.from, to: u.to, message: u.message, kind: "unresolved" });
  }
  return out.sort((x, y) => x.from - y.from);
}

const same = (a: Problem[], b: Problem[]): boolean => a.length === b.length && a.every((p, i) => p.from === b[i].from && p.to === b[i].to && p.message === b[i].message && p.kind === b[i].kind);

const runner = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) {
      this.schedule(0);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setConfig)))) this.schedule(INSPECT_DELAY);
    }
    schedule(ms: number): void {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const next = computeProblems(this.view.state);
        if (!same(this.view.state.field(problemsField), next)) this.view.dispatch({ effects: setProblems.of(next) });
      }, ms);
    }
    destroy(): void {
      clearTimeout(this.timer);
    }
  },
);

const wave = Decoration.mark({ class: "cm-sql-error-wave" });

/** Syntax errors get the red wavy underline; unresolved names are already red text. */
const waves = EditorView.decorations.compute([problemsField], (state): DecorationSet => {
  const b = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const p of state.field(problemsField)) {
    if (p.kind !== "syntax" || p.from < last) continue;
    b.add(p.from, p.to, wave);
    last = p.to;
  }
  return b.finish();
});

function tipFor(kind: Problem["kind"], hoverTime: number): Extension {
  return hoverTooltip(
    (view, pos) => {
      const p = view.state.field(problemsField).find((x) => x.kind === kind && pos >= x.from && pos <= x.to);
      if (!p) return null;
      return {
        pos: p.from,
        end: p.to,
        above: false,
        create(v) {
          const dom = document.createElement("div");
          dom.className = "cm-inspect-tip";
          const msg = document.createElement("div");
          msg.textContent = p.message;
          dom.append(msg);
          // footer: the first fix (Alt+Shift+Enter) and `More actions…` (Alt+Enter), when there is something to offer
          const list = intentionsAt(v.state, p.from, { host: v.state.facet(intentionHostFacet) });
          if (list.length) {
            const foot = document.createElement("div");
            foot.className = "cm-inspect-foot";
            const link = (label: string, key: string, run: () => void): void => {
              const a = document.createElement("a");
              a.className = "cm-inspect-link";
              a.append(label + " ");
              const k = document.createElement("span");
              k.className = "cm-inspect-key";
              k.textContent = key;
              a.append(k);
              a.addEventListener("mousedown", (e) => {
                e.preventDefault();
                v.dispatch({ selection: EditorSelection.cursor(p.from) });
                v.focus();
                run();
              });
              foot.append(a);
            };
            const first = list.find((x) => x.kind === "fix");
            if (first) link(first.label, "Alt+Shift+Enter", () => first.apply(v));
            link("More actions…", "Alt+Enter", () => void import("./intentionsPopup").then((m) => m.showIntentions(v))); // lazy: the popup needs the DOM menu
            dom.append(foot);
          }
          return { dom };
        },
      };
    },
    { hoverTime },
  );
}

export function inspectExtension(): Extension {
  return [problemsField, runner, waves, tipFor("syntax", 300), tipFor("unresolved", 1000)];
}

/** Offsets of all problems: the inspections and the errors of the last execution. */
export function problemPositions(state: EditorState): number[] {
  const out = state.field(problemsField).map((p) => p.from);
  const len = state.doc.length;
  for (const e of state.field(errorsField)) out.push(Math.min(len, e.position && e.position > 0 ? e.statementFrom + e.position - 1 : e.statementFrom));
  return out.sort((a, b) => a - b);
}

/** F2 / Shift+F2: moves the caret to the next / previous problem (wrapping around). */
export function jumpProblem(view: EditorView, dir: 1 | -1): boolean {
  const all = problemPositions(view.state);
  if (!all.length) return true;
  const head = view.state.selection.main.head;
  let target = dir > 0 ? all.find((p) => p > head) : [...all].reverse().find((p) => p < head);
  if (target === undefined) target = dir > 0 ? all[0] : all[all.length - 1];
  view.dispatch({ selection: EditorSelection.cursor(target), effects: EditorView.scrollIntoView(target, { y: "center" }), userEvent: "select" });
  return true;
}
