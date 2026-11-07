// @vitest-environment node
/**
 * A connection the server killed (pg_terminate_backend, restart, network): the backend's answers are scripted the way
 * the real one sends them (`error` with `connectionLost`, `txStatus: idle`, `txEnded { tag: "CONNECTION LOST" }`, later
 * calls on the session failing at once with the `[08006]` message, closeSession succeeding). The tab must close and the
 * app must quit without a dead end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecEvent, TxStatus } from "../../api/types";

const LOST = "[08006] connection lost: terminating connection due to administrator command";
interface Srv {
  tx: TxStatus;
  /** The server killed the connection; the backend has not noticed yet. */
  killed: boolean;
  /** The backend noticed (marked the session dead). */
  dead: boolean;
}
const be = { sessions: new Map<string, Srv>(), next: 1, opened: [] as { sid: string; initSql: string[] }[], ran: [] as string[], closed: [] as string[] };
const range = (n: number) => ({ start: 0, end: n, startChar: 0, endChar: n, startUtf16: 0, endUtf16: n });

/** What the backend answers to one statement on session `sid`. */
function answer(sid: string, sql: string): ExecEvent[] {
  const s = be.sessions.get(sid)!;
  const clean = sql.replace(/\/\*prometeo:internal\*\//g, "").trim();
  const ev: ExecEvent[] = [{ kind: "statement", index: 0, sql: clean, range: range(clean.length) }];
  if (s.killed || s.dead) {
    const wasTx = s.tx !== "idle" && !s.dead;
    s.dead = true;
    s.tx = "idle";
    ev.push({ kind: "error", index: 0, message: LOST, position: null, positionUtf16: null, connectionLost: true });
    if (wasTx) ev.push({ kind: "txStatus", status: "idle" }, { kind: "txEnded", index: 0, committed: false, tag: "CONNECTION LOST" });
    ev.push({ kind: "done", elapsedMs: 1, executionMs: 1, fetchingMs: 0 });
    return ev;
  }
  const w = clean.split(/\s+/)[0].toUpperCase();
  if (w === "BEGIN" || w === "START") (s.tx = "active", ev.push({ kind: "txStatus", status: "active" }));
  else if (w === "COMMIT" || w === "ROLLBACK") (s.tx = "idle", ev.push({ kind: "txEnded", index: 0, committed: w === "COMMIT", tag: w }, { kind: "txStatus", status: "idle" }));
  else if (w === "SELECT") ev.push({ kind: "resultset", index: 0, columns: [{ name: "c", typeName: "text", nullable: true, isPk: false, tableRef: null }], rows: [["public"]], hasMore: /big_table/.test(clean) });
  else ev.push({ kind: "update", index: 0, rowsAffected: 1 });
  ev.push({ kind: "done", elapsedMs: 1, executionMs: 1, fetchingMs: 0 });
  return ev;
}

vi.mock("../../api/db", () => ({
  isTauri: () => false,
  openSession: vi.fn(async (_ds: string, initSql: string[] = []) => {
    const sid = `s${be.next++}`;
    be.sessions.set(sid, { tx: "idle", killed: false, dead: false });
    be.opened.push({ sid, initSql });
    return sid;
  }),
  closeSession: vi.fn(async (sid: string) => void (be.closed.push(sid), be.sessions.delete(sid))), // succeeds on a dead session too
  sessionTxStatus: vi.fn(async (sid: string) => be.sessions.get(sid)?.tx ?? "idle"),
  executeCollect: vi.fn(async (sid: string, sql: string) => {
    be.ran.push(sql.replace(/\/\*prometeo:internal\*\//g, "").trim());
    return answer(sid, sql);
  }),
  execute: vi.fn(async (sid: string, sql: string, handlers: Record<string, (e: ExecEvent) => void>) => {
    be.ran.push(sql);
    let done!: (e: unknown) => void;
    const p = new Promise((r) => (done = r));
    for (const e of answer(sid, sql)) {
      const h = { statement: "onStatement", resultset: "onResultSet", update: "onUpdate", error: "onError", message: "onMessage", warning: "onWarning", txStatus: "onTxStatus", txEnded: "onTxEnded", done: "onDone" }[e.kind];
      handlers[h]?.(e);
      if (e.kind === "done") done(e);
    }
    return { executionId: "x", done: p, cancel: async () => {}, close: async () => {}, fetchMore: async () => {
        const srv = be.sessions.get(sid);
        if (srv?.killed || srv?.dead) throw Object.assign(new Error(LOST), { connectionLost: true });
        return { rows: [], hasMore: false };
      },
    };
  }),
  introspect: vi.fn(async () => []),
  setUiState: vi.fn(async () => {}),
  applyChanges: vi.fn(),
  tableData: vi.fn(),
  listDataSources: vi.fn(async () => []),
}));
vi.mock("../../components/editor", async () => ({ splitStatements: (await import("../../components/editor/split")).splitStatements }));
vi.mock("../../components/editor/state", () => ({ errorsField: {}, execMarksField: {} }));
const notify = vi.fn();
vi.mock("../../components/ui", () => ({ notify: (o: unknown) => notify(o), openMenu: vi.fn() }));
vi.mock("../../state/layout", () => ({ showToolWindow: vi.fn() }));
vi.mock("../../state/settings", () => ({ settings: { defaultTxMode: "manual", gridPageSize: 500 } }));
vi.mock("../../state/tabs", () => ({ activateTab: vi.fn(), activeTab: () => undefined }));
vi.mock("../explorer", () => ({ ensureConnected: async () => {} }));
const asked: { title: string; message: string; choices: { value: string; label: string }[] }[] = [];
let answers: string[] = [];
vi.mock("../table/dialogs", () => ({
  askChoice: async (c: (typeof asked)[number]) => (asked.push(c), answers.shift() ?? "cancel"),
}));

import { ConsoleSession } from "./session";
import { confirmEndTransactions } from "./txguard";
import { registerSession, unregisterSession } from "./registry";

const ds = { id: "d1", name: "pg", driver: "postgres", database: "shop", readOnly: false } as never;
const req = (sql: string) => ({ sql, ranges: [], source: "statement" as const });
const lines = (s: ConsoleSession) => s.out.lines.map((l) => l.text);
const kill = (sid: string) => void (be.sessions.get(sid)!.killed = true);
let s: ConsoleSession;

beforeEach(() => {
  be.sessions.clear();
  be.opened.length = be.ran.length = be.closed.length = 0;
  be.next = 1;
  asked.length = 0;
  answers = [];
  notify.mockClear();
  s = new ConsoleSession("tab1", ds, "console", () => "console [pg]");
  registerSession(s);
});

describe("a connection killed by the server while a manual transaction is open", () => {
  it("a run: resets the tx state, says so, drops the session and reopens on the next run", async () => {
    await s.run(req("update t set a = 1"));
    expect(s.txStatus()).toBe("active");
    const first = s.sessionId!;
    kill(first);

    await s.run(req("update t set a = 2")); // the statement fails: connection lost
    expect(s.txStatus()).toBe("idle");
    expect(s.inTx()).toBe(false);
    expect(s.sessionId).toBeUndefined();
    expect(lines(s)).toContain("The connection was lost. The transaction was rolled back.");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "warning" }));
    expect(s.out.running()).toBe(false);
    expect(be.closed).toContain(first); // the dead session is released (closeSession succeeds on it)

    await s.run(req("update t set a = 3")); // the next run opens a new connection (initSql applied) and a fresh BEGIN
    expect(s.sessionId).toBeDefined();
    expect(s.sessionId).not.toBe(first);
    expect(be.opened).toHaveLength(2);
    expect(s.txStatus()).toBe("active");
  });

  it("closing the tab is not blocked when ROLLBACK fails because the connection is gone", async () => {
    await s.run(req("update t set a = 1"));
    kill(s.sessionId!);
    expect(s.txStatus()).toBe("active"); // the UI does not know yet
    answers = ["rollback"];

    const ok = await confirmEndTransactions({ tabId: "tab1", reason: "closing the console" });
    expect(ok).toBe(true);
    expect(asked).toHaveLength(1); // no second dialog: nothing to decide
    expect(s.inTx()).toBe(false);
    expect(s.sessionId).toBeUndefined();
    expect(lines(s)).toContain("The connection was lost. The transaction was rolled back.");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/rolled back/i) }));
  });

  it("the same for COMMIT, and quitting the application is not blocked either", async () => {
    await s.run(req("update t set a = 1"));
    kill(s.sessionId!);
    answers = ["commit"];
    expect(await confirmEndTransactions({ reason: "quitting the application" })).toBe(true);
    expect(s.inTx()).toBe(false);
    // nothing is open any more: a second quit does not ask
    expect(await confirmEndTransactions({ reason: "quitting the application" })).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("a dead session whose status the backend already reports as idle is not a transaction", async () => {
    await s.run(req("update t set a = 1"));
    kill(s.sessionId!);
    await s.run(req("select 1")); // lost, txEnded CONNECTION LOST
    unregisterSession("tab1");
    registerSession(s);
    expect(await confirmEndTransactions({ reason: "quitting the application" })).toBe(true);
    expect(asked).toHaveLength(0);
  });
});

