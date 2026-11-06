import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { docAnalysis } from "./highlight";
import { configField } from "./state";
import { setPreview } from "./frame";
import { statementIndexAt } from "./split";
import type { ExecuteRequest, Range } from "./types";

export interface Candidate {
  range: Range;
  /** One-line label shown in the Statements chooser. */
  label: string;
}

/** Selection ranges that are not empty, in document order. */
export function selectionRanges(state: EditorState): Range[] {
  return state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
}

function oneLine(text: string, max = 50): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "..." : t;
}

/** The statement at the caret, as an execute request (no chooser). */
export function statementAtCaret(state: EditorState): { req: ExecuteRequest; candidates: Candidate[] } | null {
  const cfg = state.field(configField);
  const a = docAnalysis(state.doc, cfg.dialect);
  const head = state.selection.main.head;
  const i = statementIndexAt(a.statements, head);
  if (i === null) return null;
  const st = a.statements[i];
  const range = { from: st.start, to: st.end };
  const candidates: Candidate[] = [{ range, label: oneLine(st.text) }];

  // an attached leading comment (no blank line in between) makes a second candidate
  const prevEnd = i > 0 ? a.statements[i - 1].fullEnd : 0;
  const toks = a.tokens.filter((t) => t.from >= prevEnd && t.to <= st.start);
  let from = -1;
  let cursor = st.start;
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.kind !== "comment") break;
    const gap = a.text.slice(t.to, cursor);
    if ((gap.match(/\n/g) ?? []).length > 1) break;
    from = t.from;
    cursor = t.from;
  }
  if (from >= 0) {
    // start the range at the beginning of the comment text
    candidates.push({ range: { from, to: st.end }, label: oneLine(a.text.slice(from, st.end)) });
  }
  return { req: { sql: st.text, ranges: [range], source: "statement" }, candidates };
}

export function scriptRequest(state: EditorState): ExecuteRequest | null {
  const text = state.doc.toString();
  if (!text.trim()) return null;
  return { sql: text, ranges: [{ from: 0, to: text.length }], source: "script" };
}

export function selectionOrStatement(state: EditorState): { req: ExecuteRequest; candidates: Candidate[] } | null {
  const sel = selectionRanges(state);
  if (sel.length) {
    const sql = sel.map((r) => state.sliceDoc(r.from, r.to)).join("\n");
    return { req: { sql, ranges: sel, source: "selection" }, candidates: [] };
  }
  return statementAtCaret(state);
}

// ---------------------------------------------------------------------------------------------
// Statements chooser popup

interface ChooserHandle {
  close(): void;
}
const open = new WeakMap<EditorView, ChooserHandle>();

export function closeChooser(view: EditorView): boolean {
  const h = open.get(view);
  if (!h) return false;
  h.close();
  return true;
}

export function isChooserOpen(view: EditorView): boolean {
  return open.has(view);
}

/** Show the `Statements` popup below the caret line. `pick` gets the chosen candidate. */
export function showChooser(view: EditorView, candidates: Candidate[], pick: (c: Candidate) => void, onCustomize?: () => void): void {
  closeChooser(view);
  const root = document.createElement("div");
  root.className = "cm-statements-popup";
  const title = document.createElement("div");
  title.className = "cm-statements-title";
  title.textContent = "Statements";
  const list = document.createElement("div");
  list.className = "cm-statements-list";
  root.append(title, list);
  let sel = 0;
  const rows: HTMLElement[] = [];
  const preview = (): void => {
    rows.forEach((r, i) => r.classList.toggle("selected", i === sel));
    view.dispatch({ effects: setPreview.of(candidates[sel].range) });
  };
  candidates.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "cm-statements-row";
    row.textContent = c.label;
    row.addEventListener("mousemove", () => {
      if (sel !== i) {
        sel = i;
        preview();
      }
    });
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      done(c);
    });
    rows.push(row);
    list.append(row);
  });
  if (onCustomize) {
    const foot = document.createElement("div");
    foot.className = "cm-statements-foot";
    const link = document.createElement("a");
    link.textContent = "Customize";
    link.addEventListener("mousedown", (e) => {
      e.preventDefault();
      close();
      onCustomize();
    });
    foot.append(link);
    root.append(foot);
  }
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  const host = view.dom.getBoundingClientRect();
  root.style.left = `${Math.max(4, (coords?.left ?? host.left) - host.left - 1)}px`;
  root.style.top = `${(coords?.bottom ?? host.top) - host.top - 1}px`;
  view.dom.append(root);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown") sel = (sel + 1) % candidates.length;
    else if (e.key === "ArrowUp") sel = (sel + candidates.length - 1) % candidates.length;
    else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      done(candidates[sel]);
      return;
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= candidates.length) {
      e.preventDefault();
      done(candidates[Number(e.key) - 1]);
      return;
    } else if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    else {
      close();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    preview();
  };
  const onDown = (e: MouseEvent): void => {
    if (!root.contains(e.target as Node)) close();
  };
  view.contentDOM.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  view.contentDOM.addEventListener("blur", onBlur);
  function onBlur(): void {
    close();
  }
  function close(): void {
    if (!open.has(view)) return;
    open.delete(view);
    view.contentDOM.removeEventListener("keydown", onKey, true);
    view.contentDOM.removeEventListener("blur", onBlur);
    document.removeEventListener("mousedown", onDown, true);
    root.remove();
    view.dispatch({ effects: setPreview.of(null) });
  }
  function done(c: Candidate): void {
    close();
    pick(c);
  }
  open.set(view, { close });
  preview();
}
