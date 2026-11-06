/** Opening the table data / DDL tabs of an object (same ids, titles and payload as the explorer's). */
import type { NodeKind, ObjectRef } from "../../api/types";
import { openTab } from "../../state/tabs";
import { dsInfo, loadDataSources } from "./ds";

export interface ObjectTabData {
  dsId: string;
  objectRef: ObjectRef;
}

const suffix = (ref: ObjectRef) => `${ref.schema ?? ""}.${ref.name}${ref.signature != null ? `(${ref.signature})` : ""}`;

export function iconOfKind(kind: NodeKind): string {
  if (kind === "view") return "data-schema";
  if (kind === "materializedView") return "dg/materialized-view";
  if (kind === "sequence") return "dg/sequence";
  if (kind === "function") return "dg/function";
  if (kind === "procedure") return "dg/procedure";
  if (kind === "routine") return "dg/routine";
  return "dg/table";
}

export const tableTabId = (dsId: string, ref: ObjectRef) => `table:${dsId}:${suffix(ref)}`;
export const ddlTabId = (dsId: string, ref: ObjectRef) => `ddl:${dsId}:${suffix(ref)}`;

export async function openTableTab(dsId: string, ref: ObjectRef): Promise<void> {
  await loadDataSources();
  openTab({
    id: tableTabId(dsId, ref),
    kind: "table",
    title: `${ref.name} [${dsInfo(dsId)?.name ?? dsId}]`,
    icon: iconOfKind(ref.kind),
    data: { dsId, objectRef: ref } satisfies ObjectTabData,
  });
}

export async function openDdlTab(dsId: string, ref: ObjectRef): Promise<void> {
  await loadDataSources();
  openTab({
    id: ddlTabId(dsId, ref),
    kind: "ddl",
    title: `${ref.name} (DDL) [${dsInfo(dsId)?.name ?? dsId}]`,
    icon: iconOfKind(ref.kind),
    data: { dsId, objectRef: ref } satisfies ObjectTabData,
  });
}
