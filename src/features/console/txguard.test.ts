// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessions: unknown[] = [];
const controllers: unknown[] = [];
let answer = "commit";
const asked: { title: string; message: string; choices: { value: string }[] }[] = [];
vi.mock("../../state/tabs", () => ({ activateTab: () => {} }));
vi.mock("./registry", () => ({ allSessions: () => sessions }));
vi.mock("../table/controller", () => ({ allControllers: () => controllers }));
vi.mock("../table/dialogs", () => ({
  askChoice: async (c: (typeof asked)[number]) => {
    asked.push(c);
    return answer;
  },
}));
import { confirmEndTransactions, txDialogText } from "./txguard";

const ended: string[] = [];
const con = (tabId: string, dsId: string, status: "idle" | "active" | "failed", ok = true) => ({
  tabId,
  dsId,
  title: () => `console ${tabId}`,
  inTx: () => status !== "idle",
  txStatus: () => status,
  out: { running: () => false },
  cancel() {},
  endTx: async (k: string) => (ended.push(`${tabId}:${k}`), ok),
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
  it("fails when a transaction cannot be ended", async () => {
    sessions.push(con("c1", "ds1", "active", false), con("c2", "ds1", "active"));
    expect(await confirmEndTransactions({ reason: "quitting" })).toBe(false);
    expect(ended).toEqual(["c1:commit"]);
  });
  it("a failed transaction can only be rolled back", async () => {
    sessions.push(con("c1", "ds1", "failed"));
    answer = "rollback";
    await confirmEndTransactions({ tabId: "c1", reason: "closing the console" });
    expect(asked[0].choices.map((c) => c.value)).toEqual(["rollback", "cancel"]);
    expect(asked[0].message).toMatch(/failed/);
  });
});

describe("txDialogText", () => {
  it("names the consoles and the reason", () => {
    const t = txDialogText([{ title: "console [pg]", status: "active" }], "closing the console");
    expect(t.title).toBe("Active Transaction");
    expect(t.message).toBe("'console [pg]' has an open transaction with changes that are not committed yet. Commit or roll back before closing the console.");
  });
});
