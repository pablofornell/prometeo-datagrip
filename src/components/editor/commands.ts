import { EditorSelection, type SelectionRange } from "@codemirror/state";
import { type Command, EditorView } from "@codemirror/view";
import { docAnalysis } from "./highlight";
import { configField } from "./state";

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
