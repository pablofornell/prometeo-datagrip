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
  applyChanges,
  cancelSession,
  closeSession,
  type TxStatus,
  execute,
  executeCollect,
  explainPlan,
  introspect,
  openSession,
  sessionTxStatus,
} from "../../api/db";
import type { ColumnMeta } from "../../api/types";
import { type EditorError, type ExecMark, type ExecuteRequest, type SqlEditorHandle, splitStatements } from "../../components/editor";
import { errorsField, execMarksField } from "../../components/editor/state";
import type { GridChange, PageSize } from "../../components/grid";
import { type MenuItem, notify, openMenu } from "../../components/ui";
import { showToolWindow } from "../../state/layout";
import { settings } from "../../state/settings";
import { activateTab, activeTab } from "../../state/tabs";
import { autoSyncAfter, ensureConnected } from "../explorer";
import {
  INTERNAL_MARK,
  completedIn,
  firstKeyword,
  leadingComment,
  reportsCount,
  rowsAffected,
  rowsRetrieved,
  summary,
  underlinePosition,
} from "../output/format";
import { CONNECTION_LOST_LOG, CONNECTION_LOST_TX_LOG, isConnectionLost } from "../../state/connection-errors";
import { saveSchema, saveSearchPath, savedSchema, savedSearchPath } from "./schemaPref";
import { qualifiedTitle, resultTable } from "./title";
import { type SchemaChange, resolveEdit, schemaChange } from "./editable";
import { keyedChanges } from "../output/edit";
import { ALL_FIRST_CHUNK, ConsoleOutput, type OutputHost, ResultTab, createOutput, defaultPageSize, removeOutput } from "../output/model";
import { askChoice } from "../table/dialogs";
import {
  SERVER_ROLLBACK_BODY,
  SERVER_ROLLBACK_LOG,
  SERVER_ROLLBACK_TITLE,
  applyChangesInSession,
  classifyTxEnd,
  control,
  controlError,
  ensureTransaction,
  isSessionLost,
  txReport,
} from "../table/session";
import { previewSql, toRowChanges } from "../table/sql";
import { confirmEndTransactions } from "./txguard";
import { findParams, loadValues, paramList, saveValues, substitute } from "./params";
import { askParams } from "./paramsDialog";

export type TxMode = "auto" | "manual";
/** `default`: the server's own level (nothing is set on the session). */
export type Isolation = "default" | "read uncommitted" | "read committed" | "repeatable read" | "serializable";

/** The isolation levels of the Tx menu; Read Uncommitted only exists on MySQL (PostgreSQL runs it as Read Committed). */
export const isolationLevels = (driver: DataSource["driver"]): Isolation[] =>
  driver === "mysql" ? ["default", "read uncommitted", "read committed", "repeatable read", "serializable"] : ["default", "read committed", "repeatable read", "serializable"];
const isolationLabel = (i: Isolation): string => (i === "default" ? "Database Default" : cap(i));
const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());
const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

/** What the user changed in the session with their own statements; a new session does not have it. */
interface SessionSettings {
  /** The `SET ...` statements (single line), oldest first; `SET search_path` is left out (restored from the schema pref). */
  sets: string[];
  /** MySQL: the last `SET autocommit` of the user turned autocommit off. */
  autocommitOff: boolean;
}
const noSettings = (): SessionSettings => ({ sets: [], autocommitOff: false });

/** The text of the balloon / Output line that follows a reconnect. */
export const SESSION_RESET_LOG =
  "The connection was re-established. Session state was reset: temporary tables, session variables and SET commands you ran are lost; only the schema and isolation level were restored.";

/** `SET ...` statements (after leading comments) and whether they turn autocommit off; null for any other statement. */
export function sessionSetting(sql: string): { text: string; autocommit?: boolean } | null {
  const text = sql.replace(/^(?:\s+|\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$))+/, "").trim();
  if (!/^set\b/i.test(text) || /^set\s+(?:session\s+|local\s+)?search_path\b/i.test(text)) return null;
  const ac = /\bautocommit\s*(?:=|:=|\s+to\s+)\s*'?(\w+)/i.exec(text);
  return { text: text.replace(/\s+/g, " ").replace(/;+$/, ""), autocommit: ac ? /^(?:0|false|off)$/i.test(ac[1]) : undefined };
}

