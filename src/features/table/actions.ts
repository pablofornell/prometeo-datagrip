/** `table.*` actions (focus-guarded shortcuts) and the guard that asks before a tab with pending changes closes. */
import type { Action } from "../../state/actions";
import { registerBeforeClose } from "../../state/tabs";
import { type TableController, activeController, controllerOf, focusedController } from "./controller";

const focused = () => !!focusedController();
const act = (f: (c: TableController) => void) => () => {
  const c = focusedController() ?? activeController();
  if (c) f(c);
};

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
    return c && c.pendingCount() > 0 ? c.confirmClose() : true;
  });
}
