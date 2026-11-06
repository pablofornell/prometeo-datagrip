// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecEvent, TxStatus } from "../../api/types";

// ------------------------------------------------------------ a scripted backend
const be = {
  sessions: new Set<string>(),
  tx: new Map<string, TxStatus>(),
  next: 1,
  opened: [] as { sid: string; initSql: string[] }[],
  ran: [] as string[],
  txCalls: [] as string[],
};
const range = (n: number) => ({ start: 0, end: n, startChar: 0, endChar: n, startUtf16: 0, endUtf16: n });

/** The events the fake server answers for one script (`;` separated, one statement per line of the test). */
function answer(sid: string, sql: string): ExecEvent[] {
  const ev: ExecEvent[] = [];
  const set = (s: TxStatus) => (be.tx.set(sid, s), ev.push({ kind: "txStatus", status: s }));
  const statements = sql.replace(/\/\*prometeo:internal\*\//g, "").split(";").map((x) => x.trim()).filter(Boolean);
  let i = 0;
  for (const st of statements) {
    ev.push({ kind: "statement", index: i, sql: st, range: range(st.length) });
    const w = st.split(/\s+/)[0].toUpperCase();
    const cur = be.tx.get(sid) ?? "idle";
    if (w === "BEGIN" || w === "START") (set("active"), ev.push({ kind: "update", index: i, rowsAffected: 0 }));
    else if (w === "COMMIT") {
      ev.push({ kind: "txEnded", index: i, committed: cur !== "failed", tag: cur === "failed" ? "ROLLBACK" : "COMMIT" });
      set("idle");
      ev.push({ kind: "update", index: i, rowsAffected: 0 });
    } else if (w === "ROLLBACK") {
      ev.push({ kind: "txEnded", index: i, committed: false, tag: "ROLLBACK" });
      set("idle");
      ev.push({ kind: "update", index: i, rowsAffected: 0 });
    } else if (w === "BOOM") {
      ev.push({ kind: "error", index: i, message: "boom", position: null, positionUtf16: null });
      if (cur === "active") set("failed");
      break;
    } else if (w === "SELECT") {
      const cs = /current_schema|database\(\)/.test(st);
      ev.push({ kind: "resultset", index: i, columns: [{ name: "c", typeName: "int4", nullable: true, isPk: false, tableRef: null }], rows: cs ? [["public"]] : [[1]], hasMore: false });
    } else ev.push({ kind: "update", index: i, rowsAffected: 1 });
    i++;
  }
  ev.push({ kind: "done", elapsedMs: 1, executionMs: 1, fetchingMs: 0 });
  return ev;
}
const gone = (sid: string) => new Error(`Session '${sid}' does not exist`);

vi.mock("../../api/db", () => ({
  isTauri: () => false,
  openSession: vi.fn(async (_ds: string, initSql: string[] = []) => {
    const sid = `s${be.next++}`;
    be.sessions.add(sid);
    be.tx.set(sid, "idle");
    be.opened.push({ sid, initSql });
    return sid;
  }),
  closeSession: vi.fn(async (sid: string) => void be.sessions.delete(sid)),
  sessionTxStatus: vi.fn(async (sid: string) => {
    if (!be.sessions.has(sid)) throw gone(sid);
    return be.tx.get(sid) ?? "idle";
  }),
  executeCollect: vi.fn(async (sid: string, sql: string) => {
    if (!be.sessions.has(sid)) throw gone(sid);
    be.ran.push(sql.replace(/\/\*prometeo:internal\*\//g, "").trim());
    return answer(sid, sql);
  }),
  execute: vi.fn(async (sid: string, sql: string, handlers: Record<string, (e: ExecEvent) => void>) => {
    if (!be.sessions.has(sid)) throw gone(sid);
    be.ran.push(sql);
    const events = answer(sid, sql);
    let done!: (e: unknown) => void;
    const p = new Promise((r) => (done = r));
    for (const e of events) {
      const h = { statement: "onStatement", resultset: "onResultSet", update: "onUpdate", error: "onError", message: "onMessage", txStatus: "onTxStatus", txEnded: "onTxEnded", done: "onDone" }[e.kind];
      handlers[h]?.(e);
      if (e.kind === "done") done(e);
    }
    return { executionId: "x", done: p, cancel: async () => {}, close: async () => {}, fetchMore: async () => ({ rows: [], hasMore: false }) };
  }),
  introspect: vi.fn(async () => []),
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
vi.mock("../table/dialogs", () => ({ askChoice: async () => "cancel" }));
const resolveEdit = vi.fn(async () => null);
vi.mock("./editable", async (orig) => ({ ...(await orig<typeof import("./editable")>()), resolveEdit: (...a: unknown[]) => (resolveEdit as (...x: unknown[]) => unknown)(...a) }));
vi.mock("./schemaPref", () => {
  const m = new Map<string, string>();
  return { savedSchema: (d: string, c: string) => m.get(d + c) ?? null, saveSchema: (d: string, c: string, s: string | null) => (s ? m.set(d + c, s) : m.delete(d + c)) };
});

import { ConsoleSession } from "./session";

const ds = (driver: "postgres" | "mysql" = "postgres") => ({ id: "d1", name: "pg", driver, database: "shop", readOnly: false }) as never;
const mk = (driver: "postgres" | "mysql" = "postgres") => new ConsoleSession("tab1", ds(driver), "console", () => "console [pg]");
const req = (sql: string) => ({ sql, ranges: [], source: "statement" as const });
const lines = (s: ConsoleSession) => s.out.lines.map((l) => l.text);

beforeEach(() => {
  be.sessions.clear();
  be.tx.clear();
  be.opened.length = be.ran.length = 0;
  be.next = 1;
  notify.mockClear();
  resolveEdit.mockClear();
});

describe("Manual-mode console after a disconnect", () => {
  it("drops the dead session, says the transaction was rolled back, and reopens with the console's settings", async () => {
    const s = mk();
    await s.setIsolation("serializable");
    await s.run(req("update t set a = 1"));
    expect(s.txStatus()).toBe("active");
    const firstSid = s.sessionId!;
    be.sessions.delete(firstSid); // the data source was deactivated: every session is gone
    be.tx.clear();

    await s.run(req("update t set a = 2")); // used to throw outside the reconnect try and stay stuck
    expect(lines(s)).toContain("the transaction was rolled back: connection closed");
    expect(s.sessionId).toBeDefined();
    expect(s.sessionId).not.toBe(firstSid);
    // the isolation level the console had is part of the new session (initSql), not forgotten
    const reopened = be.opened.at(-1)!;
    expect(reopened.initSql).toEqual(["SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE"]);
    expect(s.txStatus()).toBe("active"); // a fresh BEGIN for the statement that ran
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "warning", title: "The transaction was rolled back" }));
    expect(s.out.running()).toBe(false);
  });
  it("a closed-connection signal resets the state without running anything", async () => {
    const s = mk();
    await s.run(req("update t set a = 1"));
    expect(s.inTx()).toBe(true);
    s.connectionClosed();
    expect(s.inTx()).toBe(false);
    expect(s.sessionId).toBeUndefined();
  });
});

describe("a COMMIT that the server turned into a rollback", () => {
  it("warns (balloon + log) and reports idle instead of pretending the changes were saved", async () => {
    const s = mk();
    await s.run(req("boom"));
    expect(s.txStatus()).toBe("failed");
    expect(await s.endTx("commit")).toBe(true);
    expect(s.txStatus()).toBe("idle");
    expect(lines(s).some((l) => /rolled back by the server/.test(l))).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", title: "The transaction was rolled back" }));
  });
  it("also when the user types COMMIT in the script", async () => {
    const s = mk();
    await s.run(req("boom"));
    await s.run(req("commit"));
    expect(lines(s).some((l) => /rolled back by the server/.test(l))).toBe(true);
    expect(s.txStatus()).toBe("idle");
  });
  it("a plain Roll Back is not reported as a server rollback", async () => {
    const s = mk();
    await s.run(req("update t set a = 1"));
    await s.endTx("rollback");
    expect(lines(s)).toContain("transaction rolled back");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("the schema re-check after a run", () => {
  it("does not run an internal query for `update ... set ...` (it closed the open result of the last select)", async () => {
    const s = mk();
    await s.run(req("update t set a = 1; select * from big_table"));
    const internal = be.ran.filter((x) => /current_schema/.test(x));
    expect(internal).toHaveLength(1); // only the one at session open, none after the run
    expect(be.ran.at(-1)).toContain("select * from big_table");
  });
  it("a real SET search_path updates the label from the statement text, without querying the session", async () => {
    const s = mk();
    await s.run(req("set search_path to shop; select 1"));
    expect(s.schema()).toBe("shop");
    expect(be.ran.filter((x) => /current_schema/.test(x))).toHaveLength(1);
  });
});

describe("MySQL USE earlier in the script", () => {
  it("resolves the edit target in the schema that USE selected", async () => {
    const s = mk("mysql");
    await s.run(req("use other; select * from orders"));
    expect(resolveEdit).toHaveBeenCalled();
    expect((resolveEdit.mock.calls.at(-1) as unknown[])[3]).toBe("other");
  });
});
