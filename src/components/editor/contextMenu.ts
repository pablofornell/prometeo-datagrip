/** The editor's right-click menu (replaces the webview's native one): only entries that work. */
import { toggleLineComment } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { type Command, EditorView } from "@codemirror/view";
import { isTauri } from "../../api/tauri";
import { runAction } from "../../state/actions";
import { type MenuItem, openMenu } from "../ui";
import { duplicate, goToLine, recordClip } from "./commands";
import { showIntentions } from "./intentionsPopup";
import { type NavHandlers, referenceAtCaret } from "./navigate";

export async function writeText(text: string): Promise<void> {
  if (isTauri()) {
    try {
      const { writeText: w } = await import("@tauri-apps/plugin-clipboard-manager");
      await w(text);
      return;
    } catch {
      /* fall through to the web clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

async function readText(): Promise<string> {
  if (isTauri()) {
    try {
      const { readText: r } = await import("@tauri-apps/plugin-clipboard-manager");
      return (await r()) ?? "";
    } catch {
      /* fall through to the web clipboard */
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

const selectedText = (view: EditorView): string =>
  view.state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => view.state.sliceDoc(r.from, r.to))
    .join("\n");

const copy = (view: EditorView): void => {
  recordClip(selectedText(view));
  void writeText(selectedText(view));
};

const cut = (view: EditorView): void => {
  recordClip(selectedText(view));
  void writeText(selectedText(view));
  view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut", scrollIntoView: true });
};

const paste = (view: EditorView): void => {
  void readText().then((t) => {
    if (!t) return;
    // a single-line editor strips the newlines itself (transaction filter)
    view.dispatch(view.state.replaceSelection(t), { userEvent: "input.paste", scrollIntoView: true });
  });
};

export interface EditorMenuOptions {
  /** Single-line filter field: no Go To and no execution entries. */
  single: boolean;
  nav: NavHandlers;
  /** The editor belongs to a console: Execute / Execute Script. */
  canExecute: boolean;
  reformat: Command;
  /** Ctrl+B at the caret (only when the host handles navigation). */
  goToDeclaration: Command;
}

/** Moves the caret to the pointer unless it is inside the selection (then the selection stays). */
export function placeCaretAt(view: EditorView, e: MouseEvent): void {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos === null) return;
  if (view.state.selection.ranges.some((r) => !r.empty && pos >= r.from && pos <= r.to)) return;
  view.dispatch({ selection: EditorSelection.cursor(pos) });
}

export function openEditorMenu(view: EditorView, e: MouseEvent, o: EditorMenuOptions): void {
  const sep: MenuItem = { type: "separator" };
  const ro = view.state.readOnly;
  const hasSel = view.state.selection.ranges.some((r) => !r.empty);
  const cmd =
    (c: Command) => (): void => {
      view.focus();
      c(view);
    };
  const items: MenuItem[] = [];

  if (!o.single && !ro) items.push({ label: "Show Context Actions", icon: "intention-bulb", shortcut: "Alt+Enter", run: () => { view.focus(); showIntentions(view); } }, sep);

  const edit: MenuItem[] = [];
  if (hasSel && !ro) edit.push({ label: "Cut", shortcut: "Ctrl+X", run: () => cut(view) });
  if (hasSel) edit.push({ label: "Copy", icon: "copy", shortcut: "Ctrl+C", run: () => copy(view) });
  if (!ro) edit.push({ label: "Paste", icon: "paste", shortcut: "Ctrl+V", run: () => paste(view) });
  const special: MenuItem[] = [];
  const ref = o.nav.goTo ? referenceAtCaret(view) : null;
  if (ref) special.push({ label: "Copy Reference", shortcut: "Ctrl+Alt+Shift+C", run: () => void writeText(ref) });
  if (!ro) special.push({ label: "Paste as Plain Text", run: () => paste(view) });
  if (special.length) edit.push({ label: "Copy / Paste Special", children: special });
  items.push(...edit, sep);

  if (!o.single) {
    // the usages of the name at the caret (features/usages): references in the database and in the SQL files
    if (o.nav.goTo) items.push({ label: "Find Usages", shortcut: "Alt+F7", run: () => { view.focus(); void runAction("db.findUsages"); } }, sep);
    const go: MenuItem[] = [];
    if (o.nav.goTo) go.push({ label: "Go to Declaration", shortcut: "Ctrl+B", run: cmd(o.goToDeclaration) });
    go.push({ label: "Line:Column…", shortcut: "Ctrl+G", run: cmd(goToLine) });
    items.push({ label: "Go To", children: go }, sep);
  }

  if (!ro) {
    items.push(
      { label: "Reformat Code", shortcut: "Ctrl+Alt+L", run: cmd(o.reformat) },
      { label: "Duplicate", shortcut: "Ctrl+D", run: cmd(duplicate) },
      { label: "Comment with Line Comment", shortcut: "Ctrl+/", run: cmd(toggleLineComment) },
      sep,
    );
  }

  if (!o.single && o.canExecute) {
    items.push({ label: "Explain Plan", icon: "explain-plan", children: [{ action: "sql.explainPlan" }, { action: "sql.explainAnalyse" }] });
    items.push({ action: "sql.execute" }, { action: "sql.executeScript" });
  }

  openMenu(items, { x: e.clientX, y: e.clientY, minWidth: 340 });
}
