/**
 * Main menu structure (only operative items), laid out like DataGrip's: File Edit View Navigate Run Window Help.
 * Every entry points at an action id from the registry (src/state/core-actions.ts, edit-actions.ts, feature
 * modules). `optional` entries belong to features other modules own: they are left out while no module has
 * registered the action, and appear on their own once it does. `mnemonic` letters are underlined in the bar.
 */
import { openLogFolder } from "../../api/tauri";
import { selectedNode } from "../../features/explorer/core";
import { importTargetOf } from "../../features/import/target";
import { runAction } from "../../state/actions";
import { toolWindowMenuItems } from "../../state/layout";
import { notify } from "../ui";
import type { MenuItem } from "../ui/Menu";

const sep: MenuItem = { type: "separator" };

/** Registry item with a mnemonic letter. */
const a = (action: string, mnemonic?: string, extra: Partial<Extract<MenuItem, { action?: string }>> = {}): MenuItem => ({ action, mnemonic, ...extra });
/** Same, but only present once the action is registered. */
const opt = (action: string, mnemonic?: string, extra: Partial<Extract<MenuItem, { action?: string }>> = {}): MenuItem => ({ action, mnemonic, optional: true, ...extra });
const sub = (label: string, mnemonic: string | undefined, children: MenuItem[], extra: Partial<Extract<MenuItem, { action?: string }>> = {}): MenuItem => ({ label, mnemonic, children, ...extra });

/** Import Data from File(s)…: runs `import.file` on the table / schema selected in the explorer. */
const importTarget = () => {
  const n = selectedNode();
  return n ? importTargetOf(n.data) : null;
};
const importItem = (): MenuItem => ({
  action: "import.file",
  mnemonic: "I",
  optional: true,
  label: "Import Data from File(s)…",
  enabled: () => !!importTarget(),
  run: () => {
    const t = importTarget();
    if (t) void runAction("import.file", t);
  },
});

export interface MenuBarEntry {
  label: string;
  /** Letter underlined in the bar; Alt+<letter> opens the menu. */
  mnemonic: string;
  items: MenuItem[];
}

