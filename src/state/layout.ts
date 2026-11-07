/** Layout state: tool window registry (anchors, sizes, pins), visibility, focus tracking (persisted). */
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { loadBackendState, loadLocal, saveUiState } from "./persist";

export type ToolWindowAnchor = "left" | "right" | "bottom";

export interface ToolWindowDef {
  id: string;
  title: string;
  /** Anchor it docks to until the user moves it (header ⋮ › Move To). */
  anchor: ToolWindowAnchor;
  /** Icon name (20px variant, e.g. "dg/dbms@20x20") shown in the main toolbar. */
  icon: string;
  /** Shortcut used to toggle it (Alt+1 ...); none for windows reached from the "…" list / View menu only. */
  shortcut?: string;
  /** 16px icon of the menu rows (defaults to `icon` without its @20x20 suffix). */
  menuIcon?: string;
  /** Default width (left / right) or height (bottom) in px. */
  size: number;
  /** Has a button in the main toolbar until the user unpins it in the "…" list. */
  pinned: boolean;
  /** Extra items for the header "Options" (⋮) menu; Move To / Resize / Maximize / Hide are always there. */
  options?: () => import("../components/ui/Menu").MenuItem[];
}

/** Registry, in View › Tool Windows order (by shortcut, then by title). */
export const TOOL_WINDOWS: ToolWindowDef[] = [
  { id: "explorer", title: "Database Explorer", anchor: "left", icon: "dg/dbms@20x20", shortcut: "Alt+1", size: 490, pinned: true },
  { id: "files", title: "Files", anchor: "right", icon: "project@20x20", shortcut: "Alt+4", size: 520, pinned: true },
  { id: "output", title: "Database Output", anchor: "bottom", icon: "dg/database-output@20x20", menuIcon: "dg/dbms-output", shortcut: "Alt+8", size: 480, pinned: true },
  { id: "notifications", title: "Notifications", anchor: "right", icon: "notifications@20x20", menuIcon: "notifications", size: 380, pinned: false },
  { id: "services", title: "Services", anchor: "bottom", icon: "services@20x20", size: 480, pinned: false },
  { id: "run", title: "Run", anchor: "bottom", icon: "run", size: 480, pinned: false },
];

/** Left-to-right order of the main toolbar buttons (DataGrip: Explorer, Output, Files, ...). */
const TOOLBAR_ORDER = ["explorer", "output", "files", "notifications", "services"];

export const toolWindowDef = (id: string): ToolWindowDef | undefined => TOOL_WINDOWS.find((t) => t.id === id);

export const MIN_LEFT = 160;
export const MIN_RIGHT = 160;
export const MIN_BOTTOM = 100;
export const MIN_EDITOR_W = 240;
export const MIN_EDITOR_H = 120;
/** Gap between islands (the splitter width). */
export const GAP = 5;
/** Body padding left + right, and the main toolbar + status bar + header heights the bottom window never takes. */
const BODY_PAD_X = 13;
const BODY_RESERVED_Y = 41;

export interface LayoutState {
  visible: Record<string, boolean>;
  /** Anchor per window (a window that was never moved sits at its default). */
  anchors: Record<string, ToolWindowAnchor>;
  /** Width (left / right) or height (bottom) in px per window. */
  sizes: Record<string, number>;
  /** Windows with a main toolbar button. */
  pinned: Record<string, boolean>;
}

const defaults = (): LayoutState => ({
  visible: { explorer: true },
  anchors: Object.fromEntries(TOOL_WINDOWS.map((t) => [t.id, t.anchor])),
  sizes: Object.fromEntries(TOOL_WINDOWS.map((t) => [t.id, t.size])),
  pinned: Object.fromEntries(TOOL_WINDOWS.map((t) => [t.id, t.pinned])),
});
export const DEFAULT_LAYOUT: LayoutState = defaults();

type Stored = Partial<LayoutState> & { leftWidth?: number; bottomHeight?: number };
const isAnchor = (a: unknown): a is ToolWindowAnchor => a === "left" || a === "right" || a === "bottom";

/** Merges a stored layout (also the old `leftWidth` / `bottomHeight` shape) over the defaults; one visible window per anchor. */
function normalize(raw: Stored | undefined | null, base: LayoutState = defaults()): LayoutState {
  const r = raw && typeof raw === "object" ? raw : {};
  const out: LayoutState = {
    visible: { ...base.visible, ...(r.visible ?? {}) },
    anchors: { ...base.anchors },
    sizes: { ...base.sizes },
    pinned: { ...base.pinned },
  };
  if (typeof r.leftWidth === "number" && !r.sizes?.explorer) out.sizes.explorer = r.leftWidth;
  if (typeof r.bottomHeight === "number" && !r.sizes?.output) out.sizes.output = r.bottomHeight;
  for (const [id, a] of Object.entries(r.anchors ?? {})) if (isAnchor(a) && toolWindowDef(id)) out.anchors[id] = a;
  for (const [id, s] of Object.entries(r.sizes ?? {})) if (typeof s === "number" && s > 0 && toolWindowDef(id)) out.sizes[id] = Math.round(s);
  for (const [id, p] of Object.entries(r.pinned ?? {})) if (typeof p === "boolean" && toolWindowDef(id)) out.pinned[id] = p;
  const seen = new Set<ToolWindowAnchor>();
  for (const t of TOOL_WINDOWS) {
    if (!out.visible[t.id]) continue;
    const a = out.anchors[t.id];
    if (seen.has(a)) out.visible[t.id] = false;
    else seen.add(a);
  }
  return out;
}

