/**
 * Quitting asks several things (open transactions, unsaved files, pending table changes). All answers are collected
 * first, one `Ask` after the other; only when nobody cancelled are the chosen `Plan`s applied. A Cancel on the second
 * prompt therefore never leaves the first answer half applied ("Don't Save" reverted, "Submit" sent).
 */

/** Carries out one answer. false: it could not be done (the application stays); "exit": the user gave up waiting, quit now. */
export type Plan = () => boolean | "exit" | Promise<boolean | "exit">;

/** Asks the user. false: cancelled; null: nothing to do; else the plan to apply once everybody agreed. */
export type Ask = () => Plan | null | false | Promise<Plan | null | false>;

/** Resolves true when the application may quit, false when somebody cancelled or a plan failed. */
export async function runDecisions(asks: Ask[]): Promise<boolean> {
  const plans: Plan[] = [];
  for (const ask of asks) {
    const p = await ask();
    if (p === false) return false;
    if (p) plans.push(p);
  }
  for (const plan of plans) {
    const done = await plan();
    if (done === "exit") return true; // "Quit anyway": nothing else is asked or awaited
    if (!done) return false;
  }
  return true;
}
