/**
 * Which schemas of a data source the explorer shows (Data Sources > Schemas, the badge popup). A VIEW filter kept in
 * the UI state per data source, NOT in `DataSource.options`: the options are part of the backend's connection
 * fingerprint, so saving a change there reconnects and drops every session with its open transaction.
 *
 * Stored value: the JSON array of introspection paths (PG `[db, schema]`, MySQL / SQLite `[schema]`), or "" for
 * "every non-system schema" (which also overrides a legacy `options.visibleSchemas`, see `visibleSchemasRaw`).
 */
import { loadLocal, saveUiState } from "./persist";

const KEY = "visibleSchemas";
let cache: Record<string, string> | undefined;
const all = () => (cache ??= loadLocal<Record<string, string>>(KEY, {}));

/** The stored value, `undefined` when this data source has none (then the legacy option applies). */
export function storedVisibleSchemas(dsId: string): string | undefined {
  return all()[dsId];
}

/** Stores the filter of a data source; `undefined` / "" = the default view. Never touches the connection. */
export function storeVisibleSchemas(dsId: string, raw: string | undefined): void {
  const m = { ...all(), [dsId]: raw ?? "" };
  if (JSON.stringify(m) === JSON.stringify(all())) return;
  cache = m;
  saveUiState(KEY, m);
}

/** Drops the filter of a removed data source. */
export function forgetVisibleSchemas(dsId: string): void {
  if (!(dsId in all())) return;
  const m = { ...all() };
  delete m[dsId];
  cache = m;
  saveUiState(KEY, m);
}

/** Tests: forget the in-memory copy. */
export function resetVisibleSchemasCache(): void {
  cache = undefined;
}
