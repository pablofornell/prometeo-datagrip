// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type Ask, runDecisions } from "./decisions";

describe("runDecisions (quitting)", () => {
  it("asks all, then applies in order", async () => {
    const log: string[] = [];
    const ask = (n: string): Ask => async () => (log.push(`ask ${n}`), () => (log.push(`apply ${n}`), true));
    expect(await runDecisions([ask("file A"), ask("table"), ask("tx")])).toBe(true);
    expect(log).toEqual(["ask file A", "ask table", "ask tx", "apply file A", "apply table", "apply tx"]);
  });
  it("Don't Save on A then Cancel on B applies nothing", async () => {
    const log: string[] = [];
    const a: Ask = () => () => (log.push("revert A"), true);
    const b: Ask = () => false;
    expect(await runDecisions([a, b])).toBe(false);
    expect(log).toEqual([]);
  });
  it("nothing to ask (null) is skipped", async () => {
    expect(await runDecisions([() => null, () => null])).toBe(true);
  });
  it("a plan that fails (save error) keeps the application open and stops applying", async () => {
    const log: string[] = [];
    const bad: Ask = () => () => false;
    const later: Ask = () => () => (log.push("later"), true);
    expect(await runDecisions([bad, later])).toBe(false);
    expect(log).toEqual([]);
  });
  it("'exit' (Quit anyway) quits at once: later plans do not run, nor wait", async () => {
    const log: string[] = [];
    const exit: Ask = () => () => "exit";
    const later: Ask = () => () => (log.push("later"), new Promise<boolean>(() => {})); // would hang forever
    expect(await runDecisions([exit, later])).toBe(true);
    expect(log).toEqual([]);
  });
});
