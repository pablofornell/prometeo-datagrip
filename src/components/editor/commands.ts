import { EditorSelection, type Extension, StateEffect, StateField, type SelectionRange } from "@codemirror/state";
import { type Command, EditorView, type Tooltip, showTooltip } from "@codemirror/view";
import type { MenuItem } from "../ui/Menu";
import { docAnalysis } from "./highlight";
import { functionsFor } from "./keywords";
import { configField } from "./state";
import { statementIndexAt } from "./split";

/** Ctrl+D: duplicate the selection (or the line when there is no selection). */
export const duplicate: Command = (view) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const tr = state.changeByRange((r) => {
    if (r.empty) {
      const line = state.doc.lineAt(r.head);
      const insert = "\n" + line.text;
      return {
        changes: { from: line.to, insert },
        range: EditorSelection.cursor(r.head + insert.length),
      };
    }
    const text = state.sliceDoc(r.from, r.to);
    return {
      changes: { from: r.to, insert: text },
      range: EditorSelection.range(r.to, r.to + text.length),
    };
  });
  view.dispatch(state.update(tr, { userEvent: "input", scrollIntoView: true }));
  return true;
};

/** Smart tab: insert spaces up to the next 4-column stop, or indent the selected lines. */
export const tabIndent: Command = (view) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  if (state.selection.ranges.some((r) => !r.empty && state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number)) {
    const lines = new Set<number>();
    for (const r of state.selection.ranges) {
      const a = state.doc.lineAt(r.from).number;
      const b = state.doc.lineAt(r.to).number - (r.to === state.doc.line(state.doc.lineAt(r.to).number).from && !r.empty ? 1 : 0);
      for (let n = a; n <= b; n++) lines.add(n);
    }
    const changes = [...lines].map((n) => ({ from: state.doc.line(n).from, insert: "    " }));
    view.dispatch({ changes, userEvent: "input.indent" });
    return true;
  }
  const tr = state.changeByRange((r) => {
    const line = state.doc.lineAt(r.from);
    const col = r.from - line.from;
    const n = 4 - (col % 4);
    const ins = " ".repeat(n);
    return { changes: { from: r.from, to: r.to, insert: ins }, range: EditorSelection.cursor(r.from + n) };
  });
  view.dispatch(state.update(tr, { userEvent: "input", scrollIntoView: true }));
  return true;
};

export const shiftTab: Command = (view) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  const changes: { from: number; to: number }[] = [];
  for (const n of lines) {
    const l = state.doc.line(n);
    const m = /^( {1,4}|\t)/.exec(l.text);
    if (m) changes.push({ from: l.from, to: l.from + m[0].length });
  }
  if (!changes.length) return true;
  view.dispatch({ changes, userEvent: "delete.dedent" });
  return true;
};

// ---------------------------------------------------------------------------------------------
// Extend / shrink selection (Ctrl+W / Ctrl+Shift+W)

const history = new WeakMap<EditorView, SelectionRange[]>();

function wordRange(text: string, pos: number): { from: number; to: number } | null {
  const isW = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_$]/u.test(c);
  let a = pos;
  let b = pos;
  while (a > 0 && isW(text[a - 1])) a--;
  while (b < text.length && isW(text[b])) b++;
  return a < b ? { from: a, to: b } : null;
}

