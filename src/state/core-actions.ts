/**
 * Core actions of the shell (window, tabs, tool windows, theme) plus *stubs* for the operative actions
 * implemented by other modules. A stub has no `run`, so menus and toolbars show it disabled; the
 * implementing module enables it by registering the same id with a `run` (see actions.ts).
 */
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "../api/window";
import { type Action, registerActions } from "./actions";
import {
  TOOL_WINDOWS,
  hideActiveToolWindow,
  hideAllToolWindows,
  isToolWindowVisible,
  resetLayout,
  toggleToolWindow,
} from "./layout";
import { activeTabId, closeAllTabs, closeOtherTabs, closeTab, cycleTab } from "./tabs";
import { type ThemePref, setThemePref, themePref } from "./theme";
import { menuBarOpen, setAboutOpen, setMenuBarOpen } from "./ui";


/** Ids of actions other modules are expected to implement (kept in one place for discoverability). */
export const ACTION_IDS = {
  newConsole: "db.newConsole",
  dataSources: "db.dataSources",
  refresh: "db.refresh",
  editData: "db.editData",
  gotoDdl: "db.gotoDdl",
  gotoObject: "nav.gotoObject",
  searchEverywhere: "nav.searchEverywhere",
  jumpToConsole: "db.jumpToConsole",
  execute: "sql.execute",
  cancel: "sql.cancel",
  history: "sql.history",
  commit: "sql.commit",
  rollback: "sql.rollback",
  exportData: "grid.export",
  settings: "app.settings",
  menu: "app.mainMenu",
} as const;

const stub = (id: string, title: string, shortcut?: string, icon?: string): Action => ({ id, title, shortcut, icon });

export function registerCoreActions(): () => void {
  const list: Action[] = [
    // --- window / application
    { id: "app.exit", title: "Exit", run: () => void closeWindow() },
    { id: "window.minimize", title: "Minimize", run: () => void minimizeWindow() },
    { id: "window.maximize", title: "Maximize / Restore", run: () => void toggleMaximizeWindow() },
    { id: "help.about", title: "About Prometeo DataGrip", run: () => void setAboutOpen(true) },
    { id: ACTION_IDS.menu, title: "Main Menu", shortcut: "Alt+\\", checked: () => menuBarOpen(), run: () => void setMenuBarOpen(!menuBarOpen()) },
    { id: "window.resetLayout", title: "Restore Default Layout", run: () => resetLayout() },
    stub(ACTION_IDS.settings, "Settings…", "Ctrl+Alt+S", "settings"),
    stub(ACTION_IDS.dataSources, "Data Sources…", "Ctrl+Alt+Shift+S", "dg/manage-data-sources"),
    stub(ACTION_IDS.newConsole, "New Query Console", "Ctrl+Shift+Q", "dg/console"),
    stub(ACTION_IDS.jumpToConsole, "Jump to Query Console…", "Ctrl+Shift+F10"),

    // --- tabs
    { id: "tab.close", title: "Close Tab", shortcut: "Ctrl+F4", enabled: () => !!activeTabId(), run: async () => void (await closeTab(activeTabId()!)) },
    { id: "tab.closeOthers", title: "Close Other Tabs", enabled: () => !!activeTabId(), run: async () => void (await closeOtherTabs(activeTabId()!)) },
    { id: "tab.closeAll", title: "Close All Tabs", enabled: () => !!activeTabId(), run: async () => void (await closeAllTabs()) },
    { id: "tab.next", title: "Next Tab", shortcut: "Alt+Right", run: () => cycleTab(1) },
    { id: "tab.prev", title: "Previous Tab", shortcut: "Alt+Left", run: () => cycleTab(-1) },

    // --- tool windows
    ...TOOL_WINDOWS.map<Action>((t) => ({
      id: "toolwindow." + t.id,
      title: t.title,
      shortcut: t.shortcut,
      icon: t.icon.replace("@20x20", ""),
      checked: () => isToolWindowVisible(t.id),
      run: () => toggleToolWindow(t.id),
    })),
    { id: "toolwindow.hideActive", title: "Hide Active Tool Window", shortcut: "Shift+Escape", run: () => hideActiveToolWindow() },
    { id: "toolwindow.hideAll", title: "Hide All Windows", shortcut: "Ctrl+Shift+F12", run: () => hideAllToolWindows() },

    // --- theme
    ...(
      [
        ["system", "Follow System Theme"],
        ["dark", "Islands Dark"],
        ["light", "Islands Light"],
      ] as [ThemePref, string][]
    ).map<Action>(([p, title]) => ({
      id: "theme." + p,
      title,
      checked: () => themePref() === p,
      run: () => setThemePref(p),
    })),

    // --- edit (implemented by the focused editor / grid / text field)
    stub("edit.undo", "Undo", "Ctrl+Z", "undo"),
    stub("edit.redo", "Redo", "Ctrl+Shift+Z", "redo"),
    stub("edit.cut", "Cut", "Ctrl+X"),
    stub("edit.copy", "Copy", "Ctrl+C", "copy"),
    stub("edit.paste", "Paste", "Ctrl+V", "paste"),
    stub("edit.selectAll", "Select All", "Ctrl+A"),
    stub("edit.find", "Find…", "Ctrl+F", "search"),
    stub("edit.replace", "Replace…", "Ctrl+R"),

    // --- navigate
    stub(ACTION_IDS.searchEverywhere, "Search Everywhere", "Shift Shift", "search"),
    stub(ACTION_IDS.gotoObject, "Go to Database Object…", "Ctrl+N"),
    stub(ACTION_IDS.gotoDdl, "Go to DDL", "Ctrl+B"),
    stub(ACTION_IDS.editData, "Edit Data", "F4", "dg/edit-data"),

    // --- code
    stub("code.complete", "Code Completion", "Ctrl+Space"),
    stub("code.reformat", "Reformat Code", "Ctrl+Alt+L"),
    stub("code.comment", "Comment with Line Comment", "Ctrl+/"),

    // --- tools / run
    stub(ACTION_IDS.execute, "Execute", "Ctrl+Enter", "run"),
    stub(ACTION_IDS.cancel, "Cancel Running Statements", "Ctrl+F2", "stop"),
    stub(ACTION_IDS.history, "Browse Query History", "Ctrl+Alt+E", "history"),
    stub(ACTION_IDS.commit, "Commit", "Ctrl+Alt+Shift+Enter", "dg/commit"),
    stub(ACTION_IDS.rollback, "Roll back", undefined, "dg/rollback"),
    stub(ACTION_IDS.refresh, "Refresh", "Ctrl+F5", "refresh"),
    stub(ACTION_IDS.exportData, "Export Data…", undefined, "export"),
  ];
  return registerActions(list);
}
