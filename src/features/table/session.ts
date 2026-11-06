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
  type ExecEvent,
  type TxStatus,
  executeCollect,
  isTauri,
  sessionTxStatus,
  tableData,
} from "../../api/db";
import { invoke } from "../../api/tauri";
import { isConnectionLost } from "../../state/connection-errors";
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

/**
 * The session is gone: the data source was disconnected / deactivated, the console closed, or the server killed the
 * connection (`connectionLost`, `[08006]` / `[08S01]` messages). See `isConnectionLost`.
 */
export const isSessionLost = isConnectionLost;

export type TxEndedEvent = Extract<ExecEvent, { kind: "txEnded" }>;

/** What the backend reported about the transaction while a statement ran: the last `txStatus` and any `txEnded`. */
export interface TxReport {
  status: TxStatus | null;
  ended: TxEndedEvent[];
}

/** Reads `txStatus` / `txEnded` out of collected events (the backend is the source of truth, no keyword tracking). */
export function txReport(events: ExecEvent[]): TxReport {
  const r: TxReport = { status: null, ended: [] };
  for (const e of events) {
    if (e.kind === "txStatus") r.status = e.status;
    else if (e.kind === "txEnded") r.ended.push(e);
  }
  return r;
}

export type TxEndKind = "commit" | "rollback" | "implicit" | "serverRollback" | "connectionLost";

/**
 * What a `txEnded` event means, given the statement that produced it (`COMMIT` / `END` that ends with
 * `committed: false` = PostgreSQL rolled back a failed transaction instead of committing it).
 */
export function classifyTxEnd(sql: string | null, e: Pick<TxEndedEvent, "committed" | "tag">): TxEndKind {
  if (e.tag === "IMPLICIT COMMIT") return "implicit";
  if (e.tag === "CONNECTION LOST") return "connectionLost"; // the connection took the transaction with it
  if (e.committed) return "commit";
  const kw = (/^\s*(?:\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/.exec(sql ?? "")?.[1] ?? "").toUpperCase();
  return kw === "COMMIT" || kw === "END" || sql === null ? "serverRollback" : "rollback";
}

export const SERVER_ROLLBACK_LOG = "transaction rolled back by the server: the transaction had failed, so COMMIT did not save the changes";
export const SERVER_ROLLBACK_TITLE = "The transaction was rolled back";
export const SERVER_ROLLBACK_BODY = "The transaction had failed, so the server rolled it back instead of committing it. Nothing was saved.";

/** The failure of a statement of ours as an Error that keeps the backend's `connectionLost` flag (`isConnectionLost`). */
export function controlError(err: { message: string; connectionLost?: boolean }): Error {
  return Object.assign(new Error(err.message), err.connectionLost ? { connectionLost: true } : {});
}

/** Runs a statement the user did not type (hidden from the history popup) and reports the transaction events. */
export async function control(sessionId: string, sql: string): Promise<TxReport> {
  const ev = await executeCollect(sessionId, `${sql} ${INTERNAL_MARK}`, { maxRows: 10, stopOnError: true });
  const err = ev.find((e) => e.kind === "error");
  if (err && err.kind === "error") throw controlError(err);
  return txReport(ev);
}

/**
 * Opens the transaction of a manual-mode session unless one is already open. Resolves the status of the session
 * afterwards (`failed` when an earlier error aborted it: the caller must roll back first).
 */
export async function ensureTransaction(sessionId: string, driver: Driver): Promise<TxStatus> {
  const st = await sessionTxStatus(sessionId);
  if (st !== "idle") return st;
  const r = await control(sessionId, driver === "mysql" ? "START TRANSACTION" : "BEGIN");
  return r.status ?? "active";
}

export const endTransaction = (sessionId: string, kind: "commit" | "rollback"): Promise<TxReport> => control(sessionId, kind === "commit" ? "COMMIT" : "ROLLBACK");

/** Status bar text of the transaction of a console / table editor: `Tx: Manual (failed)`. */
export function txLabel(mode: "auto" | "manual", status: TxStatus): string {
  const m = mode === "manual" ? "Manual" : "Auto";
  return status === "idle" ? `Tx: ${m}` : `Tx: ${m} (${status})`;
}
