/** `table.*` actions (focus-guarded shortcuts) and the guard that asks before a tab with pending changes closes. */
import type { ObjectRef } from "../../api/types";
import { notify } from "../../components/ui";
import { EditorView } from "@codemirror/view";
import { type Action } from "../../state/actions";
import { exportCurrentResult } from "../output";
import { openTableExport } from "./exportData";
import { registerBeforeClose } from "../../state/tabs";
import { type TableController, activeController, controllerOf, focusedController } from "./controller";

const focused = () => !!focusedController();
const act = (f: (c: TableController) => void) => () => {
  const c = focusedController() ?? activeController();
  if (c) f(c);
};

/** Focuses the WHERE field of a table editor and selects its text. */
export function focusWhere(c: TableController | undefined): void {
  const content = c?.root()?.querySelector<HTMLElement>('[data-fb="where"] .cm-content');
  const view = content && EditorView.findFromDOM(content);
  if (!view) return;
  view.focus();
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
}

export function tableActions(): Action[] {
  return [
    {
      id: "table.submit",
      title: "Submit",
      shortcut: "Ctrl+Enter",
      icon: "dg/submit",
      when: focused,
      enabled: () => (activeController()?.pendingCount() ?? 0) > 0,
      run: act((c) => c.submit()),
    },
    {
      id: "table.revert",
      title: "Revert Selected",
      shortcut: "Ctrl+Alt+Z",
      when: focused,
      enabled: () => (activeController()?.pendingCount() ?? 0) > 0,
      run: act((c) => c.revertSelected()),
    },
    {
      id: "table.addRow",
      title: "Add Row",
      shortcut: "Alt+Insert",
      icon: "add",
      when: focused,
      enabled: () => !!activeController()?.editable(),
      run: act((c) => c.addRow()),
    },
    {
      id: "table.deleteRows",
      title: "Delete Rows",
      shortcut: "Ctrl+Y",
      icon: "remove",
      when: focused,
      enabled: () => !!activeController()?.editable(),
      run: act((c) => c.deleteRows()),
    },
    {
      id: "table.reload",
      title: "Reload Page",
      shortcut: "Ctrl+F5",
      icon: "refresh",
      when: focused,
      enabled: () => !!activeController(),
      run: act((c) => c.reload()),
    },
    {
      id: "table.nextPage",
      title: "Next Page",
      shortcut: "Ctrl+Alt+Down",
      when: focused,
      enabled: () => !!activeController(),
      run: act((c) => c.nextPage()),
    },
    {
      id: "table.prevPage",
      title: "Previous Page",
      shortcut: "Ctrl+Alt+Up",
      when: focused,
      enabled: () => !!activeController(),
      run: act((c) => c.prevPage()),
    },
    {
      id: "table.commit",
      // DataGrip: Console.TableResult.SubmitAndCommit (the console's Console.Transaction.Commit is "Commit")
      title: "Submit and Commit",
      shortcut: "Ctrl+Alt+Shift+Enter",
      icon: "dg/commit",
      when: focused,
      enabled: () => {
        const c = activeController();
        return !!c && c.txMode() === "manual" && c.inTx();
      },
      run: act((c) => c.commit()),
    },
    {
      id: "table.rollback",
      title: "Roll Back",
      icon: "dg/rollback",
      enabled: () => {
        const c = activeController();
        return !!c && c.txMode() === "manual" && c.inTx();
      },
      run: act((c) => c.rollback()),
    },
    {
      // Explorer "Export Data…" passes `{ dsId, objectRef }`; without it (main menu) the active table editor exports.
      id: "grid.export",
      title: "Export Data…",
      icon: "export",
      // always enabled: the explorer passes the target in the context, which `enabled()` cannot see
      run: (ctx) => {
        const t = ctx as { dsId?: string; objectRef?: ObjectRef } | undefined;
        if (t?.dsId && t.objectRef) return openTableExport(t.dsId, t.objectRef);
        const c = activeController();
        if (c) return c.exportData();
        if (!exportCurrentResult()) notify({ kind: "info", title: "Nothing to export", body: "Open a table or select a result first." });
      },
    },
    {
      // Console.TableResult.EditFilterCriteria: the WHERE field of the active table editor takes the focus, text selected
      id: "table.editFilter",
      title: "Edit Filter Criteria",
      shortcut: "Ctrl+Alt+Shift+F",
      enabled: () => !!activeController(),
      run: () => focusWhere(activeController()),
    },
    {
      id: "table.ddl",
      title: "Go to DDL",
      shortcut: "Ctrl+B",
      when: focused,
      enabled: () => !!activeController(),
      run: act((c) => c.openDdl()),
    },
  ];
}

// ---------------------------------------------------------------- close guard

/**
 * Every way of closing a tab (x button, middle click, Ctrl+F4, tab menus, close others / all) asks the tab store's
 * `beforeClose` hooks; a table editor with pending changes asks Submit / Discard / Cancel here.
 */
export function installCloseGuard(): () => void {
  return registerBeforeClose((tab) => {
    const c = tab.kind === "table" ? controllerOf(tab.id) : undefined;
    return c && (c.pendingCount() > 0 || c.inTx()) ? c.confirmClose() : true;
  });
}
