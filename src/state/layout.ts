/** Layout state: tool window visibility + splitter sizes (persisted), tool window registry, focus tracking. */
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { loadBackendState, loadLocal, saveUiState } from "./persist";

export type ToolWindowAnchor = "left" | "bottom";

export interface ToolWindowDef {
  id: string;
  title: string;
  anchor: ToolWindowAnchor;
  /** Icon name (20px variant, e.g. "dg/dbms@20x20") shown in the main toolbar. */
  icon: string;
  /** Shortcut used to toggle it (Alt+1 ...). */
  shortcut: string;
  /** Extra items for the header "Options" (⋮) menu; Hide is always appended. */
  options?: () => import("../components/ui/Menu").MenuItem[];
}

export const TOOL_WINDOWS: ToolWindowDef[] = [
  { id: "explorer", title: "Database Explorer", anchor: "left", icon: "dg/dbms@20x20", shortcut: "Alt+1" },
  { id: "output", title: "Database Output", anchor: "bottom", icon: "dg/database-output@20x20", shortcut: "Alt+8" },
];

export const MIN_LEFT = 160;
export const MIN_BOTTOM = 100;
export const MIN_EDITOR_W = 240;
export const MIN_EDITOR_H = 120;

export interface LayoutState {
  leftWidth: number;
  bottomHeight: number;
  visible: Record<string, boolean>;
}

export const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: 490,
  bottomHeight: 480,
  visible: { explorer: true, output: false },
};

const initial = { ...DEFAULT_LAYOUT, ...loadLocal<Partial<LayoutState>>("layout", {}) };
initial.visible = { ...DEFAULT_LAYOUT.visible, ...initial.visible };

export const [layout, setLayout] = createStore<LayoutState>(initial);

function persist(): void {
  saveUiState("layout", { leftWidth: layout.leftWidth, bottomHeight: layout.bottomHeight, visible: { ...layout.visible } });
}

/** Optionally refresh from the backend copy (Tauri). Safe to ignore failures. */
export async function hydrateLayout(): Promise<void> {
  const remote = await loadBackendState<Partial<LayoutState>>("layout");
  if (remote && typeof remote === "object") {
    setLayout(produce((s) => Object.assign(s, remote, { visible: { ...s.visible, ...(remote.visible ?? {}) } })));
  }
}

/** Live resize while dragging a splitter (not persisted until `commitLayout`). */
export function setLeftWidth(w: number): void {
  setLayout("leftWidth", Math.max(MIN_LEFT, Math.round(w)));
}
export function setBottomHeight(h: number): void {
  setLayout("bottomHeight", Math.max(MIN_BOTTOM, Math.round(h)));
}
/** Persists the current sizes (call when a drag ends). */
export const commitLayout = persist;
export function resetLayout(): void {
  setLayout(produce((s) => Object.assign(s, DEFAULT_LAYOUT, { visible: { ...DEFAULT_LAYOUT.visible, output: s.visible.output } })));
  persist();
}

// ---- tool window visibility / focus

const [activeTw, setActiveTw] = createSignal<string | null>(null);
/** Id of the tool window that last had keyboard focus (shows its header actions; target of Shift+Escape). */
export const activeToolWindow = activeTw;
export const markActiveToolWindow = setActiveTw;

export const isToolWindowVisible = (id: string): boolean => !!layout.visible[id];

export function showToolWindow(id: string, focus = true): void {
  setLayout("visible", id, true);
  persist();
  if (focus) focusToolWindow(id);
}

export function hideToolWindow(id: string): void {
  setLayout("visible", id, false);
  if (activeTw() === id) setActiveTw(null);
  persist();
  // Return focus to the editor, like DataGrip does.
  queueMicrotask(() => (document.querySelector("[data-editor-area]") as HTMLElement | null)?.focus());
}

export function focusToolWindow(id: string): void {
  setActiveTw(id);
  queueMicrotask(() => {
    const el = document.querySelector<HTMLElement>(`[data-toolwindow="${id}"]`);
    if (!el) return;
    // Prefer a focusable inner element (tree, grid) marked as the tool window's main focus target.
    (el.querySelector<HTMLElement>("[data-focus-target]") ?? el).focus();
  });
}

/** Alt+N behaviour: hidden -> show+focus; visible but not focused -> focus; focused -> hide. */
export function toggleToolWindow(id: string): void {
  if (!layout.visible[id]) return showToolWindow(id);
  const el = document.querySelector<HTMLElement>(`[data-toolwindow="${id}"]`);
  if (el && el.contains(document.activeElement)) hideToolWindow(id);
  else focusToolWindow(id);
}

export function hideActiveToolWindow(): void {
  const el = document.activeElement as HTMLElement | null;
  const host = el?.closest<HTMLElement>("[data-toolwindow]");
  const id = host?.dataset.toolwindow ?? activeTw();
  if (id && layout.visible[id]) hideToolWindow(id);
}

export function hideAllToolWindows(): void {
  const any = TOOL_WINDOWS.some((t) => layout.visible[t.id]);
  if (any) {
    TOOL_WINDOWS.forEach((t) => setLayout("visible", t.id, false));
    persist();
  } else {
    showToolWindow("explorer", false);
  }
}
