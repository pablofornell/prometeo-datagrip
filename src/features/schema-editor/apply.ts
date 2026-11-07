/** Runs a generated plan on a session of its own: one transaction where the DBMS can (PostgreSQL, SQLite). */
import { closeSession, executeCollect, openSession } from "../../api/db";
import { errText } from "./load";
import { type Plan } from "./sqlgen";

async function run(session: string, sql: string): Promise<void> {
  const events = await executeCollect(session, sql);
  const err = events.find((e) => e.kind === "error");
  if (err && err.kind === "error") throw new Error(err.message);
}

/** The server message of the failing statement, and how many statements before it had been applied for good. */
export class PlanError extends Error {
  constructor(
    message: string,
    /** Statements that stay applied: always 0 in a transaction (rolled back), the ones before the failing one otherwise. */
    readonly applied: number,
  ) {
    super(message);
  }
}

/** Throws the server message of the first failing statement (the transaction is then rolled back). */
export async function runPlan(dsId: string, plan: Plan): Promise<void> {
  if (plan.error) throw new Error(plan.error);
  const session = await openSession(dsId);
  let failure: unknown;
  try {
    for (const s of plan.pre) await run(session, s);
    try {
      if (plan.transactional) await run(session, "begin;");
      let done = 0;
      try {
        for (const s of plan.statements) {
          await run(session, s);
          done++;
        }
        if (plan.transactional) await run(session, "commit;");
      } catch (e) {
        if (plan.transactional) await run(session, "rollback;").catch(() => {});
        throw new PlanError(errText(e), plan.transactional ? 0 : done);
      }
    } catch (e) {
      failure = e;
    }
    // the pragmas that were switched off come back on whatever happened
    for (const s of plan.post) await run(session, s).catch(() => {});
  } finally {
    void closeSession(session).catch(() => {});
  }
  if (failure) throw failure;
}
