/** Pure text helpers of the Database Output log (DataGrip wording, see docs/ux/datagrip-map.md §5 and §4.1). */

const p2 = (n: number): string => String(n).padStart(2, "0");

/** `[2026-11-06 13:38:47:330]` in local time. */
export function logTimestamp(t: number | Date): string {
  const d = new Date(t);
  return (
    `[${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}:${String(d.getMilliseconds()).padStart(3, "0")}]`
  );
}

/** `StringUtil.formatDuration`: `123 ms`, `1 s 234 ms`, `1 m 5 s`. */
export function formatDuration(ms: number): string {
  let t = Math.max(0, Math.round(ms));
  if (t < 1000) return `${t} ms`;
  const parts: string[] = [];
  const h = Math.floor(t / 3_600_000);
  t -= h * 3_600_000;
  const m = Math.floor(t / 60_000);
  t -= m * 60_000;
  const s = Math.floor(t / 1000);
  t -= s * 1000;
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} m`);
  if (s) parts.push(`${s} s`);
  if (t) parts.push(`${t} ms`);
  return parts.join(" ");
}

const rowsWord = (n: number): string => (n === 1 ? "1 row" : `${n} rows`);

/** `18 rows retrieved starting from 1 in 902 ms (execution: 21 ms, fetching: 881 ms)`. */
export function rowsRetrieved(rows: number, totalMs: number, execMs?: number, fetchMs?: number): string {
  const timing = execMs !== undefined && fetchMs !== undefined ? ` (execution: ${formatDuration(execMs)}, fetching: ${formatDuration(fetchMs)})` : "";
  if (rows === 0) return `0 rows retrieved in ${formatDuration(totalMs)}${timing}`;
  return `${rowsWord(rows)} retrieved starting from 1 in ${formatDuration(totalMs)}${timing}`;
}

/** `2 rows affected in 4 ms`. */
export function rowsAffected(rows: number, ms: number): string {
  return `${rowsWord(rows)} affected in ${formatDuration(ms)}`;
}

/** `completed in 12 ms` (statements without a row count: DDL, SET, transaction control). */
export function completedIn(ms: number): string {
  return `completed in ${formatDuration(ms)}`;
}

/** x. */
export function summary(executed: number, total: number, failed: number, ms: number, symbols?: number, aborted = false): string {
  return (
    `Summary: ${executed} of ${total} statements executed` +
    `${failed ? `, ${failed} failed` : ""} in ${formatDuration(ms)}` +
    `${symbols !== undefined ? ` (${symbols} symbols in file)` : ""}${aborted ? " (aborted!)" : ""}`
  );
}

/** Statements whose success is reported as `completed in` instead of a row count. */
const NO_COUNT = new Set(["CREATE", "DROP", "ALTER", "TRUNCATE", "SET", "BEGIN", "START", "COMMIT", "ROLLBACK", "END", "GRANT", "REVOKE", "USE", "COMMENT", "VACUUM", "ANALYZE", "REINDEX", "PRAGMA", "SAVEPOINT", "RELEASE", "LOCK", "DISCARD", "RESET"]);

/** First SQL keyword, skipping comments and parentheses. */
export function firstKeyword(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith("--")) s = s.slice(s.indexOf("\n") < 0 ? s.length : s.indexOf("\n") + 1).trimStart();
    else if (s.startsWith("/*")) s = s.slice(s.indexOf("*/") < 0 ? s.length : s.indexOf("*/") + 2).trimStart();
    else break;
  }
  return (/^\(*([A-Za-z]+)/.exec(s)?.[1] ?? "").toUpperCase();
}

export function reportsCount(sql: string): boolean {
  return !NO_COUNT.has(firstKeyword(sql));
}

// Leading line or block comment of a statement, used to name the result tab.
export function leadingComment(sql: string): string | null {
  const s = sql.trimStart();
  if (s.startsWith("--")) {
    const lines: string[] = [];
    for (const l of s.split("\n")) {
      const t = l.trim();
      if (!t.startsWith("--")) break;
      lines.push(t.replace(/^--+\s?/, "").trim());
    }
    return lines.find((l) => l) ?? null;
  }
  if (s.startsWith("/*")) {
    const end = s.indexOf("*/");
    if (end > 0) return s.slice(2, end).replace(/^\s*\*+/gm, "").trim().split("\n")[0].trim() || null;
  }
  return null;
}

/** Marks SQL the console sends on its own (BEGIN, SET search_path, ...) so the history can hide it. */
export const INTERNAL_MARK = "/*prometeo:internal*/";
export const isInternalSql = (sql: string): boolean => sql.includes(INTERNAL_MARK);
