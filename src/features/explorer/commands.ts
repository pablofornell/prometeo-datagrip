/** Operations behind the explorer actions: open table / DDL / console tabs, copy, drop, disconnect, dialogs. */
import { createSignal } from "solid-js";
import {
  type DataSource,
  type Driver,
  type ObjectRef,
  closeSession,
  createConsole,
  deleteDataSource,
  disconnect,
  duplicateDataSource,
  executeCollect,
  getDdl,
  listConsoles,
  listDataSources,
  openSession,
  saveDataSource,
  writeConsole,
} from "../../api/db";
import { type MenuItem, notify, openMenu } from "../../components/ui";
import { getAction, isActionEnabled, runAction } from "../../state/actions";
import { openTab, removeTab, tabs } from "../../state/tabs";
import {
  ensureConnected,
  controller,
  dataSources,
  dsName,
  dsOf,
  markDisconnected,
  nodes,
  refreshNode,
  reloadDataSources,
  selectedNode,
} from "./core";
import { type ENode, type NodeData, TABLE_CHILD, TABLE_LIKE, ddlRefOf, referenceOf, tabIconOf, tableRefOf } from "./model";
import { canRenameNode, renameSqlOf } from "./rename";
import { confirmEndTransactions } from "../console/txguard";
import { reconnectsOnSave } from "../datasource/model";
import { forgetVisibleSchemas } from "../../state/schema-filter";
import { parseDataSourceUrl } from "../datasource/urlParse";
import { addDsFolder, forgetDsGroup, moveToDsFolder, removeDsFolder, renameDsFolder } from "../../state/ds-folders";

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");
const fail = (title: string, e: unknown): void => {
  notify({ kind: "error", title, body: errText(e) });
};

// ---------------------------------------------------------------- tabs

export async function openTable(d: NodeData | undefined): Promise<void> {
  const ref = d && tableRefOf(d);
  if (d && ref) await openTableRef(d.dsId, ref);
}

/** Opens the data editor tab of a table / view given by reference (explorer nodes and names in the SQL editor). */
export async function openTableRef(dsId: string, ref: ObjectRef): Promise<void> {
  try {
    await ensureConnected(dsId);
  } catch (e) {
    return fail(`Connection to ${dsName(dsId)} failed`, e);
  }
  openTab({
    id: `table:${dsId}:${ref.schema ?? ""}.${ref.name}`,
    kind: "table",
    title: `${ref.name} [${dsName(dsId)}]`,
    icon: tabIconOf(ref.kind),
    data: { dsId, objectRef: ref },
  });
}

export async function openDdl(d: NodeData | undefined): Promise<void> {
  const ref = d && ddlRefOf(d);
  if (d && ref) await openDdlRef(d.dsId, ref);
}

/** Opens the DDL tab of an object given by reference; `column` puts the caret on that column's definition. */
export async function openDdlRef(dsId: string, ref: ObjectRef, column?: string): Promise<void> {
  try {
    await ensureConnected(dsId);
  } catch (e) {
    return fail(`Connection to ${dsName(dsId)} failed`, e);
  }
  openTab({
    id: `ddl:${dsId}:${ref.schema ?? ""}.${ref.name}${ref.signature != null ? `(${ref.signature})` : ""}`,
    kind: "ddl",
    title: `${ref.name} (DDL) [${dsName(dsId)}]`,
    icon: tabIconOf(ref.kind),
    data: { dsId, objectRef: ref, ...(column ? { column } : {}) },
  });
}

export function openConsoleTab(dsId: string, consoleName: string): void {
  openTab({
    id: `console:${dsId}:${consoleName}`,
    kind: "console",
    title: `${consoleName} [${dsName(dsId)}]`,
    icon: "dg/console",
    data: { dsId, consoleName },
  });
}

/** The data source the user means: the selected node's, the only one, or one picked from a popup. */
function pickDataSource(): Promise<string | undefined> {
  const sel = selectedNode();
  if (sel) return Promise.resolve(sel.data.dsId);
  const list = dataSources();
  if (list.length === 0) {
    notify({ kind: "info", title: "No data sources", body: "Create a data source first (Data Sources… Ctrl+Alt+Shift+S)." });
    return Promise.resolve(undefined);
  }
  if (list.length === 1) return Promise.resolve(list[0].id);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v?: string) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    openMenu(
      list.map<MenuItem>((ds) => ({ label: ds.name, icon: "dg/dbms", run: () => finish(ds.id) })),
      { ...popupPos(), title: "Data Sources", compact: true, onClose: () => setTimeout(() => finish(undefined), 0) },
    );
  });
}

