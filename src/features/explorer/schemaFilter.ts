/**
 * The data of the schema selector popup: the schemas the server lists, and how a choice is stored. The popup itself
 * is SchemaSelector.tsx. The choice is a view filter kept in the UI state (the same store as Data Sources > Schemas),
 * so applying it never reconnects the data source.
 */
import type { DataSource, TreeNode } from "../../api/db";
import { pathKey, saveVisibleSchemas, visibleSchemas } from "../datasource/schemas";
import { rawIntrospect, reloadDataSources } from "./core";

export interface SchemaItem {
  path: string[];
  name: string;
  system: boolean;
}
export interface SchemaGroup {
  /** PostgreSQL database; null for MySQL / SQLite (the schemas hang off the data source). */
  name: string | null;
  items: SchemaItem[];
}

/** Every schema the server lists (system ones included), grouped by database for PostgreSQL. */
export async function loadSchemaGroups(ds: DataSource): Promise<SchemaGroup[]> {
  const toItems = (nodes: TreeNode[]): SchemaItem[] =>
    nodes.filter((n) => n.kind === "schema").map((n) => ({ path: n.path, name: n.name, system: !!n.extra.system }));
  const top = await rawIntrospect(ds.id, [], true);
  if (ds.driver !== "postgres") return [{ name: null, items: toItems(top) }];
  const dbs = top.filter((n) => n.kind === "database" && (n.hasChildren || n.extra.current));
  return Promise.all(dbs.map(async (d) => ({ name: d.name, items: toItems(await rawIntrospect(ds.id, d.path, true)) })));
}

/**
 * The schema filter for a set of checked schemas: undefined when it is the default view (every non-system schema),
 * else the JSON list of the checked introspection paths.
 */
export function visibleSchemasOption(groups: SchemaGroup[], checked: ReadonlySet<string>): string | undefined {
  const all = groups.flatMap((g) => g.items);
  const isDefault = all.every((i) => checked.has(pathKey(i.path)) === !i.system);
  return isDefault ? undefined : JSON.stringify(all.filter((i) => checked.has(pathKey(i.path))).map((i) => i.path));
}

/** The checked set a data source starts with: its `visibleSchemas`, else the non-system schemas. */
export function initialChecked(ds: DataSource, groups: SchemaGroup[]): Set<string> {
  const v = visibleSchemas(ds);
  if (v) return new Set(v.map(pathKey));
  return new Set(groups.flatMap((g) => g.items).filter((i) => !i.system).map((i) => pathKey(i.path)));
}

/** Stores the filter and redraws the tree. The connection is not touched (the options are not saved). */
export async function save(ds: DataSource, value: string | undefined): Promise<void> {
  saveVisibleSchemas(ds.id, value);
  await reloadDataSources();
}
