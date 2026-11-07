/**
 * Status bar model. Other modules update it (e.g. the editor sets `caret`, the explorer sets
 * `path`); the status bar only renders operative items.
 */
import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

export interface Crumb {
  label: string;
  /** Icon name or URL shown before the label. */
  icon?: string;
  onClick?: () => void;
}

export interface StatusState {
  /** Navigation path, left side: Database Consoles › postgres@localhost › console [postgres@localhost]. */
  path: Crumb[];
  /** Editor caret (1-based). null hides the widget. */
  caret: { line: number; col: number } | null;
  lineSeparator: "LF" | "CRLF" | "CR" | null;
  encoding: string | null;
  /** Indentation widget ("4 spaces"). undefined: derived (shown next to the caret, like DataGrip). */
  indent?: string | null;
  /** Shows the lock icon. null hides it. */
  readOnly: boolean | null;
  /** Transaction mode text, e.g. "Tx: Manual". The status bar only shows it in Manual mode (DataGrip has no Auto widget). */
  txMode: string | null;
  /** Right-side free text (e.g. "No aggregator selected"), shown while a grid has the focus. */
  aggregator: string | null;
  /** Selection of the grid that last reported one (`tabId`: the editor tab it belongs to). See `setGridSelection`. */
  grid: {
    tabId: string;
    pos: { line: number; col: number } | null;
    cells: number;
    numeric: { count: number; sum: number; min: number; max: number } | null;
  } | null;
}

export const [status, setStatus] = createStore<StatusState>({
  path: [],
  caret: null,
  lineSeparator: null,
  encoding: null,
  readOnly: null,
  txMode: null,
  aggregator: null,
  grid: null,
});

// ---------------------------------------------------------------- focus area and breadcrumbs

/** Where the keyboard focus is: decides which breadcrumb path and which widgets the status bar shows. */
export type FocusArea = "explorer" | "editor" | "grid";

const [focusArea, setFocusAreaSignal] = createSignal<FocusArea>("editor");
export { focusArea };
export const setFocusArea = (a: FocusArea) => setFocusAreaSignal(a);

const [explorerPath, setExplorerPathSignal] = createSignal<Crumb[]>([]);
const [editorPath, setEditorPathSignal] = createSignal<Crumb[]>([]);
/** Breadcrumbs of the explorer selection (shown while the explorer has the focus). */
export const setExplorerPath = (p: Crumb[]) => setExplorerPathSignal(p);
/** Breadcrumbs of the active editor tab (shown while an editor or a result grid has the focus). */
export const setEditorPath = (p: Crumb[]) => setEditorPathSignal(p);

createRoot(() => {
  createEffect(() => {
    const own = focusArea() === "explorer" ? explorerPath() : editorPath();
    const path = own.length ? own : focusArea() === "explorer" ? editorPath() : explorerPath();
    if (path.length) setStatus("path", path);
  });
});

/** The focus area an element belongs to (undefined: not one of the tracked ones, e.g. a dialog). */
export function areaOf(el: Element | null): FocusArea | undefined {
  if (!el?.closest) return undefined;
  if (el.closest(".dgg")) return "grid";
  if (el.closest("[data-editor-area]")) return "editor";
  const host = el.closest<HTMLElement>("[data-toolwindow]");
  if (host?.dataset.toolwindow === "explorer") return "explorer";
  // the other tool windows (output, ...) hold result grids / panes that belong to the editor context
  return host ? "editor" : undefined;
}

if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const a = areaOf(e.target as Element | null);
      if (a) setFocusAreaSignal(a);
    },
    true,
  );
}

// ---------------------------------------------------------------- grid selection and aggregator

export const AGGREGATORS = ["SUM", "AVG", "COUNT", "MAX", "MIN"] as const;
export type Aggregator = (typeof AGGREGATORS)[number];

const AGG_KEY = "prometeo.ui.aggregator";
const readAggregator = (): Aggregator => {
  try {
    const v = localStorage.getItem(AGG_KEY);
    return (AGGREGATORS as readonly string[]).includes(v ?? "") ? (v as Aggregator) : "SUM";
  } catch {
    return "SUM";
  }
};
const [aggregatorChoice, setAggregatorSignal] = createSignal<Aggregator>(readAggregator());
export { aggregatorChoice };
/** The aggregate the status bar computes for a multi-cell numeric selection (remembered). */
export function setAggregator(a: Aggregator): void {
  setAggregatorSignal(a);
  try {
    localStorage.setItem(AGG_KEY, a);
  } catch {
    /* ignore */
  }
}

/** Selection report of a data grid (`SelectionInfo` of the grid component), for the status bar while the grid has the focus. */
export function setGridSelection(
  tabId: string,
  info: { row: number | null; col: number | null; cells: number; numeric: { count: number; sum: number; min: number; max: number } | null },
): void {
  setStatus("grid", { tabId, pos: info.row ? { line: info.row, col: info.col ?? 1 } : null, cells: info.cells, numeric: info.numeric });
}

const round = (n: number) => String(Number(n.toPrecision(12)));

/** `SUM: 42`, `SUM: Not enough values` or `No aggregator selected` (DataGrip's grid status bar widget). */
export function aggregatorText(g: Pick<NonNullable<StatusState["grid"]>, "cells" | "numeric">, a: Aggregator = aggregatorChoice()): string {
  const n = g.numeric;
  if (!n || n.count < 2) return g.cells > 1 ? `${a}: Not enough values` : "No aggregator selected";
  const v = a === "SUM" ? n.sum : a === "AVG" ? n.sum / n.count : a === "COUNT" ? n.count : a === "MAX" ? n.max : n.min;
  return `${a}: ${round(v)}`;
}

// ---------------------------------------------------------------- background tasks

export interface TaskHandle {
  /** Progress 0..1; leave undefined for an indeterminate bar. */
  progress: (p: number | undefined) => void;
  title: (t: string) => void;
  /** Removes the task (idempotent). */
  done: () => void;
}

export interface BackgroundTask {
  id: number;
  title: string;
  progress?: number;
  /** Hidden until its delay elapsed (short tasks never flash in the status bar). */
  visible: boolean;
  onCancel?: () => void;
}

let taskSeq = 0;
const [taskList, setTaskList] = createSignal<BackgroundTask[]>([]);
/** The running background tasks that are shown, oldest first. */
export const tasks = () => taskList().filter((t) => t.visible);

/**
 * Registers a background task for the status bar widget ("Performing complete introspection (SQLite)",
 * progress bar, cancel, `+N` for the others). `delayMs`: show it only if it is still running after that long.
 *
 *   const t = startTask("Importing orders.csv…", { cancel: () => abort() });
 *   t.progress(0.4);
 *   t.done();
 */
export function startTask(title: string, opts: { cancel?: () => void; delayMs?: number } = {}): TaskHandle {
  const id = ++taskSeq;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const patch = (f: (t: BackgroundTask) => BackgroundTask) => setTaskList((l) => l.map((t) => (t.id === id ? f(t) : t)));
  const delay = opts.delayMs ?? 0;
  setTaskList((l) => [...l, { id, title, visible: delay <= 0, onCancel: opts.cancel }]);
  if (delay > 0) timer = setTimeout(() => !finished && patch((t) => ({ ...t, visible: true })), delay);
  return {
    progress: (p) => patch((t) => ({ ...t, progress: p })),
    title: (t) => patch((x) => ({ ...x, title: t })),
    done: () => {
      finished = true;
      clearTimeout(timer);
      setTaskList((l) => l.filter((t) => t.id !== id));
    },
  };
}
