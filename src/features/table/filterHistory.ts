/**
 * History of the WHERE / ORDER BY texts applied in a table editor: the last 20 distinct ones per table, newest first,
 * kept in the UI state. Opened from the funnel / sort icon of the filter bar (or Alt+Down in the empty field).
 */
import { loadLocal, saveUiState } from "../../state/persist";

export type FilterKind = "where" | "order";
const KEY = "tableFilterHistory";
export const HISTORY_LIMIT = 20;

type Entry = { where: string[]; order: string[] };
let cache: Record<string, Entry> | undefined;
const all = () => (cache ??= loadLocal<Record<string, Entry>>(KEY, {}));

/** The applied texts of a table, newest first. `tableKey` identifies the table (data source, schema, name). */
export function filterHistory(tableKey: string, kind: FilterKind): string[] {
  return all()[tableKey]?.[kind] ?? [];
}

/** Remembers an applied text: moves it to the front, drops the oldest beyond the limit. Empty texts are ignored. */
export function rememberFilter(tableKey: string, kind: FilterKind, text: string): void {
  const t = text.trim();
  if (!t) return;
  const cur = all()[tableKey] ?? { where: [], order: [] };
  const list = [t, ...cur[kind].filter((x) => x !== t)].slice(0, HISTORY_LIMIT);
  if (list.length === cur[kind].length && list.every((x, i) => x === cur[kind][i])) return;
  cache = { ...all(), [tableKey]: { ...cur, [kind]: list } };
  saveUiState(KEY, cache);
}

/** Tests: forget the in-memory copy. */
export function resetFilterHistory(): void {
  cache = undefined;
}
