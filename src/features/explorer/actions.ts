/**
 * Registry actions of the explorer (menus, toolbar buttons and shortcuts all go through them) and the
 * context menu structure. Actions work on the selected node; right click selects before the menu opens.
 */
import { type MenuItem, openMenu } from "../../components/ui";
import { type Action, registerActions, runAction } from "../../state/actions";
import {
  canDrop,
  copyDdl,
  copyName,
  dataSourceDialogAvailable,
  copyReference,
  ddlToConsole,
  deactivate,
  dataSourceProperties,
  duplicateDs,
  isTableLike,
  isTableRelated,
  jumpToConsole,
  newConsole,
  newDataSource,
  openDdl,
  openTable,
  requestDrop,
} from "./commands";
import {
  connected,
  controller,
  dataSources,
  expandAllLoaded,
  refreshSelected,
  revealObject,
  selectedNode,
} from "./core";
import { type ENode, ddlRefOf, tableRefOf } from "./model";
import { LOCAL, localIconUrl, providerIcon } from "./icons";
import { activeTab } from "../../state/tabs";
import { theme } from "../../state/theme";

const sep: MenuItem = { type: "separator" };

/** Keyboard focus is inside the explorer tree (guard for the shortcuts that other tool windows also use). */
export const explorerFocused = (): boolean => !!(document.activeElement as HTMLElement | null)?.closest?.(".dg-explorer-tree");

const sel = (): ENode | undefined => selectedNode();
const real = (n: ENode | undefined): n is ENode => !!n && n.data.kind !== "loading" && n.data.kind !== "error";

export const DRIVERS = [
  { driver: "mariadb", label: "MariaDB" },
  { driver: "mysql", label: "MySQL" },
  { driver: "postgres", label: "PostgreSQL" },
  { driver: "sqlite", label: "SQLite" },
] as const;

// ---------------------------------------------------------------- locate (select the opened object)

export async function locateOpened(): Promise<void> {
  const t = activeTab();
  const data = t?.data as { dsId?: string; objectRef?: Parameters<typeof revealObject>[1] } | undefined;
  if (!data?.dsId) return;
  await revealObject(data.dsId, data.objectRef ?? null);
}

// ---------------------------------------------------------------- actions

export function registerExplorerActions(): () => void {
  const list: Action[] = [
    {
      id: "db.newConsole",
      title: "New Query Console",
      shortcut: "Ctrl+Shift+Q",
      icon: "dg/console",
      enabled: () => dataSources().length > 0,
      run: () => newConsole(),
    },
    {
      id: "db.jumpToConsole",
      title: "Jump to Query Console…",
      shortcut: "Ctrl+Shift+F10",
      icon: "dg/console",
      enabled: () => dataSources().length > 0,
      run: () => jumpToConsole(),
    },
    {
      id: "db.refresh",
      title: "Refresh",
      shortcut: "Ctrl+F5",
      icon: "refresh",
      when: explorerFocused,
      enabled: () => real(sel()),
      run: () => refreshSelected(),
    },
    {
      id: "db.disconnect",
      title: "Deactivate",
      shortcut: "Ctrl+F2",
      icon: "dg/kill-process",
      when: explorerFocused,
      enabled: () => {
        const n = sel();
        return !!n && connected().has(n.data.dsId);
      },
      run: () => deactivate(sel()?.data.dsId),
    },
    {
      id: "db.editData",
      title: "Edit Data",
      shortcut: "F4",
      icon: "dg/edit-data",
      when: explorerFocused,
      enabled: () => isTableRelated(sel()),
      run: () => openTable(sel()?.data),
    },
    {
      id: "db.gotoDdl",
      title: "Go to DDL",
      shortcut: "Ctrl+B",
      when: explorerFocused,
      enabled: () => {
        const n = sel();
        return real(n) && !!ddlRefOf(n.data);
      },
      run: () => openDdl(sel()?.data),
    },
    {
      id: "db.drop",
      title: "Drop…",
      shortcut: "Delete",
      when: explorerFocused,
      enabled: () => canDrop(sel()),
      run: () => requestDrop(sel()),
    },
    {
      id: "db.copyReference",
      title: "Copy Reference",
      shortcut: "Ctrl+Alt+Shift+C",
      icon: "copy",
      when: explorerFocused,
      enabled: () => real(sel()),
      run: () => copyReference(sel()?.data),
    },
    { id: "db.copyName", title: "Copy Name", enabled: () => real(sel()), run: () => copyName(sel()?.data) },
    {
      id: "db.copyDdl",
      title: "Generate DDL to Clipboard",
      enabled: () => {
        const n = sel();
        return real(n) && !!ddlRefOf(n.data);
      },
      run: () => copyDdl(sel()?.data),
    },
    {
      id: "db.ddlToConsole",
      title: "Generate DDL to Query Console",
      enabled: () => {
        const n = sel();
        return real(n) && !!ddlRefOf(n.data);
      },
      run: () => ddlToConsole(sel()?.data),
    },
    {
      id: "db.duplicateDataSource",
      title: "Duplicate",
      enabled: () => sel()?.data.kind === "dataSource",
      run: () => duplicateDs(sel()!.data.dsId),
    },
    { id: "explorer.locate", title: "Select Opened Object", icon: "locate", run: () => locateOpened() },
    { id: "explorer.expandAll", title: "Expand All", icon: "expand-all", run: () => expandAllLoaded() },
    { id: "explorer.collapseAll", title: "Collapse All", icon: "collapse-all", run: () => controller()?.collapseAll() },
  ];
  return registerActions(list);
}

