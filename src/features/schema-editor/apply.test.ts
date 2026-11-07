// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let failOn = "";
vi.mock("../../api/db", () => ({
  openSession: async () => "s1",
  closeSession: async () => {},
  executeCollect: async (_s: string, sql: string) => {
    sent.push(sql);
    return failOn && sql.includes(failOn) ? [{ kind: "error", message: `boom: ${sql}` }] : [];
  },
}));

import { PlanError, runPlan } from "./apply";
import type { Plan } from "./sqlgen";

const plan = (over: Partial<Plan>): Plan => ({ pre: [], statements: ["one;", "two;", "three;"], post: [], transactional: true, warnings: [], ...over });

describe("runPlan", () => {
  beforeEach(() => {
    sent.length = 0;
    failOn = "";
  });

  it("a transactional plan reports nothing applied after the rollback", async () => {
    failOn = "two";
    const e = await runPlan("ds", plan({})).catch((x) => x);
    expect(e).toBeInstanceOf(PlanError);
    expect(e.applied).toBe(0);
    expect(sent).toEqual(["begin;", "one;", "two;", "rollback;"]);
  });

  it("a plan without transaction (MySQL) says how many statements stay applied", async () => {
    failOn = "three";
    const e = await runPlan("ds", plan({ transactional: false })).catch((x) => x);
    expect(e).toBeInstanceOf(PlanError);
    expect(e.applied).toBe(2);
    expect(e.message).toContain("boom: three;");
  });

  it("a failure of the first statement leaves nothing to reload", async () => {
    failOn = "one";
    const e = await runPlan("ds", plan({ transactional: false })).catch((x) => x);
    expect(e.applied).toBe(0);
  });

  it("the pragmas come back after a failure", async () => {
    failOn = "two";
    await runPlan("ds", plan({ pre: ["pre;"], post: ["post;"] })).catch(() => {});
    expect(sent[0]).toBe("pre;");
    expect(sent.at(-1)).toBe("post;");
  });
});
