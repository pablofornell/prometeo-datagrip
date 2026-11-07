/**
 * Edit / Code actions of the main menu, routed to the component that has the keyboard focus:
 * a CodeMirror editor, a text field, the result grid or the explorer tree.
 *
 * The focused component keeps handling its own keys (CodeMirror, the grid and the browser do), so the
 * shortcuts here are `menuOnly`: they are shown in the menus and the keymap page but never dispatched by the
 * global keymap. The two commands the editor has no key for (Toggle Case, Join Lines) are real shortcuts
 * guarded by "focus is in an editor".
 *
 * Menus are opened without moving the focus and `closeMenu()` restores it before an item runs, so
 * `document.activeElement` is still the component the user was working in.
 */
import { closeCompletion, startCompletion } from "@codemirror/autocomplete";
import {
  copyLineDown,
  deleteCharForward,
  redo,
  redoDepth,
  selectAll as cmSelectAll,
  toggleLineComment,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { EditorSelection, type StateCommand } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isTauri } from "../api/tauri";
import { toggleBlock } from "../components/editor/commands";
import { openFind, openReplace } from "../components/editor/search";
import { type Action, getAction, isActionEnabled, registerActions, runAction } from "./actions";

// ---------------------------------------------------------------- focus routing

type Target =
  | { kind: "input"; el: HTMLInputElement | HTMLTextAreaElement }
  | { kind: "cm"; view: EditorView }
  | { kind: "grid"; el: HTMLElement }
  | { kind: "tree"; el: HTMLElement };

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password", "email", "number", ""]);

/** The editable / selectable component the keyboard focus is in (null: nothing the Edit menu can act on). */
export function editTarget(): Target | null {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return null;
  if (a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(a.type))) return { kind: "input", el: a };
  const cmDom = a.closest<HTMLElement>(".cm-editor");
  const view = cmDom ? EditorView.findFromDOM(cmDom) : null;
  if (view) return { kind: "cm", view };
  const grid = a.closest<HTMLElement>(".dgg");
  if (grid) return { kind: "grid", el: grid };
  const tree = a.closest<HTMLElement>(".dg-explorer-tree");
  if (tree) return { kind: "tree", el: tree };
  return null;
}

const cmEditable = (view: EditorView): boolean => !view.state.readOnly && view.contentDOM.getAttribute("contenteditable") !== "false";
const inEditor = (): boolean => editTarget()?.kind === "cm";
const inEditableEditor = (): boolean => {
  const t = editTarget();
  return t?.kind === "cm" && cmEditable(t.view);
};
const inputSelection = (el: HTMLInputElement | HTMLTextAreaElement): string => {
  const s = el.selectionStart ?? 0;
  const e = el.selectionEnd ?? 0;
  return s === e ? "" : el.value.slice(s, e);
};
/** Paste / Delete change cells: only an editable result grid takes them (the grid root carries `data-editable`). */
const gridEditable = (el: HTMLElement): boolean => el.hasAttribute("data-editable");
const inputWritable = (el: HTMLInputElement | HTMLTextAreaElement): boolean => !el.readOnly && !el.disabled;

// ---------------------------------------------------------------- clipboard

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* legacy path below */
  }
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    ta.remove();
    prev?.focus?.({ preventScroll: true });
  }
}

export async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return (await readText()) ?? "";
    } catch {
      /* fall through */
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- CodeMirror helpers

/** What Copy / Cut take: the selection, or the whole line when the selection is empty (IntelliJ behaviour). */
function cmCopyText(view: EditorView): { text: string; line: boolean } {
  const { state } = view;
  if (state.selection.ranges.some((r) => !r.empty)) {
    return { text: state.selection.ranges.filter((r) => !r.empty).map((r) => state.sliceDoc(r.from, r.to)).join("\n"), line: false };
  }
  const seen = new Set<number>();
  const lines: string[] = [];
  for (const r of state.selection.ranges) {
    const l = state.doc.lineAt(r.head);
    if (seen.has(l.number)) continue;
    seen.add(l.number);
    lines.push(l.text);
  }
  return { text: lines.join("\n") + "\n", line: true };
}

function cmCut(view: EditorView): void {
  const { text, line } = cmCopyText(view);
  void writeClipboardText(text);
  const { state } = view;
  const changes = line
    ? [...new Set(state.selection.ranges.map((r) => state.doc.lineAt(r.head).number))].map((n) => {
        const l = state.doc.line(n);
        return { from: l.from, to: Math.min(state.doc.length, l.to + 1) };
      })
    : state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
  view.dispatch({ changes, userEvent: "delete.cut", scrollIntoView: true });
}

function cmPaste(view: EditorView, text: string): void {
  if (!text) return;
  view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
}

function runCm(view: EditorView, cmd: (v: EditorView) => boolean | void): void {
  view.focus();
  cmd(view);
}

/** Applies a StateCommand to a view. */
const asCommand = (c: StateCommand) => (view: EditorView): boolean => c({ state: view.state, dispatch: view.dispatch.bind(view) });

/** Ctrl+Shift+U: upper-case the selection (or the word at the caret); lower-case it when it is already upper-case. */
export const toggleCase: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const tr = state.changeByRange((r) => {
    let { from, to } = r;
    if (r.empty) {
      const w = state.wordAt(r.head);
      if (!w) return { range: r };
      from = w.from;
      to = w.to;
    }
    const text = state.sliceDoc(from, to);
    const up = text.toUpperCase();
    const next = text === up ? text.toLowerCase() : up;
    return { changes: { from, to, insert: next }, range: r.empty ? r : EditorSelection.range(from, from + next.length) };
  });
  dispatch(state.update(tr, { userEvent: "input.case", scrollIntoView: true }));
  return true;
};

