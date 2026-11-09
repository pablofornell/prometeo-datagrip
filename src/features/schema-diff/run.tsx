/** Compare Schemas: the picker for the second schema, and the compare tab that opens for the pair of schemas. */
import { mountDialog } from "../table/dialogs";
import { openTab } from "../../state/tabs";
import { CompareDialog } from "./CompareDialog";
import type { SchemaRef } from "./model";

/** The compare tab of two schemas (one tab per pair: opening it again focuses it). */
export function openCompareTab(left: SchemaRef, right: SchemaRef, dsName: (dsId: string) => string): void {
  const l = `${left.schema} [${dsName(left.dsId)}]`;
  const r = `${right.schema} [${dsName(right.dsId)}]`;
  openTab({
    id: `schemadiff:${left.dsId}:${left.schema}|${right.dsId}:${right.schema}`,
    kind: "schemadiff",
    title: `Compare ${l} ↔ ${r}`,
    icon: "dg/schema",
    data: { left, right },
  });
}

/** `schemaDiff.compare` (Ctrl+D on a schema): asks for the second schema, then opens the compare tab. */
export function openCompare(left: SchemaRef, dsName: (dsId: string) => string): void {
  mountDialog((close) => (
    <CompareDialog
      left={left}
      onClose={close}
      onPick={(right) => {
        close();
        openCompareTab(left, right, dsName);
      }}
    />
  ));
}
