/**
 * One query console = one DB session + its editor state + its Database Output.
 * Owns execution (statement events -> log lines, result tabs, gutter marks, error underline), cancel,
 * transaction mode / commit / rollback and the current schema.
 */
import { type Accessor, createSignal } from "solid-js";
import {
  type DataSource,
  type ExecHandle,
  type ExecHandlers,
  closeSession,
  execute,
  executeCollect,
  introspect,
  openSession,
  sessionInTransaction,
} from "../../api/db";
import { type EditorError, type ExecMark, type ExecuteRequest, type SqlEditorHandle, splitStatements } from "../../components/editor";
import { errorsField, execMarksField } from "../../components/editor/state";
import type { PageSize } from "../../components/grid";
import { type MenuItem, notify, openMenu } from "../../components/ui";
import { showToolWindow } from "../../state/layout";
import { activateTab } from "../../state/tabs";
import { ensureConnected } from "../explorer/core";
import {
  INTERNAL_MARK,
  completedIn,
  leadingComment,
  reportsCount,
  rowsAffected,
  rowsRetrieved,
  summary,
} from "../output/format";
import { qualifiedTitle, singleTable } from "./title";
import { ConsoleOutput, DEFAULT_PAGE_SIZE, type OutputHost, ResultTab, createOutput, removeOutput } from "../output/model";

export type TxMode = "auto" | "manual";
export type Isolation = "read uncommitted" | "read committed" | "repeatable read" | "serializable";

const ISOLATIONS: Isolation[] = ["read uncommitted", "read committed", "repeatable read", "serializable"];
const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());
const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");
const LOST = /does not exist|is closed|not connected|Session is closed/i;

export interface RunOptions {
  /** Result tab to replace in place (Reload Page). */
  replace?: ResultTab;
  pageSize?: PageSize;
}

interface Pending {
  lineId: number;
  kind: "rows" | "update" | "done";
  n: number;
  ms: number;
}

export class ConsoleSession implements OutputHost {
  readonly out: ConsoleOutput;
  readonly driver: DataSource["driver"];
  editor?: SqlEditorHandle;
  sessionId?: string;
  private opening?: Promise<string>;
  private disposed = false;
  private connectedLogged = false;
  private curHandle?: Promise<ExecHandle>;

  readonly txMode: Accessor<TxMode>;
  private readonly setTx: (m: TxMode) => void;
  readonly isolation: Accessor<Isolation>;
  private readonly setIso: (i: Isolation) => void;
  readonly inTx: Accessor<boolean>;
  private readonly setInTx: (b: boolean) => void;
  /** Current schema (PG `public`, MySQL database, SQLite `main`), null until known. */
  readonly schema: Accessor<string | null>;
  private readonly setSchema: (s: string | null) => void;
  readonly marks: Accessor<ExecMark[]>;
  private readonly setMarks: (m: ExecMark[]) => void;
  readonly errors: Accessor<EditorError[]>;
  private readonly setErrors: (e: EditorError[]) => void;
  readonly pageSize: Accessor<PageSize>;
  private readonly setPageSize: (p: PageSize) => void;

  constructor(
    readonly tabId: string,
    readonly ds: DataSource,
    readonly consoleName: string,
    readonly title: () => string,
  ) {
    this.driver = ds.driver;
    this.out = createOutput(tabId, ds.driver);
    this.out.host = this;
    const sig = <T,>(v: T): [Accessor<T>, (v: T) => void] => {
      const [g, s] = createSignal<T>(v);
      return [g, (x: T) => void s(() => x)];
    };
    [this.txMode, this.setTx] = sig<TxMode>("auto");
    [this.isolation, this.setIso] = sig<Isolation>(ds.driver === "mysql" ? "repeatable read" : "read committed");
    [this.inTx, this.setInTx] = sig(false);
    [this.schema, this.setSchema] = sig<string | null>(ds.driver === "sqlite" ? "main" : ds.driver === "mysql" ? ds.database || null : null);
    [this.marks, this.setMarks] = sig<ExecMark[]>([]);
    [this.errors, this.setErrors] = sig<EditorError[]>([]);
    [this.pageSize, this.setPageSize] = sig<PageSize>(DEFAULT_PAGE_SIZE);
  }

