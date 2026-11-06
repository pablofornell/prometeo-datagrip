/**
 * Asks what to do with open transactions before something ends their sessions: closing a console tab, deactivating
 * or re-saving a data source (the backend reconnects), quitting the app. Like DataGrip: Commit / Roll Back / Cancel.
 *
 * The transaction state is the server's (`ConsoleSession.txStatus`, the table editors' `txStatus`), never keywords.
 */
import type { TxStatus } from "../../api/types";
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
}

interface OpenTx {
  tabId: string;
  title: string;
  status: TxStatus;
  /** Cancels what runs (consoles) and resolves when the transaction ended. */
  end(kind: "commit" | "rollback"): Promise<boolean>;
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
    });
  }
  for (const c of allControllers()) {
    if (!c.inTx() || !inScope(c.dsId, c.tabId)) continue;
    list.push({ tabId: c.tabId, title: c.title(), status: c.txStatus(), end: (kind) => c.endTx(kind) });
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
 * Resolves true when nothing in `scope` is left open (there was no transaction, or the user chose Commit / Roll Back
 * and it ended), false when the user cancelled or a transaction could not be ended: the caller must then not proceed.
 */
export async function confirmEndTransactions(scope: TxScope): Promise<boolean> {
  const open = openTransactions(scope);
  if (open.length === 0) return true;
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
  for (const o of open) if (!(await o.end(answer))) return false;
  return true;
}
