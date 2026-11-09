/** Open editor tabs (consoles, table data editors, DDL views). Persisted; views are supplied via slots. */
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { type PaneTree, type SplitDir, hasPane, leaf, leaves, oppositePane, removeLeaf, splitIds, splitLeaf } from "./panes";
import { loadLocal, saveUiState } from "./persist";
import { type Ask, runDecisions } from "./decisions";

export type TabKind = "console" | "table" | "ddl" | "file" | "diagram";

export interface EditorTab {
  id: string;
  title: string;
  /** Icon name from src/assets/icons (e.g. "dg/console"), or an icon URL (starts with "/" or "data:"). */
  icon?: string;
  kind: TabKind;
  closeable: boolean;
  pinned: boolean;
  /** Unsaved/dirty marker shown on the tab (table editors with pending changes; consoles autosave). Not persisted. */
  modified?: boolean;
  /** Color of the tab's data source (tint); kept up to date by the explorer. */
  color?: string;
  /** Free-form JSON payload for the view (data source id, table ref, ...). Persisted. */
  data?: unknown;
  /** Editor pane (split) the tab lives in; set by the store, defaults to the focused pane when opening. */
  pane?: string;
}

interface TabsState {
  list: EditorTab[];
  active: string | null;
}

/** Persisted editor split state (see "split editor" below). */
interface SavedPanes {
  tree?: PaneTree;
  active?: Record<string, string | null>;
  focused?: string;
  ratios?: Record<string, number>;
  mru?: string[];
  closed?: EditorTab[];
}

const saved = loadLocal<TabsState & { panes?: SavedPanes }>("tabs", { list: [], active: null });
const savedPanes: SavedPanes = saved.panes ?? {};
const noModified = (t: EditorTab): EditorTab => {
  const { modified: _m, ...rest } = t;
  return rest;
};
export const [tabsState, setTabsState] = createStore<TabsState>({
  // pending changes do not survive a restart: drop the flag
  list: Array.isArray(saved.list) ? saved.list.map(noModified) : [],
  active: saved.active ?? null,
});

function persist(): void {
  const live = new Set(splitIds(paneTree()));
  saveUiState("tabs", {
    list: tabsState.list.map(noModified),
    active: tabsState.active,
    panes: {
      tree: paneTree(),
      active: { ...paneState.active },
      focused: paneState.focused,
      ratios: Object.fromEntries(Object.entries(paneState.ratios).filter(([k]) => live.has(k))),
      mru: mru().slice(0, 50),
      closed: closedTabs().slice(0, MAX_CLOSED),
    } satisfies SavedPanes,
  });
}

// ---------------------------------------------------------------- split editor (panes)
// Every tab lives in exactly one pane (`tab.pane`); a pane shows its own active tab; the focused pane's active tab is
// the store's `active`. The layout tree itself is a plain immutable value (panes.ts).

const MAX_CLOSED = 20;
const validTree = (t: unknown): t is PaneTree => !!t && typeof t === "object" && ((t as PaneTree).kind === "leaf" || (t as PaneTree).kind === "split");

const [paneTree, setPaneTree] = createSignal<PaneTree>(validTree(savedPanes.tree) ? savedPanes.tree : leaf("p1"));
const [paneState, setPaneState] = createStore<{ active: Record<string, string | null>; focused: string; ratios: Record<string, number> }>({
  active: { ...savedPanes.active },
  focused: savedPanes.focused ?? "",
  ratios: { ...savedPanes.ratios },
});
const [mru, setMru] = createSignal<string[]>(Array.isArray(savedPanes.mru) ? savedPanes.mru : []);
const [closedTabs, setClosedTabs] = createSignal<EditorTab[]>(Array.isArray(savedPanes.closed) ? savedPanes.closed : []);