function candidates(view: EditorView, sel: SelectionRange): { from: number; to: number }[] {
  const doc = view.state.doc;
  const text = doc.toString();
  const cfg = view.state.field(configField);
  const an = docAnalysis(doc, cfg.dialect);
  const out: { from: number; to: number }[] = [];
  const w = wordRange(text, sel.from);
  if (w) out.push(w);
  // strings and quoted identifiers (inner and outer)
  for (const t of an.tokens) {
    if (t.to < sel.from) continue;
    if (t.from > sel.to) break;
    if (t.kind === "string" || t.kind === "qident") {
      out.push({ from: t.from, to: t.to });
      if (t.to - t.from > 2) out.push({ from: t.from + 1, to: t.to - 1 });
    }
  }
  // enclosing parentheses
  const stack: number[] = [];
  const pairs: { o: number; c: number }[] = [];
  for (const t of an.tokens) {
    if (t.kind !== "punct" || t.to - t.from !== 1) continue;
    const ch = text[t.from];
    if (ch === "(") stack.push(t.from);
    else if (ch === ")" && stack.length) pairs.push({ o: stack.pop() as number, c: t.from });
  }
  for (const p of pairs) {
    if (p.o < sel.from && p.c >= sel.to) {
      out.push({ from: p.o + 1, to: p.c });
      out.push({ from: p.o, to: p.c + 1 });
    }
  }
  // line (without indentation), statement, document
  const l = doc.lineAt(sel.from);
  const ind = l.text.length - l.text.trimStart().length;
  out.push({ from: l.from + ind, to: l.to });
  const st = an.statements.find((s) => s.start <= sel.from && sel.to <= s.end);
  if (st) out.push({ from: st.start, to: st.end });
  out.push({ from: 0, to: doc.length });
  return out;
}

export const extendSelection: Command = (view) => {
  const stack = history.get(view) ?? [];
  const main = view.state.selection.main;
  const best = candidates(view, main)
    .filter((c) => c.from <= main.from && c.to >= main.to && (c.from < main.from || c.to > main.to))
    .sort((x, y) => x.to - x.from - (y.to - y.from))[0];
  if (!best) return true;
  stack.push(main);
  history.set(view, stack);
  view.dispatch({ selection: EditorSelection.range(best.from, best.to), scrollIntoView: true });
  return true;
};

export const shrinkSelection: Command = (view) => {
  const stack = history.get(view);
  const prev = stack?.pop();
  if (!prev) {
    const m = view.state.selection.main;
    view.dispatch({ selection: EditorSelection.cursor(m.head) });
    return true;
  }
  view.dispatch({ selection: EditorSelection.single(prev.anchor, prev.head), scrollIntoView: true });
  return true;
};

// ---------------------------------------------------------------------------------------------
// Move statement / line

/** Ctrl+Shift+Up/Down: swap the statement at the caret with its neighbour statement. */
export function moveStatement(dir: -1 | 1): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const cfg = state.field(configField);
    const a = docAnalysis(state.doc, cfg.dialect);
    const head = state.selection.main.head;
    const i = a.statements.findIndex((s) => head >= s.start && head <= s.fullEnd);
    if (i < 0) return moveLine(dir)(view);
    const j = i + dir;
    if (j < 0 || j >= a.statements.length) return true;
    const doc = state.doc;
    // a block spans whole lines from the statement's first to its last line (delimiter included)
    const block = (k: number): { from: number; to: number } => {
      const s = a.statements[k];
      const f = doc.lineAt(s.start);
      const t = doc.lineAt(s.fullEnd);
      return { from: f.from, to: t.to };
    };
    const A = block(Math.min(i, j));
    const B = block(Math.max(i, j));
    if (A.to >= B.from) return moveLine(dir)(view);
    const gap = state.sliceDoc(A.to, B.from);
    const ta = state.sliceDoc(A.from, A.to);
    const tb = state.sliceDoc(B.from, B.to);
    const mine = block(i);
    const offsetInBlock = head - mine.from;
    const newStart = dir === -1 ? A.from : A.from + tb.length + gap.length;
    view.dispatch({
      changes: { from: A.from, to: B.to, insert: tb + gap + ta },
      selection: EditorSelection.cursor(newStart + offsetInBlock),
      scrollIntoView: true,
      userEvent: "move.line",
    });
    return true;
  };
}

