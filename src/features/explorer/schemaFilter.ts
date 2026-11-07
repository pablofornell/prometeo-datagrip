/**
 * The data of the schema selector popup: the schemas the server lists, and how a choice is stored. The popup itself
 * is SchemaSelector.tsx; the logic of the filter (patterns, the default schema row) is `datasource/schemaModel.ts`.
 * The choice is a view filter kept in the UI state (the same store as Data Sources > Schemas), so applying it never
 * reconnects the data source.
 */
import type { DataSource, TreeNode } from "../../api/db";
import { saveVisibleSchemas, visibleSchemasRaw } from "../datasource/schemas";
import { type SchemaFilter, type SchemaItem, EMPTY_FILTER, filterOrDefault, pathKey, serializeFilter } from "../datasource/schemaModel";
import { rawIntrospect, reloadDataSources } from "./core";

export type { SchemaItem } from "../datasource/schemaModel";
export interface SchemaGroup {
  /** PostgreSQL database; null for MySQL / SQLite (the schemas hang off the data source). */
  name: string | null;
  items: SchemaItem[];
}

/** Every schema the server lists (system ones included), grouped by database for PostgreSQL, alphabetical. */
export async function loadSchemaGroups(ds: DataSource): Promise<SchemaGroup[]> {
  const isDefault = (n: TreeNode) => (ds.driver === "postgres" ? !!n.extra.default : ds.driver === "sqlite" ? n.name === "main" : n.name === ds.database);
  const toItems = (nodes: TreeNode[]): SchemaItem[] =>
    nodes
      .filter((n) => n.kind === "schema")
      .map((n) => ({ path: n.path, name: n.name, system: !!n.extra.system, isDefault: isDefault(n) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const top = await rawIntrospect(ds.id, [], true);
  if (ds.driver !== "postgres") return [{ name: null, items: toItems(top) }];
  const dbs = top.filter((n) => n.kind === "database" && (n.hasChildren || n.extra.current));
  return Promise.all(dbs.map(async (d) => ({ name: d.name, items: toItems(await rawIntrospect(ds.id, d.path, true)) })));
}

/**
 * The stored text for a set of checked schemas: undefined when it is the default view (every non-system schema),
 * else the JSON list of the checked introspection paths.
 */
export function visibleSchemasOption(groups: SchemaGroup[], checked: ReadonlySet<string>): string | undefined {
  const all = groups.flatMap((g) => g.items);
  return serializeFilter({ ...EMPTY_FILTER, paths: all.filter((i) => checked.has(pathKey(i.path))).map((i) => i.path) }, all);
}

/** The filter a data source starts with in the selector: its stored one, else every non-system schema. */
export function initialFilter(ds: DataSource, groups: SchemaGroup[]): SchemaFilter {
  return filterOrDefault(visibleSchemasRaw(ds), groups.flatMap((g) => g.items));
}

/** Stores the filter and redraws the tree. The connection is not touched (the options are not saved). */
export async function save(ds: DataSource, value: string | undefined): Promise<void> {
  saveVisibleSchemas(ds.id, value);
  await reloadDataSources();
}
