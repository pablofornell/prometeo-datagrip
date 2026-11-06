// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyTxEnd, controlError, isSessionLost, txLabel, txReport } from "./session";

describe("transaction events", () => {
  it("recognises a lost session by the backend's message, not by any `does not exist`", () => {
    expect(isSessionLost(new Error("Session 's3' does not exist"))).toBe(true);
    expect(isSessionLost("Session is closed")).toBe(true);
    expect(isSessionLost(new Error('relation "t" does not exist'))).toBe(false);
  });
  it("a killed connection is a lost session: flag, [08006] / [08S01] prefix, or the old text", () => {
    expect(isSessionLost(new Error("[08006] connection lost: the server closed the connection"))).toBe(true);
    expect(isSessionLost(new Error("[08S01] connection lost"))).toBe(true);
    expect(isSessionLost(controlError({ message: "boom", connectionLost: true }))).toBe(true);
    expect(isSessionLost(controlError({ message: "boom" }))).toBe(false);
  });
  it("the backend's CONNECTION LOST tx end is its own kind (not a server rollback, even after a COMMIT)", () => {
    expect(classifyTxEnd("COMMIT", { committed: false, tag: "CONNECTION LOST" })).toBe("connectionLost");
    expect(classifyTxEnd(null, { committed: false, tag: "CONNECTION LOST" })).toBe("connectionLost");
  });
  it("a COMMIT that did not commit is the server rolling back a failed transaction", () => {
    expect(classifyTxEnd("COMMIT", { committed: false, tag: "ROLLBACK" })).toBe("serverRollback");
    expect(classifyTxEnd("end", { committed: false, tag: "ROLLBACK" })).toBe("serverRollback");
    expect(classifyTxEnd("/* x */ commit", { committed: false, tag: "ROLLBACK" })).toBe("serverRollback");
    expect(classifyTxEnd("ROLLBACK", { committed: false, tag: "ROLLBACK" })).toBe("rollback");
    expect(classifyTxEnd("COMMIT", { committed: true, tag: "COMMIT" })).toBe("commit");
    expect(classifyTxEnd("CREATE TABLE t(a int)", { committed: true, tag: "IMPLICIT COMMIT" })).toBe("implicit");
  });
  it("collects the last status and the ended events", () => {
    const r = txReport([
      { kind: "txStatus", status: "active" },
      { kind: "txEnded", index: 0, committed: true, tag: "COMMIT" },
      { kind: "txStatus", status: "idle" },
    ]);
    expect(r.status).toBe("idle");
    expect(r.ended).toHaveLength(1);
  });
  it("labels the state for the status bar", () => {
    expect(txLabel("manual", "failed")).toBe("Tx: Manual (failed)");
    expect(txLabel("manual", "active")).toBe("Tx: Manual (active)");
    expect(txLabel("auto", "idle")).toBe("Tx: Auto");
  });
});