describe("a paging fetch that finds the connection dead", () => {
  it("drops the session like a failed run (the transaction is gone with it)", async () => {
    await s.run(req("select * from big_table"));
    const tab = s.out.results()[0];
    expect(tab.hasMore()).toBe(true);
    expect(s.txStatus()).toBe("active");
    kill(s.sessionId!);
    await tab.loadMore();
    expect(s.sessionId).toBeUndefined();
    expect(s.inTx()).toBe(false);
    expect(lines(s)).toContain("The connection was lost. The transaction was rolled back.");
  });
});

describe("the session state a reconnect resets", () => {
  const BASE = "The connection was re-established. Session state was reset: temporary tables, session variables and SET commands you ran are lost; only the schema and isolation level were restored.";
  const warned = () => notify.mock.calls.map((c) => c[0] as { kind: string; title: string; body: string }).filter((n) => n.body.includes("re-established"));

  it("a reopen after a lost connection logs a warning and shows a balloon; the first open does not", async () => {
    await s.run(req("select 1"));
    expect(lines(s).some((l) => l.includes("re-established"))).toBe(false);
    expect(warned()).toHaveLength(0);
    kill(s.sessionId!);
    await s.run(req("select 2")); // lost
    expect(lines(s).some((l) => l.includes("re-established"))).toBe(false); // nothing reopened yet
    await s.run(req("select 3")); // reopens
    expect(lines(s)).toContain(BASE);
    expect(warned()).toEqual([expect.objectContaining({ kind: "warning", body: BASE })]);
    await s.run(req("select 4")); // says it once
    expect(warned()).toHaveLength(1);
    expect(lines(s).filter((l) => l.includes("re-established"))).toHaveLength(1);
  });
  it("names the SET commands the console had run (they are not replayed)", async () => {
    await s.run(req("SET ROLE reporting"));
    kill(s.sessionId!);
    await s.run(req("select 2"));
    be.ran.length = 0;
    await s.run(req("select 3"));
    const w = warned()[0].body;
    expect(w.startsWith(BASE)).toBe(true);
    expect(w).toContain("last: SET ROLE reporting");
    expect(w).toContain("were not run again");
    expect(lines(s).some((l) => l.startsWith(BASE) && l.length > BASE.length)).toBe(true);
    expect(be.opened.at(-1)!.initSql.join(" ")).not.toMatch(/ROLE/); // not replayed
  });
  it("MySQL: SET autocommit=0 is called out (autocommit is on again)", async () => {
    const my = new ConsoleSession("tab2", { id: "d2", name: "my", driver: "mysql", database: "shop", readOnly: false } as never, "console", () => "console [my]");
    registerSession(my);
    await my.run(req("SET autocommit=0"));
    kill(my.sessionId!);
    await my.run(req("select 2"));
    await my.run(req("select 3"));
    expect(warned().at(-1)!.body).toMatch(/autocommit/);
    expect(lines(my).some((l) => /autocommit is on again/i.test(l))).toBe(true);
    unregisterSession("tab2");
  });
  it("a plain reopen adds nothing about SET; SET search_path (restored) is not counted", async () => {
    await s.run(req("SET search_path TO sales"));
    kill(s.sessionId!);
    await s.run(req("select 2"));
    await s.run(req("select 3"));
    expect(warned()[0].body).toBe(BASE);
  });
});
