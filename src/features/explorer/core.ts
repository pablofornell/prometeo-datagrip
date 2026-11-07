/**
 * Explorer core: data source list, lazy children loading (connect on expand, "Loading..." rows, error nodes),
 * refresh, reveal, persistence and the status-bar breadcrumbs. No UI here (see ExplorerBody.tsx).
 *
 * Children are loaded into the items themselves (`node.children`) and the shared `Tree` is asked to
 * re-read them with `refresh(id)`; until then `loadChildren` answers with a "Loading..." row.
 */
import { createMemo, createRoot, createSignal } from "solid-js";
import {
  type DataSource,
  type ObjectRef,
  type TreeNode,
  connect,
  connectedDataSources,
  getUiState,
  introspect,
  listDataSources,
  setUiState,
} from "../../api/db";
import { type TreeController, notify } from "../../components/ui";
import { friendlyConnectionError } from "../../state/connection-errors";
import { type TaskHandle, areaOf, setExplorerPath, setFocusArea, startTask } from "../../state/status";
import { localIconUrl } from "./icons";
import {
  type ColumnContext,
  type ENode,
  type ExplorerNodeInfo,
  FOLDER_OF_KIND,
  type NodeData,
  commentOf,
  hintOf,
  iconOf,
  nodeIdOf,
  objectRefOf,
  syntheticLabel,
  tabIconOf,
} from "./model";
import { theme } from "../../state/theme";
import { dsFolders, dsGroupOf } from "../../state/ds-folders";
import { isObjectVisible, isSchemaVisible, visibleSchemas, visibleSchemasRaw } from "../datasource/schemas";

// ---------------------------------------------------------------- signals

export const [dataSources, setDataSources] = createSignal<DataSource[]>([]);
export const [roots, setRoots] = createSignal<ENode[]>([]);
export const [connected, setConnected] = createSignal<ReadonlySet<string>>(new Set());
/** Node ids being loaded (data source icon turns into a spinner). */
export const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
export const [badges, setBadges] = createSignal<Record<string, string>>({});
/** Colors set with "Set Color" on schemas / tables (a data source's color is part of its configuration). */
export const [nodeColors, setNodeColors] = createSignal<Record<string, string>>({});
export const [selectedNode, setSelectedNode] = createSignal<ENode | undefined>(undefined);
export const [searchQuery, setSearchQuery] = createSignal("");
export const [showSystemObjects, setShowSystemObjectsSignal] = createSignal(false);
export const [loaded, setLoaded] = createSignal(false);
/** View Options > Sort Alphabetically: the data sources are listed by name (default) instead of in creation order. */
export const [sortAlphabetically, setSortAlphabeticallySignal] = createSignal(true);

let ctrl: TreeController<ENode> | undefined;
export const setController = (c: TreeController<ENode> | undefined) => (ctrl = c);
export const controller = () => ctrl;

/** Every node ever created, by id. */
export const nodes = new Map<string, ENode>();

/** The data source folders of the tree (stable nodes: their members and count follow the data source list). */
const folderNodes = new Map<string, ENode>();
export const isDsFolder = (n: ENode | undefined): boolean => !!n?.data.extra.dsFolder;

/** What the explorer tree lists at the top: the folders (alphabetical), then the data sources outside any folder. */
export const treeRoots = createRoot(() =>
  createMemo<ENode[]>(() => {
    const list = roots();
    const folders = dsFolders();
    const top = list.filter((n) => !dsGroupOf(n.id));
    const nodesOfFolders = folders.map((name) => {
      const id = "dsfolder:" + name;
      const members = list.filter((n) => dsGroupOf(n.id) === name);
      let f = folderNodes.get(id);
      if (!f) {
        f = { id, label: name, icon: iconOf("folder"), hasChildren: true, data: { dsId: "", kind: "folder", name, path: [], extra: { dsFolder: true }, driver: "postgres", icon: iconOf("folder") } };
        folderNodes.set(id, f);
        nodes.set(id, f);
      }
      f.hint = String(members.length);
      f.hasChildren = members.length > 0;
      f.children = members;
      return f;
    });
    for (const id of [...folderNodes.keys()]) if (!folders.some((n) => "dsfolder:" + n === id)) (folderNodes.delete(id), nodes.delete(id));
    return [...nodesOfFolders, ...top];
  }),
);
const pending = new Map<string, Promise<void>>();
const generation = new Map<string, number>();
const raw = new Map<string, Promise<TreeNode[]>>();