/** Ctrl+Shift+J: join each selected line (or the caret line) with the next one, leaving a single space. */
export const joinLines: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const doc = state.doc;
  const changes: { from: number; to: number; insert: string }[] = [];
  const done = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = doc.lineAt(r.from).number;
    let last = doc.lineAt(r.to).number;
    if (last === first) last = first + 1; // nothing selected across lines: join with the next one
    for (let n = first; n < last && n < doc.lines; n++) {
      if (done.has(n)) continue;
      done.add(n);
      const a = doc.line(n);
      const b = doc.line(n + 1);
      const ind = b.text.length - b.text.trimStart().length;
      const trailing = a.text.length - a.text.trimEnd().length;
      const from = a.to - trailing;
      const to = b.from + ind;
      const bare = b.text.trim() === "" || a.text.trim() === "";
      changes.push({ from, to, insert: bare ? "" : " " });
    }
  }
  if (!changes.length) return true;
  dispatch(state.update({ changes, userEvent: "delete.join", scrollIntoView: true }));
  return true;
};

/** Sort Lines: sorts the selected lines alphabetically (all lines when there is no multi-line selection). */
export const sortLines: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const doc = state.doc;
  const r = state.selection.main;
  const multi = !r.empty && doc.lineAt(r.from).number !== doc.lineAt(r.to).number;
  let a = 1;
  let b = doc.lines;
  if (multi) {
    a = doc.lineAt(r.from).number;
    b = doc.lineAt(r.to).number;
    if (r.to === doc.line(b).from && b > a) b--;
  }
  const lines: string[] = [];
  for (let n = a; n <= b; n++) lines.push(doc.line(n).text);
  const sorted = [...lines].sort((x, y) => x.localeCompare(y));
  const from = doc.line(a).from;
  const to = doc.line(b).to;
  const insert = sorted.join("\n");
  if (insert === doc.sliceString(from, to)) return true;
  dispatch(state.update({ changes: { from, to, insert }, userEvent: "input.sort", scrollIntoView: true }));
  return true;
};

/** Reformat Code has no exported command: it is the editor's own Ctrl+Alt+L binding, triggered by key. */
function pressInEditor(view: EditorView, init: KeyboardEventInit): void {
  view.focus();
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

// ---------------------------------------------------------------- grid helpers

/** The grid handles its own keys: forward the equivalent chord to the focused element inside it. */
function pressInGrid(init: KeyboardEventInit): void {
  const a = document.activeElement as HTMLElement | null;
  (a?.closest(".dgg") ? a : null)?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

/** A synthetic paste event carrying `text`, for components that read `clipboardData` (the grid). */
function pasteInto(el: HTMLElement, text: string): void {
  if (!text) return;
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { getData: (t: string) => (t === "text/plain" || t === "text" ? text : "") } });
  el.dispatchEvent(ev);
}

// ---------------------------------------------------------------- actions