{
  // normalize what was loaded: every tab in an existing pane, every pane with a valid active tab
  const ids = leaves(paneTree());
  if (!ids.includes(paneState.focused)) setPaneState("focused", ids[0]);
  tabsState.list.forEach((t, i) => {
    if (!t.pane || !ids.includes(t.pane)) setTabsState("list", i, "pane", ids[0]);
  });
  for (const p of ids) {
    const inPane = tabsState.list.filter((t) => t.pane === p);
    const a = paneState.active[p];
    if (!a || !inPane.some((t) => t.id === a)) setPaneState("active", p, p === ids[0] && inPane.some((t) => t.id === saved.active) ? saved.active : (inPane[0]?.id ?? null));
  }
  setTabsState("active", paneState.active[paneState.focused] ?? null);
}

export const paneTreeValue = paneTree;
export const paneIds = (): string[] => leaves(paneTree());
export const isSplit = (): boolean => paneIds().length > 1;
export const focusedPane = (): string => paneState.focused;
export const paneOf = (id: string): string | undefined => tabsState.list.find((t) => t.id === id)?.pane;
/** Tabs of a pane in strip order. */
export const paneTabs = (pane: string): EditorTab[] => tabsState.list.filter((t) => t.pane === pane);
/** The tab a pane shows. */
export const paneActiveId = (pane: string): string | null => paneState.active[pane] ?? null;
/** Share (0..1) of the first child of a split. */
export const splitRatio = (splitId: string): number => paneState.ratios[splitId] ?? 0.5;
export function setSplitRatio(splitId: string, r: number): void {
  setPaneState("ratios", splitId, Math.min(0.9, Math.max(0.1, r)));
}
export function commitSplitRatio(): void {
  persist();
}

/** Keeps `active` equal to the focused pane's active tab. */
function syncActive(): void {
  const a = paneState.active[paneState.focused] ?? null;
  if (tabsState.active !== a) setTabsState("active", a);
}

const newId = (prefix: string): string => prefix + Math.random().toString(36).slice(2, 8);

function touch(id: string | null): void {
  if (id) setMru((l) => [id, ...l.filter((x) => x !== id)].slice(0, 100));
}

/** Makes `id` the shown tab of its pane and focuses that pane. */
function focusTab(id: string): void {
  const t = tabsState.list.find((x) => x.id === id);
  if (!t) return;
  const pane = t.pane ?? paneState.focused;
  setPaneState("active", pane, id);
  setPaneState("focused", pane);
  setTabsState("active", id);
  touch(id);
}

/** Focuses a pane (click / focus inside it): its active tab becomes the store's active tab. */
export function focusPane(pane: string): void {
  if (!hasPane(paneTree(), pane) || paneState.focused === pane) return;
  setPaneState("focused", pane);
  syncActive();
  touch(tabsState.active);
  persist();
}

/** Drops a pane from the layout (its tabs must already be elsewhere). Focus goes to `focusTo` when it was focused. */
function removePane(pane: string, focusTo?: string): void {
  const next = removeLeaf(paneTree(), pane);
  if (!next) return;
  const fallback = focusTo ?? oppositePane(paneTree(), pane) ?? leaves(next)[0];
  setPaneTree(next);
  setPaneState("active", produce((o) => void delete o[pane]));
  if (paneState.focused === pane) setPaneState("focused", fallback);
  syncActive();
}

/** The tab a pane should show after `gone` left it (its neighbour), or null. */
function neighbour(pane: string, idx: number): string | null {
  const l = paneTabs(pane);
  return l[Math.min(idx, l.length - 1)]?.id ?? null;
}

/** Moves a tab to the end of the list (= the end of its new pane's strip) or before `beforeId`. */
function placeTab(id: string, pane: string, beforeId?: string): void {
  setTabsState("list", (l) => {
    const t = l.find((x) => x.id === id)!;
    const rest = l.filter((x) => x.id !== id);
    const at = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1;
    const moved = { ...t, pane };
    rest.splice(at < 0 ? rest.length : at, 0, moved);
    return rest;
  });
}

