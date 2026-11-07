/**
 * Navigation from SQL: resolve the identifier under the caret (table, view, alias -> table, column) with the
 * statement's scope, then Ctrl+B / Ctrl+Click go to its declaration, Ctrl+Q shows its documentation and
 * Alt+Shift+B selects it in the Database Explorer. The host supplies the handlers (the editor knows no tabs).
 */
import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { docAnalysis } from "./highlight";
import { analyzeStatement } from "./semantic";
import { configField } from "./state";

export interface NavTarget {
  /** Kind of the table-like object (`table`, `view`, `matview`, `sequence`, ...). */
  kind: string;
  schema: string;
  /** Table / view name (for a column: the table it belongs to). */
  name: string;
  column?: { name: string; type: string; key?: string };
  /** The identifier in the document. */
  from: number;
  to: number;
}

export interface NavHandlers {
  /** Ctrl+B / Ctrl+Click. */
  goTo?: (t: NavTarget) => void;
  /** Ctrl+Q; `anchor` is the rectangle of the identifier on screen. */
  quickDoc?: (t: NavTarget, anchor: DOMRect) => void;
  /** Alt+Shift+B. */
  selectInExplorer?: (t: NavTarget) => void;
}

/** The object the identifier at `pos` refers to, or null (keywords, literals and unresolved names). */
export function resolveAt(state: EditorState, pos: number): NavTarget | null {
  const cfg = state.field(configField);
  if (cfg.index.empty) return null;
  const a = docAnalysis(state.doc, cfg.dialect);
  const toks = a.tokens;
  let ti = 0;
  for (const st of a.statements) {
    while (ti < toks.length && toks[ti].from < st.start) ti++;
    const begin = ti;
    while (ti < toks.length && toks[ti].from < st.fullEnd) ti++;
    if (pos < st.start || pos > st.fullEnd) continue;
    const an = analyzeStatement(a.text, toks.slice(begin, ti), cfg.index, cfg.dialect, cfg.implicit);
    // the caret may sit right after the word
    const r = an.resolved.find((x) => pos >= x.from && pos < x.to) ?? an.resolved.find((x) => pos === x.to);
    if (!r) return null;
    const col = r.column;
    return {
      kind: r.table.kind,
      schema: r.table.schema,
      name: r.table.name,
      column: col ? { name: col.name, type: col.type, key: col.key } : undefined,
      from: r.from,
      to: r.to,
    };
  }
  return null;
}

// ---------------------------------------------------------------- Ctrl hover: link look

const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-sql-link" });

const linkField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setLink)) return e.value;
    if (v && tr.docChanged) return null;
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v): DecorationSet => (v ? Decoration.set([linkMark.range(v.from, v.to)]) : Decoration.none)),
});

const isMod = (e: { ctrlKey: boolean; metaKey: boolean }): boolean => e.ctrlKey || e.metaKey;

/** Ctrl+Click and the Ctrl-hover link look. Without a `goTo` handler nothing is installed. */
export function navigationExtension(handlers: () => NavHandlers) {
  let last: { x: number; y: number } | null = null;
  const at = (view: EditorView, x: number, y: number): NavTarget | null => {
    const pos = view.posAtCoords({ x, y }, false);
    return pos === null ? null : resolveAt(view.state, pos);
  };
  const show = (view: EditorView, t: NavTarget | null): void => {
    const cur = view.state.field(linkField);
    if ((cur?.from ?? -1) === (t?.from ?? -1) && (cur?.to ?? -1) === (t?.to ?? -1)) return;
    view.dispatch({ effects: setLink.of(t ? { from: t.from, to: t.to } : null) });
  };
  const hover = (view: EditorView, ctrl: boolean): void => {
    if (!ctrl || !last || !handlers().goTo) return show(view, null);
    const cr = view.contentDOM.getBoundingClientRect();
    const inside = last.x >= cr.left && last.x <= cr.right && last.y >= cr.top && last.y <= cr.bottom;
    show(view, inside ? at(view, last.x, last.y) : null);
  };
  return [
    linkField,
    EditorView.domEventHandlers({
      mousemove(e, view) {
        last = { x: e.clientX, y: e.clientY };
        hover(view, isMod(e));
      },
      mouseleave(_e, view) {
        last = null;
        show(view, null);
      },
      keydown(e, view) {
        if (e.key === "Control" || e.key === "Meta") hover(view, true);
      },
      keyup(e, view) {
        if (e.key === "Control" || e.key === "Meta") show(view, null);
      },
      blur(_e, view) {
        show(view, null);
      },
      mousedown(e, view) {
        if (e.button !== 0 || !isMod(e) || e.altKey || e.shiftKey) return false;
        const go = handlers().goTo;
        if (!go) return false;
        const t = at(view, e.clientX, e.clientY);
        if (!t) return false;
        show(view, null);
        go(t);
        return true;
      },
    }),
  ];
}

// ---------------------------------------------------------------- commands

const targetAtCaret = (view: EditorView): NavTarget | null => resolveAt(view.state, view.state.selection.main.head);

/** Ctrl+B. */
export const goToDeclaration = (handlers: () => NavHandlers) => (view: EditorView): boolean => {
  const h = handlers().goTo;
  if (!h) return false;
  const t = targetAtCaret(view);
  if (t) h(t);
  return true;
};

/** Ctrl+Q: the popup is anchored below the word and does not take the focus. */
export const quickDocAtCaret = (handlers: () => NavHandlers) => (view: EditorView): boolean => {
  const h = handlers().quickDoc;
  if (!h) return false;
  const t = targetAtCaret(view);
  if (!t) return true;
  const a = view.coordsAtPos(t.from);
  const b = view.coordsAtPos(t.to);
  if (a) h(t, new DOMRect(a.left, a.top, Math.max(1, (b?.right ?? a.right) - a.left), a.bottom - a.top));
  return true;
};

/** Alt+Shift+B. */
export const selectInExplorerAtCaret = (handlers: () => NavHandlers) => (view: EditorView): boolean => {
  const h = handlers().selectInExplorer;
  if (!h) return false;
  const t = targetAtCaret(view);
  if (t) h(t);
  return true;
};

/** Text of "Copy Reference" for the identifier at the caret: `schema.table[.column]`. */
export function referenceAtCaret(view: EditorView): string | null {
  const t = targetAtCaret(view);
  return t ? [t.schema, t.name, t.column?.name].filter(Boolean).join(".") : null;
}
