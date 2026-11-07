/**
 * Registry actions of the explorer (menus, toolbar buttons and shortcuts all go through them) and the
 * context menu structure. Actions work on the selected node; right click selects before the menu opens.
 */
import { type MenuItem, openMenu } from "../../components/ui";
import { type Action, registerActions, runAction } from "../../state/actions";
import { COLORS, swatch } from "../datasource/widgets";
import {
  canDrop,
  canRename,
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
  moveDataSource,
  newConsole,
  newDataSource,
  newDataSourceFromUrl,
  newFolder,
  openDdl,
  openDrivers,
  openTable,
  removeFolder,
  renameFolder,
  requestDrop,
  startRename,
  updateDataSource,
} from "./commands";
import { showQuickDoc } from "./QuickDoc";
import { importTargetOf } from "../import/target";
import { canModify, modifyObject, newObjectOf, newObjectTypes, newTable } from "../schema-editor";
import {
  connected,
  controller,
  dataSources,
  expandAllLoaded,
  isDsFolder,
  refreshSelected,
  revealObject,
  selectedNode,
  colorOfNode,
  setNodeColor,
} from "./core";
import { type ENode, ddlRefOf, tableRefOf } from "./model";
import { LOCAL, localIconUrl, providerIcon } from "./icons";
import { dsFolders, dsGroupOf } from "../../state/ds-folders";
import { activeTab } from "../../state/tabs";
import { theme } from "../../state/theme";

const sep: MenuItem = { type: "separator" };

/** Keyboard focus is inside the explorer tree (guard for the shortcuts that other tool windows also use). */
export const explorerFocused = (): boolean => !!(document.activeElement as HTMLElement | null)?.closest?.(".dg-explorer-tree");

const sel = (): ENode | undefined => selectedNode();
const real = (n: ENode | undefined): n is ENode => !!n && n.data.kind !== "loading" && n.data.kind !== "error" && !isDsFolder(n);