export const [layout, setLayout] = createStore<LayoutState>(normalize(loadLocal<Stored>("layout", {})));

function persist(): void {
  saveUiState("layout", {
    visible: { ...layout.visible },
    anchors: { ...layout.anchors },
    sizes: { ...layout.sizes },
    pinned: { ...layout.pinned },
  });
}

/** Optionally refresh from the backend copy (Tauri). Safe to ignore failures. */
export async function hydrateLayout(): Promise<void> {
  const remote = await loadBackendState<Stored>("layout");
  if (remote && typeof remote === "object") setLayout(produce((s) => Object.assign(s, normalize(remote, normalize(s)))));
}

// ---- registry queries

export const anchorOf = (id: string): ToolWindowAnchor => layout.anchors[id] ?? toolWindowDef(id)?.anchor ?? "bottom";
export const isToolWindowVisible = (id: string): boolean => !!layout.visible[id];
/** The window currently shown at an anchor (at most one). */
export const visibleAt = (anchor: ToolWindowAnchor): string | undefined =>
  TOOL_WINDOWS.find((t) => layout.visible[t.id] && anchorOf(t.id) === anchor)?.id;
export const isPinned = (id: string): boolean => !!layout.pinned[id];
/** Windows with a button in the main toolbar, in toolbar order. */
export const toolbarWindows = (): ToolWindowDef[] =>
  TOOL_WINDOWS.filter((t) => layout.pinned[t.id]).sort((a, b) => TOOLBAR_ORDER.indexOf(a.id) - TOOLBAR_ORDER.indexOf(b.id));

/** Entries of View › Tool Windows (and the "…" list): every window in registry order, each running its `toolwindow.<id>` action. */
export const toolWindowMenuItems = (): import("../components/ui/Menu").MenuItem[] =>
  TOOL_WINDOWS.map((t) => ({ action: "toolwindow." + t.id }));

// ---- sizes

const [body, setBody] = createSignal({ w: 1600, h: 900 });
/** The shell reports the size of the island area so sizes can be clamped to what fits. */
export const setBodyBox = (w: number, h: number): void => void setBody({ w, h });

const minOf = (a: ToolWindowAnchor): number => (a === "left" ? MIN_LEFT : a === "right" ? MIN_RIGHT : MIN_BOTTOM);
const rawSize = (a: ToolWindowAnchor): number => {
  const id = visibleAt(a);
  return id ? (layout.sizes[id] ?? toolWindowDef(id)?.size ?? 300) : 0;
};

/** Largest size an anchor can take now (the right dock has priority over the left one). */
export function maxSizeOf(a: ToolWindowAnchor): number {
  if (a === "bottom") return Math.max(MIN_BOTTOM, body().h - MIN_EDITOR_H - BODY_RESERVED_Y - GAP);
  const free = body().w - BODY_PAD_X - MIN_EDITOR_W - GAP;
  if (a === "right") return Math.max(MIN_RIGHT, free - (visibleAt("left") ? MIN_LEFT + GAP : 0));
  return Math.max(MIN_LEFT, free - (visibleAt("right") ? effectiveSize("right") + GAP : 0));
}

/** Size in px of the window shown at an anchor (0 when none): the stored one clamped to what fits. */
export function effectiveSize(a: ToolWindowAnchor): number {
  if (!visibleAt(a)) return 0;
  return Math.min(Math.max(rawSize(a), minOf(a)), maxSizeOf(a));
}

/** Live resize while dragging a splitter (not persisted until `commitLayout`). */
export function setToolWindowSize(id: string, px: number): void {
  setLayout("sizes", id, Math.max(minOf(anchorOf(id)), Math.round(px)));
}
/** Persists the current sizes (call when a drag ends). */
export const commitLayout = persist;

export function resetLayout(): void {
  setLayout(produce((s) => Object.assign(s, normalize({ visible: { ...defaults().visible, output: !!s.visible.output } }))));
  setMaximized(null);
  persist();
}

export type StretchDir = "left" | "right" | "top" | "bottom";
const STRETCH_STEP = 40;

/** Header ⋮ › Resize: moves the edge of the window that faces the editor (the other directions do nothing). */
export function stretchToolWindow(id: string, dir: StretchDir): void {
  const a = anchorOf(id);
  const grow = (a === "left" && dir === "right") || (a === "right" && dir === "left") || (a === "bottom" && dir === "top");
  const shrink = (a === "left" && dir === "left") || (a === "right" && dir === "right") || (a === "bottom" && dir === "bottom");
  if (!grow && !shrink) return;
  const cur = visibleAt(a) === id ? effectiveSize(a) : (layout.sizes[id] ?? 300);
  const next = Math.min(Math.max(cur + (grow ? STRETCH_STEP : -STRETCH_STEP), minOf(a)), maxSizeOf(a));
  setLayout("sizes", id, next);
  persist();
}