/** Moves a tab into another pane (drag & drop, "Move to Opposite Group"); an emptied pane disappears. */
export function moveTabToPane(id: string, pane: string, beforeId?: string): void {
  const t = tabsState.list.find((x) => x.id === id);
  if (!t || !t.pane || (t.pane === pane && !beforeId) || !hasPane(paneTree(), pane)) return;
  const src = t.pane;
  const idx = paneTabs(src).findIndex((x) => x.id === id);
  placeTab(id, pane, beforeId);
  if (src !== pane && paneState.active[src] === id) setPaneState("active", src, neighbour(src, idx));
  focusTab(id);
  if (src !== pane && paneTabs(src).length === 0) removePane(src, pane);
  persist();
}

/** Split Right / Split Down: the tab moves into a new pane next to its own, which takes the focus. */
export function splitTab(id: string, dir: SplitDir): void {
  const t = tabsState.list.find((x) => x.id === id);
  if (!t || !t.pane) return;
  const src = t.pane;
  const idx = paneTabs(src).findIndex((x) => x.id === id);
  const np = newId("p");
  setPaneTree(splitLeaf(paneTree(), src, dir, np, newId("s")));
  placeTab(id, np);
  if (paneState.active[src] === id) setPaneState("active", src, neighbour(src, idx));
  focusTab(id);
  persist();
}

export function moveToOppositePane(id: string): void {
  const p = paneOf(id);
  const o = p ? oppositePane(paneTree(), p) : null;
  if (o) moveTabToPane(id, o);
}

/** Unsplit: the focused pane's tabs join the next pane and the split goes away. */
export function unsplit(): void {
  const f = paneState.focused;
  const target = oppositePane(paneTree(), f);
  if (!target) return;
  const keep = paneState.active[f];
  for (const t of paneTabs(f)) placeTab(t.id, target);
  if (keep) {
    setPaneState("active", target, keep);
    touch(keep);
  }
  removePane(f, target);
  syncActive();
  persist();
}

export function unsplitAll(): void {
  const f = paneState.focused;
  for (const t of tabsState.list) if (t.pane !== f) setTabsState("list", (x) => x.id === t.id, "pane", f);
  setPaneTree(leaf(f));
  setPaneState("active", (o) => ({ [f]: o[f] ?? null }));
  syncActive();
  persist();
}

// ---------------------------------------------------------------- recent tabs (MRU) and closed tabs
/** Open tabs, most recently activated first (the active one leads). */
export function recentTabs(): EditorTab[] {
  const byId = new Map(tabsState.list.map((t) => [t.id, t]));
  const out: EditorTab[] = [];
  for (const id of mru()) {
    const t = byId.get(id);
    if (t) {
      out.push(t);
      byId.delete(id);
    }
  }
  return [...out, ...byId.values()];
}

/** Recently closed tabs, newest first. */
export const closedTabList = closedTabs;
export const canReopenTab = (): boolean => closedTabs().length > 0;

function rememberClosed(t: EditorTab): void {
  setClosedTabs((l) => [noModified({ ...t }), ...l.filter((x) => x.id !== t.id)].slice(0, MAX_CLOSED));
}

/** Reopens one closed tab (by id) in its old pane when that still exists, else in the focused one. */
export function reopenClosedById(id: string): boolean {
  const t = closedTabs().find((x) => x.id === id);
  if (!t) return false;
  setClosedTabs((l) => l.filter((x) => x.id !== id));
  if (tabsState.list.some((x) => x.id === id)) {
    focusTab(id);
    persist();
    return true;
  }
  openTab({ ...t, pane: t.pane && hasPane(paneTree(), t.pane) ? t.pane : undefined });
  return true;
}

