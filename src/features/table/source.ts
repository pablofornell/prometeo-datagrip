/**
 * Paged row source of a table data editor.
 *
 * A *page* is what the pill shows (500 rows by default, `all` = the whole table). Rows are fetched with
 * `tableData` in *chunks*: a numeric page is one chunk; `all` is cut into 500-row chunks that are loaded
 * on demand while the grid asks for rows (`getRow` returns `undefined` until the chunk arrived, then
 * `version` bumps). The total of an `all` page comes with the first request (`countTotal`), so the
 * scrollbar has its final size at once.
 */
import { batch, createSignal } from "solid-js";
import { type Cell, type ColumnMeta, type ObjectRef, type ResultSet, tableData } from "../../api/db";

export type PageSize = number | "all";

export const DEFAULT_PAGE_SIZE = 500;
const ALL_CHUNK = 500;
const MAX_CHUNKS = 400;

export interface Query {
  where: string;
  orderBy: string;
  page: number;
  pageSize: PageSize;
}

interface Chunk {
  rows: Cell[][];
  locators?: Cell[];
}

export function createTableSource(dsId: string, ref: ObjectRef, initial: Partial<Query> = {}) {
  let query: Query = { where: "", orderBy: "", page: 0, pageSize: DEFAULT_PAGE_SIZE, ...initial };
  const chunks = new Map<number, Chunk>();
  const inflight = new Set<number>();
  let gen = 0;
  let chunkLen = 0;

  const [columns, setColumns] = createSignal<ColumnMeta[] | null>(null);
  const [rowCount, setRowCount] = createSignal(0);
  const [version, setVersion] = createSignal(0);
  const [hasMore, setHasMore] = createSignal(false);
  const [total, setTotal] = createSignal<number | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [applied, setApplied] = createSignal<Query>(query);
  const bump = () => setVersion((v) => v + 1);

  const chunkSizeOf = (q: Query) => (q.pageSize === "all" ? ALL_CHUNK : q.pageSize);
  const offsetOf = (q: Query) => (q.pageSize === "all" ? 0 : q.page * q.pageSize);

  const request = (q: Query, chunk: number, countTotal: boolean): Promise<ResultSet> =>
    tableData(dsId, ref, {
      whereClause: q.where.trim() || null,
      orderBy: q.orderBy.trim() || null,
      offset: offsetOf(q) + chunk * chunkSizeOf(q),
      limit: chunkSizeOf(q),
      countTotal,
    });

  const sameColumns = (a: ColumnMeta[] | null, b: ColumnMeta[]) =>
    !!a && a.length === b.length && a.every((c, i) => c.name === b[i].name && c.typeName === b[i].typeName && c.isPk === b[i].isPk && c.nullable === b[i].nullable);

  /**
   * Loads the page of `next` (merged into the current query) and, on success, makes it current. The previous rows
   * stay visible meanwhile and after a failure (the promise rejects with the server message).
   */
  async function load(next: Partial<Query> = {}, opts: { keepTotal?: boolean } = {}): Promise<void> {
    const q: Query = { ...query, ...next };
    const my = ++gen;
    setLoading(true);
    try {
      const all = q.pageSize === "all";
      const rs = await request(q, 0, all);
      if (my !== gen) return;
      batch(() => {
        query = q;
        setApplied(q);
        chunks.clear();
        inflight.clear();
        chunkLen = chunkSizeOf(q);
        chunks.set(0, { rows: rs.rows, locators: rs.rowLocators });
        if (!sameColumns(columns(), rs.columns)) setColumns(rs.columns);
        if (all) {
          setRowCount(rs.totalHint ?? rs.rows.length);
          setTotal(rs.totalHint ?? (rs.hasMore ? null : rs.rows.length));
          setHasMore(false);
        } else {
          setRowCount(rs.rows.length);
          setHasMore(rs.hasMore);
          if (!opts.keepTotal) setTotal(rs.hasMore ? null : offsetOf(q) + rs.rows.length);
        }
        bump();
      });
    } finally {
      if (my === gen) setLoading(false);
    }
  }

  async function loadChunk(c: number): Promise<void> {
    if (chunks.has(c) || inflight.has(c)) return;
    inflight.add(c);
    const my = gen;
    const q = query;
    try {
      const rs = await request(q, c, false);
      if (my !== gen) return;
      if (chunks.size >= MAX_CHUNKS) {
        const oldest = chunks.keys().next().value;
        if (oldest !== undefined && oldest !== 0) chunks.delete(oldest);
      }
      chunks.set(c, { rows: rs.rows, locators: rs.rowLocators });
      bump();
    } catch {
      /* the rows stay blank; scrolling again retries */
    } finally {
      inflight.delete(c);
    }
  }

  /** Row of the current page, or `undefined` while its chunk loads. Safe to call while rendering. */
  function getRow(i: number): Cell[] | undefined {
    if (i < 0 || chunkLen === 0) return undefined;
    const c = Math.floor(i / chunkLen);
    const ch = chunks.get(c);
    if (ch) return ch.rows[i - c * chunkLen];
    if (!inflight.has(c)) queueMicrotask(() => void loadChunk(c));
    return undefined;
  }

  /** Counts the rows matching the WHERE (the pill then reads `500 of 100,000 rows`). */
  async function countRows(): Promise<number> {
    const q = query;
    const rs = await tableData(dsId, ref, { whereClause: q.where.trim() || null, orderBy: null, offset: 0, limit: 1, countTotal: true });
    const n = rs.totalHint ?? rs.rows.length;
    if (q === query) setTotal(n);
    return n;
  }

  /** Hidden locator (PG ctid, SQLite rowid) of the row at `i` of the page, for tables without a primary key. */
  function locatorOf(i: number): Cell | undefined {
    if (i < 0 || chunkLen === 0) return undefined;
    const c = Math.floor(i / chunkLen);
    return chunks.get(c)?.locators?.[i - c * chunkLen];
  }

  /** Whether every row of the current page is in memory. */
  const complete = () => {
    const n = rowCount();
    return n === 0 || (chunkLen > 0 && chunks.size >= Math.ceil(n / chunkLen) && [...Array(Math.ceil(n / chunkLen)).keys()].every((c) => chunks.has(c)));
  };

  /** The loaded rows of the page in order (call only when `complete()`). */
  const pageRows = (): Cell[][] => [...chunks.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, ch]) => ch.rows);

  return {
    columns,
    rowCount,
    version,
    hasMore,
    total,
    loading,
    applied,
    query: () => query,
    load,
    getRow,
    countRows,
    locatorOf,
    complete,
    pageRows,
    /** Cancels the effect of requests still in flight (view disposed). */
    dispose: () => void ++gen,
  };
}

export type TableSource = ReturnType<typeof createTableSource>;