const add = <T>(s: ReadonlySet<T>, v: T): ReadonlySet<T> => new Set(s).add(v);
const del = <T>(s: ReadonlySet<T>, v: T): ReadonlySet<T> => {
  const n = new Set(s);
  n.delete(v);
  return n;
};

export const dsOf = (dsId: string): DataSource | undefined => dataSources().find((d) => d.id === dsId);
export const dsName = (dsId: string): string => dsOf(dsId)?.name ?? dsId;

// ---------------------------------------------------------------- persistence

interface Saved {
  expanded: string[];
  selected: string | null;
  badges: Record<string, string>;
  showSystem: boolean;
  nodeColors: Record<string, string>;
  sortAlphabetically?: boolean;
}

const LS_KEY = "prometeo.ui.explorer.state";
const EMPTY: Saved = { expanded: [], selected: null, badges: {}, showSystem: false, nodeColors: {} };
export let saved: Saved = { ...EMPTY };

function readLocal(): Saved | undefined {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Saved>) } : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the persisted state (localStorage mirror first, then the backend copy). */
export async function loadSaved(): Promise<Saved> {
  let s = readLocal();
  if (!s) {
    try {
      const b = await getUiState<Partial<Saved>>("explorer.state");
      if (b) s = { ...EMPTY, ...b };
    } catch {
      /* no backend copy */
    }
  }
  saved = s ?? { ...EMPTY };
  setBadges(saved.badges ?? {});
  setNodeColors(saved.nodeColors ?? {});
  setShowSystemObjectsSignal(!!saved.showSystem);
  setSortAlphabeticallySignal(saved.sortAlphabetically !== false);
  return saved;
}

let saveTimer: number | undefined;
export function saveState(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const st: Saved = {
      expanded: ctrl?.getExpanded() ?? saved.expanded,
      selected: selectedNode()?.id ?? saved.selected,
      badges: badges(),
      showSystem: showSystemObjects(),
      nodeColors: nodeColors(),
      sortAlphabetically: sortAlphabetically(),
    };
    saved = st;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(st));
    } catch {
      /* ignore */
    }
    setUiState("explorer.state", st).catch(() => {});
  }, 300);
}

/** "Set Color" on a schema / table: stored with the explorer state (`null` clears it). */
export function setNodeColor(id: string, color: string | null): void {
  setNodeColors((c) => {
    const n = { ...c };
    if (color) n[id] = color;
    else delete n[id];
    return n;
  });
  saveState();
}

/** The color a node is tinted with: its own, else the nearest ancestor's (the data source's color at the top). */
export function colorOfNode(n: ENode): string | undefined {
  for (let x: ENode | undefined = n; x; x = x.data.parentId ? nodes.get(x.data.parentId) : undefined) {
    const c = x.data.kind === "dataSource" ? dsOf(x.data.dsId)?.color : nodeColors()[x.id];
    if (c) return c;
  }
  return undefined;
}

export function setSortAlphabetically(v: boolean): void {
  setSortAlphabeticallySignal(v);
  saveState();
  void reloadDataSources().catch(() => {});
}

export function setShowSystemObjects(v: boolean): void {
  setShowSystemObjectsSignal(v);
  saveState();
  for (const r of roots()) refreshNodeObject(r);
}

// ---------------------------------------------------------------- data sources

/** What makes a data source node stale: its saved config (not the color: only the row tint changes), and the schema filter (UI state). */
const dsSignature = (ds: DataSource) => JSON.stringify({ ...ds, color: null }) + "\u0000" + (visibleSchemasRaw(ds) ?? "");

