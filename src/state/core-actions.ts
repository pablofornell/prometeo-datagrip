/**
 * Core actions of the shell (window, tabs, tool windows, theme) plus *stubs* for the operative actions
 * implemented by other modules. A stub has no `run`, so menus and toolbars show it disabled; the
 * implementing module enables it by registering the same id with a `run` (see actions.ts).
 */
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "../api/window";
import { openKeymapPopup, openQuickSwitch, openThemePopup } from "../components/shell/quick-switch";
import { type Action, registerActions } from "./actions";
import { registerEditActions } from "./edit-actions";
import {
  type StretchDir,
  type ToolWindowAnchor,
  TOOL_WINDOWS,
  activeToolWindow,
  currentToolWindow,
  focusToolWindow,
  hideActiveToolWindow,
  hideAllToolWindows,
  isToolWindowVisible,
  moveToolWindow,
  resetLayout,
  stretchDirsOf,
  stretchToolWindow,
  toggleMaximizeToolWindow,
  toggleToolWindow,
} from "./layout";
import { goBack, goForward, canGoBack, canGoForward, initNavHistory } from "./nav-history";
import { DEFAULT_SETTINGS, settings, updateSettings } from "./settings";
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
      icon: t.menuIcon ?? t.icon.replace("@20x20", ""),
      checked: () => isToolWindowVisible(t.id),
      run: () => toggleToolWindow(t.id),
    })),
    { id: "toolwindow.maximize", title: "Maximize Tool Window", shortcut: "Ctrl+Shift+'", enabled: () => !!currentToolWindow(), run: () => toggleMaximizeToolWindow(currentToolWindow()!) },
    ...(
      [
        ["left", "Stretch to Left", "Ctrl+Shift+Left"],
        ["right", "Stretch to Right", "Ctrl+Shift+Right"],
        ["top", "Stretch to Top", "Ctrl+Shift+Up"],
        ["bottom", "Stretch to Bottom", "Ctrl+Shift+Down"],
      ] as [StretchDir, string, string][]
    ).map<Action>(([dir, title, shortcut]) => ({
      id: "toolwindow.stretch." + dir,
      title,
      shortcut,
      // only while a tool window has focus: in the editor Ctrl+Shift+Arrow extends the selection
      when: () => !!(document.activeElement as HTMLElement | null)?.closest("[data-toolwindow]"),
      enabled: () => {
        const id = currentToolWindow();
        return !!id && stretchDirsOf(id).includes(dir);
      },
      run: () => stretchToolWindow(currentToolWindow()!, dir),
    })),
    ...(
      [
        ["left", "Move Tool Window to Left"],
        ["right", "Move Tool Window to Right"],
        ["bottom", "Move Tool Window to Bottom"],
      ] as [ToolWindowAnchor, string][]
    ).map<Action>(([anchor, title]) => ({
      id: "toolwindow.moveTo." + anchor,
      title,
      enabled: () => !!currentToolWindow(),
      run: () => moveToolWindow(currentToolWindow()!, anchor),
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

    // --- quick switch popups (gear menu, Ctrl+`)
    { id: "app.themePopup", title: "Theme…", run: () => openThemePopup() },
    { id: "app.keymapPopup", title: "Keymap…", run: () => openKeymapPopup() },
    { id: "app.quickSwitch", title: "Quick Switch Scheme…", shortcut: "Ctrl+`", run: () => openQuickSwitch() },

    // --- edit / code: src/state/edit-actions.ts (routed to the focused editor / grid / text field)

    // --- global navigation
    stub("nav.findAction", "Find Action…", "Ctrl+Shift+A"),
    { id: "nav.back", title: "Back", shortcut: "Ctrl+Alt+Left", icon: "chevron-left", enabled: canGoBack, run: goBack },
    { id: "nav.forward", title: "Forward", shortcut: "Ctrl+Alt+Right", icon: "chevron-right", enabled: canGoForward, run: goForward },
    {
      id: "editor.focus",
      title: "Focus Editor",
      shortcut: "Escape",
      // Escape in a tool window hands the focus back to the editor, unless a text field, popup or dialog is using the key.
      when: () => {
        const a = document.activeElement as HTMLElement | null;
        if (!a?.closest("[data-toolwindow]")) return false;
        if (a.matches("input, textarea, select, [contenteditable=true]")) return false;
        return !document.querySelector(".dg-menu-backdrop, .dg-dialog-overlay");
      },
      run: () => focusEditorArea(),
    },
    {
      id: "toolwindow.last",
      title: "Jump to Last Tool Window",
      shortcut: "F12",
      enabled: () => !!lastToolWindow(),
      run: () => focusToolWindow(lastToolWindow()!),
    },

    // --- font size in all editors
    {
      id: "view.fontIncrease",
      title: "Increase Font Size in All Editors",
      shortcut: "Alt+Shift+.",
      enabled: () => settings.editorFontSize < 40,
      run: () => updateSettings({ editorFontSize: settings.editorFontSize + 1 }),
    },
    {
      id: "view.fontDecrease",
      title: "Decrease Font Size in All Editors",
      shortcut: "Alt+Shift+Comma",
      enabled: () => settings.editorFontSize > 8,
      run: () => updateSettings({ editorFontSize: settings.editorFontSize - 1 }),
    },
    {
      id: "view.fontReset",
      title: "Reset Font Size in All Editors",
      enabled: () => settings.editorFontSize !== DEFAULT_SETTINGS.editorFontSize,
      run: () => updateSettings({ editorFontSize: DEFAULT_SETTINGS.editorFontSize }),
    },

    // --- navigate
    stub(ACTION_IDS.searchEverywhere, "Search Everywhere", "Shift Shift", "search"),
    stub(ACTION_IDS.gotoObject, "Go to Database Object…", "Ctrl+N"),
    stub(ACTION_IDS.gotoDdl, "Go to DDL", "Ctrl+B"),
    stub(ACTION_IDS.editData, "Edit Data", "F4", "dg/edit-data"),

    // --- tools / run
    stub(ACTION_IDS.execute, "Execute", "Ctrl+Enter", "run"),
    stub(ACTION_IDS.cancel, "Cancel Running Statements", "Ctrl+F2", "stop"),
    stub(ACTION_IDS.history, "Browse Query History", "Ctrl+Alt+E", "history"),
    stub(ACTION_IDS.commit, "Commit", "Ctrl+Alt+Shift+Enter", "dg/commit"),
    stub(ACTION_IDS.rollback, "Roll back", undefined, "dg/rollback"),
    stub(ACTION_IDS.refresh, "Refresh", "Ctrl+F5", "refresh"),
    stub(ACTION_IDS.exportData, "Export Data…", undefined, "export"),
  ];
  const disposers = [registerActions(list), registerEditActions(), initNavHistory()];
  return () => disposers.forEach((d) => d());
}

/** The tool window F12 jumps to: the one that last had the focus, if it is still shown. */
function lastToolWindow(): string | undefined {
  const id = activeToolWindow();
  return id && isToolWindowVisible(id) ? id : undefined;
}

/** Puts the keyboard focus back into the active editor (falls back to the editor island itself). */
function focusEditorArea(): void {
  const area = document.querySelector<HTMLElement>("[data-editor-area]");
  const target =
    area?.querySelector<HTMLElement>(".dg-editor-view:not(.dg-hidden) .cm-content, .dg-editor-view:not(.dg-hidden) .dgg") ?? area;
  target?.focus({ preventScroll: true });
}