/** Directions that change anything for a window at its anchor (the Resize submenu disables the others). */
export const stretchDirsOf = (id: string): StretchDir[] => {
  const a = anchorOf(id);
  return a === "left" ? ["left", "right"] : a === "right" ? ["left", "right"] : ["top", "bottom"];
};

// ---- maximize

const [maxId, setMaxId] = createSignal<string | null>(null);
/** Window maximized over the editor (not persisted). */
export const maximizedToolWindow = maxId;
const setMaximized = setMaxId;
export const isMaximized = (id: string): boolean => maxId() === id;
export function toggleMaximizeToolWindow(id: string): void {
  if (!layout.visible[id]) return;
  const on = maxId() !== id;
  setMaxId(on ? id : null);
  // the editor behind a maximized window is hidden: the keyboard focus moves into the window
  if (on) focusToolWindow(id);
}

// ---- tool window visibility / focus

const [activeTw, setActiveTw] = createSignal<string | null>(null);
/** Id of the tool window that last had keyboard focus (target of Shift+Escape, Ctrl+Shift+'). */
export const activeToolWindow = activeTw;
export const markActiveToolWindow = setActiveTw;

/** The windows Hide All Windows closed, restored by the next press (cleared when the user opens a window). */
let hiddenByHideAll: string[] | null = null;

/** Shows a window; the one it replaces at the same anchor is hidden (Services <-> Database Output). */
export function showToolWindow(id: string, focus = true): void {
  hiddenByHideAll = null;
  // a window maximized over the editor hides all the others: opening another one leaves the maximized state
  if (maxId() !== null && maxId() !== id) setMaxId(null);
  const a = anchorOf(id);
  for (const t of TOOL_WINDOWS) {
    if (t.id !== id && layout.visible[t.id] && anchorOf(t.id) === a) {
      setLayout("visible", t.id, false);
      if (activeTw() === t.id) setActiveTw(null);
      if (maxId() === t.id) setMaxId(null);
    }
  }
  setLayout("visible", id, true);
  persist();
  if (focus) focusToolWindow(id);
}

export function hideToolWindow(id: string): void {
  setLayout("visible", id, false);
  if (activeTw() === id) setActiveTw(null);
  if (maxId() === id) setMaxId(null);
  persist();
  // Return focus to the editor, like DataGrip does.
  queueMicrotask(() => (document.querySelector("[data-editor-area]") as HTMLElement | null)?.focus());
}

/** Header ⋮ › Move To: docks the window at another anchor (a window shown there is hidden). */
export function moveToolWindow(id: string, anchor: ToolWindowAnchor): void {
  if (anchorOf(id) === anchor) return;
  const wasVisible = !!layout.visible[id];
  if (wasVisible) setLayout("visible", id, false); // so the window leaving does not count at the old anchor
  setLayout("anchors", id, anchor);
  if (maxId() === id) setMaxId(null);
  if (wasVisible) showToolWindow(id, false);
  else persist();
}

export function focusToolWindow(id: string): void {
  if (maxId() !== null && maxId() !== id) setMaxId(null); // the maximized window hides the others
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

/** Id of the tool window with keyboard focus (else the last active one) that is still visible. */
export function currentToolWindow(): string | undefined {
  const el = document.activeElement as HTMLElement | null;
  const host = el?.closest<HTMLElement>("[data-toolwindow]");
  const id = host?.dataset.toolwindow ?? activeTw();
  return id && layout.visible[id] ? id : undefined;
}

/** Id of the visible tool window that holds the keyboard focus right now (none while the focus is in the editor). */
export function focusedToolWindow(): string | undefined {
  const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-toolwindow]")?.dataset.toolwindow;
  return id && layout.visible[id] ? id : undefined;
}

export function hideActiveToolWindow(): void {
  const id = currentToolWindow();
  if (id) hideToolWindow(id);
}

/** Pin / unpin the window's button in the main toolbar. */
export function setToolWindowPinned(id: string, pinned: boolean): void {
  setLayout("pinned", id, pinned);
  persist();
}

/** Ctrl+Shift+F12: hides every window; pressed again it restores exactly that set (else the Explorer). */
export function hideAllToolWindows(): void {
  const shown = TOOL_WINDOWS.filter((t) => layout.visible[t.id]).map((t) => t.id);
  if (shown.length) {
    shown.forEach((id) => setLayout("visible", id, false));
    setActiveTw(null);
    setMaxId(null);
    persist();
    hiddenByHideAll = shown;
  } else {
    const restore = hiddenByHideAll ?? ["explorer"];
    restore.forEach((id) => showToolWindow(id, false));
    hiddenByHideAll = null;
  }
}
