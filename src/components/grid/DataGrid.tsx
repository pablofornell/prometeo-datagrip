/**
 * Virtualized data grid (DataGrip look and behaviour). Rows and columns are windowed; rows are drawn
 * as plain HTML strings (no per-cell components) and all pointer interaction is hit-tested from
 * coordinates, so a 100k x 30 result keeps a few hundred DOM nodes and scrolls at the native rate.
 *
 * Layout (inside one scroller): sticky header (27px) / sticky row-number gutter / scrolling cell layers.
 *   underlay  - current row, pending-change fills, selection (below the text, grid lines stay on top)
 *   rows      - cells (transparent) with 1px right/bottom grid lines
 */
import {
  For,
  Show,
  batch,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from "solid-js";
import { COPY_FORMAT_LABELS, formatRows, type CopyColumn } from "./copy";
import {
  DEFAULT_VALUE,
  classifyType,
  compareKeys,
  displayCell,
  displayLength,
  editText,
  isBinaryCell,
  isEditableKind,
  isRightAligned,
  parseEdit,
  sortKey,
} from "./format";
import { GridMenu, type MenuItem } from "./GridMenu";
import { createPending } from "./pending";
import { TextView } from "./TextView";
import type {
  Cell,
  CellPos,
  ColumnKind,
  CopyFormat,
  DataGridApi,
  GridChange,
  GridColumn,
  SelRange,
  SortSpec,
  ViewMode,
} from "./types";
import { ValueEditor } from "./ValueEditor";
import "./grid.css";

export const ROW_H = 27;
export const HEADER_H = 27;
const OVERSCAN_ROWS = 4;
const OVERSCAN_PX = 280;
const MIN_COL_W = 28;
const CHAR_W = 8;

export interface SelectionInfo {
  /** 1-based position of the active cell (status bar `row:col`), null when nothing is selected. */
  row: number | null;
  col: number | null;
  cells: number;
  /** Aggregates over the numeric cells of the selection (only computed for <= 50k cells). */
  numeric: { count: number; sum: number; min: number; max: number } | null;
}

export interface ColumnsState {
  /** Visual order of column indexes (hidden ones included). */
  order: number[];
  hidden: number[];
  widths: number[];
}

export interface DataGridProps {
  columns: GridColumn[];
  /** Number of rows known so far (grows with paging). */
  rowCount: number;
  /** Row accessor; `undefined` = not loaded yet (drawn empty). May read reactive state. */
  getRow: (index: number) => Cell[] | undefined;
  /** Bump when the data behind `getRow` changed without `getRow`/`rowCount` changing. */
  version?: number;
  /** More rows exist on the server; `onNeedMore` fires when the viewport nears the end. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onNeedMore?: () => void;

  /** Allow cell editing / row insert / delete (false for query results without a table). */
  editable?: boolean;
  /** Called with the pending change set. Return `false` (or reject) to keep the changes pending. */
  onSubmit?: (changes: GridChange[]) => void | boolean | Promise<void | boolean>;
  onChangesChange?: (pendingCount: number) => void;
  /** Table for SQL INSERT copies, e.g. `public.clients`. */
  tableName?: string;

  /** Controlled sort; omit to let the grid keep it. */
  sort?: SortSpec[];
  onSortChange?: (sort: SortSpec[]) => void;
  /** `local` sorts the loaded rows in the grid (default); `external` only reports through `onSortChange`. */
  sortMode?: "local" | "external";

  viewMode?: ViewMode;
  /** Clipboard hook (Tauri clipboard plugin); default uses the browser clipboard. */
  onCopy?: (text: string, format: CopyFormat) => void;
  onReload?: () => void;
  /** Funnel button of a column header. */
  onColumnFilter?: (column: number, anchor: DOMRect) => void;
  onSelectionChange?: (info: SelectionInfo) => void;
  onColumnsChange?: (state: ColumnsState) => void;
  apiRef?: (api: DataGridApi) => void;
  /** Overlay slot (e.g. the floating paging pill), positioned over the scroller. */
  children?: JSX.Element;
}

/** Registers a reactive read (kept by minifiers, unlike a bare property access). */
const touch = (_: unknown) => {};

const esc = (s: string) => (/[&<>]/.test(s) ? s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : s);

/**
 * Glyph advance the layout assumes: JetBrains Mono 13px has an 8px advance in DataGrip (and in hinted Chromium).
 * Engines that lay text out at 13 * 0.6 = 7.8px (WebKitGTK) get a matching `letter-spacing` on the root, see `ls`.
 */
const charWidth = () => CHAR_W;

function iconClass(c: GridColumn): string {
  if (c.isPk && c.isFk) return "k-pkfk";
  if (c.isPk) return "k-pk";
  if (c.isFk) return "k-fk";
  if (c.isIndexed) return "k-idx";
  if (c.nullable === false) return "k-nn";
  return "k-col";
}

const norm = (a: CellPos, b: CellPos): SelRange => ({
  r0: Math.min(a.r, b.r),
  r1: Math.max(a.r, b.r),
  c0: Math.min(a.c, b.c),
  c1: Math.max(a.c, b.c),
});

interface Rect {
  k: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function DataGrid(props: DataGridProps): JSX.Element {
  let root!: HTMLDivElement;
  let scroller!: HTMLDivElement;
  const pending = createPending();

  // ---- viewport ----
  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [viewW, setViewW] = createSignal(800);
  const [viewH, setViewH] = createSignal(600);
  const [ls, setLs] = createSignal(0);

  // ---- columns ----
  const kinds = createMemo<ColumnKind[]>(() => props.columns.map((c) => classifyType(c.typeName)));
  const [widths, setWidths] = createSignal<number[]>([]);
  const [order, setOrder] = createSignal<number[]>([]);
  const [hidden, setHidden] = createSignal<Set<number>>(new Set());
  const [internalSort, setInternalSort] = createSignal<SortSpec[]>([]);
  const sortState = () => props.sort ?? internalSort();

  const headerFit = (name: string) => Math.ceil(name.length * charWidth() + 81);

  function initialWidths(): number[] {
    const cw = charWidth();
    const n = Math.min(props.rowCount, 200);
    return props.columns.map((c, ci) => {
      if (c.width) return c.width;
      // DataGrip sizes a column from header and sampled content with slack (fit to 6 measured headers: 105.2 + 9.6/char).
      let w = Math.round(105.2 + cw * 1.2 * c.name.length);
      const kind = kinds()[ci];
      let maxLen = 0;
      for (let i = 0; i < n; i++) {
        const row = props.getRow(i);
        if (row) maxLen = Math.max(maxLen, displayLength(row[ci], kind));
      }
      w = Math.max(w, Math.round(maxLen * cw * 1.2 + 16));
      return Math.min(w, 460);
    });
  }

  const vis = createMemo<number[]>(() => {
    const n = props.columns.length;
    const h = hidden();
    const o = order();
    const base = o.length === n ? o : props.columns.map((_, i) => i);
    return base.filter((c) => !h.has(c));
  });
  const widthOf = (ci: number) => widths()[ci] ?? 100;
  const colX = createMemo(() => {
    const v = vis();
    const w = widths();
    const X = new Float64Array(v.length + 1);
    for (let i = 0; i < v.length; i++) X[i + 1] = X[i] + (w[v[i]] ?? 100);
    return X;
  });
  const visPos = createMemo(() => {
    const m = new Map<number, number>();
    vis().forEach((ci, i) => m.set(ci, i));
    return m;
  });
  const totalW = () => colX()[colX().length - 1];

  // ---- rows ----
  const insCount = () => pending.insertedCount;
  const total = createMemo(() => insCount() + props.rowCount);
  const gutterW = createMemo(() => Math.max(32, String(Math.max(total(), 1)).length * 8 + 16));
  const bodyH = () => total() * ROW_H;

  /** Local sort permutation: sorted position -> source row (null = natural order). */
  const sortOrder = createMemo<Int32Array | null>(() => {
    const s = sortState();
    touch(props.version);
    const n = props.rowCount;
    if ((props.sortMode ?? "local") !== "local" || s.length === 0 || n === 0) return null;
    const keyCols = s.map((sp) => {
      const keys: (number | string | null)[] = new Array(n);
      const kind = kinds()[sp.col];
      for (let i = 0; i < n; i++) {
        const row = props.getRow(i);
        keys[i] = row ? sortKey(row[sp.col], kind) : null;
      }
      return { keys, sign: sp.dir === "asc" ? 1 : -1 };
    });
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    idx.sort((a, b) => {
      for (const kc of keyCols) {
        const d = compareKeys(kc.keys[a], kc.keys[b]);
        if (d !== 0) return d * kc.sign;
      }
      return a - b;
    });
    return idx;
  });
  const invCache = new WeakMap<Int32Array, Int32Array>();
  const invOf = (o: Int32Array) => {
    let inv = invCache.get(o);
    if (!inv) {
      inv = new Int32Array(o.length);
      for (let i = 0; i < o.length; i++) inv[o[i]] = i;
      invCache.set(o, inv);
    }
    return inv;
  };
  /** Source row of display row `r` (-1 for inserted rows). */
  const srcOf = (r: number) => {
    const k = r - pending.insertedCount;
    if (k < 0) return -1;
    const o = sortOrder();
    return o ? o[k] : k;
  };

  const rowWin = createMemo<[number, number]>(
    () => {
      const t = total();
      const r0 = Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN_ROWS);
      const r1 = Math.min(t - 1, Math.ceil((scrollTop() + viewH() - HEADER_H) / ROW_H) + OVERSCAN_ROWS);
      return [r0, r1];
    },
    [0, -1],
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  const rowList = createMemo(() => {
    const [a, b] = rowWin();
    const out: number[] = [];
    for (let r = a; r <= b; r++) out.push(r);
    return out;
  });
  const colWin = createMemo<[number, number]>(
    () => {
      const X = colX();
      const n = X.length - 1;
      if (n <= 0) return [0, -1];
      const x0 = scrollLeft() - OVERSCAN_PX;
      const x1 = scrollLeft() + viewW() - gutterW() + OVERSCAN_PX;
      let lo = 0;
      while (lo < n - 1 && X[lo + 1] <= x0) lo++;
      let hi = lo;
      while (hi < n - 1 && X[hi + 1] < x1) hi++;
      return [lo, hi];
    },
    [0, -1],
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  const hdrCols = createMemo(() => {
    const [a, b] = colWin();
    return vis().slice(a, b + 1);
  });

  /** Value shown in a display cell (pending edits applied). */
  function cellValue(r: number, ci: number): Cell {
    const ni = pending.insertedCount;
    if (r < ni) return pending.inserted(r)?.values.get(ci) ?? null;
    const src = srcOf(r);
    const e = pending.edit(src, ci);
    if (e) return e.value;
    return props.getRow(src)?.[ci] ?? null;
  }
  function rowHtml(r: number): string {
    pending.version();
    touch(props.version);
    const X = colX();
    const v = vis();
    const [c0, c1] = colWin();
    const k = kinds();
    const ni = pending.insertedCount;
    let html = "";
    const cw = charWidth();
    if (r < ni) {
      const ins = pending.inserted(r);
      for (let vi = c0; vi <= c1; vi++) {
        const ci = v[vi];
        const val = ins?.values.get(ci) ?? null;
        const d = displayCell(val, k[ci], (((X[vi + 1] - X[vi]) / cw) | 0) + 3);
        // unset cells of a new row: dim only for NOT NULL columns without default (measured on DataGrip)
        if (val === null && (props.columns[ci].nullable !== false || props.columns[ci].isPk)) d.cls = "";
        html += `<div class="c${isRightAligned(k[ci], val) ? " r" : ""}${d.cls}" style="left:${X[vi]}px;width:${X[vi + 1] - X[vi]}px">${esc(d.text)}</div>`;
      }
      return html;
    }
    const src = srcOf(r);
    const row = props.getRow(src);
    if (!row) {
      for (let vi = c0; vi <= c1; vi++) html += `<div class="c sk" style="left:${X[vi]}px;width:${X[vi + 1] - X[vi]}px"></div>`;
      return html;
    }
    const edits = pending.rowEdits(src);
    for (let vi = c0; vi <= c1; vi++) {
      const ci = v[vi];
      const val = edits && edits.has(ci) ? edits.get(ci) : (row[ci] ?? null);
      const d = displayCell(val, k[ci], (((X[vi + 1] - X[vi]) / cw) | 0) + 3);
      html += `<div class="c${isRightAligned(k[ci], val) ? " r" : ""}${d.cls}" style="left:${X[vi]}px;width:${X[vi + 1] - X[vi]}px">${esc(d.text)}</div>`;
    }
    return html;
  }

  function rowState(r: number): "" | "ins" | "del" | "mod" {
    pending.version();
    if (r < pending.insertedCount) return "ins";
    const src = srcOf(r);
    if (pending.isDeleted(src)) return "del";
    return pending.rowEdits(src) ? "mod" : "";
  }

  // ---- selection ----
  const [ranges, setRanges] = createSignal<SelRange[]>([]);
  const [active, setActive] = createSignal<CellPos | null>(null);
  let anchor: CellPos | null = null;

  // ---- editing state (declared early: the columns reset below clears it) ----
  interface EditState {
    r: number;
    vi: number;
    ci: number;
    text: string;
  }
  const [edit, setEdit] = createSignal<EditState | null>(null);
  const [valueEd, setValueEd] = createSignal<{ r: number; vi: number; ci: number; text: string; readOnly: boolean } | null>(null);


  function setSelection(rs: SelRange[], act: CellPos | null) {
    anchor = act;
    setRanges(rs);
    setActive(act);
  }

  createComputed(
    on(
      () => props.columns,
      () => {
        batch(() => {
          setWidths(untrack(initialWidths));
          setOrder(props.columns.map((_, i) => i));
          setHidden(new Set<number>());
          setInternalSort([]);
          setSelection([], null);
          setEdit(null);
          setValueEd(null);
          pending.revertAll();
        });
      },
    ),
  );

  const nCols = () => vis().length;
  const inSel = (r: number, c: number) => ranges().some((g) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1);
  const colHasSel = (vi: number) => ranges().some((g) => vi >= g.c0 && vi <= g.c1);
  const rowFullySel = (r: number) => {
    const last = nCols() - 1;
    return ranges().some((g) => r >= g.r0 && r <= g.r1 && g.c0 === 0 && g.c1 >= last);
  };

  function selectCell(r: number, c: number) {
    setSelection([{ r0: r, r1: r, c0: c, c1: c }], { r, c });
    ensureVisible(r, c);
  }
  function extendTo(r: number, c: number) {
    const a = anchor ?? active() ?? { r, c };
    const g = norm(a, { r, c });
    setRanges((prev) => (prev.length ? [...prev.slice(0, -1), g] : [g]));
    setActive({ r, c });
    ensureVisible(r, c);
  }
  function addCell(r: number, c: number) {
    // Ctrl+click on an already selected single cell deselects it
    const hit = ranges().findIndex((g) => g.r0 === r && g.r1 === r && g.c0 === c && g.c1 === c);
    if (hit >= 0 && ranges().length > 1) {
      setRanges((prev) => prev.filter((_, i) => i !== hit));
      return;
    }
    anchor = { r, c };
    setRanges((prev) => [...prev, { r0: r, r1: r, c0: c, c1: c }]);
    setActive({ r, c });
  }
  function selectRows(r0: number, r1: number, additive: boolean, act?: CellPos) {
    const g: SelRange = { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: 0, c1: Math.max(0, nCols() - 1) };
    const a = act ?? { r: r1, c: active()?.c ?? 0 };
    if (additive) setRanges((prev) => [...prev, g]);
    else setRanges([g]);
    setActive(a);
  }
  function selectCols(c0: number, c1: number, additive: boolean, act?: CellPos) {
    const g: SelRange = { r0: 0, r1: Math.max(0, total() - 1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
    const a = act ?? { r: active()?.r ?? 0, c: c1 };
    if (additive) setRanges((prev) => [...prev, g]);
    else setRanges([g]);
    setActive(a);
  }
  function selectAll() {
    if (total() === 0 || nCols() === 0) return;
    setRanges([{ r0: 0, r1: total() - 1, c0: 0, c1: nCols() - 1 }]);
    if (!active()) setActive({ r: 0, c: 0 });
  }

  function ensureVisible(r: number, c: number) {
    if (!scroller) return;
    const X = colX();
    const dataH = scroller.clientHeight - HEADER_H;
    const top = r * ROW_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_H > scroller.scrollTop + dataH) scroller.scrollTop = top + ROW_H - dataH;
    const dataW = scroller.clientWidth - gutterW();
    const left = X[c] ?? 0;
    const right = X[c + 1] ?? left;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + dataW) scroller.scrollLeft = Math.min(left, right - dataW);
  }

  // underlay rectangles
  const selRects = createMemo<Rect[]>(() => {
    const X = colX();
    const out: Rect[] = [];
    for (const g of ranges()) {
      if (g.c0 >= X.length - 1) continue;
      const x = X[g.c0];
      out.push({ k: "sel", x, y: g.r0 * ROW_H, w: X[Math.min(g.c1 + 1, X.length - 1)] - x, h: (g.r1 - g.r0 + 1) * ROW_H });
    }
    return out;
  });
  const changeRects = createMemo<Rect[]>(() => {
    pending.version();
    const out: Rect[] = [];
    if (pending.isEmpty()) return out;
    const [r0, r1] = rowWin();
    const ni = pending.insertedCount;
    const W = totalW();
    const X = colX();
    const pos = visPos();
    for (let r = r0; r <= Math.min(ni - 1, r1); r++) out.push({ k: "ins", x: 0, y: r * ROW_H, w: W, h: ROW_H });
    const o = sortOrder();
    const inv = o ? invOf(o) : null;
    const disp = (src: number) => (inv ? inv[src] : src) + ni;
    for (const src of pending.deletedRows()) {
      const d = disp(src);
      if (d >= r0 && d <= r1) out.push({ k: "del", x: 0, y: d * ROW_H, w: W, h: ROW_H });
    }
    for (const [src, m] of pending.editedRows()) {
      const d = disp(src);
      if (d < r0 || d > r1 || pending.isDeleted(src)) continue;
      for (const ci of m.keys()) {
        const vi = pos.get(ci);
        if (vi === undefined) continue;
        out.push({ k: "mod", x: X[vi], y: d * ROW_H, w: X[vi + 1] - X[vi], h: ROW_H });
      }
    }
    const a = active();
    if (a && a.r < ni) out.push({ k: "tint", x: 0, y: a.r * ROW_H, w: W, h: ROW_H });
    return out;
  });

  // ---- scrolling / sizing ----
  // Window the rows synchronously for the scroll event itself: a rAF hop would add a frame of blank rows on fast flicks.
  const onScrollSync = () => {
    batch(() => {
      setScrollTop(scroller.scrollTop);
      setScrollLeft(scroller.scrollLeft);
    });
  };

  onMount(() => {
    const measure = () => {
      setViewW(scroller.clientWidth);
      setViewH(scroller.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    // make the mono advance exactly 8px on engines that use fractional advances (7.8px)
    document.fonts?.load('13px "JetBrains Mono"').then(() => {
      try {
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = '13px "JetBrains Mono"';
        const m = ctx.measureText("0".repeat(40)).width / 40;
        setLs(m >= 7 && m < 7.98 ? +(CHAR_W - m).toFixed(3) : 0);
      } catch {
        /* keep 0 */
      }
    });
  });

  // the table node is detached while the text view is shown; the browser resets its scroll offsets
  createEffect(
    on(
      () => props.viewMode ?? "table",
      (m) => {
        if (m === "table")
          queueMicrotask(() => {
            if (!scroller) return;
            scroller.scrollTop = scrollTop();
            scroller.scrollLeft = scrollLeft();
          });
      },
      { defer: true },
    ),
  );

  // paging
  let lastNeedMoreFor = -1;
  createEffect(() => {
    const n = props.rowCount;
    const r1 = rowWin()[1];
    if (!props.hasMore || props.loadingMore || !props.onNeedMore) return;
    const pageRows = Math.ceil(viewH() / ROW_H);
    if (r1 >= total() - Math.max(60, pageRows * 2) && lastNeedMoreFor !== n) {
      lastNeedMoreFor = n;
      props.onNeedMore();
    }
  });

  // ---- hit testing ----
  function colAt(x: number): number {
    const X = colX();
    const n = X.length - 1;
    if (n <= 0 || x < 0) return -1;
    if (x >= X[n]) return -1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (X[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  function toData(e: { clientX: number; clientY: number }) {
    const rect = scroller.getBoundingClientRect();
    return {
      x: e.clientX - rect.left + scroller.scrollLeft - gutterW(),
      y: e.clientY - rect.top + scroller.scrollTop - HEADER_H,
      inGutter: e.clientX - rect.left < gutterW(),
      inHeader: e.clientY - rect.top < HEADER_H,
    };
  }
  const isScrollbar = (e: MouseEvent) =>
    e.clientX > scroller.getBoundingClientRect().left + scroller.clientWidth ||
    e.clientY > scroller.getBoundingClientRect().top + scroller.clientHeight;

  // ---- pointer: cells and gutter ----
  let dragCleanup: (() => void) | null = null;

  function startDrag(onMove: (e: MouseEvent) => void, onUp?: () => void) {
    dragCleanup?.();
    let timer = 0;
    let last: MouseEvent | null = null;
    const tick = () => {
      if (!last) return;
      const rect = scroller.getBoundingClientRect();
      const dx = last.clientX < rect.left + gutterW() ? last.clientX - rect.left - gutterW() : last.clientX > rect.left + scroller.clientWidth ? last.clientX - rect.left - scroller.clientWidth : 0;
      const dy = last.clientY < rect.top + HEADER_H ? last.clientY - rect.top - HEADER_H : last.clientY > rect.top + scroller.clientHeight ? last.clientY - rect.top - scroller.clientHeight : 0;
      if (dx || dy) {
        scroller.scrollLeft += Math.sign(dx) * Math.min(40, Math.abs(dx) / 2 + 4);
        scroller.scrollTop += Math.sign(dy) * Math.min(60, Math.abs(dy) / 2 + 4);
        onMove(last);
      }
    };
    const move = (e: MouseEvent) => {
      last = e;
      onMove(e);
      if (!timer) timer = window.setInterval(tick, 30);
    };
    const up = () => {
      cleanup();
      onUp?.();
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      if (timer) clearInterval(timer);
      dragCleanup = null;
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
    dragCleanup = cleanup;
  }
  onCleanup(() => dragCleanup?.());

  const clampRow = (y: number) => Math.max(0, Math.min(total() - 1, Math.floor(y / ROW_H)));
  const clampCol = (x: number) => {
    const c = colAt(x);
    return c >= 0 ? c : x < 0 ? 0 : nCols() - 1;
  };

  function onBodyMouseDown(e: MouseEvent) {
    if (e.button !== 0 && e.button !== 2) return;
    if ((e.target as Element).closest(".dgg-header, .dgg-editor")) return;
    if (isScrollbar(e) || total() === 0 || nCols() === 0) return;
    const p = toData(e);
    if (p.inHeader) return;
    const r = clampRow(p.y);
    if (p.y < 0 || p.y >= bodyH()) return;
    const mod = e.ctrlKey || e.metaKey;
    root.focus({ preventScroll: true });

    if (p.inGutter) {
      if (e.button === 2 && rowFullySel(r)) return;
      const act = active();
      if (e.shiftKey && act) selectRows(act.r, r, false, { r, c: act.c });
      else if (mod) selectRows(r, r, true, { r, c: act?.c ?? 0 });
      else selectRows(r, r, false, { r, c: act?.c ?? 0 });
      if (e.button === 2) return;
      const start = r;
      startDrag((ev) => {
        const q = toData(ev);
        const rr = clampRow(q.y);
        setRanges((prev) => [...prev.slice(0, -1), { r0: Math.min(start, rr), r1: Math.max(start, rr), c0: 0, c1: nCols() - 1 }]);
        setActive({ r: rr, c: active()?.c ?? 0 });
      });
      return;
    }
    const c = colAt(p.x);
    if (c < 0) return;
    if (e.button === 2) {
      if (!inSel(r, c)) selectCell(r, c);
      return;
    }
    if (e.shiftKey) extendTo(r, c);
    else if (mod) addCell(r, c);
    else selectCell(r, c);
    startDrag((ev) => {
      const q = toData(ev);
      extendTo(clampRow(q.y), clampCol(q.x));
    });
  }

  function onBodyDblClick(e: MouseEvent) {
    if ((e.target as Element).closest(".dgg-header, .dgg-editor") || isScrollbar(e)) return;
    const p = toData(e);
    if (p.inHeader || p.inGutter) return;
    const r = clampRow(p.y);
    const c = colAt(p.x);
    if (c < 0 || p.y < 0 || p.y >= bodyH()) return;
    selectCell(r, c);
    startEdit();
  }

  // ---- header interaction ----
  const [dropAt, setDropAt] = createSignal<number | null>(null);
  const [dragCol, setDragCol] = createSignal<number | null>(null);

  function onHeaderMouseDown(e: MouseEvent, ci: number) {
    if (e.button !== 0 && e.button !== 2) return;
    const t = e.target as Element;
    if (t.closest(".dgg-resize, .dgg-hbtn")) return;
    root.focus({ preventScroll: true });
    const vi = visPos().get(ci)!;
    const mod = e.ctrlKey || e.metaKey;
    if (e.button === 2) {
      if (!colSelectedFully(vi)) selectCols(vi, vi, false);
      return;
    }
    if (e.shiftKey && active()) selectCols(active()!.c, vi, false, { r: active()!.r, c: vi });
    else if (mod) selectCols(vi, vi, true);
    else selectCols(vi, vi, false);

    const x0 = e.clientX;
    let dragging = false;
    startDrag(
      (ev) => {
        if (!dragging && Math.abs(ev.clientX - x0) > 5) {
          dragging = true;
          setDragCol(ci);
        }
        if (!dragging) return;
        const q = toData(ev);
        const X = colX();
        let best = 0;
        for (let i = 0; i < X.length; i++) if (Math.abs(X[i] - q.x) < Math.abs(X[best] - q.x)) best = i;
        setDropAt(best);
      },
      () => {
        const to = dropAt();
        setDragCol(null);
        setDropAt(null);
        if (dragging && to !== null) moveColumn(ci, to);
      },
    );
  }
  const colSelectedFully = (vi: number) => ranges().some((g) => g.c0 <= vi && g.c1 >= vi && g.r0 === 0 && g.r1 >= total() - 1);

  function emitColumns() {
    props.onColumnsChange?.({ order: order(), hidden: [...hidden()], widths: widths() });
  }
  function moveColumn(ci: number, toBoundary: number) {
    const v = vis();
    const from = v.indexOf(ci);
    const t = toBoundary > from ? toBoundary - 1 : toBoundary;
    if (t === from || from < 0) return;
    const rest = v.filter((c) => c !== ci);
    const before = rest[t]; // insert before this column (undefined = at the end)
    const o = order().filter((c) => c !== ci);
    const at = before === undefined ? o.length : o.indexOf(before);
    o.splice(at, 0, ci);
    setOrder(o);
    const nv = visPos().get(ci) ?? t;
    selectCols(nv, nv, false);
    emitColumns();
  }
  function hideColumn(ci: number) {
    const keep = vis().filter((c) => c !== ci).length;
    if (keep === 0) return;
    setHidden((h) => new Set(h).add(ci));
    setSelection([], null);
    emitColumns();
  }
  function showAllColumns() {
    setHidden(new Set<number>());
    emitColumns();
  }
  function setWidth(ci: number, w: number) {
    setWidths((arr) => {
      const a = arr.slice();
      a[ci] = Math.max(MIN_COL_W, Math.round(w));
      return a;
    });
  }
  function fitColumn(ci: number) {
    const cw = charWidth();
    const kind = kinds()[ci];
    let chars = 0;
    const n = Math.min(props.rowCount, 2000);
    for (let i = 0; i < n; i++) {
      const row = props.getRow(i);
      if (row) chars = Math.max(chars, displayLength(edited(i, ci, row[ci]), kind));
    }
    for (let i = 0; i < pending.insertedCount; i++) {
      chars = Math.max(chars, displayLength(pending.inserted(i)?.values.get(ci) ?? null, kind));
    }
    const w = Math.max(headerFit(props.columns[ci].name), Math.ceil(chars * cw + 8));
    setWidth(ci, w);
    emitColumns();
  }
  const edited = (src: number, ci: number, orig: Cell) => {
    const e = pending.edit(src, ci);
    return e ? e.value : orig;
  };
  function onResizeDown(e: MouseEvent, ci: number) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = widthOf(ci);
    startDrag(
      (ev) => setWidth(ci, w0 + ev.clientX - x0),
      () => emitColumns(),
    );
  }

  // ---- sorting ----
  function applySort(next: SortSpec[]) {
    if (!props.sort) setInternalSort(next);
    props.onSortChange?.(next);
  }
  function toggleSort(ci: number, multi: boolean) {
    const cur = sortState();
    const i = cur.findIndex((s) => s.col === ci);
    if (!multi) {
      if (i < 0) applySort([{ col: ci, dir: "asc" }]);
      else if (cur[i].dir === "asc") applySort([{ col: ci, dir: "desc" }]);
      else applySort([]);
      return;
    }
    if (i < 0) applySort([...cur, { col: ci, dir: "asc" }]);
    else if (cur[i].dir === "asc") applySort(cur.map((s, j) => (j === i ? { col: ci, dir: "desc" as const } : s)));
    else applySort(cur.filter((_, j) => j !== i));
  }
  const clearSort = () => applySort([]);

  // ---- editing ----
  function canEditCell(r: number, ci: number): boolean {
    if (!props.editable) return false;
    const col = props.columns[ci];
    if (!col || !isEditableKind(kinds()[ci], col)) return false;
    if (r >= pending.insertedCount && pending.isDeleted(srcOf(r))) return false;
    return true;
  }

  function startEdit(initial?: string) {
    const a = active();
    if (!a || edit()) return;
    const ci = vis()[a.c];
    if (!canEditCell(a.r, ci)) return;
    const text = initial !== undefined ? initial : editText(cellValue(a.r, ci));
    setEdit({ r: a.r, vi: a.c, ci, text });
    ensureVisible(a.r, a.c);
  }

  function applyValue(r: number, ci: number, v: Cell) {
    const ni = pending.insertedCount;
    if (r < ni) pending.setInsertedValue(r, ci, v);
    else {
      const src = srcOf(r);
      pending.setEdit(src, ci, v, props.getRow(src)?.[ci] ?? null);
    }
  }

  function commitEdit(text: string, refocus = false) {
    const ed = edit();
    if (!ed) return;
    setEdit(null);
    if (refocus) root.focus({ preventScroll: true });
    const kind = kinds()[ed.ci];
    const cur = cellValue(ed.r, ed.ci);
    if (text === editText(cur)) return; // unchanged
    applyValue(ed.r, ed.ci, parseEdit(text, kind));
  }
  function cancelEdit() {
    if (!edit()) return;
    setEdit(null);
    root.focus({ preventScroll: true });
  }

  function openValueEditor() {
    const a = active();
    if (!a) return;
    const ci = vis()[a.c];
    const v = cellValue(a.r, ci);
    setValueEd({
      r: a.r,
      vi: a.c,
      ci,
      text: editText(v),
      readOnly: !canEditCell(a.r, ci),
    });
  }

  function selectedRows(): number[] {
    const set = new Set<number>();
    for (const g of ranges()) for (let r = g.r0; r <= g.r1; r++) set.add(r);
    return [...set].sort((a, b) => a - b);
  }
  function selectedCells(): CellPos[] {
    const seen = new Set<number>();
    const out: CellPos[] = [];
    const n = nCols();
    for (const g of ranges())
      for (let r = g.r0; r <= g.r1; r++)
        for (let c = g.c0; c <= g.c1; c++) {
          const key = r * n + c;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ r, c });
          }
        }
    return out;
  }

  function addRow() {
    if (!props.editable) return;
    const c = active()?.c ?? 0;
    pending.addInserted();
    scroller.scrollTop = 0;
    selectCell(0, c);
  }
  function cloneRow() {
    const a = active();
    if (!props.editable || !a) return;
    const m = new Map<number, Cell>();
    props.columns.forEach((_, ci) => m.set(ci, cellValue(a.r, ci)));
    pending.addInserted(m);
    scroller.scrollTop = 0;
    selectCell(0, a.c);
  }
  function deleteRows() {
    if (!props.editable) return;
    const rows = selectedRows();
    if (!rows.length) return;
    const ni = pending.insertedCount;
    const insIdx = rows.filter((r) => r < ni);
    const srcs = rows.filter((r) => r >= ni).map(srcOf);
    batch(() => {
      const allDeleted = srcs.length > 0 && srcs.every((s) => pending.isDeleted(s));
      for (const s of srcs) pending.setDeleted(s, !allDeleted);
      for (const i of insIdx.sort((a, b) => b - a)) pending.removeInserted(i);
      if (insIdx.length) {
        const keep = active();
        if (keep) selectCell(Math.min(keep.r, Math.max(0, total() - 1)), keep.c);
      }
    });
  }
  function revertSelected() {
    const rows = selectedRows();
    const ni = pending.insertedCount;
    batch(() => {
      for (const r of rows.filter((x) => x < ni).sort((a, b) => b - a)) pending.removeInserted(r);
      for (const r of rows.filter((x) => x >= ni)) pending.revertRow(srcOf(r));
    });
  }
  function setSelectedCells(v: Cell) {
    if (!props.editable) return;
    batch(() => {
      for (const { r, c } of selectedCells()) {
        const ci = vis()[c];
        if (canEditCell(r, ci)) applyValue(r, ci, v);
      }
    });
  }
  const setNull = () => setSelectedCells(null);
  const setDefault = () => setSelectedCells(DEFAULT_VALUE);

  async function submit() {
    if (pending.isEmpty() || !props.onSubmit) return;
    const changes = api.getChanges();
    try {
      const res = await props.onSubmit(changes);
      if (res !== false) pending.revertAll();
    } catch {
      /* host reports the error; keep changes pending */
    }
  }

  createEffect(
    on(
      () => pending.version(),
      () => props.onChangesChange?.(pending.count()),
      { defer: true },
    ),
  );

  // ---- clipboard ----
  function selectionBlock(): { cols: CopyColumn[]; rows: Cell[][] } | null {
    const rs = ranges();
    if (!rs.length) return null;
    const rowSet = new Set<number>();
    const colSet = new Set<number>();
    for (const g of rs) {
      for (let r = g.r0; r <= g.r1; r++) rowSet.add(r);
      for (let c = g.c0; c <= g.c1; c++) colSet.add(c);
    }
    const rows = [...rowSet].sort((a, b) => a - b);
    const cs = [...colSet].sort((a, b) => a - b);
    const single = rs.length === 1;
    const v = vis();
    const out: Cell[][] = rows.map((r) => cs.map((c) => (single || inSel(r, c) ? cellValue(r, v[c]) : undefined)));
    return { cols: cs.map((c) => ({ name: props.columns[v[c]].name, typeName: props.columns[v[c]].typeName })), rows: out };
  }
  function selectionText(format: CopyFormat): string {
    const b = selectionBlock();
    if (!b) return "";
    return formatRows(format, b.cols, b.rows, { tableName: props.tableName, header: format === "csv" || format === "markdown" ? true : false });
  }
  function writeClipboard(text: string, format: CopyFormat) {
    if (props.onCopy) {
      props.onCopy(text, format);
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    } else legacyCopy(text);
  }
  function legacyCopy(text: string) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
      root.focus({ preventScroll: true });
    }
  }
  function copy(format: CopyFormat = "tsv") {
    const t = selectionText(format);
    if (t) writeClipboard(t, format);
  }
  function pasteText(text: string) {
    const a = active();
    if (!props.editable || !a || !text) return;
    const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    batch(() => {
      lines.forEach((line, i) => {
        const r = a.r + i;
        if (r >= total()) return;
        line.split("\t").forEach((cellText, j) => {
          const c = a.c + j;
          if (c >= nCols()) return;
          const ci = vis()[c];
          if (canEditCell(r, ci)) applyValue(r, ci, parseEdit(cellText, kinds()[ci]));
        });
      });
    });
  }
  function onPaste(e: ClipboardEvent) {
    if (!props.editable || edit() || !active()) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    pasteText(text);
  }
  function pasteFromClipboard() {
    navigator.clipboard?.readText().then(pasteText).catch(() => {
      /* clipboard read denied: Ctrl+V (paste event) still works */
    });
  }

  // ---- keyboard ----
  function move(dr: number, dc: number, shift: boolean, ctrl: boolean) {
    const a = active() ?? { r: 0, c: 0 };
    const t = total();
    const n = nCols();
    if (t === 0 || n === 0) return;
    let r = a.r;
    let c = a.c;
    if (!active()) {
      selectCell(0, 0);
      return;
    }
    if (ctrl) {
      if (dr) r = dr < 0 ? 0 : t - 1;
      if (dc) c = dc < 0 ? 0 : n - 1;
    } else {
      r += dr;
      c += dc;
    }
    r = Math.max(0, Math.min(t - 1, r));
    c = Math.max(0, Math.min(n - 1, c));
    if (shift) extendTo(r, c);
    else selectCell(r, c);
  }
  const pageRows = () => Math.max(1, Math.floor((scroller.clientHeight - HEADER_H) / ROW_H) - 1);

  function onKeyDown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest?.(".dgg-editor, .dgg-ve, .dgg-menu")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const alt = e.altKey;
    const shift = e.shiftKey;
    let handled = true;
    if (k === "ArrowDown" && !alt && true) move(1, 0, shift, mod);
    else if (k === "ArrowUp" && !alt) move(-1, 0, shift, mod);
    else if (k === "ArrowRight" && !alt) move(0, 1, shift, mod);
    else if (k === "ArrowLeft" && !alt) move(0, -1, shift, mod);
    else if (k === "Home") move(mod ? -total() : 0, -nCols(), shift, false) /* ctrl: first row too */;
    else if (k === "End") move(mod ? total() : 0, nCols(), shift, false);
    else if (k === "PageDown") move(pageRows(), 0, shift, false);
    else if (k === "PageUp") move(-pageRows(), 0, shift, false);
    else if (k === "Tab") {
      const a = active();
      if (!a) selectCell(0, 0);
      else if (shift) {
        if (a.c > 0) selectCell(a.r, a.c - 1);
        else if (a.r > 0) selectCell(a.r - 1, nCols() - 1);
      } else if (a.c < nCols() - 1) selectCell(a.r, a.c + 1);
      else if (a.r < total() - 1) selectCell(a.r + 1, 0);
    } else if (k === "Enter" && mod && !alt) submit();
    else if (k === "Enter" && shift && !mod) openValueEditor();
    else if (k === "Enter" || k === "F2") startEdit();
    else if (k === "Escape") {
      if (ranges().length > 1 || (ranges()[0] && (ranges()[0].r0 !== ranges()[0].r1 || ranges()[0].c0 !== ranges()[0].c1))) {
        const a = active();
        if (a) selectCell(a.r, a.c);
      } else handled = false;
    } else if (k === "Delete" || (k.toLowerCase() === "y" && mod && !alt && !shift)) deleteRows();
    else if (k === "Insert" && alt) addRow();
    else if (k === "Insert" && mod) copy("tsv");
    else if (k.toLowerCase() === "d" && mod && alt) setDefault();
    else if (k.toLowerCase() === "d" && mod && !alt && !shift) cloneRow();
    else if (k.toLowerCase() === "n" && mod && alt) setNull();
    else if (k.toLowerCase() === "z" && mod && alt) revertSelected();
    else if (k.toLowerCase() === "a" && mod) selectAll();
    else if (k.toLowerCase() === "c" && mod && !alt) copy("tsv");
    else if (k === " " && mod) {
      const a = active();
      if (a) selectCols(a.c, a.c, false);
    } else if (k === " " && shift) {
      const a = active();
      if (a) selectRows(a.r, a.r, false);
    } else if (k === "F5" && mod) props.onReload?.();
    else if (k.length === 1 && !mod && !alt && props.editable) {
      startEdit(k);
      // the editor mounts with the typed character as its text; swallow the key so it is not inserted twice
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---- context menu ----
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function copyAsItems(): MenuItem[] {
    return (["tsv", "csv", "json", "sql", "markdown"] as CopyFormat[]).map((f) => ({
      label: COPY_FORMAT_LABELS[f] + (f === "tsv" ? " (default)" : ""),
      onSelect: () => copy(f),
    }));
  }

  function bodyMenu(): MenuItem[] {
    const a = active();
    const has = !!a;
    const ed = !!props.editable;
    const cellEditable = has && canEditCell(a!.r, vis()[a!.c]);
    return [
      { label: "Edit Cell", shortcut: "Enter", disabled: !cellEditable, onSelect: () => startEdit() },
      { label: "Show Value Editor", shortcut: "Shift+Enter", disabled: !has, onSelect: openValueEditor },
      { label: "Set NULL", shortcut: "Ctrl+Alt+N", disabled: !ed || !has, onSelect: setNull },
      { label: "Set DEFAULT", shortcut: "Ctrl+Alt+D", disabled: !ed || !has, onSelect: setDefault },
      { separator: true },
      { label: "Add Row", shortcut: "Alt+Insert", disabled: !ed, onSelect: addRow },
      { label: "Clone Row", shortcut: "Ctrl+D", disabled: !ed || !has, onSelect: cloneRow },
      { label: "Delete Rows", shortcut: "Ctrl+Y", disabled: !ed || !has, onSelect: deleteRows },
      { label: "Revert Selected", shortcut: "Ctrl+Alt+Z", disabled: !ed || pending.isEmpty(), onSelect: revertSelected },
      { separator: true },
      { label: "Copy", shortcut: "Ctrl+C", disabled: !has, onSelect: () => copy("tsv") },
      { label: "Copy As", disabled: !has, submenu: copyAsItems() },
      { label: "Paste", shortcut: "Ctrl+V", disabled: !ed || !has, onSelect: pasteFromClipboard },
      { separator: true },
      { label: "Select All", shortcut: "Ctrl+A", onSelect: selectAll },
      { label: "Reload Page", shortcut: "Ctrl+F5", disabled: !props.onReload, onSelect: () => props.onReload?.() },
    ];
  }
  function headerMenu(ci: number): MenuItem[] {
    const s = sortState();
    const cur = s.find((x) => x.col === ci);
    const hiddenList = [...hidden()].sort((a, b) => a - b);
    return [
      { label: "Sort Ascending", checked: cur?.dir === "asc", onSelect: () => applySort([{ col: ci, dir: "asc" }]) },
      { label: "Sort Descending", checked: cur?.dir === "desc", onSelect: () => applySort([{ col: ci, dir: "desc" }]) },
      { label: "Clear Sorting", shortcut: "Ctrl+Alt+Shift+Backspace", disabled: s.length === 0, onSelect: clearSort },
      { separator: true },
      { label: "Copy Column Name", onSelect: () => writeClipboard(props.columns[ci].name, "tsv") },
      { label: "Copy", shortcut: "Ctrl+C", onSelect: () => copy("tsv") },
      { label: "Copy As", submenu: copyAsItems() },
      { separator: true },
      { label: "Fit Column Width", onSelect: () => fitColumn(ci) },
      { label: "Hide Column", disabled: vis().length < 2, onSelect: () => hideColumn(ci) },
      {
        label: "Show Hidden Columns",
        disabled: hiddenList.length === 0,
        submenu: [
          { label: "Show All", onSelect: showAllColumns },
          { separator: true },
          ...hiddenList.map((h) => ({
            label: props.columns[h]?.name ?? String(h),
            onSelect: () => {
              setHidden((x) => {
                const n = new Set(x);
                n.delete(h);
                return n;
              });
              emitColumns();
            },
          })),
        ],
      },
    ];
  }
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    if ((e.target as Element).closest(".dgg-editor, .dgg-ve, .dgg-overlay")) return;
    const p = toData(e);
    if (isScrollbar(e)) return;
    if (p.inHeader) {
      const vi = colAt(p.x);
      if (vi < 0) return;
      setMenu({ x: e.clientX, y: e.clientY, items: headerMenu(vis()[vi]) });
      return;
    }
    if (p.inGutter || (p.y >= 0 && p.y < bodyH() && colAt(p.x) >= 0)) {
      setMenu({ x: e.clientX, y: e.clientY, items: bodyMenu() });
    }
  }

  // ---- status / selection info ----
  createEffect(() => {
    const a = active();
    const rs = ranges();
    if (!props.onSelectionChange) return;
    let cells = 0;
    for (const g of rs) cells += (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1);
    let numeric: SelectionInfo["numeric"] = null;
    if (cells > 1 && cells <= 50000) {
      let count = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const { r, c } of untrack(selectedCells)) {
        const v = untrack(() => cellValue(r, vis()[c]));
        const n = typeof v === "number" ? v : typeof v === "string" && kinds()[vis()[c]] === "number" ? Number(v) : NaN;
        if (!Number.isNaN(n)) {
          count++;
          sum += n;
          min = Math.min(min, n);
          max = Math.max(max, n);
        }
      }
      if (count) numeric = { count, sum, min, max };
    }
    props.onSelectionChange({ row: a ? a.r + 1 : null, col: a ? a.c + 1 : null, cells, numeric });
  });

  // ---- public api ----
  const api: DataGridApi = {
    getChanges: () => pending.toChanges(props.columns, (src) => props.getRow(src)),
    hasChanges: () => !pending.isEmpty(),
    revert: () => pending.revertAll(),
    revertSelected,
    clearChanges: () => pending.revertAll(),
    addRow,
    cloneRow,
    deleteRows,
    setNull,
    setDefault,
    submit: () => void submit(),
    getSelectionText: selectionText,
    copy,
    selectAll,
    scrollToRow: (row) => {
      scroller.scrollTop = Math.max(0, row * ROW_H);
    },
    focus: () => root.focus({ preventScroll: true }),
    openValueEditor,
    showAllColumns,
    clearSort,
  };
  props.apiRef?.(api);

  const hasSelectionAt = (r: number) => {
    const a = active();
    return !!a && a.r === r;
  };

  // ---- value editor placement ----
  const editorStyle = (ed: EditState): JSX.CSSProperties => {
    const X = colX();
    return {
      left: X[ed.vi] + "px",
      top: ed.r * ROW_H + "px",
      width: X[ed.vi + 1] - X[ed.vi] + "px",
      height: ROW_H + "px",
    };
  };

  const tableView = (
    <div
      ref={scroller}
      class="dgg-scroller"
      onScroll={onScrollSync}
      onMouseDown={onBodyMouseDown}
      onDblClick={onBodyDblClick}
    >
      <div class="dgg-sizer" style={{ width: gutterW() + totalW() + "px", height: HEADER_H + bodyH() + "px" }}>
        <div class="dgg-header">
          <div class="dgg-corner" style={{ width: gutterW() + "px" }} />
          <For each={hdrCols()}>
            {(ci) => {
              const vi = () => visPos().get(ci) ?? 0;
              const sortIdx = () => sortState().findIndex((s) => s.col === ci);
              const dir = () => sortState()[sortIdx()]?.dir;
              return (
                <div
                  class="dgg-hc"
                  classList={{ sel: colHasSel(vi()), dragging: dragCol() === ci }}
                  style={{ left: gutterW() + (colX()[vi()] ?? 0) + "px", width: widthOf(ci) + "px" }}
                  onMouseDown={(e) => onHeaderMouseDown(e, ci)}
                >
                  <i class={"dgg-ico " + iconClass(props.columns[ci])} />
                  <span class="dgg-hname" title={`${props.columns[ci].name}  ${props.columns[ci].typeName}`}>
                    {props.columns[ci].name}
                  </span>
                  <button
                    class="dgg-hbtn funnel"
                    title="Column filter"
                    tabIndex={-1}
                    onClick={(e) => props.onColumnFilter?.(ci, (e.currentTarget as HTMLElement).getBoundingClientRect())}
                  />
                  <button
                    class="dgg-hbtn sort"
                    classList={{ on: sortIdx() >= 0 }}
                    title={sortIdx() < 0 ? "Sort (Ctrl+click: add to sort)" : dir() === "asc" ? "Ascending" : "Descending"}
                    tabIndex={-1}
                    onClick={(e) => toggleSort(ci, e.ctrlKey || e.shiftKey || e.metaKey)}
                  >
                    <Show
                      when={sortIdx() >= 0}
                      fallback={
                        <svg width="16" height="16" viewBox="0 0 16 16">
                          <path d="M6 6.5L8 4.5L10 6.5ZM6 9.5L8 11.5L10 9.5Z" fill="currentColor" />
                        </svg>
                      }
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d={dir() === "asc" ? "M4.5 9.5L8 6L11.5 9.5" : "M4.5 6.5L8 10L11.5 6.5"} />
                      </svg>
                      <Show when={sortState().length > 1}>
                        <span class="dgg-snum">{sortIdx() + 1}</span>
                      </Show>
                    </Show>
                  </button>
                  <div class="dgg-resize" onMouseDown={(e) => onResizeDown(e, ci)} onDblClick={(e) => (e.stopPropagation(), fitColumn(ci))} />
                </div>
              );
            }}
          </For>
          <Show when={dropAt() !== null}>
            <div class="dgg-drop" style={{ left: gutterW() + (colX()[dropAt()!] ?? 0) + "px" }} />
          </Show>
        </div>

        <div class="dgg-body" style={{ height: bodyH() + "px" }}>
          <div class="dgg-gutter" style={{ width: gutterW() + "px", height: bodyH() + "px" }}>
            <For each={rowList()}>
              {(r) => (
                <div
                  class="dgg-gr"
                  classList={{
                    cur: hasSelectionAt(r),
                    sel: rowFullySel(r),
                    ins: rowState(r) === "ins",
                    del: rowState(r) === "del",
                    mod: rowState(r) === "mod",
                  }}
                  style={{ top: r * ROW_H + "px" }}
                >
                  {r + 1}
                </div>
              )}
            </For>
          </div>
          <div class="dgg-data" style={{ left: gutterW() + "px", width: totalW() + "px", height: bodyH() + "px" }}>
            <div class="dgg-underlay">
              <Show when={active()}>
                <div class="dgg-u cur" style={{ top: active()!.r * ROW_H + "px", width: totalW() + "px", height: ROW_H + "px" }} />
              </Show>
              <For each={changeRects()}>
                {(q) => <div class={"dgg-u " + q.k} style={{ left: q.x + "px", top: q.y + "px", width: q.w + "px", height: q.h + "px" }} />}
              </For>
              <For each={selRects()}>
                {(q) => <div class="dgg-u sel" style={{ left: q.x + "px", top: q.y + "px", width: q.w + "px", height: q.h + "px" }} />}
              </For>
            </div>
            <For each={rowList()}>
              {(r) => <div class="dgg-row" style={{ top: r * ROW_H + "px", width: totalW() + "px" }} innerHTML={rowHtml(r)} />}
            </For>
            <Show when={edit()}>
              {(ed) => <CellEditor state={ed()} style={editorStyle(ed())} right={isRightAligned(kinds()[ed().ci], cellValue(ed().r, ed().ci))} onCommit={commitEdit} onCancel={cancelEdit} onValueEditor={(t) => {
                const s = edit();
                if (!s) return;
                setEdit(null);
                setValueEd({ r: s.r, vi: s.vi, ci: s.ci, text: t, readOnly: false });
              }} onTab={(back, t) => {
                const s = edit();
                if (!s) return;
                commitEdit(t, true);
                const nc = s.vi + (back ? -1 : 1);
                if (nc >= 0 && nc < nCols()) selectCell(s.r, nc);
                root.focus({ preventScroll: true });
              }} />}
            </Show>
          </div>
        </div>
      </div>
    </div>
  );

  const empty = () => props.rowCount === 0 && pending.insertedCount === 0;

  return (
    <div
      ref={root}
      class="dgg"
      style={{ "letter-spacing": ls() ? ls() + "px" : undefined }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onPaste={onPaste}
      onCopy={(e) => {
        if (edit() || (e.target as HTMLElement).closest?.(".dgg-ve")) return;
        e.preventDefault();
        const t = selectionText("tsv");
        if (t) e.clipboardData?.setData("text/plain", t);
      }}
    >
      <Show when={(props.viewMode ?? "table") === "text"} fallback={tableView}>
        <TextView columns={props.columns} rowCount={props.rowCount} getRow={props.getRow} version={props.version} />
      </Show>
      <Show when={empty() && (props.viewMode ?? "table") === "table"}>
        <div class="dgg-empty" style={{ top: HEADER_H + 1 + "px" }}>
          No rows
        </div>
      </Show>
      <div class="dgg-overlay">{props.children}</div>
      <Show when={menu()}>{(m) => <GridMenu x={m().x} y={m().y} items={m().items} onClose={() => (setMenu(null), root.focus({ preventScroll: true }))} />}</Show>
      <Show when={valueEd()}>
        {(v) => (
          <div class="dgg-ve-wrap" onMouseDown={() => (setValueEd(null), root.focus({ preventScroll: true }))}>
            <ValueEditor
              title={props.columns[v().ci].name}
              typeName={props.columns[v().ci].typeName}
              text={v().text}
              readOnly={v().readOnly || isBinaryCell(cellValue(v().r, v().ci))}
              json={kinds()[v().ci] === "json"}
              onApply={(t) => {
                const s = v();
                setValueEd(null);
                if (t !== editText(cellValue(s.r, s.ci))) applyValue(s.r, s.ci, parseEdit(t, kinds()[s.ci]));
                root.focus({ preventScroll: true });
              }}
              onCancel={() => (setValueEd(null), root.focus({ preventScroll: true }))}
            />
          </div>
        )}
      </Show>
    </div>
  );
}

interface CellEditorProps {
  state: { r: number; vi: number; ci: number; text: string };
  style: JSX.CSSProperties;
  right: boolean;
  onCommit: (text: string, refocus?: boolean) => void;
  onCancel: () => void;
  onValueEditor: (text: string) => void;
  onTab: (back: boolean, text: string) => void;
}

function CellEditor(props: CellEditorProps): JSX.Element {
  let input!: HTMLInputElement;
  let done = false;
  onMount(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return (
    <input
      ref={input}
      class="dgg-editor"
      classList={{ r: props.right }}
      style={props.style}
      value={props.state.text}
      spellcheck={false}
      onMouseDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onBlur={() => {
        if (done) return;
        done = true;
        props.onCommit(input.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          done = true;
          props.onValueEditor(input.value);
        } else if (e.key === "Enter") {
          e.preventDefault();
          done = true;
          props.onCommit(input.value, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          done = true;
          props.onCancel();
        } else if (e.key === "Tab") {
          e.preventDefault();
          done = true;
          props.onTab(e.shiftKey, input.value);
        }
      }}
    />
  );
}
