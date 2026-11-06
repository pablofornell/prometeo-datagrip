// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessions: unknown[] = [];
const controllers: unknown[] = [];
let answer = "commit";
/** Answers to the dialogs after the first one (a follow-up dialog gets `answer` when this is empty). */
const next: string[] = [];
const asked: { title: string; message: string; choices: { value: string }[] }[] = [];
vi.mock("../../state/tabs", () => ({ activateTab: () => {} }));
vi.mock("./registry", () => ({ allSessions: () => sessions }));
vi.mock("../table/controller", () => ({ allControllers: () => controllers }));
vi.mock("../table/dialogs", () => ({
  askChoice: async (c: (typeof asked)[number]) => {
    asked.push(c);
    return asked.length > 1 && next.length ? next.shift() : answer;
  },
}));
import { STUCK_AFTER_MS, confirmEndTransactions, txDialogText } from "./txguard";

const ended: string[] = [];
let rollbackOk = false;
const con = (tabId: string, dsId: string, status: "idle" | "active" | "failed", ok = true) => ({
  tabId,
  dsId,
  title: () => `console ${tabId}`,
  inTx: () => status !== "idle",
  txStatus: () => status,
  out: { running: () => false },
  cancel() {},
  endTx: async (k: string) => (ended.push(`${tabId}:${k}`), ok || (k === "rollback" && rollbackOk)),
  txError: ok ? null : "the server hung up",
});
const tbl = (tabId: string, dsId: string, status: "idle" | "active" | "failed") => ({
  tabId,
  dsId,
  title: () => `table ${tabId}`,
  inTx: () => status !== "idle",
  txStatus: () => status,
  endTx: async (k: string) => (ended.push(`${tabId}:${k}`), true),
});

beforeEach(() => {
  sessions.length = controllers.length = ended.length = asked.length = 0;
  answer = "commit";
  next.length = 0;
  rollbackOk = false;
});

describe("confirmEndTransactions", () => {
  it("does not ask when nothing is open", async () => {
    sessions.push(con("c1", "ds1", "idle"));
    expect(await confirmEndTransactions({ reason: "quitting" })).toBe(true);
    expect(asked).toHaveLength(0);
  });
  it("asks Commit / Roll Back / Cancel and commits the consoles and table editors of the scope only", async () => {
    sessions.push(con("c1", "ds1", "active"), con("c2", "ds2", "active"));
    controllers.push(tbl("t1", "ds1", "active"), tbl("t2", "ds2", "active"));
    expect(await confirmEndTransactions({ dsId: "ds1", reason: "deactivating the data source" })).toBe(true);
    expect(asked[0].choices.map((c) => c.value)).toEqual(["commit", "rollback", "cancel"]);
    expect(asked[0].message).toContain("console c1");
    expect(asked[0].message).toContain("table t1");
    expect(asked[0].message).not.toContain("c2");
    expect(ended).toEqual(["c1:commit", "t1:commit"]);
  });
  it("a single tab only", async () => {
    sessions.push(con("c1", "ds1", "active"), con("c2", "ds1", "active"));
    answer = "rollback";
    expect(await confirmEndTransactions({ tabId: "c2", reason: "closing the console" })).toBe(true);
    expect(ended).toEqual(["c2:rollback"]);
  });
  it("Cancel keeps everything open and vetoes the action", async () => {
    sessions.push(con("c1", "ds1", "active"));
    answer = "cancel";
    expect(await confirmEndTransactions({ reason: "quitting the application" })).toBe(false);
    expect(ended).toEqual([]);
  });
  it("a COMMIT that fails (not a lost connection) offers Roll Back / Close Anyway / Cancel, never a dead end", async () => {
    sessions.push(con("c1", "ds1", "active", false));
    next.push("cancel");
    expect(await confirmEndTransactions({ reason: "quitting" })).toBe(false);
    expect(ended).toEqual(["c1:commit"]);
    expect(asked[1].title).toBe("Cannot commit the transaction");
    expect(asked[1].message).toContain("the server hung up");
    expect(asked[1].choices.map((c) => c.value)).toEqual(["rollback", "force", "cancel"]);
  });
  it("Close Anyway lets the action go on", async () => {
    sessions.push(con("c1", "ds1", "active", false));
    next.push("force");
    expect(await confirmEndTransactions({ reason: "closing the console", tabId: "c1" })).toBe(true);
  });
  it("Roll Back after a failed COMMIT tries the rollback; when that fails too, Close Anyway / Cancel remain", async () => {
    sessions.push(con("c1", "ds1", "active", false));
    next.push("rollback", "force");
    expect(await confirmEndTransactions({ reason: "quitting" })).toBe(true);
    expect(ended).toEqual(["c1:commit", "c1:rollback"]);
    expect(asked[2].choices.map((c) => c.value)).toEqual(["force", "cancel"]);
  });
  it("Roll Back after a failed COMMIT ends the transaction when the rollback works", async () => {
    sessions.push(con("c1", "ds1", "active", false));
    rollbackOk = true;
    next.push("rollback");
    expect(await confirmEndTransactions({ reason: "quitting" })).toBe(true);
    expect(asked).toHaveLength(2);
  });
  it("switching to Auto keeps the session: no Close Anyway there", async () => {
    sessions.push(con("c1", "ds1", "active", false));
    next.push("cancel");
    expect(await confirmEndTransactions({ tabId: "c1", reason: "switching to the Auto transaction mode", keepsSession: true })).toBe(false);
    expect(asked[1].choices.map((c) => c.value)).toEqual(["rollback", "cancel"]);
  });
  it("a failed transaction can only be rolled back", async () => {
    sessions.push(con("c1", "ds1", "failed"));
    answer = "rollback";
    await confirmEndTransactions({ tabId: "c1", reason: "closing the console" });
    expect(asked[0].choices.map((c) => c.value)).toEqual(["rollback", "cancel"]);
    expect(asked[0].message).toMatch(/failed/);
  });
});

