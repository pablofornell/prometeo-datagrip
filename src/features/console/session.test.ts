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
  /** What `current_schema()` / `database()` answer. */
  schema: "public",
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
      ev.push({ kind: "error", index: i, message: "boom", position: null, positionUtf16: null, connectionLost: false });
      if (cur === "active") set("failed");
      break;
    } else if (w === "SELECT") {
      const cs = /current_schema|database\(\)/.test(st);
      ev.push({ kind: "resultset", index: i, columns: [{ name: "c", typeName: "int4", nullable: true, isPk: false, tableRef: null }], rows: cs ? [[be.schema]] : [[1]], hasMore: /\bbig_table\b/.test(st) });
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
  explainPlan: vi.fn(async (sid: string, sql: string, analyze: boolean) => {
    if (!be.sessions.has(sid)) throw gone(sid);
    if (/nope/.test(sql)) throw new Error("relation \"nope\" does not exist");
    return { driver: "postgres", analyze, sql, root: { operation: "Select", params: "", rows: null, totalCost: null, startupCost: null, raw: "", props: [], children: [] }, elapsedMs: 7 };
  }),
  cancelSession: vi.fn(async () => {}),
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
vi.mock("../explorer", () => ({ ensureConnected: async () => {}, autoSyncAfter: () => {} }));
vi.mock("../table/dialogs", () => ({ askChoice: async () => "cancel" }));
const resolveEdit = vi.fn(async () => null);
vi.mock("./editable", async (orig) => ({ ...(await orig<typeof import("./editable")>()), resolveEdit: (...a: unknown[]) => (resolveEdit as (...x: unknown[]) => unknown)(...a) }));
vi.mock("./schemaPref", () => {
  const m = new Map<string, string>();
  const p = new Map<string, string>();
  return {
    savedSchema: (d: string, c: string) => m.get(d + c) ?? null,
    saveSchema: (d: string, c: string, s: string | null) => (s ? m.set(d + c, s) : m.delete(d + c)),
    savedSearchPath: (d: string, c: string) => p.get(d + c) ?? null,
    saveSearchPath: (d: string, c: string, s: string | null) => (s ? p.set(d + c, s) : p.delete(d + c)),
  };
});

import { savedSchema, savedSearchPath } from "./schemaPref";
import { ConsoleSession, isolationLevels } from "./session";

const ds = (driver: "postgres" | "mysql" = "postgres") => ({ id: "d1", name: "pg", driver, database: "shop", readOnly: false }) as never;
const mk = (driver: "postgres" | "mysql" = "postgres") => new ConsoleSession("tab1", ds(driver), "console", () => "console [pg]");
const req = (sql: string) => ({ sql, ranges: [], source: "statement" as const });
const lines = (s: ConsoleSession) => s.out.lines.map((l) => l.text);

beforeEach(() => {
  be.sessions.clear();
  be.tx.clear();
  be.opened.length = be.ran.length = 0;
  be.next = 1;
  be.schema = "public";
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
    expect(lines(s)).toContain("The connection was lost. The transaction was rolled back.");
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
    expect(lines(s)).toContain("the transaction was rolled back: connection closed");
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
  it("a SET search_path shows the schema the SERVER reports, not the first word of the text", async () => {
    const s = mk();
    be.schema = "alice"; // there is a schema named like the user, so "$user" resolves to it
    await s.run(req('SET search_path TO "$user", public'));
    expect(s.schema()).toBe("alice");
    expect(s.label()).toBe("shop.alice");
    expect(be.ran.filter((x) => /current_schema/.test(x))).toHaveLength(2); // at open + after the SET
  });
  it("`$user` without such a schema: the label is public, never `$user`", async () => {
    const s = mk();
    await s.run(req('SET search_path TO "$user", public'));
    expect(s.schema()).toBe("public");
    expect(savedSchema("d1", "console")).toBe("public");
  });
  it("pg_temp first in the path is not the current schema", async () => {
    const s = mk();
    await s.run(req("set search_path to pg_temp, public"));
    expect(s.schema()).toBe("public");
    expect(savedSchema("d1", "console")).not.toBe("pg_temp");
  });
  it("keeps the whole search_path text and replays it verbatim when the session reopens", async () => {
    const s = mk();
    await s.run(req('SET search_path TO "$user", public'));
    const first = s.sessionId!;
    be.sessions.delete(first); // gone
    await s.run(req("select 1"));
    expect(be.opened.at(-1)!.initSql).toEqual(['SET search_path TO "$user", public']);
    expect(be.opened.at(-1)!.sid).not.toBe(first);
  });
  it("RESET search_path forgets the saved path", async () => {
    const s = mk();
    await s.run(req("set search_path to a, b"));
    await s.run(req("reset search_path"));
    expect(savedSearchPath("d1", "console")).toBeNull();
  });
  it("never queries the session while a result of the console is still paging; reads when it closes", async () => {
    const s = mk();
    be.schema = "alice";
    await s.run(req('set search_path to "$user", public; select * from big_table'));
    const tab = s.out.results()[0];
    expect(tab.hasMore()).toBe(true);
    expect(be.ran.filter((x) => /current_schema/.test(x))).toHaveLength(1); // only the one at session open
    expect(be.ran.at(-1)).toContain("big_table");
    expect(savedSearchPath("d1", "console")).toBe('"$user", public'); // the text is kept at once
    expect(s.schemaReadable()).toBe(false);
    tab.close();
    expect(s.schemaReadable()).toBe(true); // the view's effect then calls settleSchema
    await s.settleSchema();
    expect(s.schema()).toBe("alice");
    expect(s.schemaReadable()).toBe(false);
    expect(be.ran.filter((x) => /current_schema/.test(x))).toHaveLength(2);
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

describe("a failed statement", () => {
  it("keeps the earlier result in front and shows the error for the banner", async () => {
    const s = mk();
    await s.run(req("select 1"));
    const tab = s.out.results()[0];
    s.out.select("output");
    s.out.select(tab.id);
    await s.run(req("boom"));
    expect(s.out.selected()).toBe(tab.id); // not switched to the log
    expect(s.out.results()).toHaveLength(1);
    expect(s.execError()).toBe("boom");
    await s.run(req("select 1")); // the next run clears it
    expect(s.execError()).toBeNull();
  });
  it("a statement without rows still shows the log", async () => {
    const s = mk();
    await s.run(req("select 1"));
    await s.run(req("update t set a = 1"));
    expect(s.out.selected()).toBe("output");
    expect(s.execError()).toBeNull();
  });
});

describe("Tx isolation", () => {
  it("lists Database Default first, and Read Uncommitted only for MySQL", () => {
    expect(isolationLevels("postgres")).toEqual(["default", "read committed", "repeatable read", "serializable"]);
    expect(isolationLevels("mysql")[1]).toBe("read uncommitted");
    expect(isolationLevels("sqlite")).not.toContain("read uncommitted");
  });
  it("a new console sets nothing; going back to the default resets the session", async () => {
    const s = mk();
    expect(s.isolation()).toBe("default");
    await s.run(req("select 1"));
    expect(be.opened.at(-1)!.initSql.filter((q) => /ISOLATION/i.test(q))).toEqual([]);
    await s.setIsolation("serializable");
    await s.setIsolation("default");
    expect(be.ran).toContain("RESET default_transaction_isolation");
    const m = mk("mysql");
    await m.run(req("select 1"));
    await m.setIsolation("default");
    expect(be.ran).toContain("SET SESSION transaction_isolation = DEFAULT");
  });
});

describe("Explain", () => {
  const withEditor = (s: ConsoleSession, sql: string | null) => {
    s.editor = { getSelectionOrStatement: () => (sql === null ? null : { sql, ranges: [], source: "statement" }) } as never;
    return s;
  };
  it("shows the plan in the Query Plan tab", async () => {
    const s = withEditor(mk(), "select 1");
    await s.explain(true);
    expect(s.out.plan()?.plan.analyze).toBe(true);
    expect(s.out.selected()).toBe("plan");
    expect(s.out.lastMs()).toBe(7);
    expect(s.out.running()).toBe(false);
    s.out.closeResult("plan");
    expect(s.out.plan()).toBeNull();
    expect(s.out.selected()).toBe("output");
  });
  it("reports a failing statement in the log and leaves the console usable", async () => {
    const s = withEditor(mk(), "select * from nope");
    await s.explain(false);
    expect(s.out.plan()).toBeNull();
    expect(lines(s)).toContain('relation "nope" does not exist');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", title: "Explain Plan failed" }));
    expect(s.out.running()).toBe(false);
  });
  it("needs a statement", async () => {
    const s = withEditor(mk(), null);
    await s.explain(false);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Nothing to explain" }));
    expect(s.out.plan()).toBeNull();
  });
});
