/**
 * Where an explorer node can dump SQL to: a schema (PostgreSQL, Oracle, SQLite), a MySQL database, a SQLite data source
 * (its `main` database), or the tables of one schema. System schemas have no target (`extra.system`, the same flag the
 * explorer hides them by).
 */
import type { Driver } from "../../api/db";
import type { NodeData } from "../explorer/model";

export interface DumpTarget {
  dsId: string;
  /** PostgreSQL / Oracle schema, MySQL database, SQLite database (`main`). */
  schema: string;
  driver: Driver;
  /** Only these tables of `schema` (the selected table nodes); absent: the whole schema. */
  tables?: string[];
}

/** One node of a selection, with the schema / database node it lives in (`owner`, for table nodes). */
export interface DumpSelectionItem {
  data: NodeData;
  owner?: NodeData;
}

/** The target of one node. A table needs its owner (the schema or MySQL database it is in) to be a target. */
export function dumpTargetOf(d: NodeData, owner?: NodeData): DumpTarget | null {
  if (d.extra?.system) return null;
  switch (d.kind) {
    case "schema":
      return { dsId: d.dsId, schema: d.name, driver: d.driver };
    case "database":
      return d.driver === "mysql" ? { dsId: d.dsId, schema: d.name, driver: d.driver } : null;
    case "dataSource":
      return d.driver === "sqlite" ? { dsId: d.dsId, schema: "main", driver: d.driver } : null;
    case "table":
      if (!owner || owner.extra?.system || (owner.kind !== "schema" && owner.kind !== "database")) return null;
      return { dsId: d.dsId, schema: owner.name, driver: d.driver, tables: [d.name] };
    default:
      return null;
  }
}

/**
 * The target of a selection: one node as `dumpTargetOf`, or several table nodes of one schema (their names become
 * `tables`). Mixed schemas, mixed kinds and an empty selection have no target.
 */
export function dumpTargetOfSelection(items: DumpSelectionItem[]): DumpTarget | null {
  if (items.length === 0) return null;
  if (items.length === 1) return dumpTargetOf(items[0].data, items[0].owner);
  if (items.some((i) => i.data.kind !== "table")) return null;
  const targets = items.map((i) => dumpTargetOf(i.data, i.owner));
  const first = targets[0];
  if (!first || targets.some((t) => !t || t.dsId !== first.dsId || t.schema !== first.schema || t.driver !== first.driver)) return null;
  return { ...first, tables: [...new Set(targets.flatMap((t) => t?.tables ?? []))] };
}
