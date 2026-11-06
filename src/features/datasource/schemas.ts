/** `options.visibleSchemas` helpers (also used by the explorer). */
import type { DataSource } from "../../api/db";

/** `null` = every (non-system) schema is visible. Otherwise the list of introspection paths to show. */
export function visibleSchemas(ds: Pick<DataSource, "options">): string[][] | null {
  const raw = ds.options?.visibleSchemas;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((p) => Array.isArray(p) && p.every((x) => typeof x === "string"))) return v;
  } catch {
    /* ignore malformed value */
  }
  return null;
}

/**
 * Is the schema node at `path` (PG: [db, schema], MySQL: [schema], SQLite: [schema]) visible?
 * A database path of PG ([db]) is visible when any of its schemas is.
 */
export function isSchemaVisible(ds: Pick<DataSource, "options">, path: string[]): boolean {
  const v = visibleSchemas(ds);
  if (!v) return true;
  return v.some((p) => path.every((x, i) => p[i] === x));
}

export const pathKey = (p: string[]) => p.join("\u0001");
