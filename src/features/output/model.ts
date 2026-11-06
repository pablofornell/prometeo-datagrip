/**
 * State of the Database Output tool window: one `ConsoleOutput` per console tab (log lines + result tabs).
 * The console feature (src/features/console) writes it; the output UI only reads it and calls back into
 * the owning console through `OutputHost`.
 */
import { type Accessor, createMemo, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { Cell, ColumnMeta, Driver, ExecHandle, ExportFormat, TxStatus } from "../../api/db";
import type { DataGridApi, GridChange, GridColumn, GridViewState, ViewMode } from "../../components/grid";
import type { PageSize } from "../../components/grid";
import { isConnectionLost } from "../../state/connection-errors";
import { settings } from "../../state/settings";
import { activeTab } from "../../state/tabs";
import type { EditTarget } from "./edit";

export type LogKind = "text" | "sql" | "error";

export interface LogLine {
  id: number;
  ts: number;
  kind: LogKind;
  text: string;
  /** `postgres.public` for `sql` lines (`prompt> statement`). */
  prompt?: string;
}

/** What the output UI needs from the console that owns the output. */
export interface OutputHost {
  readonly dsId: string;
  readonly driver: Driver;
  cancel(): void;
  /** Execute the statement of a result again (Reload Page); `pageSize` overrides the page size. */
  rerun(tab: ResultTab, pageSize?: PageSize): void;
  txMode(): "auto" | "manual";
  /** A transaction is open on the console's session (`active` or `failed`). */
  inTx(): boolean;
  /** `idle` / `active` / `failed`, as the server reports it. */
  txStatus(): TxStatus;
  /** Resolves true when the transaction ended (or there was none). */
  endTx(kind: "commit" | "rollback"): Promise<boolean>;
  /** A paging fetch failed because the connection is gone (`isConnectionLost`): the host drops its dead session. */
  connectionLost?(): void;
  openTxMenu(anchor: HTMLElement | DOMRect): void;
  /**
   * Submits the pending changes of an editable result (inside the console's transaction when Tx is Manual) and
   * reloads the result. Resolves false (changes stay pending) after showing the error.
   */
  applyEdits(tab: ResultTab, changes: GridChange[]): Promise<boolean>;
  /** SQL of the pending changes (Preview Pending Changes). */
  previewEdits(tab: ResultTab, changes: GridChange[]): string;
  /** Bring the console editor tab to the front. */
  focusEditor(): void;
}

/** The page size of Settings (`gridPageSize`, 0 = all). Read it when needed, never cache it. */
export const defaultPageSize = (): PageSize => (settings.gridPageSize > 0 ? settings.gridPageSize : "all");
/** Rows of the first `resultset` event when the page size is "all" (the rest is pulled with `fetch_more`). */
export const ALL_FIRST_CHUNK = 500;
const FETCH_CHUNK = 5000;

let resultSeq = 0;

export class ResultTab {
  readonly id = `res${++resultSeq}`;
  readonly columns: GridColumn[];
  /** Plain (non reactive) row storage: `version` signals changes. */
  rows: Cell[][];
  readonly [Symbol.toStringTag] = "ResultTab";

  readonly title: Accessor<string>;
  readonly setTitle: (t: string) => void;
  readonly pinned: Accessor<boolean>;
  readonly setPinned: (p: boolean) => void;
  readonly rowCount: Accessor<number>;
  private readonly setRowCount: (n: number) => void;
  readonly version: Accessor<number>;
  private readonly setVersion: (n: number) => void;
  readonly hasMore: Accessor<boolean>;
  readonly setHasMore: (b: boolean) => void;
  readonly loadingMore: Accessor<boolean>;
  private readonly setLoadingMore: (b: boolean) => void;
  readonly viewMode: Accessor<ViewMode>;
  readonly setViewMode: (m: ViewMode) => void;
  readonly extractor: Accessor<ExportFormat>;
  readonly setExtractor: (f: ExportFormat) => void;
  readonly pageSize: Accessor<PageSize>;
  readonly setPageSize: (p: PageSize) => void;
  /** Table and key of an editable result (null: read-only); set once the metadata is resolved. */
  readonly edit: Accessor<EditTarget | null>;
  readonly setEdit: (e: EditTarget | null) => void;
  /** Number of pending changes of the grid. */
  readonly pending: Accessor<number>;
  readonly setPending: (n: number) => void;
  /** A submit is running. */
  readonly applying: Accessor<boolean>;
  readonly setApplying: (b: boolean) => void;
  /** The "Preview Pending Changes" popup is open. */
  readonly preview: Accessor<boolean>;
  readonly setPreview: (b: boolean) => void;
  /** Transpose / record view / find state of the mounted grid (for the toolbar toggles). */
  readonly view: Accessor<GridViewState | null>;
  readonly setView: (v: GridViewState) => void;
  /** Handle of the mounted grid (set by the result view). */
  gridApi?: DataGridApi;
  /** Duration of the execution that produced it (header `648 ms`). */
  ms = 0;
  closed = false;
  /** Why the rows beyond the loaded ones are not available (result closed by the server / idle timeout / newer statement). */
  readonly partial: Accessor<string | null>;
  private readonly setPartial: (m: string | null) => void;
  /** Fetch error of the last `loadMore`. */
  fetchError?: string;
  /** Where the problem notes go (the Output log of the console that owns the tab). */
  log?: (kind: "text" | "error", text: string) => void;
  /** Set by the console: its session died under a paging fetch. */
  onConnectionLost?: () => void;

  constructor(
    readonly meta: ColumnMeta[],
    rows: Cell[][],
    hasMore: boolean,
    title: string,
    readonly sql: string,
    readonly resultIndex: number,
    /** Resolves the execution handle that can page this result (only the last statement of a script). */
    private readonly handle: () => Promise<ExecHandle>,
    pageSize: PageSize = defaultPageSize(),
  ) {
    this.rows = rows;
    this.columns = meta.map((c) => ({ name: c.name, typeName: c.typeName, nullable: c.nullable, isPk: c.isPk }));
    const sig = <T,>(v: T): [Accessor<T>, (v: T) => void] => {
      const [g, s] = createSignal<T>(v);
      return [g, (x: T) => void s(() => x)];
    };
    [this.title, this.setTitle] = sig(title);
    [this.pinned, this.setPinned] = sig(false);
    [this.rowCount, this.setRowCount] = sig(rows.length);
    [this.version, this.setVersion] = sig(0);
    [this.hasMore, this.setHasMore] = sig(hasMore);
    [this.loadingMore, this.setLoadingMore] = sig(false);
    [this.viewMode, this.setViewMode] = sig<ViewMode>("table");
    [this.extractor, this.setExtractor] = sig<ExportFormat>("csv");
    [this.pageSize, this.setPageSize] = sig<PageSize>(pageSize);
    [this.edit, this.setEdit] = sig<EditTarget | null>(null);
    [this.pending, this.setPending] = sig(0);
    [this.applying, this.setApplying] = sig(false);
    [this.preview, this.setPreview] = sig(false);
    [this.partial, this.setPartial] = sig<string | null>(null);
    [this.view, this.setView] = sig<GridViewState | null>(null);
  }

  /** `fetch_more` of the next rows (scroll). No-op while loading or when everything is loaded. */
  async loadMore(count: number = FETCH_CHUNK): Promise<void> {
    if (this.closed || !this.hasMore() || this.loadingMore()) return;
    this.setLoadingMore(true);
    try {
      const h = await this.handle();
      const r = await h.fetchMore(this.resultIndex, count);
      for (const row of r.rows) this.rows.push(row);
      this.setRowCount(this.rows.length);
      this.setHasMore(r.hasMore);
      this.setVersion(this.version() + 1);
    } catch (e) {
      // the paging stream is gone (idle timeout, newer statement on the session, data source disconnected): what is
      // loaded is NOT the whole result, and the user has to be told
      this.fetchError = String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");
      this.setHasMore(false);
      this.markPartial(partialMessage(this.fetchError, this.rows.length));
      if (isConnectionLost(e)) this.onConnectionLost?.();
    } finally {
      this.setLoadingMore(false);
    }
  }

  /** "All" / "Count Rows": pull every remaining row. */
  async loadAll(): Promise<void> {
    while (!this.closed && this.hasMore()) {
      const before = this.rows.length;
      await this.loadMore(FETCH_CHUNK);
      if (this.rows.length === before) break;
    }
  }

  /** Records that the result is incomplete (banner above the grid + a line in the Output log). */
  private markPartial(message: string): void {
    if (this.partial() === message) return;
    this.setPartial(message);
    this.log?.("error", `${this.title()}: ${message}`);
  }

  /**
   * The server side of the paging stream is gone (a newer execution on the session): stop offering more rows. When
   * rows were still to come, say that the grid shows only part of the result (`silent`: not yet, `announce` later;
   * a tab that the new execution replaces anyway needs no note).
   */
  detach(reason = "a newer statement ran on the same connection", silent = false): void {
    if (this.closed) return;
    if (this.hasMore()) {
      this.cutShort = true;
      this.cutReason = reason;
    }
    this.setHasMore(false);
    if (!silent) this.announce();
  }

  private cutShort = false;
  private cutReason = "";

  /** Shows the "not the complete result" note of a stream that was cut short (once). */
  announce(): void {
    if (this.cutShort && !this.partial() && !this.closed) {
      this.markPartial(`only the first ${this.rows.length.toLocaleString("en-US")} rows are shown: the result set was closed because ${this.cutReason}. Reload the result to see all rows.`);
    }
  }

  /** Release the open result set on the server. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.hasMore()) void this.handle().then((h) => h.close()).catch(() => {});
    this.setHasMore(false);
    this.release();
  }

  /**
   * Drops what keeps the rows reachable once the tab is closed or replaced: the row storage itself, the grid handle
   * (it closes over the grid's row accessor) and the log hook. Measured (FinalizationRegistry on the tabs): a closed
   * result IS collected, but WebKit collects lazily, so its memory (+25 MB for 100k rows) only drops a few cycles
   * later; nothing of ours keeps it alive.
   */
  private release(): void {
    this.rows = [];
    this.gridApi = undefined;
    this.log = undefined;
    this.fetchError = undefined;
  }
}

/** The note for a failed `fetch_more`; "result set is closed" is the backend's wording for a stream that was released. */
export function partialMessage(error: string, loaded: number): string {
  const n = loaded.toLocaleString("en-US");
  if (/result set is closed/i.test(error)) {
    return `only the first ${n} rows are shown: the result set was closed (idle timeout, or another statement ran on the same connection), so it is not the complete result. Reload the result to see all rows.`;
  }
  return `could not load more rows (${error}). Only the first ${n} rows are shown, not the complete result.`;
}

const MAX_LINES = 3000;
let lineSeq = 0;

export class ConsoleOutput {
  readonly [Symbol.toStringTag] = "ConsoleOutput";
  host?: OutputHost;

  /** Log lines (reactive store; old lines are dropped past 3000). */
  readonly lines: LogLine[];
  private readonly setLines: (...a: any[]) => void;

  readonly results: Accessor<ResultTab[]>;
  readonly setResults: (r: ResultTab[]) => void;
  /** `"output"` or a result tab id. */
  readonly selected: Accessor<string>;
  readonly select: (id: string) => void;
  readonly running: Accessor<boolean>;
  readonly setRunning: (b: boolean) => void;
  /** Duration of the last execution, `null` until something ran. */
  readonly lastMs: Accessor<number | null>;
  readonly setLastMs: (n: number | null) => void;
  readonly wrap: Accessor<boolean>;
  readonly setWrap: (b: boolean) => void;
  readonly scrollToEnd: Accessor<boolean>;
  readonly setScrollToEnd: (b: boolean) => void;
  readonly current: Accessor<ResultTab | undefined>;

  constructor(
    readonly tabId: string,
    readonly dialect: Driver,
  ) {
    const [lines, setLines] = createStore<LogLine[]>([]);
    this.lines = lines;
    this.setLines = setLines as any;
    const sig = <T,>(v: T): [Accessor<T>, (v: T) => void] => {
      const [g, s] = createSignal<T>(v);
      return [g, (x: T) => void s(() => x)];
    };
    [this.results, this.setResults] = sig<ResultTab[]>([]);
    [this.selected, this.select] = sig("output");
    [this.running, this.setRunning] = sig(false);
    [this.lastMs, this.setLastMs] = sig<number | null>(null);
    [this.wrap, this.setWrap] = sig(false);
    [this.scrollToEnd, this.setScrollToEnd] = sig(true);
    this.current = createMemo(() => this.results().find((r) => r.id === this.selected()));
  }

  log(kind: LogKind, text: string, prompt?: string, ts: number = Date.now()): number {
    const id = ++lineSeq;
    this.setLines(
      produce((l: LogLine[]) => {
        l.push({ id, ts, kind, text, prompt });
        if (l.length > MAX_LINES) l.splice(0, l.length - MAX_LINES);
      }),
    );
    return id;
  }

  patchLine(id: number, text: string): void {
    const i = this.lines.findIndex((l) => l.id === id);
    if (i >= 0) this.setLines(i, "text", text);
  }

  clearLog(): void {
    this.setLines(produce((l: LogLine[]) => void l.splice(0)));
  }

  /** New result tabs of an execution: replaces `replace` in place (Reload) or every unpinned tab. */
  addResult(tab: ResultTab, opts: { first: boolean; replace?: ResultTab }): void {
    tab.log = (kind, text) => void this.log(kind, text);
    tab.onConnectionLost = () => this.host?.connectionLost?.();
    let list = this.results();
    if (opts.first) {
      if (opts.replace) {
        const i = list.findIndex((r) => r.id === opts.replace!.id);
        tab.setPinned(opts.replace.pinned());
        if (i >= 0) {
          list[i].close();
          list = [...list.slice(0, i), tab, ...list.slice(i + 1)];
        } else list = [...list, tab];
      } else {
        for (const r of list) if (!r.pinned()) r.close();
        list = [...list.filter((r) => r.pinned()), tab];
      }
      this.select(tab.id);
    } else list = [...list, tab];
    this.setResults(list);
  }

  closeResult(id: string): void {
    const list = this.results();
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return;
    list[i].close();
    const next = list.filter((r) => r.id !== id);
    this.setResults(next);
    if (this.selected() === id) this.select(next[Math.min(i, next.length - 1)]?.id ?? "output");
  }

  closeOthers(id: string): void {
    for (const r of this.results()) if (r.id !== id && !r.pinned()) r.close();
    const next = this.results().filter((r) => r.id === id || r.pinned());
    this.setResults(next);
    if (!next.some((r) => r.id === this.selected())) this.select("output");
  }

  dispose(): void {
    for (const r of this.results()) r.close();
    this.setResults([]);
  }
}

// ---------------------------------------------------------------- registry

const [outputs, setOutputs] = createSignal<ReadonlyMap<string, ConsoleOutput>>(new Map());
const [lastConsoleId, setLastConsoleId] = createSignal<string | null>(null);

export function createOutput(tabId: string, dialect: Driver): ConsoleOutput {
  const o = new ConsoleOutput(tabId, dialect);
  setOutputs((m) => new Map(m).set(tabId, o));
  return o;
}

export function removeOutput(tabId: string): void {
  const m = new Map(outputs());
  m.get(tabId)?.dispose();
  m.delete(tabId);
  setOutputs(m);
  if (lastConsoleId() === tabId) setLastConsoleId(null);
}

export const allOutputs = (): ConsoleOutput[] => [...outputs().values()];
export const outputOf = (tabId: string): ConsoleOutput | undefined => outputs().get(tabId);

/**
 * The output shown by the tool window: the active console's, the active table editor's (its own queries), or the
 * last active console's (DDL tabs).
 */
export function currentOutput(): ConsoleOutput | undefined {
  const t = activeTab();
  if (t?.kind === "console") return outputs().get(t.id);
  if (t?.kind === "table" && outputs().has(t.id)) return outputs().get(t.id);
  const last = lastConsoleId();
  return last ? outputs().get(last) : undefined;
}

/** Called by the console view when its tab becomes active. */
export function markConsoleActive(tabId: string): void {
  setLastConsoleId(tabId);
}
