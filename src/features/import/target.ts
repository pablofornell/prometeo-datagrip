/** Where an explorer node can import data to: a schema, its tables folder, or a table. */
import type { NodeData } from "../explorer/model";
import type { ImportTarget } from "./run";

export function importTargetOf(d: NodeData): ImportTarget | null {
  switch (d.kind) {
    case "schema":
      return { dsId: d.dsId, schema: d.name };
    case "folder":
      return d.extra.folder === "tables" ? { dsId: d.dsId, schema: d.extra.schema ?? null } : null;
    case "table":
      return { dsId: d.dsId, schema: d.extra.schema ?? null, table: d.name };
    default:
      return null;
  }
}
