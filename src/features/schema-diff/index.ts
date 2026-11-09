/**
 * Compare Schemas feature: Ctrl+D (and "Compare…" in the menu) on a schema of the explorer picks a second schema and
 * opens a tab with the difference tree, the DDL of the selected object on both sides and "Generate migration script"
 * (a console of the second schema with the SQL that makes it like the first). Registers `schemaDiff.compare` and the
 * `editor.view.schemadiff` slot. The model, diff and migration rules are pure modules covered by vitest.
 */
import type { NodeKind } from "../../api/types";
import { registerActions } from "../../state/actions";
import { registerSlot } from "../../state/slots";
import { getSelectedNode, explorerDataSources } from "../explorer";
import { explorerFocused } from "../explorer/actions";
import { SchemaDiffView } from "./SchemaDiffView";
import { openCompare } from "./run";

/** The schema the explorer has selected, or undefined (the action is for schemas only). */
function selectedSchema(): { dsId: string; schema: string; kind: NodeKind } | undefined {
  const n = getSelectedNode();
  if (!n || n.kind !== "schema") return undefined;
  return { dsId: n.dsId, schema: n.name, kind: n.kind };
}

const dsName = (dsId: string): string => explorerDataSources().find((d) => d.id === dsId)?.name ?? dsId;

const disposeActions = registerActions([
  {
    id: "schemaDiff.compare",
    title: "Compare…",
    shortcut: "Ctrl+D",
    icon: "dg/schema",
    when: explorerFocused,
    enabled: () => selectedSchema() !== undefined,
    run: () => {
      const s = selectedSchema();
      if (s) openCompare({ dsId: s.dsId, schema: s.schema }, dsName);
    },
  },
]);

const disposeSlot = registerSlot("editor.view.schemadiff", SchemaDiffView);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeActions();
    disposeSlot();
  });
}