/** Alt+Shift+Up/Down: move the selected lines. */
export function moveLine(dir: -1 | 1): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const { state } = view;
    const doc = state.doc;
    const r = state.selection.main;
    const first = doc.lineAt(r.from);
    let last = doc.lineAt(r.to);
    if (!r.empty && r.to === last.from && last.number > first.number) last = doc.line(last.number - 1);
    if (dir === -1 && first.number === 1) return true;
    if (dir === 1 && last.number === doc.lines) return true;
    const block = state.sliceDoc(first.from, last.to);
    if (dir === -1) {
      const above = doc.line(first.number - 1);
      view.dispatch({
        changes: { from: above.from, to: last.to, insert: block + "\n" + above.text },
        selection: EditorSelection.range(r.anchor - (first.from - above.from), r.head - (first.from - above.from)),
        scrollIntoView: true,
        userEvent: "move.line",
      });
    } else {
      const below = doc.line(last.number + 1);
      const shift = below.length + 1;
      view.dispatch({
        changes: { from: first.from, to: below.to, insert: below.text + "\n" + block },
        selection: EditorSelection.range(r.anchor + shift, r.head + shift),
        scrollIntoView: true,
        userEvent: "move.line",
      });
    }
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// Go to line (Ctrl+G)

const gotoOpen = new WeakMap<EditorView, () => void>();

export const goToLine: Command = (view) => {
  const existing = gotoOpen.get(view);
  if (existing) {
    existing();
    return true;
  }
  const root = document.createElement("div");
  root.className = "cm-goto";
  const label = document.createElement("div");
  label.className = "cm-goto-title";
  label.textContent = "Go to Line:Column";
  const input = document.createElement("input");
  input.className = "cm-goto-input";
  input.spellcheck = false;
  const hint = document.createElement("div");
  hint.className = "cm-goto-hint";
  const lines = view.state.doc.lines;
  hint.textContent = `Enter line[:column] (1..${lines})`;
  root.append(label, input, hint);
  view.dom.append(root);
  const head = view.state.selection.main.head;
  const ln = view.state.doc.lineAt(head);
  input.value = `${ln.number}:${head - ln.from + 1}`;
  input.select();
  input.focus();
  const close = (): void => {
    gotoOpen.delete(view);
    root.remove();
    view.focus();
  };
  gotoOpen.set(view, close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = /^\s*(\d+)?\s*(?::\s*(\d+))?\s*$/.exec(input.value);
      if (!m || (!m[1] && !m[2])) {
        input.classList.add("invalid");
        return;
      }
      const n = Math.min(Math.max(1, Number(m[1] ?? ln.number)), view.state.doc.lines);
      const line = view.state.doc.line(n);
      const col = m[2] ? Math.min(Math.max(1, Number(m[2])), line.length + 1) : 1;
      view.dispatch({ selection: EditorSelection.cursor(line.from + col - 1), effects: EditorView.scrollIntoView(line.from + col - 1, { y: "center" }) });
      close();
    } else input.classList.remove("invalid");
  });
  input.addEventListener("blur", () => {
    if (gotoOpen.has(view)) close();
  });
  return true;
};

// ---------------------------------------------------------------------------------------------
// Block comment (Ctrl+Shift+/): `/*text*/` without padding, like IntelliJ

export const toggleBlock: Command = (view) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const tr = state.changeByRange((r) => {
    if (r.empty) {
      return { changes: { from: r.from, insert: "/**/" }, range: EditorSelection.cursor(r.from + 2) };
    }
    const text = state.sliceDoc(r.from, r.to);
    if (text.startsWith("/*") && text.endsWith("*/") && text.length >= 4) {
      return { changes: { from: r.from, to: r.to, insert: text.slice(2, -2) }, range: EditorSelection.range(r.from, r.to - 4) };
    }
    if (state.sliceDoc(Math.max(0, r.from - 2), r.from) === "/*" && state.sliceDoc(r.to, r.to + 2) === "*/") {
      return {
        changes: [
          { from: r.from - 2, to: r.from },
          { from: r.to, to: r.to + 2 },
        ],
        range: EditorSelection.range(r.from - 2, r.to - 2),
      };
    }
    return {
      changes: [
        { from: r.from, insert: "/*" },
        { from: r.to, insert: "*/" },
      ],
      range: EditorSelection.range(r.from + 2, r.to + 2),
    };
  });
  view.dispatch(state.update(tr, { userEvent: "input.comment", scrollIntoView: true }));
  return true;
};

