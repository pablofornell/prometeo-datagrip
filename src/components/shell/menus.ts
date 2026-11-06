/**
 * Main menu structure (only operative items). Every entry points at an action id from the registry
 * (src/state/core-actions.ts); entries whose action has no implementation render disabled.
 */
import { TOOL_WINDOWS } from "../../state/layout";
import type { MenuItem } from "../ui/Menu";

const sep: MenuItem = { type: "separator" };

export interface MenuBarEntry {
  label: string;
  items: MenuItem[];
}

export const MAIN_MENU: MenuBarEntry[] = [
  {
    label: "File",
    items: [
      { action: "db.newConsole" },
      { action: "db.dataSources" },
      sep,
      { action: "tab.close" },
      { action: "tab.closeAll" },
      sep,
      { action: "app.settings" },
      sep,
      { action: "grid.export" },
      sep,
      { action: "app.exit" },
    ],
  },
  {
    label: "Edit",
    items: [
      { action: "edit.undo" },
      { action: "edit.redo" },
      sep,
      { action: "edit.cut" },
      { action: "edit.copy" },
      { action: "edit.paste" },
      { action: "edit.selectAll" },
      sep,
      { action: "edit.find" },
      { action: "edit.replace" },
    ],
  },
  {
    label: "View",
    items: [
      { label: "Tool Windows", children: TOOL_WINDOWS.map((t) => ({ action: "toolwindow." + t.id })) },
      { action: "toolwindow.hideActive" },
      { action: "toolwindow.hideAll" },
      sep,
      {
        label: "Appearance",
        children: [{ action: "theme.system" }, { action: "theme.dark" }, { action: "theme.light" }],
      },
    ],
  },
  {
    label: "Navigate",
    items: [
      { action: "nav.searchEverywhere" },
      { action: "nav.gotoObject" },
      { action: "db.gotoDdl" },
      { action: "db.editData" },
      sep,
      { action: "tab.next" },
      { action: "tab.prev" },
    ],
  },
  {
    label: "Code",
    items: [{ action: "code.complete" }, { action: "code.reformat" }, { action: "code.comment" }],
  },
  {
    label: "Tools",
    items: [
      { action: "sql.execute" },
      { action: "sql.cancel" },
      sep,
      { action: "sql.commit" },
      { action: "sql.rollback" },
      sep,
      { action: "sql.history" },
      { action: "db.jumpToConsole" },
      { action: "db.refresh" },
    ],
  },
  {
    label: "Window",
    items: [
      { action: "window.resetLayout" },
      sep,
      { action: "tab.next" },
      { action: "tab.prev" },
      { action: "tab.closeOthers" },
      sep,
      { action: "window.minimize" },
      { action: "window.maximize" },
    ],
  },
  {
    label: "Help",
    items: [{ action: "help.about" }],
  },
];

/** Gear (Settings) menu in the main toolbar. */
export const GEAR_MENU: MenuItem[] = [
  { action: "app.settings" },
  sep,
  {
    label: "Theme",
    children: [{ action: "theme.system" }, { action: "theme.dark" }, { action: "theme.light" }],
  },
  { action: "window.resetLayout" },
];
