/** Open editor tabs (consoles, table data editors, DDL views). Persisted; views are supplied via slots. */
import { createStore, produce } from "solid-js/store";
import { loadLocal, saveUiState } from "./persist";

export type TabKind = "console" | "table" | "ddl";

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
  /** Free-form JSON payload for the view (data source id, table ref, ...). Persisted. */
  data?: unknown;
}

interface TabsState {
  list: EditorTab[];
  active: string | null;
}

const saved = loadLocal<TabsState>("tabs", { list: [], active: null });
export const [tabsState, setTabsState] = createStore<TabsState>({
  // pending changes do not survive a restart: drop the flag
  list: Array.isArray(saved.list) ? saved.list.map(({ modified: _m, ...t }) => t) : [],
  active: saved.active ?? null,
});

function persist(): void {
  saveUiState("tabs", {
    list: tabsState.list.map(({ modified: _m, ...t }) => t),
    active: tabsState.active,
  });
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
    setTabsState("list", (l) => [...l, { closeable: true, pinned: false, ...t }]);
  }
  setTabsState("active", t.id);
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
    setTabsState("active", id);
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

/** Removes the tab without asking (the caller already decided, or the tab's subject is gone). */
export function removeTab(id: string): void {
  const i = tabsState.list.findIndex((t) => t.id === id);
  if (i < 0) return;
  const wasActive = tabsState.active === id;
  setTabsState("list", (l) => l.filter((t) => t.id !== id));
  if (wasActive) {
    const next = tabsState.list[Math.min(i, tabsState.list.length - 1)];
    setTabsState("active", next ? next.id : null);
  }
  persist();
}

/** Closes the tabs in order, asking the hooks for each; stops at the first veto. Resolves true if all closed. */
async function closeEach(ids: string[]): Promise<boolean> {
  for (const id of ids) {
    const t = tabsState.list.find((x) => x.id === id);
    if (!t) continue;
    if (!(await mayClose({ ...t }))) return false;
    removeTab(id);
  }
  return true;
}

/** Closes a tab unless a `beforeClose` hook vetoes it. Resolves true when the tab is gone. */
export function closeTab(id: string): Promise<boolean> {
  const t = tabsState.list.find((x) => x.id === id);
  if (!t || !t.closeable) return Promise.resolve(false);
  return closeEach([id]);
}

export async function closeOtherTabs(id: string): Promise<boolean> {
  const ok = await closeEach(tabsState.list.filter((t) => t.id !== id && t.closeable && !t.pinned).map((t) => t.id));
  if (!tabsState.list.some((t) => t.id === tabsState.active) && tabsState.list.some((t) => t.id === id)) activateTab(id);
  return ok;
}

export async function closeAllTabs(): Promise<boolean> {
  const ok = await closeEach(tabsState.list.filter((t) => t.closeable && !t.pinned).map((t) => t.id));
  if (!tabsState.list.some((t) => t.id === tabsState.active)) setTabsState("active", tabsState.list[0]?.id ?? null);
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

export function cycleTab(dir: 1 | -1): void {
  const n = tabsState.list.length;
  if (n < 2) return;
  const i = tabsState.list.findIndex((t) => t.id === tabsState.active);
  activateTab(tabsState.list[(i + dir + n) % n].id);
}
