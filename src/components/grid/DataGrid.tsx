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
import { Portal } from "solid-js/web";
import { settings } from "../../state/settings";
import { computeAggregates, formatStat, type Aggregates } from "./aggregates";
import { COPY_FORMAT_LABELS, formatRows, type CopyColumn } from "./copy";
import { DateEditor } from "./DateEditor";
import { DEFAULT_FIND_OPTIONS, compileQuery, findNextMatch, type FindOptions } from "./find";
import { FindBar } from "./FindBar";
import { LocalFilterPopup } from "./LocalFilterPopup";
import { NULL_KEY, countMatches, countValues, type ValueCount } from "./localFilter";
import { ManageColumns } from "./ManageColumns";
import { SidePanel, type SideDock } from "./SidePanel";
import { cellRect, indexAt, prefixSums, recordWidth, toLogical, toScreen, windowOf } from "./transpose";
import { measuredViewport } from "./viewport";
import { logicalPos, logicalShift, scrollExtent, scrollPos } from "./virtualScroll";
import {
  DEFAULT_VALUE,
  classifyType,
  compareKeys,
  displayCell,
  displayLength,
  editText,
  isBinaryCell,
  isEditableKind,
  isExprCell,
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
  GridNavigation,
  GridViewState,
  SelRange,
  SideTab,
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
/** Transposed layout: record columns are fitted to the first rows only (the rest get a default width). */
const REC_FIT_ROWS = 3000;
const REC_DEFAULT_W = recordWidth(17);
const REC_MIN_W = 40;
const REC_MAX_W = 460;
/** Width of the column-name gutter of the transposed layout: icon + name (measured: 11 chars -> 132px with its border). */
const nameGutterW = (maxChars: number) => Math.max(60, Math.round(maxChars * CHAR_W + 44));

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
  /** Pinned (frozen) column indexes. */
  pinned?: number[];
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
  /** Funnel button of a column header. Omit it to get the built-in local filter popup. */
  onColumnFilter?: (column: number, anchor: DOMRect) => void;
  onSelectionChange?: (info: SelectionInfo) => void;
  onColumnsChange?: (state: ColumnsState) => void;
  /** Order / hidden / widths / pinned to restore when the columns are (re)loaded (kept per result tab by the host). */
  initialColumns?: ColumnsState;
  /** Foreign key navigation (`Go To`, F4). */
  navigation?: GridNavigation;
  /** Name of the data extractor for the cell menu entry `Change Data Extractor (CSV)`; omit both to hide it. */
  extractorLabel?: string;
  onChangeExtractor?: (at: { x: number; y: number }) => void;
  /** `Export Table to Clipboard` of the cell menu; omitted = no entry. */
  onExportToClipboard?: () => void;
  /** SQL dialect, for the expressions offered by `Set SQL Expression`. */
  dialect?: "postgres" | "mysql" | "sqlite";
  /** Extra scroll room below the last row (the floating paging pill). */
  bottomPad?: number;
  /** Names of the columns that hold a foreign key (their icon shows the key); read reactively, no grid reset. */
  fkColumns?: () => ReadonlySet<string>;
  /** Gutter / header numbers start after this many rows (paged table editor: `offset + index + 1`). */
  rowNumberOffset?: number;
  /** Reports transpose / find / record view / local filter / hidden columns, to keep toolbar toggles in sync. */
  onViewChange?: (state: GridViewState) => void;
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

function iconClass(c: GridColumn | undefined): string {
  if (!c) return "k-col";
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

  // ---- view state ----
  const [transposed, setTransposed] = createSignal(false);
  const T = transposed;
  const [findOpen, setFindOpen] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [findOpts, setFindOpts] = createSignal<FindOptions>(DEFAULT_FIND_OPTIONS);
  const [findFilterRows, setFindFilterRows] = createSignal(false);
  const [sideTab, setSideTab] = createSignal<SideTab | null>(null);
  const [sideDock, setSideDock] = createSignal<SideDock>("right");
  const [sideTwoCol, setSideTwoCol] = createSignal(false);
  const [sideSize, setSideSize] = createSignal(0);
  const [colFilters, setColFilters] = createSignal<Map<number, Set<string>>>(new Map());
  const [lfEnabled, setLfEnabled] = createSignal(true);
  const [lfPopup, setLfPopup] = createSignal<{ ci: number; anchor: DOMRect; values: ValueCount[]; truncated: boolean } | null>(null);
  const [manage, setManage] = createSignal<{ anchor?: DOMRect; bounds: DOMRect } | null>(null);

  const findRe = createMemo(() => compileQuery(findQuery(), findOpts()));
  const findError = () => {
    const c = findRe();
    return typeof c === "string" ? c : null;
  };
  /** Cell text predicate of the open Find bar (null when closed, empty or invalid). */
  const matcher = createMemo<((t: string) => boolean) | null>(() => {
    const c = findRe();
    return findOpen() && c && typeof c !== "string" ? (t) => c.test(t) : null;
  });

  // ---- columns ----
  const iconOf = (c: GridColumn | undefined) => iconClass(c && !c.isFk && props.fkColumns?.().has(c.name) ? { ...c, isFk: true } : c);
  const kinds = createMemo<ColumnKind[]>(() => props.columns.map((c) => classifyType(c.typeName)));
  const [widths, setWidths] = createSignal<number[]>([]);
  const [order, setOrder] = createSignal<number[]>([]);
  const [hidden, setHidden] = createSignal<Set<number>>(new Set());
  const [pinned, setPinned] = createSignal<Set<number>>(new Set());
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
    const list = base.filter((c) => !h.has(c));
    const p = pinned();
    return p.size ? [...list.filter((c) => p.has(c)), ...list.filter((c) => !p.has(c))] : list;
  });
  /** Pinned (frozen) columns lead the visible ones; the transposed layout has none. */
  const nPinned = createMemo(() => {
    if (T()) return 0;
    const p = pinned();
    return p.size ? vis().filter((c) => p.has(c)).length : 0;
  });
  const pinW = () => colX()[nPinned()] ?? 0;
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
  const totalW = () => hX()[hX().length - 1];

  // ---- rows ----
  const insCount = createMemo(() => pending.insertedCount);
  const rowOff = () => props.rowNumberOffset ?? 0;
  const nameW = createMemo(() => nameGutterW(props.columns.reduce((m, c) => Math.max(m, c.name.length), 0)));

  /** Value key of a cell for the local filter (what the popup lists and compares). */
  const keyOf = (v: Cell, kind: ColumnKind) => (v === null || v === undefined ? NULL_KEY : displayCell(v, kind, 100000, "").text);

  /** Row predicate of the active local filters and of the Find bar's "Filter rows" (null = every row passes). */
  const rowFilter = createMemo<((row: Cell[]) => boolean) | null>(() => {
    const preds: ((row: Cell[]) => boolean)[] = [];
    if (lfEnabled()) {
      for (const [ci, allowed] of colFilters()) {
        const kind = kinds()[ci];
        preds.push((row) => allowed.has(keyOf(row[ci] ?? null, kind)));
      }
    }
    const m = findFilterRows() ? matcher() : null;
    if (m) {
      const v = vis();
      const k = kinds();
      const nt = settings.gridNullText;
      preds.push((row) => v.some((ci) => m(displayCell(row[ci] ?? null, k[ci], 400, nt).text)));
    }
    return preds.length ? (row) => preds.every((f) => f(row)) : null;
  });

  /** Display order of the source rows after the local filter and the local sort (null = natural order, every row). */
  const rowOrder = createMemo<Int32Array | null>(() => {
    const s = sortState();
    touch(props.version);
    const n = props.rowCount;
    const local = (props.sortMode ?? "local") === "local" && s.length > 0;
    const filt = rowFilter();
    if ((!local && !filt) || n === 0) return null;
    let idx: Int32Array;
    if (filt) {
      const keep: number[] = [];
      for (let i = 0; i < n; i++) {
        const row = props.getRow(i);
        if (row && filt(row)) keep.push(i);
      }
      idx = Int32Array.from(keep);
    } else {
      idx = new Int32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
    }
    if (local) {
      const keyCols = s.map((sp) => {
        const keys: (number | string | null)[] = new Array(n);
        const kind = kinds()[sp.col];
        for (let i = 0; i < n; i++) {
          const row = props.getRow(i);
          keys[i] = row ? sortKey(row[sp.col], kind) : null;
        }
        return { keys, sign: sp.dir === "asc" ? 1 : -1 };
      });
      idx.sort((a, b) => {
        for (const kc of keyCols) {
          const d = compareKeys(kc.keys[a], kc.keys[b]);
          if (d !== 0) return d * kc.sign;
        }
        return a - b;
      });
    }
    return idx;
  });
  const viewCount = () => rowOrder()?.length ?? props.rowCount;
  const total = createMemo(() => insCount() + viewCount());
  const gutterW = createMemo(() => (T() ? nameW() : Math.max(32, String(Math.max(rowOff() + total(), 1)).length * 8 + 16)));
  /** Number of screen rows (vertical axis): records normally, visible columns when transposed. */
  const vCount = () => (T() ? vis().length : total());
  const bodyH = () => vCount() * ROW_H;

  const invCache = new WeakMap<Int32Array, Int32Array>();
  /** Source row -> display position (-1 when filtered out). */
  const invOf = (o: Int32Array) => {
    let inv = invCache.get(o);
    if (!inv) {
      inv = new Int32Array(props.rowCount).fill(-1);
      for (let i = 0; i < o.length; i++) inv[o[i]] = i;
      invCache.set(o, inv);
    }
    return inv;
  };
  /** Source row of display row `r` (-1 for inserted rows). */
  const srcOf = (r: number) => {
    const k = r - insCount();
    if (k < 0) return -1;
    const o = rowOrder();
    return o ? o[k] : k;
  };

  /** Transposed layout: widths of the record columns, fitted to the first rows (see `recordWidth`). */
  const recX = createMemo<Float64Array>(() => {
    if (!T()) return new Float64Array(1);
    touch(props.version);
    const n = total();
    const ni = insCount();
    const o = rowOrder();
    const v = vis();
    const k = kinds();
    const nt = settings.gridNullText;
    const off = rowOff();
    const w = new Float64Array(n);
    const scan = Math.min(n, ni + REC_FIT_ROWS);
    for (let r = 0; r < n; r++) {
      if (r < ni || r >= scan) {
        w[r] = REC_DEFAULT_W;
        continue;
      }
      const row = props.getRow(o ? o[r - ni] : r - ni);
      if (!row) {
        w[r] = REC_DEFAULT_W;
        continue;
      }
      let chars = String(off + r + 1).length;
      for (let i = 0; i < v.length; i++) chars = Math.max(chars, displayLength(row[v[i]] ?? null, k[v[i]], nt));
      w[r] = Math.min(REC_MAX_W, Math.max(REC_MIN_W, recordWidth(chars)));
    }
    return prefixSums(w);
  });
  /** Prefix sums of the horizontal screen axis: visible columns normally, records when transposed. */
  const hX = createMemo<Float64Array>(() => (T() ? recX() : colX()));
  // Axes longer than SCROLL_CAP are scrolled with a scaled scrollbar (virtualScroll.ts): the scroller is `extentH` / `extentW`
  // long, `shiftV` / `shiftH` turn logical coordinates (row * ROW_H, prefix sums) into scroller coordinates.
  const dataViewH = () => Math.max(0, viewH() - HEADER_H);
  const dataViewW = () => Math.max(0, viewW() - gutterW());
  const extentH = () => scrollExtent(bodyH());
  const extentW = () => scrollExtent(totalW());
  const shiftV = createMemo(() => (bodyH() > scrollExtent(bodyH()) ? logicalShift(scrollTop(), bodyH(), dataViewH()) : 0));
  const shiftH = createMemo(() => (totalW() > scrollExtent(totalW()) ? logicalShift(scrollLeft(), totalW(), dataViewW()) : 0));

  const rowWin = createMemo<[number, number]>(
    () => {
      const t = vCount();
      const top = scrollTop() + shiftV();
      const r0 = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN_ROWS);
      const r1 = Math.min(t - 1, Math.ceil((top + viewH() - HEADER_H) / ROW_H) + OVERSCAN_ROWS);
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
      const left = scrollLeft() + shiftH();
      return windowOf(hX(), left - OVERSCAN_PX, left + viewW() - gutterW() + OVERSCAN_PX);
    },
    [0, -1],
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  const hdrCols = createMemo(() => {
    const [a, b] = colWin();
    if (T()) {
      const out: number[] = [];
      for (let r = a; r <= b; r++) out.push(r);
      return out;
    }
    return vis().slice(Math.max(a, nPinned()), b + 1);
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
  /** HTML of one cell; `fm` = Find matcher (marks matching cells that are not selected). */
  function cellHtml(r: number, vi: number, ci: number, val: Cell, x: number, w: number, right: boolean, dimUnset: boolean, nt: string, fm: ((t: string) => boolean) | null): string {
    const maxc = ((w / charWidth()) | 0) + 3;
    const d = displayCell(val, kinds()[ci], fm ? 400 : maxc, nt);
    // unset cells of a new row: dim only for NOT NULL columns without default (measured on DataGrip)
    let cls = dimUnset && val === null && (props.columns[ci].nullable !== false || props.columns[ci].isPk) ? "" : d.cls;
    let text = d.text;
    if (fm) {
      if (fm(text) && !inSel(r, vi)) cls += " fm";
      if (text.length > maxc) text = text.slice(0, maxc);
    }
    return `<div class="c${right ? " r" : ""}${cls}" style="left:${x}px;width:${w}px">${esc(text)}</div>`;
  }
  /** `pin`: the pinned columns only (drawn in the sticky layer); otherwise the windowed, unpinned ones. */
  function rowHtml(r: number, pin = false): string {
    pending.version();
    touch(props.version);
    const nt = settings.gridNullText;
    const fm = matcher();
    const X = colX();
    const v = vis();
    const np = nPinned();
    const [c0, c1] = pin ? [0, np - 1] : [Math.max(colWin()[0], np), colWin()[1]];
    const k = kinds();
    const ni = pending.insertedCount;
    let html = "";
    if (r < ni) {
      const ins = pending.inserted(r);
      for (let vi = c0; vi <= c1; vi++) {
        const ci = v[vi];
        const val = ins?.values.get(ci) ?? null;
        html += cellHtml(r, vi, ci, val, X[vi], X[vi + 1] - X[vi], isRightAligned(k[ci], val), true, nt, fm);
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
      html += cellHtml(r, vi, ci, val, X[vi], X[vi + 1] - X[vi], isRightAligned(k[ci], val), false, nt, fm);
    }
    return html;
  }
  /** Transposed layout: HTML of screen row `vi` (one column of the result) across the visible records. */
  function rowHtmlT(vi: number): string {
    pending.version();
    touch(props.version);
    const ci = vis()[vi];
    if (ci === undefined) return "";
    const nt = settings.gridNullText;
    const fm = matcher();
    const X = recX();
    const [h0, h1] = colWin();
    const shift = shiftH();
    const ni = pending.insertedCount;
    const o = rowOrder();
    let html = "";
    for (let r = h0; r <= h1; r++) {
      const x = X[r] - shift;
      const w = X[r + 1] - X[r];
      if (r < ni) {
        html += cellHtml(r, vi, ci, pending.inserted(r)?.values.get(ci) ?? null, x, w, false, true, nt, fm);
        continue;
      }
      const src = o ? o[r - ni] : r - ni;
      const row = props.getRow(src);
      if (!row) {
        html += `<div class="c sk" style="left:${x}px;width:${w}px"></div>`;
        continue;
      }
      const edits = pending.rowEdits(src);
      html += cellHtml(r, vi, ci, edits && edits.has(ci) ? edits.get(ci) : (row[ci] ?? null), x, w, false, false, nt, fm);
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
    /** The text is a raw SQL expression (`Edit as SQL Expression`), stored as `{ $expr }`. */
    expr?: boolean;
  }
  const [edit, setEdit] = createSignal<EditState | null>(null);
  /** The true / false / default list under a boolean cell. */
  const [boolPick, setBoolPick] = createSignal<{ r: number; vi: number; ci: number } | null>(null);
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
          const keep = untrack(() => props.initialColumns);
          const fits = !!keep && keep.order.length === props.columns.length && keep.widths.length === props.columns.length;
          setWidths(fits ? keep!.widths.slice() : untrack(initialWidths));
          setOrder(fits ? keep!.order.slice() : props.columns.map((_, i) => i));
          setHidden(new Set<number>(fits ? keep!.hidden : []));
          setPinned(new Set<number>(fits ? (keep!.pinned ?? []) : []));
          setInternalSort([]);
          setColFilters(new Map());
          setLfPopup(null);
          setManage(null);
          setSelection([], null);
          setEdit(null);
          setBoolPick(null);
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

  /** Logical data coordinate at the top / left of the visible data area, read from the scroller. */
  const logicalTop = () => logicalPos(scroller.scrollTop, bodyH(), scroller.clientHeight - HEADER_H);
  const logicalLeft = () => logicalPos(scroller.scrollLeft, totalW(), scroller.clientWidth - gutterW());

  function ensureVisible(r: number, c: number) {
    if (!scroller) return;
    const X = hX();
    const sp = toScreen(T(), r, c);
    const dataH = scroller.clientHeight - HEADER_H;
    const top = sp.v * ROW_H;
    const viewTop = logicalTop();
    if (top < viewTop) scroller.scrollTop = scrollPos(top, bodyH(), dataH);
    else if (top + ROW_H > viewTop + dataH) scroller.scrollTop = scrollPos(top + ROW_H - dataH, bodyH(), dataH);
    const dataW = scroller.clientWidth - gutterW();
    const left = X[sp.h] ?? 0;
    const right = X[sp.h + 1] ?? left;
    const viewLeft = logicalLeft();
    // pinned columns are always in view; the others scroll clear of the pinned block
    const pw = !T() && sp.h >= nPinned() ? pinW() : 0;
    if (!T() && sp.h < nPinned()) return;
    if (left - pw < viewLeft) scroller.scrollLeft = scrollPos(left - pw, totalW(), dataW);
    else if (right > viewLeft + dataW) scroller.scrollLeft = scrollPos(Math.min(left - pw, right - dataW), totalW(), dataW);
  }

  // underlay rectangles (logical blocks mapped through the active layout)
  const rectOf = (r0: number, r1: number, c0: number, c1: number) => {
    const q = cellRect(T(), hX(), ROW_H, r0, r1, c0, c1);
    return { ...q, x: q.x - shiftH(), y: q.y - shiftV() };
  };
  const selRects = createMemo<Rect[]>(() => {
    const out: Rect[] = [];
    const n = nCols();
    const tot = total();
    for (const g of ranges()) {
      if (g.c0 >= n || g.r0 >= tot) continue;
      out.push({ k: "sel", ...rectOf(g.r0, Math.min(g.r1, tot - 1), g.c0, Math.min(g.c1, n - 1)) });
    }
    return out;
  });
  const curRect = createMemo<Rect | null>(() => {
    const a = active();
    if (!a || a.r >= total()) return null;
    return { k: "cur", ...rectOf(a.r, a.r, 0, Math.max(0, nCols() - 1)) };
  });
  const changeRects = createMemo<Rect[]>(() => {
    pending.version();
    const out: Rect[] = [];
    if (pending.isEmpty()) return out;
    const [w0, w1] = T() ? colWin() : rowWin(); // window over display rows
    const ni = pending.insertedCount;
    const last = Math.max(0, nCols() - 1);
    const pos = visPos();
    for (let r = w0; r <= Math.min(ni - 1, w1); r++) out.push({ k: "ins", ...rectOf(r, r, 0, last) });
    const o = rowOrder();
    const inv = o ? invOf(o) : null;
    const disp = (src: number) => (inv ? inv[src] : src);
    for (const src of pending.deletedRows()) {
      const d = disp(src);
      if (d < 0) continue;
      if (d + ni >= w0 && d + ni <= w1) out.push({ k: "del", ...rectOf(d + ni, d + ni, 0, last) });
    }
    for (const [src, m] of pending.editedRows()) {
      const d = disp(src);
      if (d < 0) continue;
      const r = d + ni;
      if (r < w0 || r > w1 || pending.isDeleted(src)) continue;
      for (const ci of m.keys()) {
        const vi = pos.get(ci);
        if (vi === undefined) continue;
        out.push({ k: "mod", ...rectOf(r, r, vi, vi) });
      }
    }
    const a = active();
    if (a && a.r < ni) out.push({ k: "tint", ...rectOf(a.r, a.r, 0, last) });
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
      // a hidden pane measures 0 x 0: keep the last size, or the rows built meanwhile lack every column from the third on
      const v = measuredViewport(scroller.clientWidth, scroller.clientHeight, { w: viewW(), h: viewH() });
      batch(() => {
        setViewW(v.w);
        setViewH(v.h);
      });
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
    const r1 = T() ? colWin()[1] : rowWin()[1];
    if (!props.hasMore || props.loadingMore || !props.onNeedMore) return;
    const pageRows = T() ? 30 : Math.ceil(viewH() / ROW_H);
    if (r1 >= total() - Math.max(60, pageRows * 2) && lastNeedMoreFor !== n) {
      lastNeedMoreFor = n;
      props.onNeedMore();
    }
  });

  // ---- hit testing ----
  /** Index of the horizontal axis entry (column normally, record when transposed) under data x; -1 outside. */
  const colAt = (x: number) => indexAt(hX(), x);

  function toData(e: { clientX: number; clientY: number }) {
    const rect = scroller.getBoundingClientRect();
    // the pinned block does not scroll: a pointer over it hits those columns whatever the scroll offset
    const vx = e.clientX - rect.left - gutterW();
    const onPin = nPinned() > 0 && vx >= 0 && vx < pinW();
    return {
      x: onPin ? vx : vx + logicalLeft(),
      y: e.clientY - rect.top + logicalTop() - HEADER_H,
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

  /** Screen row (vertical axis) under data y, clamped. */
  const clampV = (y: number) => Math.max(0, Math.min(vCount() - 1, Math.floor(y / ROW_H)));
  /** Horizontal axis entry under data x, clamped. */
  const clampH = (x: number) => {
    const c = colAt(x);
    return c >= 0 ? c : x < 0 ? 0 : Math.max(0, hX().length - 2);
  };
  const clampCell = (p: { x: number; y: number }): CellPos => toLogical(T(), clampV(p.y), clampH(p.x));
  /** Logical cell under a data point, null outside the cells. */
  function cellAtPoint(p: { x: number; y: number }): CellPos | null {
    if (p.y < 0 || p.y >= bodyH()) return null;
    const h = colAt(p.x);
    if (h < 0) return null;
    return toLogical(T(), Math.floor(p.y / ROW_H), h);
  }

  function onBodyMouseDown(e: MouseEvent) {
    if (e.button !== 0 && e.button !== 2) return;
    if ((e.target as Element).closest(".dgg-header, .dgg-ew, .dgg-bool")) return;
    if (isScrollbar(e) || total() === 0 || nCols() === 0) return;
    const p = toData(e);
    if (p.inHeader) return;
    if (p.y < 0 || p.y >= bodyH()) return;
    const mod = e.ctrlKey || e.metaKey;
    root.focus({ preventScroll: true });

    if (p.inGutter) {
      // row numbers (normal) select a row; column names (transposed) select a column
      const t = T();
      const idx = clampV(p.y);
      const act = active();
      const at = (i: number): CellPos => (t ? { r: act?.r ?? 0, c: i } : { r: i, c: act?.c ?? 0 });
      const pick = t ? selectCols : selectRows;
      const full = t ? colSelectedFully : rowFullySel;
      if (e.button === 2 && full(idx)) return;
      if (e.shiftKey && act) pick(t ? act.c : act.r, idx, false, at(idx));
      else if (mod) pick(idx, idx, true, at(idx));
      else pick(idx, idx, false, at(idx));
      if (e.button === 2) return;
      const start = idx;
      startDrag((ev) => {
        const q = toData(ev);
        const ii = clampV(q.y);
        const g: SelRange = t
          ? { r0: 0, r1: Math.max(0, total() - 1), c0: Math.min(start, ii), c1: Math.max(start, ii) }
          : { r0: Math.min(start, ii), r1: Math.max(start, ii), c0: 0, c1: nCols() - 1 };
        setRanges((prev) => [...prev.slice(0, -1), g]);
        setActive(at(ii));
      });
      return;
    }
    const cell = cellAtPoint(p);
    if (!cell) return;
    const { r, c } = cell;
    if (e.button === 2) {
      if (!inSel(r, c)) selectCell(r, c);
      return;
    }
    if (e.shiftKey) extendTo(r, c);
    else if (mod) addCell(r, c);
    else selectCell(r, c);
    startDrag((ev) => {
      const q = clampCell(toData(ev));
      extendTo(q.r, q.c);
    });
  }

  function onBodyDblClick(e: MouseEvent) {
    if ((e.target as Element).closest(".dgg-header, .dgg-ew, .dgg-bool") || isScrollbar(e)) return;
    const p = toData(e);
    if (p.inHeader || p.inGutter) return;
    const cell = cellAtPoint(p);
    if (!cell) return;
    selectCell(cell.r, cell.c);
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
    // right-click only opens the menu: the selection stays as it is
    if (e.button === 2) return;
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
  const rowHasSel = (r: number) => ranges().some((g) => r >= g.r0 && r <= g.r1);

  /** Transposed layout: the numbered header cell of a record selects that row. */
  function onRecHeaderDown(e: MouseEvent, r: number) {
    if (e.button !== 0 && e.button !== 2) return;
    root.focus({ preventScroll: true });
    const act = active();
    const at: CellPos = { r, c: act?.c ?? 0 };
    if (e.button === 2) {
      if (!rowFullySel(r)) selectRows(r, r, false, at);
      return;
    }
    if (e.shiftKey && act) selectRows(act.r, r, false, { r, c: act.c });
    else if (e.ctrlKey || e.metaKey) selectRows(r, r, true, at);
    else selectRows(r, r, false, at);
    const start = r;
    startDrag((ev) => {
      const rr = clampH(toData(ev).x);
      setRanges((prev) => [...prev.slice(0, -1), { r0: Math.min(start, rr), r1: Math.max(start, rr), c0: 0, c1: nCols() - 1 }]);
      setActive({ r: rr, c: active()?.c ?? 0 });
    });
  }

  function emitColumns() {
    props.onColumnsChange?.({ order: order(), hidden: [...hidden()], widths: widths(), pinned: [...pinned()] });
  }
  function pinColumns(cis: number[]) {
    batch(() => {
      setPinned((p) => new Set([...p, ...cis]));
      setSelection([], null);
    });
    if (scroller) scroller.scrollLeft = 0;
    emitColumns();
  }
  function unpinColumn(ci: number) {
    batch(() => {
      setPinned((p) => {
        const n = new Set(p);
        n.delete(ci);
        return n;
      });
      setSelection([], null);
    });
    emitColumns();
  }
  /** `Hide Other Columns`. */
  function hideOthers(ci: number) {
    const keep = new Set<number>([ci]);
    setHiddenSet(new Set(props.columns.map((_, i) => i).filter((c) => !keep.has(c))));
  }
  /** `Fit Columns to Window`: the visible columns share the data width in proportion to their widths. */
  function fitToWindow() {
    const v = vis();
    const w = widths();
    const sum = v.reduce((a, c) => a + (w[c] ?? 100), 0);
    const avail = scroller ? scroller.clientWidth - gutterW() : 0;
    if (!sum || avail <= 0) return;
    const k = avail / sum;
    setWidths((arr) => {
      const a = arr.slice();
      for (const c of v) a[c] = Math.max(MIN_COL_W, Math.floor((arr[c] ?? 100) * k));
      return a;
    });
    emitColumns();
  }
  /** `Reset Columns Width`: back to the widths computed from header and content. */
  function resetWidths() {
    setWidths(untrack(initialWidths));
    emitColumns();
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
  /** `Add to ORDER BY`: the column joins the sort (or changes direction in it). */
  function addSort(ci: number, dir: "asc" | "desc") {
    const cur = sortState();
    if (cur.some((x) => x.col === ci)) applySort(cur.map((x) => (x.col === ci ? { col: ci, dir } : x)));
    else applySort([...cur, { col: ci, dir }]);
  }

  // ---- editing ----
  function canEditCell(r: number, ci: number): boolean {
    if (!props.editable) return false;
    const col = props.columns[ci];
    if (!col || !isEditableKind(kinds()[ci], col)) return false;
    if (r >= pending.insertedCount && pending.isDeleted(srcOf(r))) return false;
    return true;
  }

  function startEdit(initial?: string, expr = false) {
    const a = active();
    if (!a || edit() || boolPick()) return;
    const ci = vis()[a.c];
    if (!canEditCell(a.r, ci)) return;
    ensureVisible(a.r, a.c);
    // a boolean is picked from a list (typing still opens the text field)
    if (kinds()[ci] === "bool" && initial === undefined && !expr) {
      setBoolPick({ r: a.r, vi: a.c, ci });
      return;
    }
    const cur = cellValue(a.r, ci);
    const text = initial !== undefined ? initial : expr ? (isExprCell(cur) ? cur.$expr : "") : editText(cur);
    setEdit({ r: a.r, vi: a.c, ci, text, expr });
  }
  function pickBool(b: { r: number; ci: number }, v: boolean | "default") {
    setBoolPick(null);
    root.focus({ preventScroll: true });
    applyValue(b.r, b.ci, v === "default" ? DEFAULT_VALUE : v);
  }
  /** Space on a boolean cell flips it (NULL becomes true). */
  function toggleBool(): boolean {
    const a = active();
    if (!a || ranges().length !== 1) return false;
    const ci = vis()[a.c];
    if (kinds()[ci] !== "bool" || !canEditCell(a.r, ci)) return false;
    applyValue(a.r, ci, cellValue(a.r, ci) !== true);
    return true;
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
    if (ed.expr) {
      const e = text.trim();
      if (e && !(isExprCell(cur) && cur.$expr === e)) applyValue(ed.r, ed.ci, { $expr: e });
      return;
    }
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
  const setExpression = (e: string) => setSelectedCells({ $expr: e });
  /** `Load File…`: the text of a chosen file goes into the active cell. */
  function loadFile() {
    const a = active();
    if (!a) return;
    const { r } = a;
    const ci = vis()[a.c];
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    input.onchange = () => {
      const f = input.files?.[0];
      input.remove();
      if (f) void f.text().then((t) => applyValue(r, ci, t));
    };
    input.oncancel = () => input.remove();
    document.body.appendChild(input);
    input.click();
  }

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
    if (T() && format === "tsv") {
      // the transposed grid copies what is on screen: one line per column of the result
      const flipped = b.cols.map((_, j) => b.rows.map((row) => row[j]));
      return formatRows(format, b.rows.map((_, i) => ({ name: String(i + 1), typeName: "" })), flipped, { tableName: props.tableName, header: false });
    }
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
  /** Move by screen deltas: `dv` down the vertical axis, `dh` along the horizontal one (swapped when transposed). */
  const moveScreen = (dv: number, dh: number, shift: boolean, ctrl: boolean) => (T() ? move(dh, dv, shift, ctrl) : move(dv, dh, shift, ctrl));
  /** Next cell of Tab / Shift+Tab in reading order of the active layout (null at the ends). */
  function tabTarget(r: number, c: number, back: boolean): CellPos | null {
    if (T()) {
      if (!back) return r < total() - 1 ? { r: r + 1, c } : c < nCols() - 1 ? { r: 0, c: c + 1 } : null;
      return r > 0 ? { r: r - 1, c } : c > 0 ? { r: total() - 1, c: c - 1 } : null;
    }
    if (!back) return c < nCols() - 1 ? { r, c: c + 1 } : r < total() - 1 ? { r: r + 1, c: 0 } : null;
    return c > 0 ? { r, c: c - 1 } : r > 0 ? { r: r - 1, c: nCols() - 1 } : null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest?.(".dgg-ew, .dgg-bool, .dgg-ve, .dgg-menu, .dgg-find, .dgg-side")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const alt = e.altKey;
    const shift = e.shiftKey;
    let handled = true;
    const big = Math.max(total(), nCols()) + 1;
    if (k === "ArrowDown" && !alt) moveScreen(1, 0, shift, mod);
    else if (k === "ArrowUp" && !alt) moveScreen(-1, 0, shift, mod);
    else if (k === "ArrowRight" && !alt) moveScreen(0, 1, shift, mod);
    else if (k === "ArrowLeft" && !alt) moveScreen(0, -1, shift, mod);
    else if (k === "Home") moveScreen(mod ? -big : 0, -big, shift, false) /* ctrl: first row too */;
    else if (k === "End") moveScreen(mod ? big : 0, big, shift, false);
    else if (k === "PageDown") moveScreen(pageRows(), 0, shift, false);
    else if (k === "PageUp") moveScreen(-pageRows(), 0, shift, false);
    else if (k === "Tab") {
      const a = active();
      if (!a) selectCell(0, 0);
      else {
        const t = tabTarget(a.r, a.c, shift);
        if (t) selectCell(t.r, t.c);
      }
    } else if ((k === "ArrowUp" || k === "ArrowDown") && alt && shift && !mod) {
      const ci = activeCi();
      if (ci !== null) applySort([{ col: ci, dir: k === "ArrowUp" ? "asc" : "desc" }]);
    } else if (k === "Backspace" && mod && alt && shift) clearSort();
    else if (k === "ArrowUp" && mod && alt && shift) resetWidths();
    else if (k === "F4" && !mod && !alt && !shift) {
      if (!gotoReferenced()) handled = false;
    } else if (k.toLowerCase() === "c" && mod && shift && !alt) copyAggregation();
    else if (k.toLowerCase() === "q" && mod && !alt && !shift) openDoc();
    else if (k.toLowerCase() === "w" && mod && !alt && !shift) {
      const a = active();
      if (a) selectCols(a.c, a.c, false);
    } else if (k === "Enter" && mod && shift && !alt) toggleRecordView();
    else if (k === "F12" && mod) openManageColumns();
    else if (k.toLowerCase() === "f" && mod && !alt && !shift) openFind();
    else if (k === "Enter" && mod && !alt) submit();
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
    } else if (k === " " && !mod && !alt && toggleBool()) {
      /* flipped */
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
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: () => MenuItem[]; preselect?: boolean } | null>(null);
  /** Where the menu was opened (menu entries that open a popup anchor it there; the menu is closed by then). */
  let menuPt = { x: 0, y: 0 };
  /** Quick Documentation of the column of the active cell. */
  const [doc, setDoc] = createSignal<{ x: number; y: number; ci: number } | null>(null);

  function copyAsItems(): MenuItem[] {
    return (["tsv", "csv", "json", "sql", "markdown"] as CopyFormat[]).map((f) => ({
      label: COPY_FORMAT_LABELS[f] + (f === "tsv" ? " (default)" : ""),
      onSelect: () => copy(f),
    }));
  }

  /** Values of the record of display row `r` by column name (what the host builds the target's WHERE from). */
  function recordOf(r: number): Record<string, Cell> {
    const rec: Record<string, Cell> = {};
    props.columns.forEach((c, ci) => (rec[c.name] = cellValue(r, ci)));
    return rec;
  }
  /** F4 / `Go To > Referenced Row`: opens the row the active cell's foreign key points to. False when it has none. */
  function gotoReferenced(): boolean {
    const a = active();
    const nav = props.navigation;
    if (!a || !nav || a.r >= total()) return false;
    const rec = recordOf(a.r);
    const t = nav.referenced(props.columns[vis()[a.c]].name).find((x) => !x.enabled || x.enabled(rec));
    if (!t) return false;
    t.open(rec);
    return true;
  }
  /** `Go To` submenu of the active cell, null when the host gives no navigation. */
  function goToItem(): MenuItem | null {
    const nav = props.navigation;
    const a = active();
    if (!nav) return null;
    if (!a || a.r >= total()) return { label: "Go To", disabled: true };
    const col = props.columns[vis()[a.c]].name;
    const rec = recordOf(a.r);
    const target = (t: { label: string; open: (r: Record<string, Cell>) => void; enabled?: (r: Record<string, Cell>) => boolean }, prefix = ""): MenuItem => ({
      label: prefix + t.label,
      disabled: t.enabled ? !t.enabled(rec) : false,
      onSelect: () => t.open(rec),
    });
    const refs = nav.referenced(col);
    const rels = nav.related(col);
    const items: MenuItem[] = [];
    if (refs.length === 1) items.push({ ...target(refs[0], "Referenced Row: "), shortcut: "F4" });
    else if (refs.length > 1) items.push({ label: "Referenced Row", submenu: refs.map((t) => target(t)) });
    items.push(
      rels.length
        ? { label: "Related Rows", submenu: rels.map((t) => target(t)) }
        : { label: nav.loading?.() ? "Related Rows (loading...)" : "Related Rows", disabled: true },
    );
    return { label: "Go To", submenu: items };
  }

  /** Sum of the selected numbers to the clipboard (`Copy Aggregation Result (SUM)`). */
  function copyAggregation() {
    const g = aggregates();
    if (g.countNums > 0) writeClipboard(formatStat(g.sum), "tsv");
  }
  function openDoc() {
    const a = active();
    if (!a) return;
    const r = scroller.getBoundingClientRect();
    const X = hX();
    const { v, h } = toScreen(T(), a.r, a.c);
    setDoc({ x: Math.min(window.innerWidth - 320, r.left + gutterW() + (X[h] ?? 0) - logicalLeft()), y: r.top + HEADER_H + (v + 1) * ROW_H - logicalTop() + 2, ci: vis()[a.c] });
  }

  /** Expressions `Set SQL Expression` offers for the column of the active cell. */
  function expressionChoices(ci: number): string[] {
    const k = kinds()[ci];
    const lite = props.dialect === "sqlite";
    if (k === "datetime") return lite ? ["current_timestamp"] : ["now()", "current_timestamp"];
    if (k === "date") return lite ? ["current_date"] : ["current_date", "now()"];
    if (k === "time") return ["current_time"];
    return [];
  }

  function bodyMenu(): MenuItem[] {
    pending.version();
    const a = active();
    const has = !!a;
    const ed = !!props.editable;
    const ci = has ? vis()[a!.c] : -1;
    const cellEditable = has && canEditCell(a!.r, ci);
    const kind = ci >= 0 ? kinds()[ci] : "other";
    const agg = has ? aggregates() : null;
    const exprs = ci >= 0 ? expressionChoices(ci) : [];
    const goTo = goToItem();
    const x = (list: (MenuItem | null | false | undefined)[]) => list.filter((i): i is MenuItem => !!i);
    return [
      { label: "Edit", shortcut: "Enter", disabled: !cellEditable, onSelect: () => startEdit() },
      { separator: true },
      { label: "Show Record View", shortcut: "Ctrl+Shift+Enter", icon: "record", onSelect: toggleRecordView },
      { label: "Open in Value Editor", shortcut: "Shift+Enter", disabled: !has, onSelect: openValueEditor },
      { label: "Show Aggregate View", disabled: !has, onSelect: () => showSidePanel("aggregates") },
      { separator: true },
      { label: "Revert Selected", shortcut: "Ctrl+Alt+Z", icon: "revert", disabled: !ed || pending.isEmpty(), onSelect: revertSelected },
      { separator: true },
      { label: "Edit as SQL Expression", icon: "fx", disabled: !cellEditable, onSelect: () => startEdit(undefined, true) },
      {
        label: "Set SQL Expression",
        icon: "fx",
        disabled: !ed || !has,
        submenu: [
          { label: "NULL", shortcut: "Ctrl+Alt+N", onSelect: setNull },
          { label: "DEFAULT", shortcut: "Ctrl+Alt+D", onSelect: setDefault },
          ...exprs.map((e) => ({ label: e, onSelect: () => setExpression(e) })),
        ],
      },
      ...x([kind === "text" && { label: "Load File...", disabled: !cellEditable, onSelect: loadFile }]),
      { separator: true },
      { label: "Copy", shortcut: "Ctrl+C", icon: "copy", disabled: !has, onSelect: () => copy("tsv") },
      { label: "Copy As", disabled: !has, submenu: copyAsItems() },
      { label: "Paste", shortcut: "Ctrl+V", disabled: !ed || !has, onSelect: pasteFromClipboard },
      { label: "Select All", shortcut: "Ctrl+A", onSelect: selectAll },
      ...x([
        props.onChangeExtractor && {
          label: `Change Data Extractor (${props.extractorLabel ?? "CSV"})`,
          onSelect: () => props.onChangeExtractor?.(menuPt),
        },
      ]),
      { label: "Copy Aggregation Result (SUM)", shortcut: "Ctrl+Shift+C", icon: "copy", disabled: !agg || agg.countNums === 0, onSelect: copyAggregation },
      { separator: true },
      { label: "Add Row", shortcut: "Alt+Insert", icon: "add", disabled: !ed, onSelect: addRow },
      { label: "Delete Row", shortcut: "Ctrl+Y", icon: "remove", disabled: !ed || !has, onSelect: deleteRows },
      { label: "Clone Row", shortcut: "Ctrl+D", icon: "copy", disabled: !ed || !has, onSelect: cloneRow },
      ...(goTo || props.onExportToClipboard
        ? x([{ separator: true }, goTo, props.onExportToClipboard && { label: "Export Table to Clipboard", icon: "export", onSelect: () => props.onExportToClipboard?.() }])
        : []),
      { separator: true },
      {
        label: "Set Local Filter",
        disabled: !has,
        onSelect: () => has && openColumnFilter(ci, new DOMRect(menuPt.x, menuPt.y, 0, 0)),
      },
      { label: "Local Filter By Cell Value", disabled: !has, onSelect: filterByCellValue },
      { separator: true },
      { label: "Quick Documentation", shortcut: "Ctrl+Q", disabled: !has, onSelect: openDoc },
    ];
  }
  function headerMenu(ci: number): MenuItem[] {
    const s = sortState();
    const isPinned = pinned().has(ci);
    const vi = visPos().get(ci) ?? 0;
    const asc = (add: boolean) => () => (add ? addSort(ci, "asc") : applySort([{ col: ci, dir: "asc" }]));
    const desc = (add: boolean) => () => (add ? addSort(ci, "desc") : applySort([{ col: ci, dir: "desc" }]));
    return [
      { label: "Copy Column Name", onSelect: () => writeClipboard(props.columns[ci].name, "tsv") },
      { label: "Select Column", shortcut: "Ctrl+W", onSelect: () => selectCols(vi, vi, false) },
      { separator: true },
      isPinned ? { label: "Unpin Column", icon: "pinOn", onSelect: () => unpinColumn(ci) } : { label: "Pin Column", icon: "pin", onSelect: () => pinColumns([ci]) },
      { label: "Pin Columns Up to Here", icon: "pin", onSelect: () => pinColumns(vis().slice(0, vi + 1)) },
      { separator: true },
      { label: "Hide Column", disabled: vis().length < 2, onSelect: () => hideColumn(ci) },
      { label: "Hide Other Columns", disabled: vis().length < 2, onSelect: () => hideOthers(ci) },
      { label: "Manage Columns...", shortcut: "Ctrl+F12", icon: "columns", onSelect: () => openManageColumns() },
      { separator: true },
      { label: "Fit Columns to Window", onSelect: fitToWindow },
      { label: "Reset Columns Width", shortcut: "Ctrl+Alt+Shift+Up", onSelect: resetWidths },
      { separator: true },
      { label: "ORDER BY", header: true },
      { label: "Ascending", shortcut: "Alt+Shift+Up", onSelect: asc(false) },
      { label: "Descending", shortcut: "Alt+Shift+Down", onSelect: desc(false) },
      { separator: true },
      { label: "Add to ORDER BY", header: true },
      { label: "Ascending", shortcut: "Alt+Click", disabled: s.length === 0, onSelect: asc(true) },
      { label: "Descending", shortcut: "Alt+Double Click", disabled: s.length === 0, onSelect: desc(true) },
      { separator: true },
      {
        label: "Set Local Filter",
        onSelect: () => openColumnFilter(ci, new DOMRect(menuPt.x, menuPt.y, 0, 0)),
      },
      { label: "Clear Sorting", shortcut: "Ctrl+Alt+Shift+Backspace", disabled: s.length === 0, onSelect: clearSort },
    ];
  }
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    if ((e.target as Element).closest(".dgg-ew, .dgg-bool, .dgg-ve, .dgg-overlay")) return;
    const p = toData(e);
    if (isScrollbar(e)) return;
    menuPt = { x: e.clientX, y: e.clientY };
    if (p.inHeader && !T()) {
      const vi = colAt(p.x);
      if (vi < 0) return;
      const ci = vis()[vi];
      setMenu({ x: e.clientX, y: e.clientY, items: () => headerMenu(ci), preselect: true });
      return;
    }
    if (p.inHeader || p.inGutter || (p.y >= 0 && p.y < bodyH() && colAt(p.x) >= 0)) {
      setMenu({ x: e.clientX, y: e.clientY, items: bodyMenu });
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

  // ---- transpose ----
  function toggleTranspose() {
    setTransposedView(!T());
  }
  function setTransposedView(on: boolean) {
    if (on === T()) return;
    batch(() => {
      setEdit(null);
      setDropAt(null);
      setDragCol(null);
      setTransposed(on);
    });
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
    }
    queueMicrotask(() => {
      const a = active();
      if (a) ensureVisible(a.r, a.c);
    });
  }

  // ---- find ----
  let focusFind: (() => void) | null = null;
  const cellText = (r: number, c: number): string => {
    const ci = vis()[c];
    if (r >= insCount() && !props.getRow(srcOf(r))) return "";
    return displayCell(cellValue(r, ci), kinds()[ci], 400, settings.gridNullText).text;
  };
  function findFrom(dir: 1 | -1, includeStart: boolean) {
    const m = matcher();
    if (!m || total() === 0 || nCols() === 0) return;
    const hit = findNextMatch({ nRows: total(), nCols: nCols(), start: active(), dir, transposed: T(), textAt: cellText, match: m, includeStart });
    if (hit) selectCell(hit.r, hit.c);
  }
  const findNext = () => findFrom(1, false);
  const findPrevious = () => findFrom(-1, false);
  let findTimer = 0;
  function onFindQuery(q: string) {
    setFindQuery(q);
    clearTimeout(findTimer);
    findTimer = window.setTimeout(() => findFrom(1, true), 60);
  }
  onCleanup(() => clearTimeout(findTimer));
  function openFind() {
    if (findOpen()) {
      focusFind?.();
      return;
    }
    const a = active();
    if (a && a.r < total()) {
      const v = cellValue(a.r, vis()[a.c]);
      // DataGrip prefills (and selects) the text of the active cell
      if (v !== null && v !== undefined && typeof v !== "object") setFindQuery(String(v).split("\n")[0].slice(0, 200));
    }
    setFindOpen(true);
  }
  function closeFind() {
    if (!findOpen()) return;
    clearTimeout(findTimer);
    setFindOpen(false);
    root.focus({ preventScroll: true });
  }
  // rows can vanish under the selection (reverting inserted rows, a smaller page): clamp it to the rows that are left
  createEffect(
    on(
      total,
      (tot) => {
        const rs = ranges();
        const a = active();
        if (!rs.some((g) => g.r1 >= tot) && !(a && a.r >= tot)) return;
        batch(() => {
          const next = rs.filter((g) => g.r0 < tot).map((g) => ({ ...g, r1: Math.min(g.r1, tot - 1) }));
          const act = a && a.r >= tot ? (tot > 0 ? { r: tot - 1, c: a.c } : null) : a;
          if (!next.length && act) next.push({ r0: act.r, r1: act.r, c0: act.c, c1: act.c });
          setSelection(next, act);
        });
      },
      { defer: true },
    ),
  );
  // a changed row filter re-numbers the rows: drop the selection and go back to the top
  createEffect(
    on(
      rowFilter,
      () =>
        batch(() => {
          setSelection([], null);
          if (scroller) scroller.scrollTop = 0;
        }),
      { defer: true },
    ),
  );

  // ---- local filter (header funnel) ----
  const sourceKey = (i: number, ci: number) => {
    const row = props.getRow(i);
    return row ? keyOf(row[ci] ?? null, kinds()[ci]) : undefined;
  };
  /** The funnel of a column: the host's popup when it has one, else the local filter popup. */
  function openColumnFilter(ci: number, anchor: DOMRect) {
    if (props.onColumnFilter) props.onColumnFilter(ci, anchor);
    else openLocalFilter(ci, anchor);
  }
  /** `Local Filter By Cell Value`: only the rows equal to the active cell's value. */
  function filterByCellValue() {
    const a = active();
    if (!a) return;
    const ci = vis()[a.c];
    const key = keyOf(cellValue(a.r, ci), kinds()[ci]);
    const m = new Map(colFilters());
    m.set(ci, new Set([key]));
    batch(() => {
      setLfEnabled(true);
      setColFilters(m);
    });
  }
  function openLocalFilter(ci: number, anchor: DOMRect) {
    const { values, truncated } = countValues(props.rowCount, (i) => sourceKey(i, ci));
    setLfPopup({ ci, anchor, values, truncated });
  }
  function toggleFilterValue(ci: number, key: string) {
    const m = new Map(colFilters());
    const set = new Set(m.get(ci) ?? []);
    if (!set.delete(key)) set.add(key);
    if (set.size) m.set(ci, set);
    else m.delete(ci);
    batch(() => {
      setLfEnabled(true);
      setColFilters(m);
    });
  }
  function toggleAllFilterValues(ci: number) {
    const m = new Map(colFilters());
    if (m.get(ci)?.size) m.delete(ci);
    else m.set(ci, new Set(lfPopup()?.values.map((v) => v.key) ?? []));
    batch(() => {
      setLfEnabled(true);
      setColFilters(m);
    });
  }
  const filterMatchCount = () => countMatches(props.rowCount, colFilters(), sourceKey);
  const clearLocalFilter = () => setColFilters(new Map());

  // ---- manage columns ----
  function openManageColumns(anchor?: DOMRect) {
    setManage({ anchor, bounds: root.getBoundingClientRect() });
  }
  function setHiddenSet(next: Set<number>) {
    batch(() => {
      setHidden(next);
      setSelection([], null);
    });
    emitColumns();
  }
  function moveColumnTo(ci: number, toIndex: number) {
    const o = order().filter((c) => c !== ci);
    o.splice(Math.max(0, Math.min(o.length, toIndex)), 0, ci);
    batch(() => {
      setOrder(o);
      setSelection([], null);
    });
    emitColumns();
  }

  // ---- side panel (record view) ----
  function showSidePanel(tab: SideTab | null = "record") {
    if (tab === null) {
      setSideTab(null);
      root.focus({ preventScroll: true });
      return;
    }
    if (!sideSize()) setSideSize(sideDock() === "right" ? Math.max(240, Math.min(520, Math.round(root.clientWidth * 0.3) + 1)) : 260);
    if (!sideTab() && !active() && total() > 0 && nCols() > 0) selectCell(0, 0);
    setSideTab(tab);
  }
  function toggleRecordView() {
    showSidePanel(sideTab() ? null : "record");
  }
  const activeCi = () => {
    const a = active();
    return a ? (vis()[a.c] ?? null) : null;
  };
  const recordValue = (ci: number): Cell => {
    pending.version();
    touch(props.version);
    const a = active();
    return a && a.r < total() ? cellValue(a.r, ci) : null;
  };
  function focusField(ci: number) {
    const a = active();
    const vi = visPos().get(ci);
    if (!a || vi === undefined || (a.c === vi && ranges().length === 1)) return;
    setSelection([{ r0: a.r, r1: a.r, c0: vi, c1: vi }], { r: a.r, c: vi });
    ensureVisible(a.r, vi);
  }
  function commitField(ci: number, text: string) {
    const a = active();
    if (!a) return;
    const kind = kinds()[ci];
    if (!canEditCell(a.r, ci) || text === editText(cellValue(a.r, ci))) return;
    applyValue(a.r, ci, parseEdit(text, kind));
  }
  function aggregates(): Aggregates {
    pending.version();
    touch(props.version);
    const nums: number[] = [];
    const rowSet = new Set<number>();
    const colSet = new Set<number>();
    let count = 0;
    let seen = 0;
    const v = vis();
    outer: for (const g of ranges()) {
      for (let r = g.r0; r <= g.r1; r++) {
        for (let c = g.c0; c <= g.c1; c++) {
          if (seen++ > 200000) break outer;
          rowSet.add(r);
          colSet.add(c);
          const val = cellValue(r, v[c]);
          if (val === null || val === undefined) continue;
          count++;
          const n = typeof val === "number" ? val : typeof val === "string" && kinds()[v[c]] === "number" ? Number(val) : NaN;
          if (!Number.isNaN(n)) nums.push(n);
        }
      }
    }
    return computeAggregates(nums, count, rowSet.size, colSet.size);
  }

  // ---- view state ----
  const viewState = createMemo<GridViewState>(() => ({
    transposed: T(),
    findOpen: findOpen(),
    sidePanel: sideTab(),
    localFilterActive: lfEnabled() && colFilters().size > 0,
    localFilterEnabled: lfEnabled(),
    hiddenColumns: hidden().size,
    pinnedColumns: pinned().size,
  }));
  createEffect(() => props.onViewChange?.(viewState()));

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
      if (T()) scroller.scrollLeft = scrollPos(hX()[Math.min(Math.max(0, row), hX().length - 1)] ?? 0, totalW(), scroller.clientWidth - gutterW());
      else scroller.scrollTop = scrollPos(Math.max(0, row * ROW_H), bodyH(), scroller.clientHeight - HEADER_H);
    },
    focus: () => root.focus({ preventScroll: true }),
    openValueEditor,
    showAllColumns,
    clearSort,
    setTransposed: setTransposedView,
    toggleTranspose,
    showSidePanel,
    toggleRecordView,
    openFind,
    closeFind,
    findNext,
    findPrevious,
    openManageColumns,
    setLocalFilterEnabled: setLfEnabled,
    clearLocalFilter,
    getViewState: viewState,
  };
  props.apiRef?.(api);

  const hasSelectionAt = (r: number) => {
    const a = active();
    return !!a && a.r === r;
  };

  // ---- value editor placement ----
  const editorStyle = (ed: { r: number; vi: number }, pin = false): JSX.CSSProperties => {
    const X = hX();
    const { v, h } = toScreen(T(), ed.r, ed.vi);
    return {
      left: X[h] - (pin ? 0 : shiftH()) + "px",
      top: v * ROW_H - shiftV() + "px",
      width: X[h + 1] - X[h] + "px",
      height: ROW_H + "px",
    };
  };

  /** One column header; `pin`: inside the sticky pinned block (positions relative to it, no scroll offset). */
  const headerCell = (ci: number, pin: boolean): JSX.Element => {
    const vi = () => visPos().get(ci) ?? 0;
    const sortIdx = () => sortState().findIndex((s) => s.col === ci);
    const dir = () => sortState()[sortIdx()]?.dir;
    return (
      <div
        class="dgg-hc"
        classList={{ sel: colHasSel(vi()), dragging: dragCol() === ci }}
        style={{ left: (pin ? 0 : gutterW()) + (colX()[vi()] ?? 0) + "px", width: widthOf(ci) + "px" }}
        onMouseDown={(e) => onHeaderMouseDown(e, ci)}
      >
        <i class={"dgg-ico " + iconOf(props.columns[ci])} />
        <span class="dgg-hname" title={`${props.columns[ci].name}: ${props.columns[ci].typeName.toUpperCase()}`}>
          {props.columns[ci].name}
        </span>
        <button
          class="dgg-hbtn funnel"
          classList={{ on: lfEnabled() && colFilters().has(ci) }}
          title="Column filter"
          tabIndex={-1}
          onClick={(e) => openColumnFilter(ci, (e.currentTarget as HTMLElement).getBoundingClientRect())}
        />
        <button
          class="dgg-hbtn sort"
          classList={{ on: sortIdx() >= 0 }}
          title={sortIdx() < 0 ? "Sort (Alt+click: add to sort)" : dir() === "asc" ? "Ascending" : "Descending"}
          tabIndex={-1}
          onClick={(e) => toggleSort(ci, e.altKey)}
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
  };

  /** Selection / current row / pending-change fills. `pin`: for the pinned layer (no horizontal scroll shift). */
  const underlay = (pin: boolean): JSX.Element => {
    const dx = () => (pin ? shiftH() : 0);
    return (
      <>
        <Show when={curRect()}>
          {(q) => <div class="dgg-u cur" style={{ left: q().x + dx() + "px", top: q().y + "px", width: q().w + "px", height: q().h + "px" }} />}
        </Show>
        <For each={changeRects()}>
          {(q) => <div class={"dgg-u " + q.k} style={{ left: q.x + dx() + "px", top: q.y + "px", width: q.w + "px", height: q.h + "px" }} />}
        </For>
        <For each={selRects()}>
          {(q) => <div class="dgg-u sel" style={{ left: q.x + dx() + "px", top: q.y + "px", width: q.w + "px", height: q.h + "px" }} />}
        </For>
      </>
    );
  };
  const cellEditor = (pin: boolean): JSX.Element => {
    const ed = untrack(edit)!;
    return (
      <CellEditor
        state={ed}
        style={editorStyle(ed, pin)}
        kind={kinds()[ed.ci]}
        right={!T() && isRightAligned(kinds()[ed.ci], cellValue(ed.r, ed.ci))}
        onCommit={commitEdit}
        onCancel={cancelEdit}
        onValueEditor={(t) => {
          const s = edit();
          if (!s) return;
          setEdit(null);
          setValueEd({ r: s.r, vi: s.vi, ci: s.ci, text: t, readOnly: false });
        }}
        onTab={(back, t) => {
          const s = edit();
          if (!s) return;
          commitEdit(t, true);
          const nx = tabTarget(s.r, s.vi, back);
          if (nx) selectCell(nx.r, nx.c);
          root.focus({ preventScroll: true });
        }}
      />
    );
  };
  const boolList = (pin: boolean): JSX.Element => {
    const b = untrack(boolPick)!;
    return (
      <BoolList
        style={{ left: parseFloat(String(editorStyle(b, pin).left)) - 14 + "px", top: parseFloat(String(editorStyle(b, pin).top)) + ROW_H + "px" }}
        onPick={(v) => pickBool(b, v)}
        onCancel={() => (setBoolPick(null), root.focus({ preventScroll: true }))}
      />
    );
  };

  const tableView = (
    <div
      ref={scroller}
      class="dgg-scroller"
      onScroll={onScrollSync}
      onMouseDown={onBodyMouseDown}
      onDblClick={onBodyDblClick}
    >
      <div class="dgg-sizer" style={{ width: gutterW() + extentW() + "px", height: HEADER_H + extentH() + (props.bottomPad ?? 0) + "px" }}>
        <div class="dgg-header">
          <div class="dgg-corner" style={{ width: gutterW() + "px" }} />
          <Show when={T()}>
            <For each={hdrCols()}>
              {(r) => (
                <div
                  class="dgg-hc rec"
                  classList={{ sel: rowHasSel(r) }}
                  style={{ left: gutterW() + (hX()[r] ?? 0) - shiftH() + "px", width: (hX()[r + 1] ?? 0) - (hX()[r] ?? 0) + "px" }}
                  onMouseDown={(e) => onRecHeaderDown(e, r)}
                >
                  {rowOff() + r + 1}
                </div>
              )}
            </For>
          </Show>
          <Show when={nPinned() > 0}>
            <div class="dgg-hpin" style={{ left: gutterW() + "px", width: pinW() + "px" }}>
              <For each={vis().slice(0, nPinned())}>{(ci) => headerCell(ci, true)}</For>
            </div>
          </Show>
          <For each={T() ? [] : hdrCols()}>{(ci) => headerCell(ci, false)}</For>
          <Show when={!T() && dropAt() !== null}>
            <div class="dgg-drop" style={{ left: gutterW() + (colX()[dropAt()!] ?? 0) + "px" }} />
          </Show>
        </div>

        <div class="dgg-body" style={{ height: extentH() + "px" }}>
          <div class="dgg-gutter" style={{ width: gutterW() + "px", height: extentH() + "px" }}>
            <For each={rowList()}>
              {(r) => (
                <Show
                  when={T()}
                  fallback={
                    <div
                      class="dgg-gr"
                      classList={{
                        cur: hasSelectionAt(r),
                        sel: rowFullySel(r),
                        ins: rowState(r) === "ins",
                        del: rowState(r) === "del",
                        mod: rowState(r) === "mod",
                      }}
                      style={{ top: r * ROW_H - shiftV() + "px" }}
                    >
                      {rowOff() + r + 1}
                    </div>
                  }
                >
                  <div class="dgg-gr nm" classList={{ sel: colSelectedFully(r) }} style={{ top: r * ROW_H - shiftV() + "px" }}>
                    <i class={"dgg-ico " + iconOf(props.columns[vis()[r]])} />
                    <span>{props.columns[vis()[r]]?.name}</span>
                  </div>
                </Show>
              )}
            </For>
          </div>
          <div class="dgg-data" style={{ left: gutterW() + "px", width: extentW() + "px", height: extentH() + "px" }}>
            <div class="dgg-underlay">{underlay(false)}</div>
            <For each={rowList()}>
              {(r) => <div class="dgg-row" style={{ top: r * ROW_H - shiftV() + "px", width: extentW() + "px" }} innerHTML={T() ? rowHtmlT(r) : rowHtml(r)} />}
            </For>
            <Show when={nPinned() > 0}>
              <div class="dgg-pinlayer" style={{ left: gutterW() + "px", width: pinW() + "px", height: extentH() + "px" }}>
                <div class="dgg-underlay">{underlay(true)}</div>
                <For each={rowList()}>
                  {(r) => <div class="dgg-row" style={{ top: r * ROW_H - shiftV() + "px", width: pinW() + "px" }} innerHTML={rowHtml(r, true)} />}
                </For>
                <Show when={edit() && edit()!.vi < nPinned()}>{cellEditor(true)}</Show>
                <Show when={boolPick() && boolPick()!.vi < nPinned()}>{boolList(true)}</Show>
              </div>
            </Show>
            <Show when={edit() && (T() || edit()!.vi >= nPinned())}>{cellEditor(false)}</Show>
            <Show when={boolPick() && (T() || boolPick()!.vi >= nPinned())}>{boolList(false)}</Show>
          </div>
        </div>
      </div>
    </div>
  );

  const textMode = () => (props.viewMode ?? "table") === "text";
  const sideStyleSize = () => sideSize() || 476;

  return (
    <div
      ref={root}
      class="dgg"
      data-editable={props.editable ? "" : undefined}
      classList={{ pop: !!(manage() || lfPopup()) }}
      style={{ "letter-spacing": ls() ? ls() + "px" : undefined }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onPaste={onPaste}
      onCopy={(e) => {
        if (edit() || (e.target as HTMLElement).closest?.(".dgg-ve, .dgg-find, .dgg-side")) return;
        e.preventDefault();
        const t = selectionText("tsv");
        if (t) e.clipboardData?.setData("text/plain", t);
      }}
    >
      <div class="dgg-split" classList={{ bottom: sideDock() === "bottom" }}>
        <div class="dgg-main">
          <Show when={findOpen()}>
            <FindBar
              query={findQuery()}
              options={findOpts()}
              filterRows={findFilterRows()}
              error={findError()}
              focusRef={(f) => (focusFind = f)}
              onQuery={onFindQuery}
              onOptions={setFindOpts}
              onFilterRows={setFindFilterRows}
              onNext={findNext}
              onPrevious={findPrevious}
              onClose={closeFind}
            />
          </Show>
          <div class="dgg-view">
            <Show when={!textMode()} fallback={<TextView columns={props.columns} rowCount={props.rowCount} getRow={props.getRow} version={props.version} />}>
              {tableView}
            </Show>
            <div class="dgg-overlay">{props.children}</div>
          </div>
        </div>
        <Show when={sideTab()}>
          {(tab) => (
            <SidePanel
              tab={tab()}
              onTab={setSideTab}
              dock={sideDock()}
              onDock={(d) => (setSideDock(d), setSideSize(d === "right" ? Math.max(240, Math.min(520, Math.round(root.clientWidth * 0.3) + 1)) : 260))}
              twoColumns={sideTwoCol()}
              onTwoColumns={setSideTwoCol}
              onClose={() => showSidePanel(null)}
              size={sideStyleSize()}
              onSize={setSideSize}
              columns={props.columns}
              fieldCols={vis()}
              activeCol={activeCi}
              hasRecord={() => !!active() && active()!.r < total()}
              fieldText={(ci) => editText(recordValue(ci))}
              fieldIsNull={(ci) => recordValue(ci) === null || recordValue(ci) === undefined}
              fieldEditable={(ci) => {
                const a = active();
                return !!a && canEditCell(a.r, ci);
              }}
              nullText={settings.gridNullText}
              iconClass={iconOf}
              onFocusField={focusField}
              onCommitField={commitField}
              onExpandField={(ci) => {
                focusField(ci);
                openValueEditor();
              }}
              valueTitle={() => (activeCi() === null ? "" : props.columns[activeCi()!].name)}
              valueText={() => (activeCi() === null ? "" : editText(recordValue(activeCi()!)))}
              valueEditable={() => {
                const a = active();
                return !!a && canEditCell(a.r, vis()[a.c]);
              }}
              onCommitValue={(t) => {
                const ci = activeCi();
                if (ci !== null) commitField(ci, t);
              }}
              aggregates={aggregates}
              onFocusGrid={() => root.focus({ preventScroll: true })}
            />
          )}
        </Show>
      </div>
      <Show when={menu()}>
        {(m) => <GridMenu x={m().x} y={m().y} items={m().items()} preselect={m().preselect} onClose={() => (setMenu(null), root.focus({ preventScroll: true }))} />}
      </Show>
      <Show when={doc()}>{(d) => <ColumnDoc x={d().x} y={d().y} col={props.columns[d().ci]} table={props.tableName} onClose={() => (setDoc(null), root.focus({ preventScroll: true }))} />}</Show>
      <Show when={manage()}>
        {(m) => (
          <ManageColumns
            columns={props.columns}
            order={order().length === props.columns.length ? order() : props.columns.map((_, i) => i)}
            hidden={hidden()}
            anchor={m().anchor}
            bounds={m().bounds}
            onToggle={(ci, visible) => {
              const n = new Set(hidden());
              if (visible) n.delete(ci);
              else n.add(ci);
              setHiddenSet(n);
            }}
            pinned={pinned()}
            onTogglePin={(ci) => (pinned().has(ci) ? unpinColumn(ci) : pinColumns([ci]))}
            onShowAll={() => setHiddenSet(new Set())}
            onHideAll={() => setHiddenSet(new Set(props.columns.map((_, i) => i)))}
            onMove={moveColumnTo}
            onClose={() => (setManage(null), root.focus({ preventScroll: true }))}
          />
        )}
      </Show>
      <Show when={lfPopup()}>
        {(m) => (
          <LocalFilterPopup
            column={props.columns[m().ci].name}
            anchor={m().anchor}
            values={m().values}
            truncated={m().truncated}
            selected={colFilters().get(m().ci) ?? new Set<string>()}
            matchCount={filterMatchCount()}
            onToggle={(k) => toggleFilterValue(m().ci, k)}
            onToggleAll={() => toggleAllFilterValues(m().ci)}
            onClose={() => (setLfPopup(null), root.focus({ preventScroll: true }))}
          />
        )}
      </Show>
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
  state: { r: number; vi: number; ci: number; text: string; expr?: boolean };
  style: JSX.CSSProperties;
  kind: ColumnKind;
  right: boolean;
  onCommit: (text: string, refocus?: boolean) => void;
  onCancel: () => void;
  onValueEditor: (text: string) => void;
  onTab: (back: boolean, text: string) => void;
}

/**
 * In-cell text editor. Date / timestamp / time columns get a `...` button (value editor) and the picker panel
 * under the cell; the wrapper commits when the focus leaves it as a whole (the picker's fields are inside it).
 */
function CellEditor(props: CellEditorProps): JSX.Element {
  let input!: HTMLInputElement;
  let wrap!: HTMLDivElement;
  let done = false;
  let refocus = false;
  const [text, setText] = createSignal(props.state.text);
  const isDate = () => !props.state.expr && (props.kind === "date" || props.kind === "datetime" || props.kind === "time");
  onMount(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  const finish = (fn: () => void) => {
    if (done) return;
    done = true;
    fn();
  };
  return (
    <div
      ref={wrap}
      class="dgg-ew"
      classList={{ expr: !!props.state.expr, dt: isDate() }}
      style={props.style}
      onMouseDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onFocusOut={(e) => {
        if (!wrap.contains(e.relatedTarget as Node | null)) finish(() => props.onCommit(text(), refocus));
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const inInput = e.target === input;
        if (e.key === "Enter" && e.shiftKey && inInput) {
          e.preventDefault();
          finish(() => props.onValueEditor(text()));
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (inInput) finish(() => props.onCommit(text(), true));
          else {
            // a picker field: its pending change event fires on blur, then the focus-out commits
            refocus = true;
            (e.target as HTMLElement).blur();
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(() => props.onCancel());
        } else if (e.key === "Tab" && inInput) {
          e.preventDefault();
          finish(() => props.onTab(e.shiftKey, text()));
        }
      }}
    >
      <input
        ref={input}
        class="dgg-editor"
        classList={{ r: props.right }}
        value={text()}
        spellcheck={false}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <Show when={isDate()}>
        <button class="dgg-ew-more" tabIndex={-1} title="Open value editor" onMouseDown={(e) => e.preventDefault()} onClick={() => finish(() => props.onValueEditor(text()))}>
          ...
        </button>
        <DateEditor kind={props.kind} text={text()} onChange={setText} />
      </Show>
    </div>
  );
}

const BOOL_CHOICES: { label: string; value: boolean | "default" }[] = [
  { label: "true", value: true },
  { label: "false", value: false },
  { label: "default", value: "default" },
];

/** The list under a boolean cell: true / false / default (Up / Down / Enter, Esc cancels). */
function BoolList(props: { style: JSX.CSSProperties; onPick: (v: boolean | "default") => void; onCancel: () => void }): JSX.Element {
  let el!: HTMLDivElement;
  const [hi, setHi] = createSignal(0);
  onMount(() => el.focus());
  return (
    <div
      ref={el}
      class="dgg-bool"
      tabIndex={-1}
      style={props.style}
      onMouseDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onBlur={() => props.onCancel()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setHi((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + BOOL_CHOICES.length) % BOOL_CHOICES.length);
        } else if (e.key === "Enter") {
          e.preventDefault();
          props.onPick(BOOL_CHOICES[hi()].value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          props.onCancel();
        }
      }}
    >
      <For each={BOOL_CHOICES}>
        {(c, i) => (
          <div class="dgg-bool-item" classList={{ hi: hi() === i() }} onMouseEnter={() => setHi(i())} onClick={() => props.onPick(c.value)}>
            {c.label}
          </div>
        )}
      </For>
    </div>
  );
}

/** Quick Documentation of a column (Ctrl+Q on a cell): name, type and keys. Closes on any click or key. */
function ColumnDoc(props: { x: number; y: number; col: GridColumn; table?: string; onClose: () => void }): JSX.Element {
  let el!: HTMLDivElement;
  onMount(() => {
    const down = (e: MouseEvent) => !el.contains(e.target as Node) && props.onClose();
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    });
  });
  const c = () => props.col;
  const flags = () => [c().isPk && "primary key", c().isFk && "foreign key", c().isIndexed && "indexed", c().nullable === false ? "not null" : "nullable"].filter(Boolean).join(", ");
  return (
    <Portal>
      <div ref={el} class="dgg-doc" style={{ left: Math.max(4, props.x) + "px", top: Math.max(4, props.y) + "px" }}>
        <div class="dgg-doc-title">
          <i class={"dgg-ico " + iconClass(c())} /> {c().name}
        </div>
        <div class="dgg-doc-row">
          <span>Type</span>
          {c().typeName}
        </div>
        <div class="dgg-doc-row">
          <span>Flags</span>
          {flags()}
        </div>
        <Show when={props.table}>
          <div class="dgg-doc-row">
            <span>Table</span>
            {props.table}
          </div>
        </Show>
      </div>
    </Portal>
  );
}
