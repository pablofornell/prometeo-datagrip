/** Data source helpers of the console feature. */
import type { DataSource, SnapshotObject } from "../../api/db";
import type { SchemaSnapshot, SchemaTable, TableKind } from "../../components/editor";
import { explorerDataSources } from "../explorer";

export const dsOf = (dsId: string): DataSource | undefined => explorerDataSources().find((d) => d.id === dsId);

const KIND: Record<string, TableKind> = { table: "table", view: "view", materializedView: "matview" };

/** `schemaSnapshot` (flat list) -> the tree the SQL editor uses for completion and highlighting. */
export function toEditorSchema(objects: readonly SnapshotObject[], database?: string, synonyms: readonly { schema: string; name: string; target?: string[] }[] = []): SchemaSnapshot {
  const bySchema = new Map<string, SchemaTable[]>();
  for (const o of objects) {
    let l = bySchema.get(o.schema);
    if (!l) bySchema.set(o.schema, (l = []));
    l.push({
      name: o.name,
      kind: KIND[o.kind] ?? "table",
      columns: o.columns.map((c) => ({ name: c.name, type: c.typeName, key: c.isPk ? ("pk" as const) : undefined })),
    });
  }
  const syn = new Map<string, { name: string; target?: string[] }[]>();
  for (const x of synonyms) {
    if (!bySchema.has(x.schema)) continue;
    let l = syn.get(x.schema);
    if (!l) syn.set(x.schema, (l = []));
    l.push({ name: x.name, target: x.target });
  }
  return { database, schemas: [...bySchema].map(([name, tables]) => ({ name, tables, ...(syn.has(name) ? { synonyms: syn.get(name) } : {}) })) };
}
