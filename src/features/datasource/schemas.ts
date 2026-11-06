/**
 * The schema filter of a data source (also used by the explorer). It lives in the UI state (`state/schema-filter`),
 * never in `options`: saving a data source whose connection settings changed reconnects it, a view filter must not.
 * Data sources saved by earlier versions keep `options.visibleSchemas`; it is read as the fallback until the user
 * changes the filter (the stored value then wins, even "show everything").
 */
import type { DataSource } from "../../api/db";
import { storedVisibleSchemas, storeVisibleSchemas } from "../../state/schema-filter";

/** The filter of a data source as its raw JSON text (stored value first, legacy option second). */
export function visibleSchemasRaw(ds: Pick<DataSource, "id" | "options">): string | undefined {
  return storedVisibleSchemas(ds.id) ?? ds.options?.visibleSchemas ?? undefined;
}

/** Parses the raw text. `null` = every (non-system) schema is visible. Otherwise the list of introspection paths. */
export function parseVisibleSchemas(raw: string | undefined | null): string[][] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((p) => Array.isArray(p) && p.every((x) => typeof x === "string"))) return v;
  } catch {
    /* ignore malformed value */
  }
  return null;
}

/** `null` = every (non-system) schema is visible. Otherwise the list of introspection paths to show. */
export function visibleSchemas(ds: Pick<DataSource, "id" | "options">): string[][] | null {
  return parseVisibleSchemas(visibleSchemasRaw(ds));
}

/**
 * Is the schema node at `path` (PG: [db, schema], MySQL: [schema], SQLite: [schema]) visible?
 * A database path of PG ([db]) is visible when any of its schemas is.
 */
export function isSchemaVisible(ds: Pick<DataSource, "id" | "options">, path: string[]): boolean {
  const v = visibleSchemas(ds);
  if (!v) return true;
  return v.some((p) => path.every((x, i) => p[i] === x));
}

export const pathKey = (p: string[]) => p.join("\u0001");

/** Saves the filter of a data source (`undefined` = default view). A UI-state write: no reconnect, sessions stay. */
export function saveVisibleSchemas(dsId: string, raw: string | undefined): void {
  storeVisibleSchemas(dsId, raw);
}