export function registerEditActions(): () => void {
  const list: Action[] = [
    {
      id: "edit.undo",
      title: "Undo",
      shortcut: "Ctrl+Z",
      icon: "undo",
      menuOnly: true,
      enabled: () => {
        const t = editTarget();
        return t?.kind === "cm" ? undoDepth(t.view.state) > 0 : t?.kind === "input" ? inputWritable(t.el) : false;
      },
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, undo);
        else if (t?.kind === "input") document.execCommand("undo");
      },
    },
    {
      id: "edit.redo",
      title: "Redo",
      shortcut: "Ctrl+Shift+Z",
      icon: "redo",
      menuOnly: true,
      enabled: () => {
        const t = editTarget();
        return t?.kind === "cm" ? redoDepth(t.view.state) > 0 : t?.kind === "input" ? inputWritable(t.el) : false;
      },
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, redo);
        else if (t?.kind === "input") document.execCommand("redo");
      },
    },
    {
      id: "edit.cut",
      title: "Cut",
      shortcut: "Ctrl+X",
      menuOnly: true,
      enabled: () => {
        const t = editTarget();
        return t?.kind === "cm" ? cmEditable(t.view) : t?.kind === "input" ? inputWritable(t.el) && !!inputSelection(t.el) : false;
      },
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") cmCut(t.view);
        else if (t?.kind === "input") {
          void writeClipboardText(inputSelection(t.el));
          document.execCommand("delete");
        }
      },
    },
    {
      id: "edit.copy",
      title: "Copy",
      shortcut: "Ctrl+C",
      icon: "copy",
      menuOnly: true,
      enabled: () => {
        const t = editTarget();
        if (!t) return false;
        if (t.kind === "input") return !!inputSelection(t.el);
        if (t.kind === "tree") return isActionEnabled(getAction("db.copyName"));
        return true;
      },
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") void writeClipboardText(cmCopyText(t.view).text);
        else if (t?.kind === "input") void writeClipboardText(inputSelection(t.el));
        else if (t?.kind === "grid") pressInGrid({ key: "c", code: "KeyC", ctrlKey: true });
        else if (t?.kind === "tree") void runAction("db.copyName");
      },
    },
    {
      id: "edit.paste",
      title: "Paste",
      shortcut: "Ctrl+V",
      icon: "paste",
      menuOnly: true,
      enabled: () => {
        const t = editTarget();
        return t?.kind === "cm" ? cmEditable(t.view) : t?.kind === "input" ? inputWritable(t.el) : t?.kind === "grid" && gridEditable(t.el);
      },
      run: async () => {
        const t = editTarget();
        if (!t) return;
        const text = await readClipboardText();
        if (!text) return;
        if (t.kind === "cm") cmPaste(t.view, text);
        else if (t.kind === "input") {
          t.el.focus();
          if (!document.execCommand("insertText", false, text)) {
            t.el.setRangeText(text, t.el.selectionStart ?? 0, t.el.selectionEnd ?? 0, "end");
            t.el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        } else if (t.kind === "grid") pasteInto((document.activeElement as HTMLElement | null) ?? t.el, text);
      },
    },
    {
      id: "edit.delete",
      title: "Delete",
      shortcut: "Delete",
      menuOnly: true,
      enabled: () => {
        const t = editTarget();
        return t?.kind === "cm" ? cmEditable(t.view) : t?.kind === "input" ? inputWritable(t.el) : t?.kind === "grid" && gridEditable(t.el);
      },
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, deleteCharForward);
        else if (t?.kind === "input") document.execCommand("delete");
        else if (t?.kind === "grid") pressInGrid({ key: "Delete", code: "Delete" });
      },
    },
    {
      id: "edit.selectAll",
      title: "Select All",
      shortcut: "Ctrl+A",
      menuOnly: true,
      enabled: () => {
        const t = editTarget();
        return t?.kind === "cm" || t?.kind === "input" || t?.kind === "grid";
      },
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, cmSelectAll);
        else if (t?.kind === "input") t.el.select();
        else if (t?.kind === "grid") pressInGrid({ key: "a", code: "KeyA", ctrlKey: true });
      },
    },
    {
      id: "edit.find",
      title: "Find…",
      shortcut: "Ctrl+F",
      icon: "search",
      menuOnly: true,
      enabled: () => {
        const t = editTarget();
        return t?.kind === "cm" || t?.kind === "grid";
      },
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, openFind);
        else if (t?.kind === "grid") pressInGrid({ key: "f", code: "KeyF", ctrlKey: true });
      },
    },
    {
      id: "edit.replace",
      title: "Replace…",
      shortcut: "Ctrl+R",
      menuOnly: true,
      enabled: inEditableEditor,
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, openReplace);
      },
    },
    {
      id: "edit.duplicateLines",
      title: "Duplicate Entire Lines",
      enabled: inEditableEditor,
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, asCommand(copyLineDown));
      },
    },
    {
      id: "edit.toggleCase",
      title: "Toggle Case",
      shortcut: "Ctrl+Shift+U",
      enabled: inEditableEditor,
      when: inEditor,
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, asCommand(toggleCase));
      },
    },
    {
      id: "edit.joinLines",
      title: "Join Lines",
      shortcut: "Ctrl+Shift+J",
      enabled: inEditableEditor,
      when: inEditor,
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, asCommand(joinLines));
      },
    },
    {
      id: "edit.sortLines",
      title: "Sort Lines",
      enabled: inEditableEditor,
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, asCommand(sortLines));
      },
    },

    // --- code (the SQL editor only)
    {
      id: "code.complete",
      title: "Code Completion",
      shortcut: "Ctrl+Space",
      menuOnly: true,
      enabled: inEditableEditor,
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, (v) => (closeCompletion(v), startCompletion(v)));
      },
    },
    {
      id: "code.reformat",
      title: "Reformat Code",
      shortcut: "Ctrl+Alt+L",
      menuOnly: true,
      enabled: inEditableEditor,
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") pressInEditor(t.view, { key: "l", code: "KeyL", ctrlKey: true, altKey: true });
      },
    },
    {
      id: "code.comment",
      title: "Comment with Line Comment",
      shortcut: "Ctrl+/",
      menuOnly: true,
      enabled: inEditableEditor,
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, toggleLineComment);
      },
    },
    {
      id: "code.commentBlock",
      title: "Comment with Block Comment",
      shortcut: "Ctrl+Shift+/",
      menuOnly: true,
      enabled: inEditableEditor,
      run: () => {
        const t = editTarget();
        if (t?.kind === "cm") runCm(t.view, toggleBlock);
      },
    },
  ];
  return registerActions(list);
}