describe("the COMMIT / ROLLBACK of the quit guard shows its progress", () => {
  /** A progress dialog that records what happened to it. */
  const progress = () => {
    const log: string[] = [];
    let quit!: () => void;
    const quitAnyway = new Promise<void>((r) => (quit = r));
    return { log, quit, p: { begin: (verb: string, title: string) => (log.push(`${verb} ${title}`), { stuck: () => void log.push("stuck"), close: () => void log.push("close"), quitAnyway }) } };
  };
  /** A console whose COMMIT only ends when `release` is called. */
  const hanging = () => {
    let release!: (ok: boolean) => void;
    const s = { ...con("c1", "ds1", "active"), endTx: (k: string) => (ended.push(`c1:${k}`), new Promise<boolean>((r) => (release = r))) };
    return { s, release: (ok = true) => release(ok) };
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows 'Committing' while it runs, then closes; a quick COMMIT never offers Quit anyway", async () => {
    const { s, release } = hanging();
    sessions.push(s);
    const pr = progress();
    const done = confirmEndTransactions({ reason: "quitting the application", progress: pr.p });
    await vi.advanceTimersByTimeAsync(STUCK_AFTER_MS - 1);
    expect(pr.log).toEqual(["Committing console c1"]);
    release();
    expect(await done).toBe(true);
    await vi.advanceTimersByTimeAsync(STUCK_AFTER_MS * 2);
    expect(pr.log).toEqual(["Committing console c1", "close"]); // no "stuck"
  });
  it("a ROLLBACK says 'Rolling back'", async () => {
    sessions.push(con("c1", "ds1", "active"));
    answer = "rollback";
    const pr = progress();
    await confirmEndTransactions({ reason: "quitting the application", progress: pr.p });
    expect(pr.log[0]).toBe("Rolling back console c1");
  });
  it("a COMMIT that takes longer than 10 s turns the dialog to 'Quit anyway', which lets the quit go on", async () => {
    const { s } = hanging();
    sessions.push(s);
    const pr = progress();
    let result: boolean | undefined;
    void confirmEndTransactions({ reason: "quitting the application", progress: pr.p }).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(STUCK_AFTER_MS);
    expect(pr.log).toEqual(["Committing console c1", "stuck"]);
    expect(result).toBeUndefined(); // still waiting until the user decides
    pr.quit();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(true);
    expect(pr.log.at(-1)).toBe("close");
    expect(asked).toHaveLength(1); // no "Cannot commit" dialog: the user already chose
  });
  it("a COMMIT that fails closes the progress before the failure dialog", async () => {
    sessions.push(con("c1", "ds1", "active", false));
    next.push("cancel");
    const pr = progress();
    expect(await confirmEndTransactions({ reason: "quitting", progress: pr.p })).toBe(false);
    expect(pr.log).toEqual(["Committing console c1", "close"]);
    expect(asked[1].title).toBe("Cannot commit the transaction");
  });
});

describe("txDialogText", () => {
  it("names the consoles and the reason", () => {
    const t = txDialogText([{ title: "console [pg]", status: "active" }], "closing the console");
    expect(t.title).toBe("Active Transaction");
    expect(t.message).toBe("'console [pg]' has an open transaction with changes that are not committed yet. Commit or roll back before closing the console.");
  });
});