/** Reopens the most recently closed tab accepted by `valid` (stale ones are dropped); false when there is none. */
export function reopenClosedTab(valid: (t: EditorTab) => boolean = () => true): boolean {
  for (const t of closedTabs()) {
    if (!valid(t)) {
      setClosedTabs((l) => l.filter((x) => x.id !== t.id));
      continue;
    }
    return reopenClosedById(t.id);
  }
  return false;
}

/** Tab limit (Settings > Editor > General > Editor Tabs): beyond it the least recently used unpinned tab is closed. 0 = unlimited. */
let tabLimit = loadLocal<number>("tabLimit", 10);
export const getTabLimit = (): number => tabLimit;
export function setTabLimit(n: number): void {
  tabLimit = Math.max(0, Math.floor(n));
  saveUiState("tabLimit", tabLimit);
}

function enforceTabLimit(pane: string, keep: string): void {
  if (tabLimit <= 0) return;
  const cand = paneTabs(pane).filter((t) => t.closeable && !t.pinned && t.id !== keep);
  if (cand.length + 1 <= tabLimit) return;
  const order = mru();
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? Infinity : i;
  };
  const victim = cand.reduce((a, b) => (rank(b.id) > rank(a.id) ? b : a));
  void closeTab(victim.id);
}

export const tabs = () => tabsState.list;
export const activeTabId = () => tabsState.active;
export const activeTab = () => tabsState.list.find((t) => t.id === tabsState.active);

export type NewTab = Pick<EditorTab, "id" | "title" | "kind"> & Partial<EditorTab>;

/** Opens a tab, or activates (and refreshes the title/data of) an existing one with the same id. */
export function openTab(t: NewTab): void {
  const i = tabsState.list.findIndex((x) => x.id === t.id);
  if (i >= 0) {
    setTabsState("list", i, produce((x) => Object.assign(x, t)));
  } else {
    const pane = t.pane && hasPane(paneTree(), t.pane) ? t.pane : paneState.focused;
    setTabsState("list", (l) => [...l, { closeable: true, pinned: false, ...t, pane }]);
  }
  focusTab(t.id);
  const pane = paneOf(t.id);
  if (pane && i < 0) enforceTabLimit(pane, t.id);
  persist();
}

export function updateTab(id: string, patch: Partial<EditorTab>): void {
  const i = tabsState.list.findIndex((x) => x.id === id);
  if (i >= 0) {
    setTabsState("list", i, produce((x) => Object.assign(x, patch)));
    persist();
  }
}

export function activateTab(id: string): void {
  if (tabsState.list.some((t) => t.id === id)) {
    focusTab(id);
    persist();
  }
}

// ---------------------------------------------------------------- closing (with veto hook)

/** Return false to keep the tab open (e.g. after the user cancelled an "unsaved changes" dialog). */
export type BeforeClose = (tab: EditorTab) => boolean | Promise<boolean>;

const beforeCloseHooks = new Set<BeforeClose>();

/** Registers a veto hook; every way of closing a tab (button, Ctrl+F4, menus, close others / all) asks it first. */
export function registerBeforeClose(hook: BeforeClose): () => void {
  beforeCloseHooks.add(hook);
  return () => void beforeCloseHooks.delete(hook);
}

async function mayClose(tab: EditorTab): Promise<boolean> {
  for (const hook of [...beforeCloseHooks]) {
    if (!(await hook(tab))) return false;
  }
  return true;
}

/** What a tab wants asked when the application quits (`registerQuitGuard`); the answer is applied only if nobody cancels. */
export type QuitGuard = (tab: EditorTab) => ReturnType<Ask>;

const quitGuards = new Set<QuitGuard>();

/**
 * Registers a quit question for tabs (unsaved file, pending table changes). Unlike `beforeClose` it only asks: the
 * returned plan is applied after every question was answered, see `runDecisions`.
 */
export function registerQuitGuard(guard: QuitGuard): () => void {
  quitGuards.add(guard);
  return () => void quitGuards.delete(guard);
}