/** Statements that may return rows: their result tab shows (spinning) while they run. */
const ROW_QUERY = new Set(["SELECT", "WITH", "SHOW", "VALUES", "TABLE", "EXPLAIN", "PRAGMA", "DESCRIBE", "DESC", "CALL", "EXEC", "EXECUTE"]);
export const returnsRows = (sql: string): boolean => ROW_QUERY.has(firstKeyword(sql));
/** A statement that takes longer than this ends with a balloon when the console is out of sight. */
const LONG_RUN_MS = 5000;
/** The pending result tab appears when the statement still runs after this (a quick statement never flashes it). */
const PENDING_DELAY_MS = 150;

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
  /** The DB session of the console (undefined until the first run / after it was lost); reactive for the Services window. */
  private readonly sidSig = createSignal<string | undefined>(undefined);
  get sessionId(): string | undefined {
    return this.sidSig[0]();
  }
  set sessionId(v: string | undefined) {
    this.sidSig[1](v);
  }
  private opening?: Promise<string>;
  private disposed = false;
  /** SET commands etc. of the live session, and (after the session was lost) of the dead one, until the reopen says so. */
  private userSettings = noSettings();
  private lostSettings?: SessionSettings;
  private connectedLogged = false;
  private curHandle?: Promise<ExecHandle>;
  /** A result was edited inside the open transaction (the editable result is reloaded when it is rolled back). */
  private editedInTx = false;
  /** The session's schema changed and the server has to say which one; read it as soon as nothing is paging. */
  private readonly schemaDirtySig = createSignal(false);
  private get schemaDirty(): boolean {
    return this.schemaDirtySig[0]();
  }
  private set schemaDirty(v: boolean) {
    this.schemaDirtySig[1](v);
  }


  readonly txMode: Accessor<TxMode>;
  private readonly setTx: (m: TxMode) => void;
  readonly isolation: Accessor<Isolation>;
  private readonly setIso: (i: Isolation) => void;
  /** The server's transaction state of the session (events of `execute`, `sessionTxStatus`); never keyword tracking. */
  readonly txStatus: Accessor<TxStatus>;
  private readonly setTxStatus: (s: TxStatus) => void;
  /** A transaction is open (`active` or `failed`). */
  readonly inTx: Accessor<boolean>;
  /** Why the last `endTx` failed (null when it did not): the close / quit guard shows it. */
  txError: string | null = null;
  /** Current schema (PG `public`, MySQL database, SQLite `main`), null until known. */
  readonly schema: Accessor<string | null>;
  private readonly setSchema: (s: string | null) => void;
  readonly marks: Accessor<ExecMark[]>;
  private readonly setMarks: (m: ExecMark[]) => void;
  readonly errors: Accessor<EditorError[]>;
  private readonly setErrors: (e: EditorError[]) => void;
  /** The error of the last run (full text), shown in the banner at the bottom of the editor until dismissed or the next run. */
  readonly execError: Accessor<string | null>;
  readonly setExecError: (m: string | null) => void;
  /** The page size of this console: the pill's choice, else the Settings page size (reactive). */
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
    [this.txMode, this.setTx] = sig<TxMode>(settings.defaultTxMode);
    [this.isolation, this.setIso] = sig<Isolation>("default");
    [this.txStatus, this.setTxStatus] = sig<TxStatus>("idle");
    this.inTx = () => this.txStatus() !== "idle";
    // the schema chosen last time shows at once; it is applied to the session when that opens (`ensureSession`)
    [this.schema, this.setSchema] = sig<string | null>(
      ds.driver === "sqlite" ? "main" : (savedSchema(ds.id, consoleName) ?? (ds.driver === "mysql" ? ds.database || null : null)),
    );
    [this.marks, this.setMarks] = sig<ExecMark[]>([]);
    [this.errors, this.setErrors] = sig<EditorError[]>([]);
    [this.execError, this.setExecError] = sig<string | null>(null);
    const [sizeOverride, setSizeOverride] = createSignal<PageSize | null>(null);
    this.pageSize = () => sizeOverride() ?? defaultPageSize();
    this.setPageSize = (p) => void setSizeOverride(() => p);
  }

  /**
   * A schema change is waiting for the server to say which schema it is, and nothing blocks the query any more (no
   * result is paging, nothing runs). Reactive: the view calls `settleSchema` when this turns true.
   */
  readonly schemaReadable = (): boolean => this.schemaDirty && !this.out.running() && !!this.sessionId && !this.out.results().some((r) => r.hasMore());

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

  /**
   * What a (re)opened session needs to look like the console: the schema the user chose and a non-default isolation
   * level. The backend keeps no session settings, so they are re-applied as `initSql`.
   */
  private initSql(withSchema = true): string[] {
    if (this.driver === "sqlite") return [];
    const sql: string[] = [];
    const want = withSchema ? savedSchema(this.ds.id, this.consoleName) : null;
    // the user's own `SET search_path` is replayed as written (`"$user", public`); a schema picked in the switcher is one name
    const path = withSchema && this.driver === "postgres" ? savedSearchPath(this.ds.id, this.consoleName) : null;
    if (path) sql.push(`SET search_path TO ${path}`);
    else if (want) sql.push(this.useSchemaSql(want));
    if (this.isolation() !== "default") sql.push(this.isolationSql(this.isolation()));
    return sql;
  }

  private isolationSql(i: Isolation): string {
    if (i === "default") return this.driver === "postgres" ? "RESET default_transaction_isolation" : "SET SESSION transaction_isolation = DEFAULT";
    const lvl = i.toUpperCase();
    return this.driver === "postgres" ? `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${lvl}` : `SET SESSION TRANSACTION ISOLATION LEVEL ${lvl}`;
  }

  /** Opens the DB session (once). Connects the data source first. */
  ensureSession(): Promise<string> {
    if (this.sessionId) return Promise.resolve(this.sessionId);
    this.opening ??= (async () => {
      await ensureConnected(this.ds.id);
      let sid: string;
      try {
        sid = await openSession(this.ds.id, this.initSql());
      } catch (e) {
        if (isSessionLost(e) || !(savedSchema(this.ds.id, this.consoleName) || savedSearchPath(this.ds.id, this.consoleName))) throw e;
        // the saved schema is gone (dropped / renamed): forget it, open with the session default
        saveSchema(this.ds.id, this.consoleName, null);
        saveSearchPath(this.ds.id, this.consoleName, null);
        sid = await openSession(this.ds.id, this.initSql(false));
      }
      if (this.disposed) {
        void closeSession(sid).catch(() => {});
        throw new Error("Console closed");
      }
      this.sessionId = sid;
      this.connectedLogged = false;
      this.setTxStatus("idle");
      this.reportReset();
      await this.detectSchema(sid);
      return sid;
    })().finally(() => (this.opening = undefined));
    return this.opening;
  }

  /**
   * A session replaced the one that was lost: everything the user set in it is gone (the backend's own "settings were
   * reset" message never shows, the dead session is closed). Say so; the user's SET commands are not run again.
   */
  private reportReset(): void {
    const lost = this.lostSettings;
    this.lostSettings = undefined;
    if (!lost) return;
    let text = SESSION_RESET_LOG;
    if (this.driver === "mysql" && lost.autocommitOff) text += " SET autocommit=0 was run in this console: autocommit is on again.";
    if (lost.sets.length) {
      const last = lost.sets[lost.sets.length - 1];
      text += ` The SET commands run in this console (last: ${last.length > 60 ? `${last.slice(0, 60)}…` : last}) are not in effect and were not run again.`;
    }
    this.out.log("error", text);
    notify({ kind: "warning", title: "Session state was reset", body: text });
  }

  /** Remembers what a statement of the user changes in the session (reported when a reconnect loses it). */
  private noteSetting(sql: string): void {
    const set = sessionSetting(sql);
    if (!set) return;
    this.userSettings.sets = [...this.userSettings.sets.filter((x) => x !== set.text), set.text];
    if (set.autocommit !== undefined) this.userSettings.autocommitOff = set.autocommit;
  }

  /**
   * A statement of ours (BEGIN, COMMIT, `select current_schema()`, ...). The transaction events it produces are
   * applied here, like those of the user's statements.
   */
  private async silent(sid: string, sql: string) {
    const ev = await executeCollect(sid, `${sql} ${INTERNAL_MARK}`, { maxRows: 10, stopOnError: true });
    const err = ev.find((e) => e.kind === "error");
    if (err && err.kind === "error") throw controlError(err);
    const r = txReport(ev);
    if (r.status) this.setTxStatus(r.status);
    return ev;
  }

  /** A paged result still holds the connection: running anything on the session closes its stream. Say so. */
  private releaseResults(reason: string): void {
    for (const r of this.out.results()) if (r.hasMore()) r.detach(reason);
  }

  /** Reads the session's current schema into the signal; resolves to it (null when it could not be read). */
  private async detectSchema(sid: string): Promise<string | null> {
    if (this.driver === "sqlite") {
      this.setSchema("main");
      return "main";
    }
    try {
      const ev = await this.silent(sid, this.driver === "postgres" ? "select current_schema()" : "select database()");
      const rs = ev.find((e) => e.kind === "resultset");
      const v = rs && rs.kind === "resultset" ? rs.rows[0]?.[0] : null;
      if (typeof v === "string") {
        this.setSchema(v);
        return v;
      }
    } catch {
      /* the label stays "<schema>" */
    }
    return null;
  }

  private useSchemaSql(name: string): string {
    const q = this.driver === "postgres" ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, "``")}\``;
    return this.driver === "postgres" ? `SET search_path TO ${q}` : `USE ${q}`;
  }

  /** Re-detect after the user ran `SET search_path` / `USE` themselves; the new schema is the console's from now on. */
  private async refreshSchema(sid: string): Promise<void> {
    this.schemaDirty = false;
    const now = await this.detectSchema(sid);
    if (this.driver !== "sqlite" && now) saveSchema(this.ds.id, this.consoleName, now);
  }

  /** The deferred read of `afterSchemaChange` (see `schemaReadable`). */
  async settleSchema(): Promise<void> {
    const sid = this.sessionId;
    if (!sid || !this.schemaReadable()) return;
    try {
      await this.refreshSchema(sid);
    } catch (e) {
      if (isSessionLost(e)) this.sessionLost();
    }
  }

  // ------------------------------------------------------------ lost session

  /**
   * The session is gone (the data source was disconnected / deactivated): drop it, forget the transaction (the server
   * rolled it back with the connection) and reopen on the next run with the console's settings (`initSql`).
   */
  private sessionLost(o: { tx?: boolean; closed?: boolean } = {}): void {
    // `tx`: the caller knows a transaction was open (the backend's `txStatus: idle` may have been applied already)
    const had = o.tx ?? this.txStatus() !== "idle";
    const old = this.sessionId;
    this.sessionId = undefined;
    this.opening = undefined;
    this.setTxStatus("idle");
    this.editedInTx = false;
    this.connectedLogged = false;
    this.schemaDirty = false;
    if (old) {
      this.lostSettings = this.userSettings; // the next session starts without them: tell the user when it opens
      this.userSettings = noSettings();
      void closeSession(old).catch(() => {}); // releases a dead session (the backend accepts that)
    }
    if (o.closed) {
      if (had) {
        this.out.log("error", "the transaction was rolled back: connection closed");
        notify({ kind: "warning", title: "The transaction was rolled back", body: `The connection of '${this.title()}' was closed, so its open transaction was rolled back.` });
      } else this.out.log("text", "connection closed");
    } else if (had) {
      this.out.log("error", CONNECTION_LOST_TX_LOG);
      notify({ kind: "warning", title: "The transaction was rolled back", body: `The connection of '${this.title()}' was lost, so its open transaction was rolled back. The next run opens a new connection.` });
    } else this.out.log("text", CONNECTION_LOST_LOG);
  }

  /** A paging fetch of a result found the connection dead (the backend marked the session lost; its transaction is gone). */
  connectionLost(): void {
    if (this.sessionId && !this.out.running()) this.sessionLost({ tx: this.inTx() });
  }

  /** The data source was disconnected while this console was open (called by the view). */
  connectionClosed(): void {
    if (this.sessionId && !this.out.running()) this.sessionLost({ closed: true });
  }

  // ------------------------------------------------------------ execution

  focusEditor(): void {
    activateTab(this.tabId);
    this.editor?.focus();
  }

  /** `Open in Console` of the SQL popup: the text goes in at the caret (replacing the selection). */
  insertSql(text: string): void {
    const v = this.editor?.view;
    if (v) v.dispatch(v.state.replaceSelection(text), { scrollIntoView: true });
    this.focusEditor();
  }

  cancel(): void {
    if (this.explaining && this.sessionId) void cancelSession(this.sessionId).catch(() => {});
    void this.curHandle?.then((h) => h.cancel()).catch(() => {});
  }

  /** An Explain runs on the session (it has no execution handle: `cancel` stops it through the session). */
  private explaining = false;

  /**
   * Explain Plan / Explain Analyse (which runs the statement) of the selection or the statement at the caret; the plan
   * opens in the `Query Plan` tab of the Database Output.
   */
  async explain(analyze: boolean): Promise<void> {
    const out = this.out;
    if (out.running()) {
      notify({ kind: "info", title: "The console is busy", body: "Wait for the running statement or cancel it (Ctrl+F2)." });
      return;
    }
    const req = this.editor?.getSelectionOrStatement();
    if (!req?.sql.trim()) {
      notify({ kind: "info", title: "Nothing to explain", body: "Put the caret in a statement." });
      return;
    }
    if (analyze && this.driver === "sqlite") return;
    out.setRunning(true);
    this.explaining = true;
    this.setExecError(null);
    showToolWindow("output", false);
    let sid: string | undefined;
    try {
      sid = await this.ensureSession();
      this.releaseResults("an Explain ran on the same connection");
      const plan = await explainPlan(sid, req.sql, analyze);
      out.setLastMs(plan.elapsedMs);
      out.showPlan(plan);
    } catch (e) {
      const msg = errText(e);
      if (isSessionLost(e)) this.sessionLost({ tx: this.inTx() });
      else if (sid) await this.syncTxStatus(sid); // a failing EXPLAIN aborts a PostgreSQL transaction
      out.log("error", msg);
      this.setExecError(msg);
      notify({ kind: "error", title: analyze ? "Explain Analyse failed" : "Explain Plan failed", body: msg });
    } finally {
      this.explaining = false;
      out.setRunning(false);
    }
  }

  rerun(tab: ResultTab, pageSize?: PageSize): void {
    if (pageSize !== undefined) this.setPageSize(pageSize);
    void this.run({ sql: tab.sql, ranges: [], source: "statement" }, { replace: tab, pageSize: pageSize ?? this.pageSize() });
  }

  /**
   * Asks for the values of the `?`, `:name`, `$1` ... of the script and substitutes them (null: cancelled). The values
   * are remembered per console and parameter.
   */
  private async resolveParams(req: ExecuteRequest): Promise<ExecuteRequest | null> {
    const refs = findParams(req.sql, this.driver);
    if (!refs.length) return req;
    const values = await askParams(paramList(refs), loadValues(this.ds.id, this.consoleName), true);
    if (!values) return null;
    saveValues(this.ds.id, this.consoleName, { ...loadValues(this.ds.id, this.consoleName), ...values });
    const sub = substitute(req.sql, refs, values);
    return { ...req, sql: sub.sql, unmap: sub.unmap };
  }

  /** `View Parameters`: the parameters of the selection / statement (else the script), without running anything. */
  async viewParameters(): Promise<void> {
    const req = this.editor?.getSelectionOrStatement() ?? this.editor?.getScript();
    const keys = req ? paramList(findParams(req.sql, this.driver)) : [];
    if (!keys.length) {
      notify({ kind: "info", title: "No parameters", body: "The statement has no ?, :name or $1 parameters." });
      return;
    }
    const values = await askParams(keys, loadValues(this.ds.id, this.consoleName), false);
    if (values) saveValues(this.ds.id, this.consoleName, { ...loadValues(this.ds.id, this.consoleName), ...values });
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
    if (req.unmap) p = req.unmap(p);
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
    const options = { maxRows: size === "all" ? ALL_FIRST_CHUNK : size, keepOpenSecs: 600 };
    return execute(sid, sql, handlers, options);
  }

  async run(req: ExecuteRequest, o: RunOptions = {}): Promise<void> {
    const out = this.out;
    if (out.running()) {
      notify({ kind: "info", title: "The console is busy", body: "Wait for the running statement or cancel it (Ctrl+F2)." });
      return;
    }
    const dirty = out.results().filter((r) => r.pending() > 0 && (r.id === o.replace?.id || (!o.replace && !r.pinned())));
    if (dirty.length) {
      const n = dirty.reduce((a, r) => a + r.pending(), 0);
      const a = await askChoice({
        title: "Uncommitted Changes",
        message: `The result has ${n} pending change${n === 1 ? "" : "s"} that were not submitted. Running the statement discards them.`,
        choices: [
          { label: "Discard and Run", value: "run", primary: true },
          { label: "Cancel", value: "cancel" },
        ],
        cancel: "cancel",
      });
      if (a !== "run") return;
      if (out.running()) return;
    }
    const withParams = await this.resolveParams(req);
    if (!withParams || out.running()) return;
    req = withParams;
    out.setRunning(true);
    this.setExecError(null);
    showToolWindow("output", false);
    const pageSize = o.pageSize ?? this.pageSize();
    const stmtTotal = Math.max(1, splitStatements(req.sql, this.driver).length);
    const recs: Pending[] = [];
    let first = true;
    let ordinal = 0;
    let failed = 0;
    let executed = 0;
    let cur: { sql: string; t0: number; from: number; to: number; errored: boolean; schema?: SchemaChange } | null = null;
    // schema of the session while the script runs: a `USE x;` / `SET search_path` earlier in the script decides which
    // schema the edit-target lookup and the tab title of the next statements use
    let scriptSchema = this.schema();
    let schemaTouched = false;
    let schemaUnknown = false;
    let searchPath: string | null | undefined; // the last `SET search_path` value list of the script (null: reset)
    let sessionClosed = false;
    let txLost = false; // the backend ended the transaction because the connection died
    const txAtStart = this.inTx();
    let reloadEdited = false;
    const nowMs = () => performance.now();
    const t00 = nowMs();
    let resolveHandle!: (h: ExecHandle) => void;
    let rejectHandle!: (e: unknown) => void;
    const handleP = new Promise<ExecHandle>((res, rej) => ((resolveHandle = res), (rejectHandle = rej)));
    handleP.catch(() => {});
    this.curHandle = handleP;

    // the new execution closes the paging streams of the earlier results: the tabs it replaces need no note, the ones
    // that stay (pinned, or when this run returns no rows) say that they are cut short
    const staleTabs = out.results().filter((r) => r.id !== o.replace?.id);
    for (const r of staleTabs) r.detach(undefined, true);

    const mark = (status: "ok" | "error", ms: number) => {
      if (!cur || !req.ranges.length) return;
      const r = this.editorStatement(cur.from, cur.to);
      const keep = this.currentMarks().filter((m) => !(m.from < r.to && m.to > r.from) && m.from !== r.from);
      this.setMarks([...keep, { from: r.from, to: r.to, status, ms }]);
    };

    let doneEvent: { elapsedMs: number; executionMs: number; fetchingMs: number } | null = null;

    // --- the running state: the gutter spinner + elapsed inlay of the statement and its pending result tab
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let placeholder: ResultTab | null = null;
    const stopPending = () => {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
      if (placeholder) out.clearPending();
      placeholder = null;
    };
    // the inlay counts whole seconds: the marks are only rewritten when the number changes
    let shownSecs = 0;
    const tickRunning = () => {
      if (!cur) return;
      const ms = nowMs() - cur.t0;
      const secs = Math.floor(ms / 1000);
      if (secs === shownSecs) return;
      shownSecs = secs;
      const marks = this.currentMarks();
      if (marks.some((m) => m.status === "running")) this.setMarks(marks.map((m) => (m.status === "running" ? { ...m, ms } : m)));
    };
    const tick = setInterval(tickRunning, 250);
    const resultTitle = (meta: ColumnMeta[], sql: string, from: number | null, n: number) => {
      const parts = resultTable(meta, sql, this.driver);
      return (
        leadingComment(sql) ?? (req.ranges.length && from !== null ? this.attachedComment(from) : null) ?? (parts ? qualifiedTitle(parts, this.driver, this.ds.database, scriptSchema) : `Result ${n}`)
      );
    };

    const handlers: ExecHandlers = {
      onStatement: (e) => {
        executed++;
        const from = this.docOffset(req, e.range.startUtf16);
        const to = this.docOffset(req, e.range.endUtf16);
        this.noteSetting(e.sql);
        stopPending();
        cur = { sql: e.sql, t0: nowMs(), from, to, errored: false, schema: schemaChange(e.sql, this.driver) ?? undefined };
        shownSecs = 0;
        out.log("sql", e.sql, this.prompt());
        if (req.ranges.length) {
          const r = this.editorStatement(from, to);
          this.setErrors(this.currentErrors().filter((x) => !(x.statementFrom >= r.from && x.statementFrom < r.to) && x.statementFrom !== from));
          // spinner instead of the check mark, and the elapsed time after the statement
          const keep = this.currentMarks().filter((m) => !(m.from < r.to && m.to > r.from) && m.from !== r.from);
          this.setMarks([...keep, { from: r.from, to: r.to, status: "running", ms: 0 }]);
        }
        // the result tab of a statement that returns rows replaces the unpinned ones while it runs
        if (first && returnsRows(e.sql)) {
          const sql = e.sql;
          const startFrom = from;
          pendingTimer = setTimeout(() => {
            pendingTimer = undefined;
            const tab = new ResultTab([], [], false, resultTitle([], sql, startFrom, ordinal + 1), sql, e.index, () => handleP, pageSize);
            placeholder = tab;
            out.showPending(tab, o.replace);
          }, PENDING_DELAY_MS);
        }
      },
      onResultSet: (e) => {
        const ms = nowMs() - (cur?.t0 ?? t00);
        stopPending();
        ordinal++;
        const sql = cur?.sql ?? req.sql;
        const meta = e.columns;
        const title = resultTitle(meta, sql, req.ranges.length && cur ? cur.from : null, ordinal);
        const tab = new ResultTab(meta, e.rows, e.hasMore, title, sql, e.index, () => handleP, pageSize);
        tab.ms = ms;
        // editable when it is one table with a usable key (resolved with the table's metadata, so a moment later)
        if (meta.length) void resolveEdit(this.ds, meta, sql, scriptSchema).then((t) => !tab.closed && tab.setEdit(t));
        out.addResult(tab, { first, replace: first ? o.replace : undefined });
        first = false;
        const id = out.log("text", rowsRetrieved(e.rows.length, ms));
        recs.push({ lineId: id, kind: "rows", n: e.rows.length, ms });
        mark("ok", ms);
        if (pageSize === "all" && e.hasMore) void tab.loadAll();
      },
      onUpdate: (e) => {
        stopPending();
        if (cur?.schema) {
          schemaTouched = true;
          if (cur.schema.schema) scriptSchema = cur.schema.schema;
          else schemaUnknown = true;
          searchPath = cur.schema.searchPath === undefined ? null : cur.schema.searchPath; // `USE x` drops an earlier path
        }
        const ms = nowMs() - (cur?.t0 ?? t00);
        const sql = cur?.sql ?? req.sql;
        const count = reportsCount(sql);
        const id = out.log("text", count ? rowsAffected(e.rowsAffected, ms) : completedIn(ms));
        recs.push({ lineId: id, kind: count ? "update" : "done", n: e.rowsAffected, ms });
        mark("ok", ms);
      },
      onError: (e) => {
        stopPending(); // the earlier result stays selected
        failed++;
        this.setExecError(e.message);
        out.log("error", e.message);
        if (isConnectionLost(e)) sessionClosed = true; // `connectionLost`, `[08006]` / `[08S01]`, or the session is gone
        const ms = nowMs() - (cur?.t0 ?? t00);
        if (cur && req.ranges.length) {
          cur.errored = true;
          mark("error", ms);
          this.setErrors([
            ...this.currentErrors(),
            { statementFrom: cur.from, statementTo: cur.to, position: underlinePosition(cur.sql, e.positionUtf16, e.message), message: e.message.split("\n")[0] },
          ]);
        }
      },
      onMessage: (e) => void out.log("text", e.text),
      onTxStatus: (e) => this.setTxStatus(e.status),
      onTxEnded: (e) => {
        const kind = classifyTxEnd(cur?.sql ?? null, e);
        if (kind === "connectionLost") {
          txLost = true; // reported once, with the dead session dropped, when the run ends
          sessionClosed = true;
        } else if (kind === "serverRollback") {
          out.log("error", SERVER_ROLLBACK_LOG);
          notify({ kind: "error", title: SERVER_ROLLBACK_TITLE, body: SERVER_ROLLBACK_BODY });
        } // "implicit": the backend's own message line already says that the statement committed the transaction
        // the grid must not keep values that are no longer in the database
        if ((kind === "serverRollback" || kind === "rollback") && this.editedInTx) reloadEdited = true;
        this.editedInTx = false;
      },
      onDone: (e) => {
        doneEvent = e;
      },
    };

    // the session ready for the statements: opened, connected, and in a transaction when the mode is Manual
    const prepare = async (): Promise<string> => {
      const sid = await this.ensureSession();
      if (!this.connectedLogged) {
        out.log("text", "Connected");
        this.connectedLogged = true;
      }
      if (this.schemaDirty) {
        this.schemaDirty = false;
        await this.refreshSchema(sid);
        scriptSchema = this.schema();
      }
      if (this.txMode() === "manual") {
        const st = await sessionTxStatus(sid);
        this.setTxStatus(st);
        if (st === "idle") await this.silent(sid, this.driver === "mysql" ? "START TRANSACTION" : "BEGIN");
      }
      return sid;
    };

    const launch = async (): Promise<void> => {
      let sid: string;
      try {
        sid = await prepare();
      } catch (e) {
        if (!isSessionLost(e)) throw e;
        // the session died (connection lost, data source deactivated / disconnected): reopen it once
        this.sessionLost({ tx: txAtStart || this.inTx() });
        sid = await prepare();
      }
      let handle: ExecHandle;
      try {
        handle = await this.startExecute(sid, req.sql, o, handlers);
      } catch (e) {
        if (!isSessionLost(e)) throw e;
        this.sessionLost({ tx: txAtStart || this.inTx() });
        sid = await prepare();
        handle = await this.startExecute(sid, req.sql, o, handlers);
      }
      resolveHandle(handle);
      await handle.done;
      // Data Sources > Options > Auto sync: DDL that ran here shows up in the explorer
      autoSyncAfter(this.ds.id, req.sql);
    };

    let launchFailed = false;
    try {
      await launch();
    } catch (e) {
      rejectHandle(e);
      launchFailed = true;
      out.log("error", errText(e));
    }
    clearInterval(tick);
    stopPending();
    // a statement that never reported back (the call itself failed) must not keep its spinner
    if (this.currentMarks().some((m) => m.status === "running")) this.setMarks(this.currentMarks().filter((m) => m.status !== "running"));

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
      const roundTrip = Math.max(de.elapsedMs, de.executionMs + de.fetchingMs) || recs.reduce((a, r) => a + r.ms, 0) || total;
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
    for (const r of staleTabs) r.announce();
    // nothing returned rows: show the log, unless a statement failed (the earlier result stays in front, the editor shows the error)
    if (first && !failed && !launchFailed) out.select("output");
    if (sessionClosed) this.sessionLost({ tx: txLost || txAtStart || this.inTx() });
    if (this.sessionId && schemaTouched) await this.afterSchemaChange(this.sessionId, scriptSchema, schemaUnknown, searchPath ?? null);
    out.setRunning(false);
    if (reloadEdited) this.reloadEdited();
    this.announceLongRun(req, total);
  }

  /** A long run ended while the console is out of sight (another tab, or the window has no focus): a balloon says so. */
  private announceLongRun(req: ExecuteRequest, ms: number): void {
    if (ms < LONG_RUN_MS || this.disposed || typeof document === "undefined") return;
    if (document.hasFocus() && activeTab()?.id === this.tabId) return;
    const text = req.sql.replace(/\s+/g, " ").trim();
    notify({ kind: "info", title: this.consoleName, body: `${text.length > 30 ? `${text.slice(0, 30)}...` : text} completed.`, timeout: 8000 });
  }

  /**
   * The script switched the schema. A textual name (`USE x`, `SET search_path TO x`) shows at once. For PostgreSQL the
   * real current schema is read from the server (`current_schema()`: `"$user", public` is `public` when there is no
   * such user schema, `pg_temp` is never it), and so is every change whose target the text does not give. That query
   * is only run while no result of this console is paging (a query on the session closes the open result set, and the
   * rows beyond the first page would be lost); otherwise it waits until the results are complete or closed.
   * The text of `SET search_path` is kept as written for the next session (`initSql`).
   */
  private async afterSchemaChange(sid: string, textual: string | null, unknown: boolean, path: string | null): Promise<void> {
    if (this.driver !== "sqlite") saveSearchPath(this.ds.id, this.consoleName, path);
    if (textual) {
      this.setSchema(textual);
      if (this.driver !== "sqlite") saveSchema(this.ds.id, this.consoleName, textual);
    }
    if (!unknown && this.driver !== "postgres") return;
    if (this.out.results().some((r) => r.hasMore())) {
      this.schemaDirty = true;
      return;
    }
    try {
      await this.refreshSchema(sid);
    } catch (e) {
      if (isSessionLost(e)) this.sessionLost();
    }
  }

  /** Executes the edited result again, so the grid shows what the database holds (after a roll back). */
  private reloadEdited(): void {
    const cur = this.out.current();
    const target = cur?.edit() ? cur : this.out.results().find((r) => r.edit());
    if (target) this.rerun(target);
  }

  // ------------------------------------------------------------ editing results

  /**
   * Submit of an editable result. Tx: Auto applies the changes in their own transaction; Tx: Manual applies them
   * inside the console's transaction (a savepoint on its session), which stays open until Commit / Roll Back. The
   * result is executed again afterwards, so it shows what the database now has.
   */
  async applyEdits(tab: ResultTab, changes: GridChange[]): Promise<boolean> {
    const edit = tab.edit();
    if (!edit || tab.applying()) return false;
    const fail = (body: string) => {
      notify({ kind: "error", title: "Cannot submit the changes", body });
      return false;
    };
    tab.setApplying(true);
    try {
      const rowChanges = toRowChanges(keyedChanges(edit, tab.meta, tab.rows, changes), []);
      let res;
      if (this.txMode() === "manual") {
        const sid = await this.ensureSession();
        tab.detach("the changes are applied on the same connection"); // the paging stream is released by the session operation
        const st = await ensureTransaction(sid, this.driver);
        this.setTxStatus(st);
        if (st === "failed") return fail("The transaction has failed (an earlier statement raised an error). Roll it back, then submit the changes again.");
        res = await applyChangesInSession(this.ds.id, sid, edit.table, rowChanges);
        await this.syncTxStatus(sid);
        if (res.committed) this.editedInTx = true;
      } else {
        res = await applyChanges(this.ds.id, edit.table, rowChanges);
      }
      if (!res.committed) return fail(res.results.find((r) => r.error)?.error ?? "The transaction was rolled back.");
    } catch (e) {
      if (isSessionLost(e)) {
        this.sessionLost();
        return fail("The connection was closed and its transaction rolled back, so nothing was applied. Submit the changes again.");
      }
      return fail(errText(e));
    } finally {
      tab.setApplying(false);
    }
    this.out.log("text", this.txMode() === "manual" ? `${changes.length} change${changes.length === 1 ? "" : "s"} applied in the open transaction` : `${changes.length} change${changes.length === 1 ? "" : "s"} committed`);
    tab.gridApi?.clearChanges();
    tab.setPending(0);
    this.rerun(tab);
    return true;
  }

  /** The statements Submit would run (Preview Pending Changes). */
  previewEdits(tab: ResultTab, changes: GridChange[]): string {
    const edit = tab.edit();
    if (!edit) return "";
    return previewSql(this.driver, edit.table, tab.meta, keyedChanges(edit, tab.meta, tab.rows, changes));
  }

  // ------------------------------------------------------------ transactions

  /** Reads the server's state of the session into the signal (after an operation that gives no `txStatus` event). */
  private async syncTxStatus(sid: string): Promise<void> {
    try {
      this.setTxStatus(await sessionTxStatus(sid));
    } catch (e) {
      if (isSessionLost(e)) this.sessionLost();
    }
  }

  async setTxMode(m: TxMode): Promise<void> {
    if (m === this.txMode()) return;
    if (m === "auto" && this.inTx() && !(await confirmEndTransactions({ tabId: this.tabId, reason: "switching to the Auto transaction mode", keepsSession: true }))) return;
    this.setTx(m);
    this.out.log("text", `${m === "manual" ? "Manual" : "Auto"} transaction mode ON`);
  }

  async setIsolation(i: Isolation): Promise<void> {
    this.setIso(i);
    if (this.driver === "sqlite") return;
    try {
      const sid = await this.ensureSession();
      this.releaseResults("the isolation level was changed on the same connection");
      await this.silent(sid, this.isolationSql(i));
    } catch (e) {
      if (isSessionLost(e)) this.sessionLost(); // the new level is applied when the session reopens (`initSql`)
      else notify({ kind: "error", title: "Cannot change the transaction isolation", body: errText(e) });
    }
  }

  /**
   * Commit / Roll Back of the open transaction. Resolves true when it ended (or there was none), false when it did not
   * (error shown). The server decides what happened: a COMMIT of a failed PostgreSQL transaction rolls back.
   */
  async endTx(kind: "commit" | "rollback"): Promise<boolean> {
    this.txError = null;
    if (this.out.running()) {
      this.txError = "A statement is still running on the connection.";
      return false;
    }
    let sid: string | undefined;
    try {
      sid = await this.ensureSession();
      if ((await sessionTxStatus(sid)) === "idle") {
        this.setTxStatus("idle");
        return true;
      }
      this.releaseResults(kind === "commit" ? "the transaction was committed" : "the transaction was rolled back");
      const r = await control(sid, kind === "commit" ? "COMMIT" : "ROLLBACK");
      if (r.status) this.setTxStatus(r.status);
      else await this.syncTxStatus(sid);
      const ended = r.ended[0];
      const how = ended ? classifyTxEnd(kind === "commit" ? "COMMIT" : "ROLLBACK", ended) : kind;
      if (how === "connectionLost") {
        this.sessionLost({ tx: true });
        return true; // the connection took the transaction with it
      }
      if (how === "serverRollback") {
        this.out.log("error", SERVER_ROLLBACK_LOG);
        notify({ kind: "error", title: SERVER_ROLLBACK_TITLE, body: SERVER_ROLLBACK_BODY });
      } else this.out.log("text", how === "commit" ? "transaction committed" : how === "implicit" ? "transaction committed" : "transaction rolled back");
      // the edited result must show what the database holds now: after a roll back (by us or by the server)
      const edited = this.editedInTx;
      this.editedInTx = false;
      if (edited && (how === "rollback" || how === "serverRollback")) this.reloadEdited();
      return true;
    } catch (e) {
      if (isSessionLost(e)) {
        this.sessionLost({ tx: true });
        return true; // the connection took the transaction with it: it is rolled back, the user was told
      }
      this.txError = errText(e);
      this.out.log("error", this.txError);
      if (sid) await this.syncTxStatus(sid);
      return false;
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
      for (const i of isolationLevels(this.driver)) items.push({ label: isolationLabel(i), checked: this.isolation() === i, run: () => void this.setIsolation(i) });
    }
    items.push({ type: "separator" }, {
      type: "hint",
      label: manual ? "Manually commit changes submitted to the database" : "Changes submitted to the database are auto-committed",
    });
    if (anchor instanceof HTMLElement) openMenu(items, { anchor, minWidth: 210 });
    else openMenu(items, { x: anchor.left, y: anchor.bottom + 2, minWidth: 210 });
  }

  // ------------------------------------------------------------ schema switcher

  /** Popup of the toolbar's `postgres.public` button. */
  async openSchemaMenu(anchor: HTMLElement | { left: number; bottom: number }): Promise<void> {
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
                children: schemas.map<MenuItem>((s) => ({ label: s.name, icon: "dg/schema", checked: s.name === cur, run: () => void this.switchSchema(s.name) })),
              }
            : { label: d.name, enabled: false },
        );
        items.push({ type: "separator" }, { type: "hint", label: "Connect to database (Enter)" });
      } else {
        const list = await introspect(this.ds.id, []);
        items = list.map<MenuItem>((s) => ({ label: s.name, icon: "dg/schema", checked: s.name === cur, run: () => void this.switchSchema(s.name) }));
      }
      if (anchor instanceof HTMLElement) openMenu(items, { anchor, minWidth: 230 });
      else openMenu(items, { x: anchor.left, y: anchor.bottom + 2, minWidth: 230 });
    } catch (e) {
      notify({ kind: "error", title: "Cannot list the schemas", body: errText(e) });
    }
  }

  async switchSchema(name: string): Promise<void> {
    if (this.driver === "sqlite") return;
    if (this.out.running()) return;
    if (this.ds.options?.switchSchema === "disabled") {
      notify({ kind: "info", title: "Switch schema is disabled", body: "Enable it in Data Sources > Options > Switch schema." });
      return;
    }
    try {
      const sid = await this.ensureSession();
      this.releaseResults("the schema was switched on the same connection");
      await this.silent(sid, this.useSchemaSql(name));
      this.setSchema(name);
      saveSchema(this.ds.id, this.consoleName, name);
      if (this.driver === "postgres") saveSearchPath(this.ds.id, this.consoleName, null);
    } catch (e) {
      if (isSessionLost(e)) this.sessionLost();
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