// ---------------------------------------------------------------------------------------------
// Complete statement (Ctrl+Shift+Enter). Toggle Case / Join Lines (Ctrl+Shift+U / J) are the Edit menu's actions.

/** Ctrl+Shift+Enter: ends the statement at the caret with `;` (when missing) and opens a new line below it. */
export const completeStatement: Command = (view) => {
  if (view.state.readOnly) return false;
  const { state } = view;
  const head = state.selection.main.head;
  const a = docAnalysis(state.doc, state.field(configField).dialect);
  const si = statementIndexAt(a.statements, head);
  const st = si === null ? undefined : a.statements[si];
  const changes: { from: number; insert: string }[] = [];
  let endPos = state.doc.lineAt(head).to;
  if (st && st.text.trim()) {
    if (st.fullEnd === st.end) {
      changes.push({ from: st.end, insert: ";" });
      endPos = st.end;
    } else endPos = st.fullEnd;
  }
  const lineTo = state.doc.lineAt(endPos).to;
  const nl = "\n" + /^\s*/.exec(state.doc.lineAt(st ? st.start : head).text)![0];
  view.dispatch({
    changes: [...changes, { from: lineTo, insert: nl }],
    selection: EditorSelection.cursor(lineTo + changes.length + nl.length),
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  return true;
};

// ---------------------------------------------------------------------------------------------
// Paste from history (Ctrl+Shift+V): the last 10 texts copied in the editors

const clips: string[] = [];

/** Remembers a copied / cut text (newest first, 10 kept, no doubles). */
export function recordClip(text: string): void {
  if (!text.trim()) return;
  const i = clips.indexOf(text);
  if (i >= 0) clips.splice(i, 1);
  clips.unshift(text);
  clips.length = Math.min(clips.length, 10);
}

/** Texts copied so far, newest first (tests). */
export const clipHistory = (): readonly string[] => clips;

/** `copy` / `cut` of the editor's own DOM events feed the history. */
export const clipRecorder: Extension = EditorView.domEventHandlers({
  copy(_e, view) {
    recordClip(view.state.selection.ranges.filter((r) => !r.empty).map((r) => view.state.sliceDoc(r.from, r.to)).join("\n"));
  },
  cut(_e, view) {
    recordClip(view.state.selection.ranges.filter((r) => !r.empty).map((r) => view.state.sliceDoc(r.from, r.to)).join("\n"));
  },
});

const oneLine = (t: string): string => {
  const x = t.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return x.length > 80 ? x.slice(0, 80) + "…" : x;
};

export const pasteFromHistory: Command = (view) => {
  if (view.state.readOnly) return false;
  if (!clips.length) return true;
  const items: MenuItem[] = clips.map((t) => ({
    label: oneLine(t),
    run: () => {
      view.focus();
      view.dispatch(view.state.replaceSelection(t), { userEvent: "input.paste", scrollIntoView: true });
    },
  }));
  const c = view.coordsAtPos(view.state.selection.main.head);
  // lazy: the menu needs the DOM (this module is also loaded by the DOM-free tests)
  void import("../ui/Menu").then((m) => m.openMenu(items, { x: c?.left ?? 0, y: (c?.bottom ?? 0) + 2, compact: true, minWidth: 260, selected: "first", title: "Choose Content to Paste" }));
  return true;
};

// ---------------------------------------------------------------------------------------------
// Parameter info (Ctrl+P): the signature of the routine call around the caret

export interface CallInfo {
  name: string;
  args: string[];
  /** Index of the argument the caret is in. */
  current: number;
  ret?: string;
}

/** The innermost unclosed call before `pos`: its name and the argument index (from the token text, strings skipped). */
export function callAt(text: string, pos: number): { name: string; current: number } | null {
  let depth = 0;
  let commas = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) {
        const m = /([A-Za-z_][A-Za-z0-9_$]*)\s*$/.exec(text.slice(Math.max(0, i - 80), i));
        return m ? { name: m[1], current: commas } : null;
      }
      depth--;
    } else if (c === "," && depth === 0) commas++;
    else if (c === ";") return null;
  }
  return null;
}

