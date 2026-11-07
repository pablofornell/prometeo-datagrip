/**
 * Asks what to do with open transactions before something ends their sessions: closing a console tab, deactivating
 * or re-saving a data source (the backend reconnects), quitting the app. Like DataGrip: Commit / Roll Back / Cancel.
 *
 * The transaction state is the server's (`ConsoleSession.txStatus`, the table editors' `txStatus`), never keywords.
 */
import type { TxStatus } from "../../api/types";
import type { Plan } from "../../state/decisions";
import { activateTab } from "../../state/tabs";
import { allControllers } from "../table/controller";
import { askChoice } from "../table/dialogs";
import { allSessions } from "./registry";

export interface TxScope {
  /** Only transactions on this data source. */
  dsId?: string;
  /** Only the transaction of this editor tab (console or table). */
  tabId?: string;
  /** What is about to happen, as the end of "Commit or roll back before ...": `closing the console`. */
  reason: string;
  /** The session stays alive afterwards (switching to Auto): a transaction that cannot be ended must not be abandoned. */
  keepsSession?: boolean;
  /**
   * Shows that the COMMIT / ROLLBACK the user chose is running (quit guard). After `STUCK_AFTER_MS` without an answer
   * it is told so (`stuck`) and may resolve `quitAnyway`: the outcome is then unknown, but the user is not trapped.
   */
  progress?: TxProgress;
}

/** A COMMIT / ROLLBACK that takes longer than this offers "Quit anyway" (`TxScope.progress`). */
export const STUCK_AFTER_MS = 10_000;

export interface TxProgress {
  begin(verb: "Committing" | "Rolling back", title: string): { stuck(): void; close(): void; quitAnyway: Promise<void> };
}