function dsNode(ds: DataSource): ENode {
  const n: ENode = {
    id: ds.id,
    label: ds.name,
    hasChildren: true,
    data: { dsId: ds.id, kind: "dataSource", name: ds.name, path: [], extra: { sig: dsSignature(ds) }, driver: ds.driver },
  };
  nodes.set(n.id, n);
  return n;
}

/** DataGrip lists the data sources alphabetically (case-insensitive); with "Sort Alphabetically" off: creation order. */
export const sortDataSources = <T extends { name: string }>(list: T[], sorted: boolean): T[] =>
  sorted ? [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) : list;

export async function reloadDataSources(): Promise<void> {
  const list = sortDataSources(await listDataSources(), sortAlphabetically());
  const prev = new Map(roots().map((n) => [n.id, n]));
  setDataSources(list);
  let changed = prev.size !== list.length;
  const next = list.map((ds) => {
    const old = prev.get(ds.id);
    if (old && old.data.extra.sig === dsSignature(ds)) return old;
    changed = true;
    if (old) dropSubtree(old);
    return dsNode(ds);
  });
  for (const [id, n] of prev) if (!list.some((d) => d.id === id)) dropSubtree(n, true);
  if (changed || next.some((n, i) => n !== roots()[i])) {
    setRoots(next);
    ctrl?.refresh(); // forget the Tree's cached children of replaced / removed data sources
  }
  await refreshConnectionState();
  if (selectedNode() && !nodes.has(selectedNode()!.id)) setSelectedNode(undefined);
  for (const n of next) restoreSelection(n);
}

/** Re-reads which data sources the backend has connected (other modules may have connected / disconnected). */
export async function refreshConnectionState(): Promise<void> {
  try {
    setConnected(new Set(await connectedDataSources()));
  } catch {
    /* keep the last known state */
  }
}

const connecting = new Map<string, Promise<void>>();

/** Connects a data source if needed. The data source node shows a spinner meanwhile. */
export function ensureConnected(dsId: string): Promise<void> {
  if (connected().has(dsId)) return Promise.resolve();
  let p = connecting.get(dsId);
  if (p) return p;
  setBusy((s) => add(s, dsId));
  // a connection that takes a while shows up as a background task (like DataGrip's "Connecting to ...")
  const task = startTask(`Connecting to ${dsName(dsId)}`, { delayMs: 300 });
  p = connect(dsId)
    .then(() => {
      setConnected((s) => add(s, dsId));
    })
    .finally(() => {
      task.done();
      connecting.delete(dsId);
      setBusy((s) => del(s, dsId));
    });
  connecting.set(dsId, p);
  return p;
}

export function markDisconnected(dsId: string): void {
  setConnected((s) => del(s, dsId));
}

// ---------------------------------------------------------------- background task of the loads