function popupPos(): { x: number; y: number } {
  const r = document.querySelector(".dg-explorer-tree")?.getBoundingClientRect();
  return { x: (r?.left ?? 0) + 24, y: (r?.top ?? 0) + 40 };
}

/** New Query Console (Ctrl+Shift+Q) on the selected / only / chosen data source. */
export async function newConsole(dsId?: string): Promise<void> {
  const id = dsId ?? (await pickDataSource());
  if (!id) return;
  try {
    await ensureConnected(id);
    openConsoleTab(id, await createConsole(id));
  } catch (e) {
    fail("Cannot create a query console", e);
  }
}

/** Jump to Query Console… (Ctrl+Shift+F10): the existing consoles of the data source, or a new one. */
export async function jumpToConsole(dsId?: string): Promise<void> {
  const id = dsId ?? (await pickDataSource());
  if (!id) return;
  try {
    const names = await listConsoles(id);
    if (names.length === 0) return newConsole(id);
    if (names.length === 1) {
      await ensureConnected(id);
      return openConsoleTab(id, names[0]);
    }
    const items: MenuItem[] = [
      ...names.map<MenuItem>((n) => ({
        label: `${n} [${dsName(id)}]`,
        icon: "dg/console",
        run: () => void ensureConnected(id).then(() => openConsoleTab(id, n), (e) => fail("Cannot connect", e)),
      })),
      { type: "separator" },
      { label: "New Query Console", icon: "add", shortcut: "Ctrl+Shift+Q", run: () => void newConsole(id) },
    ];
    openMenu(items, { ...popupPos(), title: "Query Consoles", compact: true });
  } catch (e) {
    fail("Cannot list the query consoles", e);
  }
}

// ---------------------------------------------------------------- clipboard / DDL

export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through to the legacy path (insecure context, webview without permission) */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

export const copyReference = (d: NodeData | undefined) => d && void writeClipboard(referenceOf(d));
export const copyName = (d: NodeData | undefined) => d && void writeClipboard(d.name);

async function ddlText(d: NodeData): Promise<string | undefined> {
  const ref = ddlRefOf(d);
  if (!ref) return undefined;
  try {
    await ensureConnected(d.dsId);
    return await getDdl(d.dsId, ref);
  } catch (e) {
    fail("Cannot generate the DDL", e);
    return undefined;
  }
}

export async function copyDdl(d: NodeData | undefined): Promise<void> {
  const text = d && (await ddlText(d));
  if (text !== undefined) await writeClipboard(text);
}

export async function ddlToConsole(d: NodeData | undefined): Promise<void> {
  const text = d && (await ddlText(d));
  if (!d || text === undefined) return;
  try {
    const name = await createConsole(d.dsId);
    await writeConsole(d.dsId, name, text);
    openConsoleTab(d.dsId, name);
  } catch (e) {
    fail("Cannot create a query console", e);
  }
}

// ---------------------------------------------------------------- data source operations

/** Opens the Data Sources dialog (feature `datasource`) on a data source: `db.properties` takes the id as context. */
export function dataSourceProperties(dsId: string | undefined): void {
  if (dsId && getAction("db.properties")?.run) void runAction("db.properties", dsId);
  else void runAction("db.dataSources");
}

/** Opens the dialog with a new data source of the DBMS selected (`db.newDataSource.<dbms>` actions). */
export function newDataSource(dbms: Driver | "mariadb"): void {
  void runAction("db.newDataSource." + dbms);
}

/** Whether the dialog is available (its actions are registered by the `datasource` feature). */
export const dataSourceDialogAvailable = (): boolean => isActionEnabled(getAction("db.properties") ?? getAction("db.dataSources"));

export async function deactivate(dsId: string | undefined): Promise<void> {
  if (!dsId) return;
  if (!(await confirmEndTransactions({ dsId, reason: "deactivating the data source" }))) return;
  try {
    await disconnect(dsId);
  } catch (e) {
    return fail("Cannot disconnect", e);
  }
  markDisconnected(dsId);
}

export async function duplicateDs(dsId: string): Promise<void> {
  try {
    await duplicateDataSource(dsId);
    await reloadDataSources();
  } catch (e) {
    fail("Cannot duplicate the data source", e);
  }
}