  get dsId(): string {
    return this.ds.id;
  }

  // ------------------------------------------------------------ labels

  /** `postgres.public` / `demo` / `main`: prompt of the log and text of the schema switcher. */
  label(): string | null {
    const s = this.schema();
    if (this.driver === "postgres") return s ? `${this.ds.database}.${s}` : null;
    return s;
  }
  private prompt(): string {
    return this.label() ?? this.ds.database ?? this.ds.name;
  }

  // ------------------------------------------------------------ session

  /** Opens the DB session (once). Connects the data source first. */
  ensureSession(): Promise<string> {
    if (this.sessionId) return Promise.resolve(this.sessionId);
    this.opening ??= (async () => {
      await ensureConnected(this.ds.id);
      const sid = await openSession(this.ds.id);
      if (this.disposed) {
        void closeSession(sid).catch(() => {});
        throw new Error("Console closed");
      }
      this.sessionId = sid;
      this.connectedLogged = false;
      await this.detectSchema(sid);
      return sid;
    })().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private async silent(sid: string, sql: string) {
    const ev = await executeCollect(sid, `${sql} ${INTERNAL_MARK}`, { maxRows: 10, stopOnError: true });
    const err = ev.find((e) => e.kind === "error");
    if (err && err.kind === "error") throw new Error(err.message);
    return ev;
  }

  private async detectSchema(sid: string): Promise<void> {
    if (this.driver === "sqlite") return this.setSchema("main");
    try {
      const ev = await this.silent(sid, this.driver === "postgres" ? "select current_schema()" : "select database()");
      const rs = ev.find((e) => e.kind === "resultset");
      const v = rs && rs.kind === "resultset" ? rs.rows[0]?.[0] : null;
      if (typeof v === "string") this.setSchema(v);
    } catch {
      /* the label stays "<schema>" */
    }
  }

  /** Re-detect after the user ran `SET search_path` / `USE` themselves. */
  private async refreshSchema(sid: string): Promise<void> {
    await this.detectSchema(sid);
  }

  // ------------------------------------------------------------ execution

  focusEditor(): void {
    activateTab(this.tabId);
    this.editor?.focus();
  }

  cancel(): void {
    void this.curHandle?.then((h) => h.cancel()).catch(() => {});
  }

  rerun(tab: ResultTab, pageSize?: PageSize): void {
    if (pageSize !== undefined) this.setPageSize(pageSize);
    void this.run({ sql: tab.sql, ranges: [], source: "statement" }, { replace: tab, pageSize: pageSize ?? this.pageSize() });
  }

  /** The editor's own Ctrl+Enter path (statement chooser included). */
  executeFromEditor(): void {
    this.editor?.execute();
  }

  executeScript(): void {
    const req = this.editor?.getScript();
    if (req) void this.run(req);
  }

  /** Document offset of position `p` of the text that was sent. */
  private docOffset(req: ExecuteRequest, p: number): number {
    let acc = 0;
    for (const r of req.ranges) {
      const len = r.to - r.from;
      if (p <= acc + len) return r.from + Math.max(0, p - acc);
      acc += len + 1;
    }
    const last = req.ranges[req.ranges.length - 1];
    return last ? last.to : 0;
  }

  /** The statement range of the editor that starts inside `[from, to)` (skips an attached leading comment). */
  private editorStatement(from: number, to: number): { from: number; to: number } {
    const sts = this.editor?.getStatements() ?? [];
    return sts.find((s) => s.from >= from && s.from < to) ?? sts.find((s) => s.from <= from && s.to > from) ?? { from, to };
  }

  /** `-- Top customers` right above the statement (no blank line in between): DataGrip names the result tab after it. */
  private attachedComment(from: number): string | null {
    const doc = this.editor?.view?.state.doc;
    if (!doc || from > doc.length) return null;
    const first = doc.lineAt(from);
    if (doc.sliceString(first.from, from).trim()) return null;
    const names: string[] = [];
    for (let n = first.number - 1; n >= 1; n--) {
      const t = doc.line(n).text.trim();
      if (!t.startsWith("--")) break;
      names.unshift(t.replace(/^--+\s?/, "").trim());
    }
    return names.find((x) => x) ?? null;
  }

  private currentMarks(): ExecMark[] {
    const v = this.editor?.view;
    return v ? [...v.state.field(execMarksField)] : this.marks();
  }
  private currentErrors(): EditorError[] {
    const v = this.editor?.view;
    return v ? [...v.state.field(errorsField)] : this.errors();
  }

  private async startExecute(sid: string, sql: string, o: RunOptions, handlers: ExecHandlers) {
    const size = o.pageSize ?? this.pageSize();
    const options = { maxRows: size === "all" ? DEFAULT_PAGE_SIZE : size, keepOpenSecs: 600 };
    return execute(sid, sql, handlers, options);
  }

  async run(req: ExecuteRequest, o: RunOptions = {}): Promise<void> {
    const out = this.out;
    if (out.running()) {
      notify({ kind: "info", title: "The console is busy", body: "Wait for the running statement or cancel it (Ctrl+F2)." });
      return;
    }
    out.setRunning(true);
    showToolWindow("output", false);
    const pageSize = o.pageSize ?? this.pageSize();
    const stmtTotal = Math.max(1, splitStatements(req.sql, this.driver).length);
    const recs: Pending[] = [];
    let first = true;
    let ordinal = 0;
    let failed = 0;
    let executed = 0;
    let cur: { sql: string; t0: number; from: number; to: number; errored: boolean } | null = null;
    const nowMs = () => performance.now();
    const t00 = nowMs();
    let resolveHandle!: (h: ExecHandle) => void;
    let rejectHandle!: (e: unknown) => void;
    const handleP = new Promise<ExecHandle>((res, rej) => ((resolveHandle = res), (rejectHandle = rej)));
    handleP.catch(() => {});
    this.curHandle = handleP;

    for (const r of out.results()) if (r.id !== o.replace?.id) r.detach();

    const mark = (status: "ok" | "error", ms: number) => {
      if (!cur || !req.ranges.length) return;
      const r = this.editorStatement(cur.from, cur.to);
      const keep = this.currentMarks().filter((m) => !(m.from < r.to && m.to > r.from) && m.from !== r.from);
      this.setMarks([...keep, { from: r.from, to: r.to, status, ms }]);
    };

    let doneEvent: { elapsedMs: number; executionMs: number; fetchingMs: number } | null = null;

    const handlers: ExecHandlers = {
      onStatement: (e) => {
        executed++;
        const from = this.docOffset(req, e.range.startUtf16);
        const to = this.docOffset(req, e.range.endUtf16);
        cur = { sql: e.sql, t0: nowMs(), from, to, errored: false };
        out.log("sql", e.sql, this.prompt());
        if (req.ranges.length) {
          const r = this.editorStatement(from, to);
          this.setErrors(this.currentErrors().filter((x) => !(x.statementFrom >= r.from && x.statementFrom < r.to) && x.statementFrom !== from));
        }
      },
      onResultSet: (e) => {
        const ms = nowMs() - (cur?.t0 ?? t00);
        ordinal++;
        const sql = cur?.sql ?? req.sql;
        const meta = e.columns;
        const refs = new Set(meta.map((c) => c.tableRef));
        const ref = refs.size === 1 ? meta[0]?.tableRef : null;
        const parts = ref ? ref.split(".") : singleTable(sql, this.driver);
        const title =
          leadingComment(sql) ?? (req.ranges.length && cur ? this.attachedComment(cur.from) : null) ?? (parts ? qualifiedTitle(parts, this.driver, this.ds.database, this.schema()) : `Result ${ordinal}`);
        const tab = new ResultTab(meta, e.rows, e.hasMore, title, sql, e.index, () => handleP, pageSize);
        tab.ms = ms;
        out.addResult(tab, { first, replace: first ? o.replace : undefined });
        first = false;
        const id = out.log("text", rowsRetrieved(e.rows.length, ms));
        recs.push({ lineId: id, kind: "rows", n: e.rows.length, ms });
        mark("ok", ms);
        if (pageSize === "all" && e.hasMore) void tab.loadAll();
      },
      onUpdate: (e) => {
        const ms = nowMs() - (cur?.t0 ?? t00);
        const sql = cur?.sql ?? req.sql;
        const count = reportsCount(sql);
        const id = out.log("text", count ? rowsAffected(e.rowsAffected, ms) : completedIn(ms));
        recs.push({ lineId: id, kind: count ? "update" : "done", n: e.rowsAffected, ms });
        mark("ok", ms);
      },
      onError: (e) => {
        failed++;
        out.log("error", e.message);
        const ms = nowMs() - (cur?.t0 ?? t00);
        if (cur && req.ranges.length) {
          cur.errored = true;
          mark("error", ms);
          this.setErrors([
            ...this.currentErrors(),
            { statementFrom: cur.from, statementTo: cur.to, position: e.position ?? undefined, message: e.message.split("\n")[0] },
          ]);
        }
      },
      onMessage: (e) => void out.log("text", e.text),
      onDone: (e) => {
        doneEvent = e;
      },
    };

    const launch = async (): Promise<void> => {
      let sid = await this.ensureSession();
      if (!this.connectedLogged) {
        out.log("text", "Connected");
        this.connectedLogged = true;
      }
      if (this.txMode() === "manual" && !(await sessionInTransaction(sid))) {
        await this.silent(sid, this.driver === "mysql" ? "START TRANSACTION" : "BEGIN");
      }
      let handle: ExecHandle;
      try {
        handle = await this.startExecute(sid, req.sql, o, handlers);
      } catch (e) {
        if (!LOST.test(errText(e))) throw e;
        // the session died (data source deactivated): reconnect once
        this.sessionId = undefined;
        this.setInTx(false);
        sid = await this.ensureSession();
        out.log("text", "Connected");
        this.connectedLogged = true;
        handle = await this.startExecute(sid, req.sql, o, handlers);
      }
      resolveHandle(handle);
      await handle.done;
    };

    try {
      await launch();
    } catch (e) {
      rejectHandle(e);
      out.log("error", errText(e));
    }

    // timing breakdown (`execution: x ms, fetching: y ms`): exact for one statement, proportional for scripts
    const total = nowMs() - t00;
    const de = doneEvent as { elapsedMs: number; executionMs: number; fetchingMs: number } | null;
    if (de) {
      const exact = recs.length === 1 && de.executionMs + de.fetchingMs > 0;
      const execShare = de.executionMs + de.fetchingMs > 0 ? de.executionMs / (de.executionMs + de.fetchingMs) : 0.5;
      for (const r of recs) {
        const ms = exact ? de.executionMs + de.fetchingMs : r.ms;
        const ex = exact ? de.executionMs : Math.round(ms * execShare);
        const fe = exact ? de.fetchingMs : Math.max(0, Math.round(ms) - ex);
        if (r.kind === "rows") out.patchLine(r.lineId, rowsRetrieved(r.n, ms, ex, fe));
        else out.patchLine(r.lineId, r.kind === "update" ? rowsAffected(r.n, ms) : completedIn(ms));
      }
      // the server reports whole milliseconds (0 for fast statements): fall back to the client clock
      const roundTrip = Math.max(de.elapsedMs, de.executionMs + de.fetchingMs) || recs.reduce((a, r) => a + r.ms, 0);
      if (recs.length === 1 && cur) {
        // the gutter hint shows the whole round trip, like the header
        const c = cur as { from: number; to: number };
        const r = this.editorStatement(c.from, c.to);
        this.setMarks(this.currentMarks().map((m) => (m.from === r.from && m.ms !== undefined ? { ...m, ms: roundTrip } : m)));
      }
      out.setLastMs(roundTrip);
      if (stmtTotal > 1 || executed > 1) {
        out.log("text", summary(executed - failed, Math.max(stmtTotal, executed), failed, roundTrip, req.source === "script" ? req.sql.length : undefined, failed > 0 && executed < stmtTotal));
      }
    } else {
      out.setLastMs(total);
    }
    if (first) out.select("output"); // nothing returned rows: show the log
    const sid = this.sessionId;
    if (sid) {
      try {
        this.setInTx(await sessionInTransaction(sid));
        if (/\b(set|use)\b/i.test(req.sql)) await this.refreshSchema(sid);
      } catch {
        /* session gone */
      }
    }
    out.setRunning(false);
  }

  // ------------------------------------------------------------ transactions

  async setTxMode(m: TxMode): Promise<void> {
    if (m === this.txMode()) return;
    if (m === "auto" && this.inTx()) await this.endTx("commit");
    this.setTx(m);
    this.out.log("text", `${m === "manual" ? "Manual" : "Auto"} transaction mode ON`);
  }

  async setIsolation(i: Isolation): Promise<void> {
    this.setIso(i);
    if (this.driver === "sqlite") return;
    try {
      const sid = await this.ensureSession();
      const lvl = i.toUpperCase();
      await this.silent(sid, this.driver === "postgres" ? `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${lvl}` : `SET SESSION TRANSACTION ISOLATION LEVEL ${lvl}`);
    } catch (e) {
      notify({ kind: "error", title: "Cannot change the transaction isolation", body: errText(e) });
    }
  }

  async endTx(kind: "commit" | "rollback"): Promise<void> {
    if (this.out.running()) return;
    try {
      const sid = await this.ensureSession();
      if (!(await sessionInTransaction(sid))) return this.setInTx(false);
      await this.silent(sid, kind === "commit" ? "COMMIT" : "ROLLBACK");
      this.out.log("text", kind === "commit" ? "transaction committed" : "transaction rolled back");
      this.setInTx(false);
    } catch (e) {
      this.out.log("error", errText(e));
    }
  }

  openTxMenu(anchor: HTMLElement | DOMRect): void {
    const manual = this.txMode() === "manual";
    const items: MenuItem[] = [
      { type: "header", label: "Transaction Mode" },
      { label: "Auto", checked: !manual, run: () => void this.setTxMode("auto") },
      { label: "Manual", checked: manual, run: () => void this.setTxMode("manual") },
    ];
    if (this.driver !== "sqlite") {
      items.push({ type: "separator" }, { type: "header", label: "Transaction Isolation" });
      for (const i of ISOLATIONS) items.push({ label: cap(i), checked: this.isolation() === i, run: () => void this.setIsolation(i) });
    }
    items.push({ type: "separator" }, {
      type: "hint",
      label: manual ? "Manually commit changes submitted to the database" : "Changes submitted to the database are auto-committed",
    });
    if (anchor instanceof HTMLElement) openMenu(items, { anchor, minWidth: 190 });
    else openMenu(items, { x: anchor.left, y: anchor.bottom + 2, minWidth: 190 });
  }

  // ------------------------------------------------------------ schema switcher

  /** Popup of the toolbar's `postgres.public` button. */
  async openSchemaMenu(anchor: HTMLElement): Promise<void> {
    try {
      await ensureConnected(this.ds.id);
      const cur = this.schema();
      let items: MenuItem[];
      if (this.driver === "postgres") {
        const dbs = await introspect(this.ds.id, []);
        const schemas = await introspect(this.ds.id, [this.ds.database]);
        items = dbs.map<MenuItem>((d) =>
          d.name === this.ds.database
            ? {
                label: d.name,
                icon: "dg/database",
                children: schemas.map<MenuItem>((s) => ({ label: s.name, icon: "dg/schema", checked: s.name === cur, run: () => void this.switchSchema(s.name) })),
              }
            : { label: d.name, icon: "dg/database", enabled: false },
        );
      } else {
        const list = await introspect(this.ds.id, []);
        items = list.map<MenuItem>((s) => ({ label: s.name, icon: "dg/schema", checked: s.name === cur, run: () => void this.switchSchema(s.name) }));
      }
      openMenu(items, { anchor, minWidth: 200 });
    } catch (e) {
      notify({ kind: "error", title: "Cannot list the schemas", body: errText(e) });
    }
  }

  async switchSchema(name: string): Promise<void> {
    if (this.driver === "sqlite") return;
    if (this.out.running()) return;
    try {
      const sid = await this.ensureSession();
      const q = this.driver === "postgres" ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, "``")}\``;
      await this.silent(sid, this.driver === "postgres" ? `SET search_path TO ${q}` : `USE ${q}`);
      this.setSchema(name);
    } catch (e) {
      notify({ kind: "error", title: "Cannot switch the schema", body: errText(e) });
    }
  }

  // ------------------------------------------------------------ lifecycle

  dispose(): void {
    this.disposed = true;
    this.cancel();
    const sid = this.sessionId;
    this.sessionId = undefined;
    if (sid) void closeSession(sid).catch(() => {});
    removeOutput(this.tabId);
  }
}
