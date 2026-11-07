/**
 * The schema filter of a data source (also used by the explorer). It lives in the UI state (`state/schema-filter`),
 * never in `options`: saving a data source whose connection settings changed reconnects it, a view filter must not.
 * Data sources saved by earlier versions keep `options.visibleSchemas`; it is read as the fallback until the user
 * changes the filter (the stored value then wins, even "show everything").
 */
import type { DataSource } from "../../api/db";
import { storedVisibleSchemas, storeVisibleSchemas } from "../../state/schema-filter";
import { type SchemaFilter, parseFilter, patternVerdict, splitPatterns } from "./schemaModel";

export { pathKey } from "./schemaModel";

/** The filter of a data source as its raw JSON text (stored value first, legacy option second). */
export function visibleSchemasRaw(ds: Pick<DataSource, "id" | "options">): string | undefined {
  return storedVisibleSchemas(ds.id) ?? ds.options?.visibleSchemas ?? undefined;
}

/**
 * Parses the raw text. `null` = every (non-system) schema is visible. Otherwise the list of introspection paths the
 * filter names (patterns and the default row are not paths: see `parseSchemaFilter`).
 */
export function parseVisibleSchemas(raw: string | undefined | null): string[][] | null {
  return parseFilter(raw)?.paths ?? null;
}

/** The whole filter of a data source (paths, patterns, default row, object filter); `null` = the default view. */
export function parseSchemaFilter(raw: string | undefined | null): SchemaFilter | null {
  return parseFilter(raw);
}

/** `null` = every (non-system) schema is visible. Otherwise the list of introspection paths to show. */
export function visibleSchemas(ds: Pick<DataSource, "id" | "options">): string[][] | null {
  return parseVisibleSchemas(visibleSchemasRaw(ds));
}

/** The schema a data source starts in, as far as the data source itself tells (PostgreSQL's is `public` unless the server says otherwise). */
export const defaultSchemaName = (ds: Pick<DataSource, "driver" | "database" | "user">): string =>
  ds.driver === "sqlite" ? "main" : ds.driver === "mysql" ? ds.database : ds.driver === "oracle" ? ds.user.toUpperCase() : "public";

/**
 * Is the schema node at `path` (PG: [db, schema], MySQL: [schema], SQLite: [schema]) visible?
 * A database path of PG ([db]) is visible when any of its schemas is. `info` (the node's name and whether it is the
 * default schema) is only needed for the patterns and the `Default schema` row.
 */
export function isSchemaVisible(ds: Pick<DataSource, "id" | "options" | "driver" | "database" | "user">, path: string[], info?: { isDefault?: boolean }): boolean {
  const f = parseFilter(visibleSchemasRaw(ds));
  if (!f) return true;
  const name = path[path.length - 1];
  const verdict = patternVerdict(name, f.patterns);
  if (verdict === "no") return false;
  if (verdict === "yes") return true;
  if (f.useDefault && (info?.isDefault ?? name === defaultSchemaName(ds))) return true;
  return f.paths.some((p) => path.every((x, i) => p[i] === x));
}

/** Same by schema name only (search lists, where there is no node): the paths' last element is the schema. */
export function isSchemaNameVisible(ds: Pick<DataSource, "id" | "options" | "driver" | "database" | "user">, name: string): boolean {
  const f = parseFilter(visibleSchemasRaw(ds));
  if (!f) return true;
  const verdict = patternVerdict(name, f.patterns);
  if (verdict === "no") return false;
  return verdict === "yes" || (f.useDefault && name === defaultSchemaName(ds)) || f.paths.some((p) => p[p.length - 1] === name);
}

/** Does `name` pass the object filter of the data source (the `Object filter:` field of Data Sources > Schemas)? */
export function isObjectVisible(ds: Pick<DataSource, "id" | "options">, name: string): boolean {
  const patterns = splitPatterns(parseFilter(visibleSchemasRaw(ds))?.objects ?? "");
  if (!patterns.length) return true;
  const v = patternVerdict(name, patterns);
  // only negative patterns: everything else stays visible
  return v === "yes" || (v === "none" && patterns.every((p) => p.startsWith("!")));
}


/** Saves the filter of a data source (`undefined` = default view). A UI-state write: no reconnect, sessions stay. */
export function saveVisibleSchemas(dsId: string, raw: string | undefined): void {
  storeVisibleSchemas(dsId, raw);
}