// ---------------------------------------------------------------- confirmations (Drop, Remove Data Source)

export type DialogState =
  | { kind: "drop"; node: ENode; sql: string; what: string }
  | { kind: "rename"; node: ENode; sql: string; what: string; newName: string }
  | { kind: "removeDs"; ds: DataSource }
  /** One text field (new folder name...). `accept` returns an error text to keep the dialog open, or null when done. */
  | { kind: "prompt"; title: string; label: string; value: string; width?: number; accept: (v: string) => string | null };

export const [dialog, setDialog] = createSignal<DialogState | null>(null);

const quote = (driver: Driver, s: string) => (driver === "mysql" ? "`" + s.replace(/`/g, "``") + "`" : '"' + s.replace(/"/g, '""') + '"');

/** The statement behind "Drop…" for a node, or null if the node cannot be dropped. */
export function dropSqlOf(d: NodeData): string | null {
  const q = (s: string) => quote(d.driver, s);
  const ex = d.extra;
  const qn = (name: string) => (ex.schema ? `${q(ex.schema)}.${q(name)}` : q(name));
  const qt = ex.table ? qn(ex.table) : "";
  const pg = d.driver === "postgres";
  const my = d.driver === "mysql";
  if (d.driver === "oracle") {
    const alterT = (what: string) => `ALTER TABLE ${qt} ${what}`;
    switch (d.kind) {
      case "table":
        return `DROP TABLE ${qn(d.name)}`;
      case "view":
        return `DROP VIEW ${qn(d.name)}`;
      case "materializedView":
        return `DROP MATERIALIZED VIEW ${qn(d.name)}`;
      case "sequence":
        return `DROP SEQUENCE ${qn(d.name)}`;
      case "package":
        return `DROP PACKAGE ${qn(d.name)}`;
      case "synonym":
        return `DROP SYNONYM ${qn(d.name)}`;
      case "function":
        return `DROP FUNCTION ${qn(d.name)}`;
      case "procedure":
        return `DROP PROCEDURE ${qn(d.name)}`;
      case "routine":
        return `DROP ${ex.routineType === "PROCEDURE" ? "PROCEDURE" : "FUNCTION"} ${qn(d.name)}`;
      case "index":
        return `DROP INDEX ${qn(d.name)}`;
      case "trigger":
        return `DROP TRIGGER ${qn(d.name)}`;
      case "column":
        return alterT(`DROP COLUMN ${q(d.name)}`);
      case "primaryKey":
      case "uniqueKey":
      case "foreignKey":
      case "check":
        return alterT(`DROP CONSTRAINT ${q(d.name)}`);
      default:
        return null; // a schema is a user: creating and dropping it is an administrator's job
    }
  }
  switch (d.kind) {
    case "table":
      return `DROP TABLE ${qn(d.name)}`;
    case "view":
      return `DROP VIEW ${qn(d.name)}`;
    case "materializedView":
      return pg ? `DROP MATERIALIZED VIEW ${qn(d.name)}` : null;
    case "sequence":
      return pg ? `DROP SEQUENCE ${qn(d.name)}` : null;
    case "function":
    case "procedure":
    case "routine": {
      const w = d.kind === "procedure" || ex.routineType === "PROCEDURE" ? "PROCEDURE" : "FUNCTION";
      return pg ? `DROP ${w} ${qn(d.name)}(${ex.signature ?? ""})` : my ? `DROP ${w} ${qn(d.name)}` : null;
    }
    case "schema":
      return pg ? `DROP SCHEMA ${q(d.name)}` : my ? `DROP DATABASE ${q(d.name)}` : null;
    case "index":
      return my ? `DROP INDEX ${q(d.name)} ON ${qt}` : `DROP INDEX ${qn(d.name)}`;
    case "trigger":
      return pg ? `DROP TRIGGER ${q(d.name)} ON ${qt}` : `DROP TRIGGER ${qn(d.name)}`;
    case "column":
      return `ALTER TABLE ${qt} DROP COLUMN ${q(d.name)}`;
    case "primaryKey":
      return pg ? `ALTER TABLE ${qt} DROP CONSTRAINT ${q(d.name)}` : my ? `ALTER TABLE ${qt} DROP PRIMARY KEY` : null;
    case "uniqueKey":
      return pg ? `ALTER TABLE ${qt} DROP CONSTRAINT ${q(d.name)}` : my ? `ALTER TABLE ${qt} DROP INDEX ${q(d.name)}` : null;
    case "foreignKey":
      return pg ? `ALTER TABLE ${qt} DROP CONSTRAINT ${q(d.name)}` : my ? `ALTER TABLE ${qt} DROP FOREIGN KEY ${q(d.name)}` : null;
    case "check":
      return pg ? `ALTER TABLE ${qt} DROP CONSTRAINT ${q(d.name)}` : my ? `ALTER TABLE ${qt} DROP CHECK ${q(d.name)}` : null;
    default:
      return null;
  }
}

const KIND_WORD: Partial<Record<NodeData["kind"], string>> = {
  table: "table",
  view: "view",
  materializedView: "materialized view",
  package: "package",
  synonym: "synonym",
  sequence: "sequence",
  function: "function",
  procedure: "procedure",
  routine: "routine",
  schema: "schema",
  index: "index",
  trigger: "trigger",
  column: "column",
  primaryKey: "key",
  uniqueKey: "key",
  foreignKey: "foreign key",
  check: "check",
};

/** "Drop…" / "Remove Data Source…" on a node: opens the confirmation dialog. */
export function requestDrop(n: ENode | undefined): void {
  if (!n) return;
  const d = n.data;
  if (d.kind === "dataSource") {
    const ds = dsOf(d.dsId);
    if (ds) setDialog({ kind: "removeDs", ds });
    return;
  }
  const sql = dropSqlOf(d);
  if (!sql) return;
  setDialog({ kind: "drop", node: n, sql, what: `${KIND_WORD[d.kind] ?? d.kind} '${referenceOf(d)}'` });
}

export const canDrop = (n: ENode | undefined): boolean => !!n && (n.data.kind === "dataSource" || dropSqlOf(n.data) !== null);

/** Runs one DDL statement on a session of its own. Throws the server message. */
async function runDdl(dsId: string, sql: string): Promise<void> {
  let session: string | undefined;
  try {
    await ensureConnected(dsId);
    session = await openSession(dsId);
    const events = await executeCollect(session, sql);
    const err = events.find((e) => e.kind === "error");
    if (err && err.kind === "error") throw new Error(err.message);
  } finally {
    if (session) void closeSession(session).catch(() => {});
  }
}

/** Reloads the container of a node after DDL (the folder of the object sits one level below the schema). */
function refreshContainerOf(d: NodeData): ENode | undefined {
  const parent = d.parentId ? nodes.get(d.parentId) : undefined;
  const target = (parent && parent.data.kind === "folder" && parent.data.parentId ? nodes.get(parent.data.parentId) : parent) ?? parent;
  if (target) refreshNode(target.id);
  return target;
}

export async function confirmDrop(s: Extract<DialogState, { kind: "drop" }>): Promise<void> {
  const d = s.node.data;
  setDialog(null);
  try {
    await runDdl(d.dsId, s.sql);
  } catch (e) {
    fail(`Cannot drop ${s.what}`, e);
    return;
  }
  const target = refreshContainerOf(d);
  controller()?.select(target?.id ?? null);
}

// ---------------------------------------------------------------- rename (Shift+F6)

/** Id of the node whose label is being edited in place (the tree row shows a text field). */
export const [renaming, setRenaming] = createSignal<string | null>(null);

export const canRename = (n: ENode | undefined): boolean => !!n && n.data.kind !== "loading" && n.data.kind !== "error" && canRenameNode(n.data);

/** Shift+F6: edit the name of the node in the tree. */
export function startRename(n: ENode | undefined): void {
  if (!n || !canRename(n)) return;
  controller()?.select(n.id, { reveal: true });
  setRenaming(n.id);
}

export function cancelRename(): void {
  setRenaming(null);
  controller()?.focus();
}

/** Enter in the inline editor: a data source is renamed at once, any other object asks first (the dialog shows the SQL). */
export async function commitRename(n: ENode, text: string): Promise<void> {
  const name = text.trim();
  setRenaming(null);
  controller()?.focus();
  const d = n.data;
  if (!name || name === d.name) return;
  if (d.kind === "dataSource") {
    try {
      await updateDataSource(d.dsId, (c) => ({ ...c, name }));
    } catch (e) {
      fail("Cannot rename the data source", e);
    }
    return;
  }
  const sql = renameSqlOf(d, name);
  if (!sql) return;
  setDialog({ kind: "rename", node: n, sql, newName: name, what: `${KIND_WORD[d.kind] ?? d.kind} '${referenceOf(d)}'` });
}

export async function confirmRename(s: Extract<DialogState, { kind: "rename" }>): Promise<void> {
  const d = s.node.data;
  setDialog(null);
  try {
    await runDdl(d.dsId, s.sql);
  } catch (e) {
    fail(`Cannot rename ${s.what}`, e);
    return;
  }
  const target = refreshContainerOf(d);
  controller()?.select(target?.id ?? null);
}

/**
 * Saves a change to the stored configuration of a data source, then reloads the explorer. The password is kept.
 * A change the backend answers with a reconnect (anything but the name / color) first asks about open transactions;
 * resolves false when the user cancelled. View settings (the schema filter) do not belong here: `saveVisibleSchemas`.
 */
export async function updateDataSource(dsId: string, change: (cfg: Omit<DataSource, "hasPassword" | "passwordStorage">) => Omit<DataSource, "hasPassword" | "passwordStorage">): Promise<boolean> {
  // the saved copy: another window or the dialog may have changed it meanwhile
  const cur = (await listDataSources()).find((x) => x.id === dsId) ?? dsOf(dsId);
  if (!cur) return true;
  const { hasPassword: _h, passwordStorage: _p, ...cfg } = cur;
  const next = change(cfg);
  if (reconnectsOnSave(cfg, next) && !(await confirmEndTransactions({ dsId, reason: "reconnecting with the new settings" }))) return false;
  await saveDataSource(next);
  window.dispatchEvent(new CustomEvent("prometeo:datasources-changed"));
  await reloadDataSources();
  return true;
}

export async function confirmRemoveDs(ds: DataSource): Promise<void> {
  setDialog(null);
  if (!(await confirmEndTransactions({ dsId: ds.id, reason: "removing the data source" }))) return;
  try {
    await deleteDataSource(ds.id);
    forgetVisibleSchemas(ds.id);
    forgetDsGroup(ds.id);
  } catch (e) {
    return fail("Cannot remove the data source", e);
  }
  for (const t of tabs()) if ((t.data as { dsId?: string } | undefined)?.dsId === ds.id) removeTab(t.id);
  markDisconnected(ds.id);
  await reloadDataSources();
}

export const isTableLike = (n: ENode | undefined) => !!n && TABLE_LIKE.includes(n.data.kind);
export const isTableRelated = (n: ENode | undefined) => !!n && (TABLE_LIKE.includes(n.data.kind) || TABLE_CHILD.includes(n.data.kind));

// ---------------------------------------------------------------- data source folders

/** New > Folder: asks for the name. With `thenMove` the data source goes into the new folder (Move > New Folder…). */
export function newFolder(thenMove?: string): void {
  setDialog({
    kind: "prompt",
    title: "New Folder",
    label: "Name:",
    value: "",
    accept: (v) => {
      const name = addDsFolder(v);
      if (!name) return v.trim() ? `Folder "${v.trim()}" already exists` : "Name is empty";
      if (thenMove) moveToDsFolder(thenMove, name);
      return null;
    },
  });
}

export function renameFolder(name: string): void {
  setDialog({
    kind: "prompt",
    title: "Rename Folder",
    label: "Name:",
    value: name,
    accept: (v) => (v.trim() === name || renameDsFolder(name, v) ? null : v.trim() ? `Folder "${v.trim()}" already exists` : "Name is empty"),
  });
}

export const removeFolder = (name: string): void => removeDsFolder(name);
export const moveDataSource = (dsId: string, folder: string | null): void => moveToDsFolder(dsId, folder);

/** New > Data Source from URL: a connection URL or the path of a SQLite file fills in a new data source. */
export function newDataSourceFromUrl(): void {
  setDialog({
    kind: "prompt",
    title: "Data Source from URL",
    label: "URL:",
    value: "",
    width: 520,
    accept: (v) => {
      const p = parseDataSourceUrl(v);
      if (!p) return v.trim() ? "Unsupported URL. Use jdbc:postgresql://host:port/db, mysql://..., jdbc:oracle:thin:@//host:port/service, or the path of a SQLite file." : "URL is empty";
      void runAction("db.newDataSourceFromUrl", p);
      return null;
    },
  });
}

/** New > Driver: the Drivers page of the Data Sources dialog. */
export const openDrivers = (): void => void runAction("db.drivers");