interface OpenTx {
  tabId: string;
  title: string;
  status: TxStatus;
  /**
   * Cancels what runs (consoles) and resolves when the transaction ended. A connection that was lost counts as
   * ended (the server rolled the transaction back; the tab told the user). False: it could not be ended.
   */
  end(kind: "commit" | "rollback"): Promise<boolean>;
  /** Why the last `end` failed. */
  error(): string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The open transactions (`active` / `failed`) of the consoles and table editors in `scope`. */
export function openTransactions(scope: Pick<TxScope, "dsId" | "tabId">): OpenTx[] {
  const inScope = (dsId: string, tabId: string) => (!scope.dsId || scope.dsId === dsId) && (!scope.tabId || scope.tabId === tabId);
  const list: OpenTx[] = [];
  for (const s of allSessions()) {
    if (!s.inTx() || !inScope(s.dsId, s.tabId)) continue;
    list.push({
      tabId: s.tabId,
      title: s.title(),
      status: s.txStatus(),
      end: async (kind) => {
        if (s.out.running()) {
          s.cancel();
          for (let i = 0; i < 60 && s.out.running(); i++) await sleep(50);
        }
        return s.endTx(kind);
      },
      error: () => s.txError ?? null,
    });
  }
  for (const c of allControllers()) {
    if (!c.inTx() || !inScope(c.dsId, c.tabId)) continue;
    list.push({ tabId: c.tabId, title: c.title(), status: c.txStatus(), end: (kind) => c.endTx(kind), error: () => c.txError?.() ?? null });
  }
  return list;
}

/** The text of the dialog (pure, for the tests). */
export function txDialogText(open: Pick<OpenTx, "title" | "status">[], reason: string): { title: string; message: string; onlyRollback: boolean } {
  const names = open.map((o) => `'${o.title}'`).join(", ");
  const failed = open.filter((o) => o.status === "failed").length;
  const one = open.length === 1;
  let message = `${names} ${one ? "has" : "have"} an open transaction with changes that are not committed yet. Commit or roll back before ${reason}.`;
  if (failed) {
    message += one
      ? " The transaction has failed (an earlier statement raised an error): it can only be rolled back, a commit would be rolled back by the server."
      : ` ${failed === open.length ? "All of them have" : `${failed} of them have`} failed: a commit would be rolled back by the server.`;
  }
  return { title: one ? "Active Transaction" : "Active Transactions", message, onlyRollback: failed === open.length };
}

/**
 * Asks Commit / Roll Back / Cancel about the open transactions in `scope` and ends nothing yet: false when the user
 * cancelled, null when none is open, else the plan that ends them (resolves "exit" when the user gave up waiting for a
 * COMMIT that hangs: "Quit anyway", the remaining transactions are then left to the server).
 */
export async function askEndTransactions(scope: TxScope): Promise<Plan | null | false> {
  const open = openTransactions(scope);
  if (open.length === 0) return null;
  if (scope.tabId) activateTab(scope.tabId);
  const t = txDialogText(open, scope.reason);
  const answer = await askChoice({
    title: t.title,
    message: t.message,
    choices: t.onlyRollback
      ? [
          { label: "Roll Back", value: "rollback", primary: true },
          { label: "Cancel", value: "cancel" },
        ]
      : [
          { label: "Commit", value: "commit", primary: true },
          { label: "Roll Back", value: "rollback" },
          { label: "Cancel", value: "cancel" },
        ],
    cancel: "cancel",
  });
  if (answer !== "commit" && answer !== "rollback") return false;
  return async () => {
    for (const o of open) {
      const r = await endOne(o, answer, scope);
      if (r === "quitAnyway") return "exit";
      if (!r) return false;
    }
    return true;
  };
}

/**
 * Resolves true when nothing in `scope` is left open (there was no transaction, or the user chose Commit / Roll Back
 * and it ended), false when the user cancelled or a transaction could not be ended: the caller must then not proceed.
 */
export async function confirmEndTransactions(scope: TxScope): Promise<boolean> {
  const plan = await askEndTransactions(scope);
  if (plan === false) return false;
  return plan ? (await plan()) !== false : true;
}

/** `o.end(kind)`, with the progress dialog of `scope` while it runs; "quitAnyway" when the user gave up waiting. */
async function endWithProgress(o: OpenTx, kind: "commit" | "rollback", scope: TxScope): Promise<boolean | "quitAnyway"> {
  const ending = o.end(kind);
  ending.catch(() => {}); // when the user quits anyway nobody awaits it any more
  const p = scope.progress?.begin(kind === "commit" ? "Committing" : "Rolling back", o.title);
  if (!p) return ending;
  const timer = setTimeout(() => p.stuck(), STUCK_AFTER_MS);
  try {
    return await Promise.race([ending, p.quitAnyway.then(() => "quitAnyway" as const)]);
  } finally {
    clearTimeout(timer);
    p.close();
  }
}

/**
 * Ends one transaction. When that fails (not a lost connection: `end` resolves true for those), the user always gets a
 * way out: after a failed COMMIT Roll Back / Close anyway / Cancel, after a failed ROLLBACK Close anyway / Cancel.
 * Closing the connection makes the server roll back what is not committed, so Close anyway loses nothing the
 * failed COMMIT had not already lost. (A session that stays alive has no Close anyway.)
 */
async function endOne(o: OpenTx, first: "commit" | "rollback", scope: TxScope): Promise<boolean | "quitAnyway"> {
  let kind = first;
  for (;;) {
    const ended = await endWithProgress(o, kind, scope);
    if (ended === "quitAnyway") return "quitAnyway";
    if (ended === true) return true;
    const why = o.error() ?? "the server did not answer";
    const verb = kind === "commit" ? "commit" : "roll back";
    const choices = [
      ...(kind === "commit" ? [{ label: "Roll Back", value: "rollback", primary: true }] : []),
      ...(scope.keepsSession ? [] : [{ label: "Close Anyway", value: "force", primary: kind !== "commit" }]),
      { label: "Cancel", value: "cancel" },
    ];
    const answer = await askChoice({
      title: `Cannot ${verb} the transaction`,
      message:
        `The transaction of '${o.title}' could not be ${kind === "commit" ? "committed" : "rolled back"}: ${why}` +
        (scope.keepsSession ? "" : `\n\nClose Anyway goes on with ${scope.reason}: the connection closes and the server rolls back whatever was not committed.`),
      choices,
      cancel: "cancel",
    });
    if (answer === "force" && !scope.keepsSession) return true;
    if (answer === "rollback") {
      kind = "rollback";
      continue;
    }
    return false;
  }
}