export const DRIVERS = [
  { driver: "mariadb", label: "MariaDB" },
  { driver: "mysql", label: "MySQL" },
  { driver: "oracle", label: "Oracle" },
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
      enabled: () => canDrop(sel()) || isDsFolder(sel()),
      run: () => (isDsFolder(sel()) ? removeFolder(sel()!.data.name) : requestDrop(sel())),
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
    {
      id: "db.rename",
      title: "Rename…",
      shortcut: "Shift+F6",
      when: explorerFocused,
      enabled: () => canRename(sel()) || isDsFolder(sel()),
      run: () => (isDsFolder(sel()) ? renameFolder(sel()!.data.name) : startRename(sel())),
    },
    {
      id: "db.quickDoc",
      title: "Quick Documentation",
      shortcut: "Ctrl+Q",
      when: explorerFocused,
      enabled: () => real(sel()),
      run: () => showQuickDoc(sel()),
    },
    { id: "db.copyName", title: "Copy Name", enabled: () => real(sel()), run: () => copyName(sel()?.data) },
    {
      id: "db.copyDdl",
      title: "Generate DDL to Clipboard",
      shortcut: ["Ctrl+Alt+Shift+G", "Ctrl+Shift+C"],
      when: explorerFocused,
      enabled: () => {
        const n = sel();
        return real(n) && !!ddlRefOf(n.data);
      },
      run: () => copyDdl(sel()?.data),
    },
    {
      id: "db.ddlToConsole",
      title: "Generate DDL to Query Console",
      shortcut: "Ctrl+Alt+Shift+B",
      when: explorerFocused,
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
    {
      id: "db.modifyObject",
      title: "Modify Object…",
      shortcut: "Ctrl+F6",
      when: explorerFocused,
      enabled: () => canModify(sel()),
      run: () => void modifyObject(sel()),
    },
    {
      id: "db.new",
      title: "New",
      shortcut: "Alt+Insert",
      when: explorerFocused,
      enabled: () => !!sel(),
      run: () => openNewPopup(sel()),
    },
    { id: "explorer.locate", title: "Select Opened Object", shortcut: "Alt+Shift+B", icon: "locate", run: () => locateOpened() },
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
  return [
    dataSourceItem(),
    { label: "Data Source from URL", icon: "dg/dbms", run: newDataSourceFromUrl },
    sep,
    { label: "Folder", icon: "folder", run: () => newFolder() },
    { label: "Driver", icon: "dg/dbms", run: openDrivers },
    sep,
    { action: "db.newConsole", label: "Query Console" },
  ];
}

/** Table / View / Sequence / Schema ... of the New submenu: each opens its create dialog. */
function objectItems(n: ENode | undefined): MenuItem[] {
  const types = newObjectTypes(n);
  return types.length
    ? [
        sep,
        ...types.map<MenuItem>((t) => ({ label: t.label, icon: t.icon, run: () => void (t.kind === "table" ? newTable(n) : newObjectOf(t.kind, n)) })),
      ]
    : [];
}

const newChildren = (n?: ENode): MenuItem[] => [{ action: "db.newConsole", label: "Query Console" }, ...objectItems(n), sep, dataSourceItem()];

const newSub = (n?: ENode): MenuItem => ({ label: "New", icon: "add", children: newChildren(n) });

/** Alt+Insert: the New popup at the selected row. */
function openNewPopup(n: ENode | undefined): void {
  const row = document.querySelector<HTMLElement>(".dg-explorer-tree .dg-tree-row.dg-selected");
  const r = row?.getBoundingClientRect();
  openMenu(newChildren(real(n) ? n : undefined), {
    x: (r?.left ?? 0) + 60,
    y: (r?.bottom ?? 120) + 2,
    title: "New",
    compact: true,
    minWidth: 260,
    selected: 0,
  });
}

/** `Modify Table…` / `Modify Schema…` / `Modify Column…` after `New ›`. */
function modifyItem(n: ENode): MenuItem[] {
  if (!canModify(n)) return [];
  const k = n.data.kind;
  const what = k === "table" ? "Table" : k === "schema" ? "Schema" : { column: "Column", index: "Index", foreignKey: "Foreign Key", check: "Check", primaryKey: "Key", uniqueKey: "Key" }[k as string] ?? "Table";
  return [{ action: "db.modifyObject", label: `Modify ${what}…` }];
}

/** `Set Color ›`: a data source keeps its color in its configuration, schemas / tables in the explorer state. */
function setColorItem(n: ENode): MenuItem {
  const own = (): string | undefined => (n.data.kind === "dataSource" ? (dataSources().find((d) => d.id === n.data.dsId)?.color ?? undefined) : colorOfNode(n));
  const set = (color: string | null) => {
    if (n.data.kind !== "dataSource") return setNodeColor(n.id, color);
    void updateDataSource(n.data.dsId, (c) => ({ ...c, color }));
  };
  const same = (c: string) => own()?.toLowerCase() === c.toLowerCase();
  const custom = () => {
    const input = document.createElement("input");
    input.type = "color";
    input.value = /^#[0-9a-f]{6}$/i.test(own() ?? "") ? own()! : "#3574f0";
    input.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    input.addEventListener("change", () => (set(input.value), input.remove()));
    input.addEventListener("cancel", () => input.remove());
    document.body.appendChild(input);
    input.click();
  };
  return {
    label: "Set Color",
    children: [
      { label: "No Color", checked: () => !own(), run: () => set(null) },
      sep,
      ...COLORS.map<MenuItem>((c) => ({ label: c.name, icon: swatch(c.value), checked: () => same(c.value), run: () => set(c.value) })),
      sep,
      { label: "Custom…", run: custom },
    ],
  };
}

const colorable = (n: ENode) => n.data.kind === "dataSource" || n.data.kind === "schema" || n.data.kind === "database" || isTableLike(n);

/** `Move ›` of a data source: the top level, the folders and `New Folder…`. */
function moveItem(n: ENode): MenuItem {
  const here = dsGroupOf(n.id);
  return {
    label: "Move",
    children: [
      { label: "(root)", checked: () => !here, run: () => moveDataSource(n.id, null) },
      ...dsFolders().map<MenuItem>((f) => ({ label: f, icon: "folder", checked: () => here === f, run: () => moveDataSource(n.id, f) })),
      sep,
      { label: "New Folder…", run: () => newFolder(n.id) },
    ],
  };
}

/** Context menu of a data source folder. */
function folderMenu(n: ENode): MenuItem[] {
  return [
    { label: "New", icon: "add", children: [{ label: "Folder", icon: "folder", run: () => newFolder() }, sep, dataSourceItem()] },
    sep,
    { label: "Rename…", mnemonic: "R", shortcut: "Shift+F6", run: () => renameFolder(n.data.name) },
    sep,
    { label: "Remove Folder", run: () => removeFolder(n.data.name) },
  ];
}

export function contextMenuItems(n: ENode | undefined): MenuItem[] {
  if (n && isDsFolder(n)) return folderMenu(n);
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

  /** SQL Scripts > Run SQL Script… (run configurations module): files are picked, the data source / schema is the target. */
  const runScript = (): MenuItem => ({
    label: "Run SQL Script…",
    icon: "run",
    run: () => void runAction("run.sqlScript", { dsId: d.dsId, schema: d.kind === "schema" ? d.name : undefined }),
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
      newSub(n),
      { label: "Copy/Paste", children: [{ action: "db.copyReference" }, { action: "db.duplicateDataSource" }] },
      { action: "db.refresh" },
      { action: "db.disconnect" },
      sep,
      { action: "db.rename", mnemonic: "R" },
      moveItem(n),
      setColorItem(n),
      sep,
      { action: "db.quickDoc", mnemonic: "D" },
      { label: "Navigation", children: [{ action: "db.jumpToConsole" }] },
      { label: "SQL Scripts", children: [runScript()] },
      sep,
      { label: "Remove Data Source…", shortcut: "Delete", run: () => requestDrop(n) },
    ];
  }

  const items: MenuItem[] = [newSub(n), ...modifyItem(n), { label: "Copy/Paste", children: [{ action: "db.copyReference" }, { action: "db.copyName" }] }];
  if (isTableLike(n)) items.push({ action: "db.editData" });
  items.push({ action: "db.refresh" });
  if (canRename(n)) items.push(sep, { action: "db.rename", mnemonic: "R" });
  if (colorable(n)) items.push(...(canRename(n) ? [] : [sep]), setColorItem(n));
  items.push(sep, { action: "db.quickDoc", mnemonic: "D" }, navigation());
  if (ddlRefOf(d)) {
    items.push(sep, {
      label: "SQL Scripts",
      children: [{ action: "db.copyDdl" }, { action: "db.ddlToConsole" }, ...(d.kind === "schema" ? [runScript()] : [])],
    });
  } else if (d.kind === "schema") {
    items.push(sep, { label: "SQL Scripts", children: [runScript()] });
  }
  const importTarget = importTargetOf(d);
  if (importTarget || isTableLike(n)) {
    const children: MenuItem[] = [];
    if (importTarget) children.push({ label: "Import Data from File…", icon: "import", run: () => void runAction("import.file", importTarget) });
    if (isTableLike(n)) children.push(exportItem());
    items.push({ label: "Import/Export", children });
  }
  if (canDrop(n)) items.push(sep, { label: "Drop…", shortcut: "Delete", run: () => requestDrop(n) });
  return items;
}

export function showContextMenu(n: ENode | undefined, e: MouseEvent): void {
  // DataGrip's context menu is about 340px wide
  // while the menu is open the right-clicked row shows the unfocused selection color (the tree keeps the focus)
  const tree = document.querySelector(".dg-explorer-tree");
  tree?.classList.add("dg-menu-open");
  openMenu(contextMenuItems(n), { x: e.clientX, y: e.clientY, minWidth: 340, mnemonics: true, onClose: () => tree?.classList.remove("dg-menu-open") });
}