const DRIVER_LABEL: Record<string, string> = { postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", oracle: "Oracle", sqlite: "SQLite" };
const driverLabel = (dsId: string): string => {
  const d = dsOf(dsId)?.driver;
  return (d && DRIVER_LABEL[d]) || d || "database";
};

interface LoadTrack {
  task: TaskHandle;
  count: number;
}
/** One status bar task per data source while any of its loads runs (they come and go as the tree is expanded). */
const tracks = new Map<string, LoadTrack>();
/** Data sources whose next loads are a complete introspection (new data source, Refresh): the task is named so. */
const fullIntrospection = new Map<string, { delayMs: number; timer: number }>();

/** Called by Refresh / the new data source flow: the loads that follow belong to a complete introspection. */
export function markFullIntrospection(dsId: string, delayMs = 300): void {
  const prev = fullIntrospection.get(dsId);
  if (prev) window.clearTimeout(prev.timer);
  // not consumed (nothing expanded, nothing to load): forget it so that a later expand is a plain load.
  // The timer only removes its own mark: a newer one (marked again meanwhile) keeps its full 2 s.
  const mark = { delayMs, timer: 0 };
  mark.timer = window.setTimeout(() => {
    if (fullIntrospection.get(dsId) === mark) fullIntrospection.delete(dsId);
  }, 2000);
  fullIntrospection.set(dsId, mark);
}

/**
 * Registers one running load (or a longer unit of work: the new data source flow holds one for its whole
 * duration) of a data source with the status bar task. Returns `end` and the task for progress updates.
 */
export function beginIntrospection(dsId: string): { end: () => void; task: TaskHandle } {
  let t = tracks.get(dsId);
  if (!t) {
    const mark = fullIntrospection.get(dsId);
    if (mark) window.clearTimeout(mark.timer);
    fullIntrospection.delete(dsId);
    const delay = mark?.delayMs;
    const title = delay === undefined ? `Loading ${dsName(dsId)}` : `Performing complete introspection (${driverLabel(dsId)})`;
    t = { count: 0, task: startTask(title, { cancel: () => cancelLoads(dsId), delayMs: delay ?? 300 }) };
    tracks.set(dsId, t);
  }
  t.count++;
  const mine = t;
  let ended = false;
  return {
    task: mine.task,
    end: () => {
      if (ended) return;
      ended = true;
      if (--mine.count > 0) return;
      mine.task.done();
      if (tracks.get(dsId) === mine) tracks.delete(dsId);
    },
  };
}

/** The status bar cancel button: results of the loads in flight are dropped, their nodes show "cancelled". */
function cancelLoads(dsId: string): void {
  const t = tracks.get(dsId);
  tracks.delete(dsId);
  t?.task.done();
  generation.set(dsId, (generation.get(dsId) ?? 0) + 1);
  for (const k of [...raw.keys()]) if (k.startsWith(dsId + "\u0000")) raw.delete(k);
  for (const id of [...pending.keys()]) {
    const n = nodes.get(id);
    if (!n || n.data.dsId !== dsId) continue;
    pending.delete(id);
    n.children = [placeholder(n, "error", "Introspection cancelled")];
    ctrl?.refresh(id);
  }
  setBusy((b) => new Set([...b].filter((id) => nodes.get(id)?.data.dsId !== dsId)));
}

// ---------------------------------------------------------------- loading

export function rawIntrospect(dsId: string, path: string[], showSystem: boolean): Promise<TreeNode[]> {
  const key = `${dsId}\u0000${showSystem ? 1 : 0}\u0000${path.join("\u0000")}`;
  let p = raw.get(key);
  if (!p) {
    p = introspect(dsId, path, showSystem).catch(async (e) => {
      raw.delete(key);
      // The backend may have dropped the connection behind our back (settings changed): reconnect once.
      if (!(await connectedDataSources().then((l) => l.includes(dsId)).catch(() => true))) {
        markDisconnected(dsId);
        await ensureConnected(dsId);
        return introspect(dsId, path, showSystem);
      }
      throw e;
    });
    raw.set(key, p);
  }
  return p;
}

/** Forgets the cached listings of a data source (the next `rawIntrospect` asks the server again); the tree stays as it is. */
export function forgetListings(dsId: string): void {
  for (const k of [...raw.keys()]) if (k.startsWith(dsId + "\u0000")) raw.delete(k);
}

function setBadge(id: string, text: string | undefined): void {
  setBadges((b) => {
    if ((b[id] ?? undefined) === text) return b;
    const n = { ...b };
    if (text === undefined) delete n[id];
    else n[id] = text;
    return n;
  });
  saveState();
}

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/,\s*/).map((s) => s.replace(/^["`]|["`]$/g, "")) : [];

/** Which columns of a table belong to a foreign key / unique key / secondary index (icon variants). */
async function columnContext(folder: ENode): Promise<ColumnContext> {
  const ctx: ColumnContext = { fk: new Set(), uq: new Set(), idx: new Set() };
  const owner = folder.data.parentId ? nodes.get(folder.data.parentId) : undefined;
  const kind = folder.data.ownerKind;
  if (!owner || (kind !== "table" && kind !== "materializedView")) return ctx;
  const present = (key: string) => owner.children?.some((f) => f.data.extra.folder === key);
  const tablePath = folder.data.path.slice(0, -1);
  const get = (key: string) =>
    present(key) ? rawIntrospect(folder.data.dsId, [...tablePath, key], false).catch(() => [] as TreeNode[]) : Promise.resolve([] as TreeNode[]);
  const [fks, keys, idxs] = await Promise.all([get("foreign_keys"), get("keys"), get("indexes")]);
  for (const f of fks) arr(f.extra.columns).forEach((c) => ctx.fk.add(c));
  for (const k of keys) if (k.kind === "uniqueKey") arr(k.extra.columns).forEach((c) => ctx.uq.add(c));
  for (const i of idxs) if (!i.extra.primary) arr(i.extra.columns).forEach((c) => ctx.idx.add(c));
  return ctx;
}

function mkNode(parent: ENode, tn: TreeNode, index: number, ctx?: ColumnContext): ENode {
  const pd = parent.data;
  const ownerKind =
    pd.kind === "table" || pd.kind === "view" || pd.kind === "materializedView" ? pd.kind : pd.ownerKind;
  const synth = syntheticLabel(tn.kind, pd.driver, index + 1);
  const n: ENode = {
    id: tn.id,
    label: synth ?? tn.name,
    hint: hintOf(tn),
    tooltip: commentOf(tn),
    tooltipMono: true,
    hasChildren: tn.hasChildren,
    data: {
      dsId: pd.dsId,
      kind: tn.kind,
      name: tn.name,
      path: tn.path,
      extra: tn.extra,
      driver: pd.driver,
      parentId: parent.id,
      ownerKind,
      synthetic: !!synth,
      icon: iconOf(tn.kind, tn, ctx),
    },
  };
  nodes.set(n.id, n);
  return n;
}

const placeholder = (parent: ENode, kind: "loading" | "error", label: string): ENode => ({
  id: parent.id + "\u0000" + kind,
  label,
  hasChildren: false,
  tooltip: kind === "error" ? label : undefined,
  tooltipMono: false,
  data: { dsId: parent.data.dsId, kind, name: label, path: [], extra: {}, driver: parent.data.driver, parentId: parent.id },
});

const errMessage = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

async function fetchChildren(node: ENode): Promise<ENode[]> {
  const d = node.data;
  const ds = dsOf(d.dsId);
  if (d.kind === "dataSource") await ensureConnected(d.dsId);
  // The node that lists schemas also lists the system ones (hidden by default: "3 of 5" badge).
  const schemaLevel = (d.kind === "dataSource" && ds?.driver !== "postgres") || d.kind === "database";
  const tns = await rawIntrospect(d.dsId, d.path, schemaLevel || showSystemObjects());
  let list = tns;
  if (schemaLevel) {
    // the schema filter (Data Sources > Schemas, or the badge popup) lists the schemas to show; without it
    // every non-system schema is shown.
    const explicit = ds ? visibleSchemas(ds) : null;
    const all = explicit
      ? tns.filter((t) => t.kind !== "schema" || isSchemaVisible(ds!, t.path, { isDefault: !!t.extra.default }))
      : showSystemObjects()
        ? tns
        : tns.filter((t) => !t.extra.system);
    list = all;
    // the badge counts the schemas, not `Server Objects` / `Database Objects`
    const total = tns.filter((t) => t.kind === "schema").length;
    const shown = all.filter((t) => t.kind === "schema").length;
    setBadge(node.id, total > shown ? `${shown} of ${total}` : d.kind === "dataSource" ? String(shown) : undefined);
  } else if (d.kind === "dataSource") {
    // PostgreSQL: only the database of the connection is shown (DataGrip's default).
    list = tns.filter((t) => t.hasChildren || t.extra.current);
    setBadge(node.id, String(list.filter((t) => t.kind === "database").length));
  }
  // Data Sources > Schemas > Object filter: only the tables / views whose name passes it
  if (ds && d.kind === "folder" && ["tables", "views", "materialized_views"].includes(d.extra.folder)) list = list.filter((t) => isObjectVisible(ds, t.name));
  const ctx = d.kind === "folder" && d.extra.folder === "columns" ? await columnContext(node) : undefined;
  // Numbering of unnamed constraints is per folder, not per type, so index = position in the list.
  return list.map((tn, i) => mkNode(node, tn, i, ctx));
}

/** Starts (or joins) the load of a node's children; resolves when `node.children` is set. */
export function startLoad(node: ENode): Promise<void> {
  if (node.children) return Promise.resolve();
  let p = pending.get(node.id);
  if (p) return p;
  const dsId = node.data.dsId;
  const gen = generation.get(dsId) ?? 0;
  const isDs = node.data.kind === "dataSource";
  setBusy((s) => add(s, node.id));
  const intro = beginIntrospection(dsId);
  p = (async () => {
    let kids: ENode[];
    try {
      kids = await fetchChildren(node);
    } catch (e) {
      const ds = dsOf(dsId);
      const msg = ds ? friendlyConnectionError(errMessage(e), { driver: ds.driver, host: ds.host, port: ds.port, file: ds.file }) : errMessage(e);
      notify({
        kind: "error",
        title: isDs ? `Connection to ${node.label} failed` : `Cannot load ${node.label}`,
        body: msg,
      });
      kids = [placeholder(node, "error", msg)];
    }
    if ((generation.get(dsId) ?? 0) !== gen) return; // refreshed or removed while loading
    node.children = kids;
    ctrl?.refresh(node.id);
    for (const k of kids) restoreSelection(k);
  })().finally(() => {
    intro.end();
    if (pending.get(node.id) === p) pending.delete(node.id);
    setBusy((s) => del(s, node.id));
  });
  pending.set(node.id, p);
  return p;
}

/** `Tree.loadChildren`: real children if known, else start loading and show "Loading...". */
export function loadChildren(item: ENode): ENode[] {
  if (item.children) return item.children;
  void startLoad(item);
  return item.data.kind === "dataSource" ? [] : [placeholder(item, "loading", "Loading…")];
}

async function ensureKids(n: ENode): Promise<ENode[]> {
  await startLoad(n);
  return n.children ?? [];
}

// ---------------------------------------------------------------- refresh

function dropSubtree(n: ENode, forget = false): void {
  const stack = [n];
  while (stack.length) {
    const x = stack.pop()!;
    if (x.children) stack.push(...x.children);
    x.children = undefined;
    if (forget) nodes.delete(x.id);
    pending.delete(x.id);
  }
  if (n.data.kind === "dataSource") {
    generation.set(n.data.dsId, (generation.get(n.data.dsId) ?? 0) + 1);
    for (const k of [...raw.keys()]) if (k.startsWith(n.data.dsId + "\u0000")) raw.delete(k);
    setBusy((s) => del(s, n.id));
  }
}

function refreshNodeObject(n: ENode): void {
  const dsId = n.data.dsId;
  // Bumping the generation of the data source invalidates in-flight loads of its subtree.
  generation.set(dsId, (generation.get(dsId) ?? 0) + 1);
  for (const k of [...raw.keys()]) if (k.startsWith(dsId + "\u0000")) raw.delete(k);
  dropSubtree(n);
  invalidateSnapshots?.(dsId);
  ctrl?.refresh();
}

let invalidateSnapshots: ((dsId: string) => void) | undefined;
export const onRefreshed = (f: (dsId: string) => void) => (invalidateSnapshots = f);

/** Reloads a node (and its loaded subtree). `target`: node id, or `[dsId, ...backend path]`. */
export function refreshNode(target: string | string[]): void {
  const id = Array.isArray(target) ? nodeIdOf(target[0], target.slice(1)) : target;
  const n = nodes.get(id);
  if (n) refreshNodeObject(n);
}

/** Drops everything loaded below the node and, if it is expanded, loads it again. */
export function refreshSelected(): void {
  const n = selectedNode();
  if (!n) return;
  // A leaf (column, key...) refreshes the object it belongs to.
  let t: ENode | undefined = n;
  while (t && !t.hasChildren && t.data.parentId) t = nodes.get(t.data.parentId);
  if (t) {
    markFullIntrospection(t.data.dsId);
    refreshNodeObject(t);
    if (t.data.kind === "dataSource") void ensureConnectedSafe(t);
  }
}

async function ensureConnectedSafe(n: ENode): Promise<void> {
  try {
    await ensureConnected(n.data.dsId);
  } catch {
    /* reported when the node loads */
  }
}

// ---------------------------------------------------------------- selection, status bar

function restoreSelection(n: ENode): void {
  if (!selectedNode() && saved.selected && n.id === saved.selected) setSelectedNode(n);
}

type Crumb = { label: string; icon?: string; onClick?: () => void };

/** Clicking a crumb selects that node in the explorer (DataGrip's navigation bar). */
const selectNode = (id: string) => () => {
  ctrl?.select(id, { reveal: true });
  ctrl?.focus();
};

export function crumbsOf(n: ENode): Crumb[] {
  const chain: ENode[] = [];
  for (let x: ENode | undefined = n; x; x = x.data.parentId ? nodes.get(x.data.parentId) : undefined) chain.unshift(x);
  return [
    { label: "Database" },
    ...chain.map((x, i) => {
      const icon = i === chain.length - 1 ? iconUrlOf(x) : undefined;
      return { label: x.label, ...(icon ? { icon } : {}), onClick: selectNode(x.id) };
    }),
  ];
}

function iconUrlOf(n: ENode): string | undefined {
  const k = n.data.kind;
  if (k === "dataSource" || k === "folder" || k === "loading" || k === "error") return undefined;
  const key = n.data.icon ?? tabIconOf(k);
  return key.startsWith("x:") ? localIconUrl(key.slice(2), theme()) : key;
}

/**
 * Status bar breadcrumb of a table / DDL tab: `Database > ds > [db >] schema > tables > name`.
 * (Consoles set their own `Database Consoles > ds > console` path.) Undefined for other tabs.
 */
export function crumbsOfTab(tab: { kind: string; data?: unknown } | undefined): Crumb[] | undefined {
  if (!tab || (tab.kind !== "table" && tab.kind !== "ddl")) return undefined;
  const data = tab.data as { dsId?: string; objectRef?: ObjectRef } | undefined;
  const ds = data?.dsId ? dsOf(data.dsId) : undefined;
  const ref = data?.objectRef;
  if (!ds || !ref) return undefined;
  const out: Crumb[] = [{ label: "Database" }, { label: ds.name, onClick: () => void revealObject(ds.id, null) }];
  if (ds.driver === "postgres" && ds.database) out.push({ label: ds.database });
  if (ref.schema) {
    const schema = ref.schema;
    out.push({ label: schema, onClick: () => void revealObject(ds.id, { kind: "schema", schema, name: schema }) });
  }
  const folder = FOLDER_OF_KIND[ref.kind];
  if (folder) out.push({ label: folder.replace(/_/g, " ") });
  out.push({
    label: ref.table ? ref.table : ref.name,
    icon: iconUrlOf({ data: { kind: ref.kind } } as ENode),
    onClick: () => void revealObject(ds.id, ref),
  });
  return out;
}

export function onSelect(n: ENode | undefined): void {
  setSelectedNode(n);
  if (n && n.data.kind !== "loading" && n.data.kind !== "error") {
    setExplorerPath(crumbsOf(n));
    if (areaOf(document.activeElement) === "explorer") setFocusArea("explorer");
  }
  saveState();
}

export function nodeInfo(n: ENode | undefined): ExplorerNodeInfo | undefined {
  if (!n || n.data.kind === "loading" || n.data.kind === "error") return undefined;
  const d: NodeData = n.data;
  return {
    id: n.id,
    dsId: d.dsId,
    kind: d.kind as ExplorerNodeInfo["kind"],
    name: d.name,
    label: n.label,
    path: d.path,
    extra: d.extra,
    objectRef: objectRefOf(d),
  };
}

// ---------------------------------------------------------------- expand / collapse

let prevExpanded = new Set<string>();
export function onExpandedChange(ids: string[]): void {
  const now = new Set(ids);
  // Collapsing a node whose load failed forgets the error so that expanding again retries.
  for (const id of prevExpanded) {
    if (now.has(id)) continue;
    const n = nodes.get(id);
    if (n?.children?.[0]?.data.kind === "error") {
      n.children = undefined;
      ctrl?.refresh(id);
    }
  }
  prevExpanded = now;
  saveState();
}

export function setInitialExpanded(ids: string[]): void {
  prevExpanded = new Set(ids);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Expands every node whose children are already loaded (never triggers new loads). */
export async function expandAllLoaded(): Promise<void> {
  if (!ctrl) return;
  for (let pass = 0; pass < 10; pass++) {
    const exp = new Set(ctrl.getExpanded());
    let changed = false;
    // A collapsed node is expanded this pass; its children are visited on the next one.
    const walk = (list: ENode[]) => {
      for (const n of list) {
        if (!n.children?.length) continue;
        if (!exp.has(n.id)) {
          ctrl!.expand(n.id);
          changed = true;
        } else walk(n.children);
      }
    };
    walk(treeRoots());
    if (!changed) break;
    await tick();
  }
}

// ---------------------------------------------------------------- reveal

/** Finds (loading as needed) and selects the node of a database object. Returns false if it was not found. */
export async function revealObject(dsId: string, ref: ObjectRef | null | undefined): Promise<boolean> {
  if (!ctrl) return false;
  const ds = roots().find((r) => r.id === dsId);
  if (!ds) return false;
  const inFolder = dsGroupOf(dsId);
  const chain: ENode[] = inFolder && folderNodes.get("dsfolder:" + inFolder) ? [folderNodes.get("dsfolder:" + inFolder)!, ds] : [ds];
  let found = !ref;
  try {
    await ensureConnected(dsId);
    let cur: ENode | undefined = ds;
    if (ref) {
      if (ds.data.driver === "postgres") {
        cur = (await ensureKids(cur)).find((n) => n.data.kind === "database");
        if (cur) chain.push(cur);
      }
      if (cur && ref.kind !== "database") {
        const schemas = await ensureKids(cur);
        cur = schemas.find((n) => n.data.kind === "schema" && n.data.name === ref.schema) ?? (ref.schema ? undefined : schemas[0]);
        if (cur) chain.push(cur);
        found = ref.kind === "schema" && !!cur;
      } else found = !!cur;
      if (cur && ref.kind !== "schema" && ref.kind !== "database") {
        const isChild = ref.table != null;
        const folders = await ensureKids(cur);
        const keys = isChild ? ["tables", "views", "materialized_views"] : [FOLDER_OF_KIND[ref.kind]];
        const owner = isChild ? ref.table : ref.name;
        let hit: ENode | undefined;
        for (const key of keys) {
          const folder = folders.find((n) => n.data.extra.folder === key);
          if (!folder) continue;
          hit = (await ensureKids(folder)).find((n) => n.data.name === owner && (!ref.signature || isChild || n.data.extra.signature === ref.signature));
          if (hit) {
            chain.push(folder, hit);
            break;
          }
        }
        found = !!hit;
        if (hit && isChild) {
          const sub = (await ensureKids(hit)).find((n) => n.data.extra.folder === FOLDER_OF_KIND[ref.kind]);
          if (sub) {
            chain.push(sub);
            const leaf = (await ensureKids(sub)).find((n) => n.data.name === ref.name);
            if (leaf) chain.push(leaf);
          }
        }
      }
    }
  } catch {
    /* connection errors are reported by the load itself */
  }
  const target = chain[chain.length - 1];
  for (const a of chain.slice(0, -1)) {
    ctrl.expand(a.id);
    await tick();
  }
  ctrl.select(target.id, { reveal: true });
  ctrl.focus();
  return found;
}