export const MAIN_MENU: MenuBarEntry[] = [
  {
    label: "File",
    mnemonic: "F",
    items: [
      sub("New", "N", [a("db.newConsole", "Q"), opt("db.newDataSource", "D"), opt("file.newScratch", "S")]),
      opt("file.open", "O"),
      sep,
      a("app.settings", "t"),
      a("db.dataSources", "D"),
      sub("Manage IDE Settings", "M", [a("app.exportSettings", "E"), a("app.importSettings", "I")]),
      sep,
      opt("file.saveAll", "l"),
      opt("file.reload", "R"),
      sep,
      opt("grid.export", "E"),
      sep,
      a("app.exit", "x"),
    ],
  },
  {
    label: "Edit",
    mnemonic: "E",
    items: [
      a("edit.undo", "U"),
      a("edit.redo", "R"),
      sep,
      a("edit.cut", "t"),
      a("edit.copy", "C"),
      a("db.copyReference", "y", { label: "Copy Path/Reference…" }),
      a("edit.paste", "P"),
      a("edit.delete", "D"),
      sub("Selection", "S", [a("edit.selectAll", "A")]),
      sep,
      a("edit.find", "F"),
      a("edit.replace", "e"),
      sep,
      a("code.reformat", "o"),
      a("code.comment", "L"),
      a("code.commentBlock", "B"),
      sep,
      sub("Refactor", undefined, [a("db.rename", "R"), opt("db.modifyObject", "M")]),
      sep,
      a("edit.toggleCase", "g"),
      a("edit.joinLines", "J"),
      a("edit.duplicateLines", "i"),
      a("edit.sortLines", "n"),
    ],
  },
  {
    label: "View",
    mnemonic: "V",
    items: [
      sub("Tool Windows", "T", toolWindowMenuItems()),
      sub("Appearance", "A", [a("theme.system"), a("theme.dark"), a("theme.light")]),
      sep,
      opt("nav.recentFiles", "F"),
      sep,
      a("view.fontIncrease", "I"),
      a("view.fontDecrease", "D"),
      a("view.fontReset", "R"),
    ],
  },
  {
    label: "Navigate",
    mnemonic: "N",
    items: [
      a("nav.back", "B"),
      a("nav.forward", "F"),
      sep,
      a("nav.searchEverywhere", "S"),
      sep,
      a("nav.gotoObject", "D", { label: "Database Object…" }),
      opt("nav.gotoFile", "i", { label: "File…" }),
      opt("nav.gotoText", "T", { label: "Text…" }),
      sep,
      a("db.gotoDdl", "G"),
      a("db.editData", "E"),
      opt("diagram.show"),
      a("explorer.locate", "O", { label: "Scroll from Editor" }),
    ],
  },
  {
    label: "Run",
    mnemonic: "R",
    items: [
      a("sql.execute", "E"),
      a("sql.executeScript", "S"),
      a("sql.explainPlan", "P"),
      a("sql.explainAnalyse", "A"),
      a("sql.cancel", "C"),
      a("grid.export", "x", { label: "Export Data to File" }),
      sep,
      a("sql.commit", "m"),
      a("sql.rollback", "R"),
      sep,
      a("sql.history", "H"),
      opt("run.file", "F", { label: "Run File" }), // DataGrip: Run '<file>' Ctrl+Shift+F10; Jump to Query Console lives in the explorer's toolbar and menus
      opt("run.chooseConfiguration", "u"),
      opt("run.sqlScript", "q"),
      opt("run.editConfigurations", "g"),
      sep,
      importItem(),
    ],
  },
  {
    label: "Window",
    mnemonic: "W",
    items: [
      sub("Layouts", "L", [a("window.resetLayout", "R")]),
      sub("Active Tool Window", "A", [
        a("toolwindow.hideActive", "H"),
        opt("toolwindow.maximize", "M"),
        a("toolwindow.hideAll", "A"),
        sub("Move To", "o", [opt("toolwindow.moveTo.left", "L"), opt("toolwindow.moveTo.right", "R"), opt("toolwindow.moveTo.bottom", "B")]),
        sub("Resize", "z", [
          opt("toolwindow.stretch.left", "L"),
          opt("toolwindow.stretch.right", "R"),
          opt("toolwindow.stretch.top", "T"),
          opt("toolwindow.stretch.bottom", "B"),
        ]),
      ]),
      sub("Editor Tabs", "T", [
        opt("editor.splitRight", "R"),
        opt("editor.splitDown", "D"),
        opt("editor.unsplit", "U"),
        sep,
        a("tab.close", "C"),
        a("tab.closeOthers", "O"),
        a("tab.closeAll", "A"),
        opt("tab.reopen", "e"),
        sep,
        a("tab.next", "N"),
        a("tab.prev", "P"),
      ]),
      sub("Notifications", "N", [opt("notifications.menu", "S", { label: "Show All" }), opt("notifications.expireAll", "E", { label: "Expire All" })]),
    ],
  },
  {
    label: "Help",
    mnemonic: "H",
    items: [
      a("nav.findAction", "F"),
      sep,
      {
        label: "Open Log Folder",
        mnemonic: "L",
        run: () =>
          void openLogFolder().catch((e) =>
            notify({ kind: "error", title: "Cannot open the log folder", body: String((e as Error)?.message ?? e) }),
          ),
      },
      sep,
      a("help.about", "A"),
    ],
  },
];

/** Gear (Settings) menu in the main toolbar. */
export const GEAR_MENU: MenuItem[] = [
  a("app.settings"),
  sep,
  a("app.themePopup"),
  a("app.keymapPopup"),
  sep,
  a("window.resetLayout"),
];