/** The questions quitting asks about the open tabs, in tab order (nothing is closed). Run them with `runDecisions`. */
export function quitAsks(): Ask[] {
  const asks: Ask[] = [];
  for (const t of [...tabsState.list]) for (const g of [...quitGuards]) asks.push(() => g({ ...t }));
  return asks;
}

/** Quitting the app: asks every tab, applies the answers when nobody cancelled. False when the quit is off. */
export function confirmCloseAll(): Promise<boolean> {
  return runDecisions(quitAsks());
}

/** Removes the tab without asking (the caller already decided, or the tab's subject is gone). */
export function removeTab(id: string): void {
  const i = tabsState.list.findIndex((t) => t.id === id);
  if (i < 0) return;
  const pane = tabsState.list[i].pane ?? paneState.focused;
  const idx = paneTabs(pane).findIndex((t) => t.id === id);
  const wasShown = paneState.active[pane] === id;
  setTabsState("list", (l) => l.filter((t) => t.id !== id));
  if (wasShown) setPaneState("active", pane, neighbour(pane, idx));
  // closing the last tab of a pane removes the split
  if (paneTabs(pane).length === 0 && paneIds().length > 1) removePane(pane);
  syncActive();
  persist();
}

/** Closes the tabs in order, asking the hooks for each; stops at the first veto. Resolves true if all closed. */
async function closeEach(ids: string[]): Promise<boolean> {
  for (const id of ids) {
    const t = tabsState.list.find((x) => x.id === id);
    if (!t) continue;
    if (!(await mayClose({ ...t }))) return false;
    const snapshot = { ...t };
    removeTab(id);
    rememberClosed(snapshot);
  }
  return true;
}

/** Closes a tab unless a `beforeClose` hook vetoes it. Resolves true when the tab is gone. */
export function closeTab(id: string): Promise<boolean> {
  const t = tabsState.list.find((x) => x.id === id);
  if (!t || !t.closeable) return Promise.resolve(false);
  return closeEach([id]);
}

/** Closes the other tabs of the same pane. */
export async function closeOtherTabs(id: string): Promise<boolean> {
  const pane = paneOf(id);
  const ok = await closeEach(tabsState.list.filter((t) => t.id !== id && t.pane === pane && t.closeable && !t.pinned).map((t) => t.id));
  if (!tabsState.list.some((t) => t.id === tabsState.active) && tabsState.list.some((t) => t.id === id)) activateTab(id);
  return ok;
}

/** Close Tabs to the Left / Right of `id` in its pane. */
export async function closeTabsSide(id: string, side: "left" | "right"): Promise<boolean> {
  const l = paneTabs(paneOf(id) ?? "");
  const i = l.findIndex((t) => t.id === id);
  if (i < 0) return true;
  const part = side === "left" ? l.slice(0, i) : l.slice(i + 1);
  return closeEach(part.filter((t) => t.closeable && !t.pinned).map((t) => t.id));
}

export async function closeAllTabs(): Promise<boolean> {
  const ok = await closeEach(tabsState.list.filter((t) => t.closeable && !t.pinned).map((t) => t.id));
  syncActive();
  persist();
  return ok;
}

export function setPinned(id: string, pinned: boolean): void {
  updateTab(id, { pinned });
}

export function moveTab(from: number, to: number): void {
  if (from === to || from < 0 || to < 0 || from >= tabsState.list.length || to >= tabsState.list.length) return;
  setTabsState("list", (l) => {
    const c = l.slice();
    const [m] = c.splice(from, 1);
    c.splice(to, 0, m);
    return c;
  });
  persist();
}

/** Select next / previous tab (within the focused pane). */
export function cycleTab(dir: 1 | -1): void {
  const l = paneTabs(paneState.focused);
  const n = l.length;
  if (n < 2) return;
  const i = l.findIndex((t) => t.id === tabsState.active);
  activateTab(l[(i + dir + n) % n].id);
}
