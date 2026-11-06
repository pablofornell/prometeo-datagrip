/**
 * Session-scoped table access (manual transaction mode): reads and edits that run on a dedicated session
 * connection, so they see and stay inside the session's open transaction.
 *
 * `table_data_in_session` / `apply_changes_in_session` are Tauri commands (src-tauri) that have no wrapper in
 * `src/api/db.ts` yet. Outside Tauri (browser mock) there is no session isolation: both fall back to the
 * pool-based calls, so the UI still works but a Rollback cannot undo anything there.
 */
import {
  type ApplyResult,
  type Driver,
  type ObjectRef,
  type ResultSet,
  type RowChange,
  type TableDataRequest,
  applyChanges,
  executeCollect,
  isTauri,
  sessionInTransaction,
  tableData,
} from "../../api/db";
import { invoke } from "../../api/tauri";
import { INTERNAL_MARK } from "../output/format";

export function tableDataInSession(dsId: string, sessionId: string, table: ObjectRef, request: TableDataRequest = {}): Promise<ResultSet> {
  return isTauri() ? invoke("table_data_in_session", { sessionId, table, request }) : tableData(dsId, table, request);
}

/**
 * Applies the changes on the session. In an open transaction they stay uncommitted (`committed` then means
 * "applied") and a failing batch leaves the transaction usable; outside one the batch commits at once.
 */
export function applyChangesInSession(dsId: string, sessionId: string, table: ObjectRef, changes: RowChange[]): Promise<ApplyResult> {
  return isTauri() ? invoke("apply_changes_in_session", { sessionId, table, changes }) : applyChanges(dsId, table, changes);
}

/** Runs a transaction-control statement the user did not type (hidden from the history popup). */
async function control(sessionId: string, sql: string): Promise<void> {
  const ev = await executeCollect(sessionId, `${sql} ${INTERNAL_MARK}`, { maxRows: 10, stopOnError: true });
  const err = ev.find((e) => e.kind === "error");
  if (err && err.kind === "error") throw new Error(err.message);
}

/** Opens the transaction of a manual-mode session unless one is already open. Resolves whether it was open. */
export async function ensureTransaction(sessionId: string, driver: Driver): Promise<boolean> {
  if (await sessionInTransaction(sessionId)) return true;
  await control(sessionId, driver === "mysql" ? "START TRANSACTION" : "BEGIN");
  return false;
}

export const endTransaction = (sessionId: string, kind: "commit" | "rollback"): Promise<void> => control(sessionId, kind === "commit" ? "COMMIT" : "ROLLBACK");
