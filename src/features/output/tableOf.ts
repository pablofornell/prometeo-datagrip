/** The table a result tab reads: the editable target, else the one table of a plain select (null for joins, aggregates...). */
import type { ObjectRef } from "../../api/types";
import { resultTable } from "../console/title";
import type { OutputHost, ResultTab } from "./model";

export function resultTableRef(tab: ResultTab, host: OutputHost | undefined): ObjectRef | null {
  if (!host) return null;
  const e = tab.edit();
  if (e) return e.table;
  const parts = resultTable(tab.meta, tab.sql, host.driver);
  if (!parts) return null;
  const schema = parts.length > 1 ? parts[0] : host.driver === "sqlite" ? "main" : (host.schema?.() ?? null);
  return { schema, name: parts[parts.length - 1], kind: "table" };
}