// ---------------------------------------------------------------- menus

/** "Data Source >" submenu: the DBMS list with brand icons. */
export function driverItems(): MenuItem[] {
  return [
    { type: "header", label: "Complete Support" },
    ...DRIVERS.map<MenuItem>((d) => ({ label: d.label, icon: iconUrl(providerIcon(d.driver)), run: () => newDataSource(d.driver) })),
  ];
}

/** URL of an explorer-local icon for the current theme (menus take kit names or URLs). */
const iconUrl = (key: string): string | undefined => (key.startsWith(LOCAL) ? localIconUrl(key.slice(LOCAL.length), theme()) : key);

const dataSourceItem = (): MenuItem => ({ label: "Data Source", icon: "dg/dbms", children: driverItems() });

/** Items of the toolbar "+" popup. */
export function newMenuItems(): MenuItem[] {
  return [dataSourceItem(), sep, { action: "db.newConsole", label: "Query Console" }];
}

const newSub = (): MenuItem => ({
  label: "New",
  icon: "add",
  children: [{ action: "db.newConsole", label: "Query Console" }, sep, dataSourceItem()],
});

export function contextMenuItems(n: ENode | undefined): MenuItem[] {
  if (!real(n)) return [newSub()];
  const d = n.data;
  const navigation = (): MenuItem => ({
    label: "Navigation",
    children: [{ action: "db.gotoDdl" }, { action: "db.jumpToConsole" }],
  });
  const exportItem = (): MenuItem => ({
    label: "Export Data…",
    action: "grid.export",
    icon: "export",
    run: () => void runAction("grid.export", { dsId: d.dsId, objectRef: tableRefOf(d) }),
  });

  if (d.kind === "dataSource") {
    return [
      {
        label: "Properties",
        icon: "dg/manage-data-sources",
        shortcut: "Ctrl+Alt+Shift+S",
        enabled: () => dataSourceDialogAvailable(),
        run: () => dataSourceProperties(d.dsId),
      },
      sep,
      newSub(),
      { label: "Copy/Paste", children: [{ action: "db.copyReference" }, { action: "db.duplicateDataSource" }] },
      { action: "db.refresh" },
      { action: "db.disconnect" },
      sep,
      { label: "Navigation", children: [{ action: "db.jumpToConsole" }] },
      sep,
      { label: "Remove Data Source…", shortcut: "Delete", run: () => requestDrop(n) },
    ];
  }

  const items: MenuItem[] = [newSub(), { label: "Copy/Paste", children: [{ action: "db.copyReference" }, { action: "db.copyName" }] }];
  if (isTableLike(n)) items.push({ action: "db.editData" });
  items.push({ action: "db.refresh" }, sep, navigation());
  if (ddlRefOf(d)) {
    items.push(sep, {
      label: "SQL Scripts",
      children: [{ action: "db.copyDdl" }, { action: "db.ddlToConsole" }],
    });
  }
  if (isTableLike(n)) items.push({ label: "Import/Export", children: [exportItem()] });
  if (canDrop(n)) items.push(sep, { label: "Drop…", shortcut: "Delete", run: () => requestDrop(n) });
  return items;
}

export function showContextMenu(n: ENode | undefined, e: MouseEvent): void {
  openMenu(contextMenuItems(n), { x: e.clientX, y: e.clientY });
}