/** Signature of function `name` from the introspected routines first, then the built-ins. */
export function signatureOf(state: import("@codemirror/state").EditorState, name: string): { args: string[]; ret?: string } | null {
  const cfg = state.field(configField);
  const lower = name.toLowerCase();
  for (const s of cfg.index.list) {
    const r = s.routines.find((x) => x.name.toLowerCase() === lower);
    if (r) return { args: splitArgs(r.args), ret: r.returns };
  }
  const f = functionsFor(cfg.dialect).find((x) => x.name.toLowerCase() === lower);
  return f ? { args: splitArgs(f.args), ret: f.ret } : null;
}

const splitArgs = (a: string): string[] => (a.trim() ? a.split(",").map((x) => x.trim()) : []);

const setParamInfo = StateEffect.define<Tooltip | null>();
const paramInfoField = StateField.define<Tooltip | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setParamInfo)) return e.value;
    // the hint stays while the caret moves inside the call, and goes with any edit that leaves it
    if (v && (tr.docChanged || tr.selection)) return null;
    return v;
  },
  provide: (f) => showTooltip.compute([f], (st) => st.field(f)),
});

export const parameterInfoExtension: Extension = paramInfoField;

/** The offset from which to scan backward for the call at `head`: the current statement start, capped ~4000 chars back. */
export function callScanStart(state: import("@codemirror/state").EditorState, head: number): number {
  const cfg = state.field(configField);
  const a = docAnalysis(state.doc, cfg.dialect);
  const si = statementIndexAt(a.statements, head);
  return Math.max(si !== null ? a.statements[si].start : 0, head - 4000);
}

/** The parameter-info tooltip for the call around `head`, or null when there is no known signature. */
function paramInfoTooltip(state: import("@codemirror/state").EditorState, head: number): Tooltip | null {
  const from = callScanStart(state, head);
  const call = callAt(state.doc.sliceString(from, head), head - from);
  const sig = call ? signatureOf(state, call.name) : null;
  if (!call || !sig) return null;
  const tip: Tooltip = {
    pos: head,
    above: true,
    arrow: false,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-param-info";
      if (!sig.args.length) {
        const none = document.createElement("span");
        none.className = "cm-param-none";
        none.textContent = "<no parameters>";
        dom.append(none);
      }
      sig.args.forEach((a, i) => {
        if (i) dom.append(", ");
        const span = document.createElement("span");
        span.textContent = a;
        if (i === Math.min(call.current, sig.args.length - 1)) span.className = "cm-param-current";
        dom.append(span);
      });
      return { dom };
    },
  };
  return tip;
}

/** Ctrl+P. */
export const parameterInfo: Command = (view) => {
  const head = view.state.selection.main.head;
  view.dispatch({ effects: setParamInfo.of(paramInfoTooltip(view.state, head)) });
  return true;
};

/** Auto-shows the parameter info after `(` and refreshes it after `,` inside a call (DataGrip's popup). */
export const autoParameterInfo: Extension = EditorView.updateListener.of((u) => {
  if (!u.docChanged || u.state.readOnly) return;
  let trigger = false;
  u.changes.iterChanges((_a, _b, _c, _d, ins) => {
    const t = ins.toString();
    if (t === "(" || t === "," || t.endsWith("(") || t.endsWith(",")) trigger = true;
  });
  if (!trigger) return;
  const head = u.state.selection.main.head;
  const tip = paramInfoTooltip(u.state, head);
  if (!tip) return;
  u.view.dispatch({ effects: setParamInfo.of(tip) });
});
