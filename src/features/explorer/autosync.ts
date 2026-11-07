/**
 * Auto sync (Data Sources > Options > Introspection): after a console ran DDL, the explorer re-reads the data source,
 * so a table created or dropped in the console shows up without Refresh.
 */
import { dsOf, refreshNode } from "./core";

/** Text without comments and string / quoted-identifier literals, lower-cased (statement starts are all that matter). */
function bare(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, "``")
    .toLowerCase();
}

/** Does the script contain a statement that changes the schema (create / alter / drop / rename / comment on)? */
export function changesSchema(sql: string): boolean {
  return /(?:^|;)\s*(?:create|alter|drop|rename|comment\s+on)\b/.test(bare(sql));
}

/** Called by the consoles after a script ran: refreshes the data source when it was DDL and Auto sync is on. */
export function autoSyncAfter(dsId: string, sql: string): void {
  const ds = dsOf(dsId);
  if (!ds || ds.options?.autoSync === "false" || !changesSchema(sql)) return;
  refreshNode(dsId);
}
