/**
 * Database diagram feature: registers the `editor.view.diagram` editor slot and the `diagram.show` action
 * (Ctrl+Alt+Shift+U, guarded to the explorer). The diagram opens on the selected explorer node: a schema draws
 * that schema, a data source / database draws every table, and a table (or one of its children) draws its schema.
 * Model building, layout and SVG rendering are pure modules (model.ts / layout.ts / svg.ts) covered by vitest.
 */
import type { NodeKind } from "../../api/types";
import { registerActions } from "../../state/actions";
import { registerSlot } from "../../state/slots";
import { openTab } from "../../state/tabs";
import { explorerDataSources, getSelectedNode } from "../explorer";
import { explorerFocused } from "../explorer/actions";
import { DiagramView } from "./DiagramView";

/** Kinds whose selection opens a diagram (a schema, the whole data source / database, or a table and its children). */
const DIAGRAM_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "schema",
  "dataSource",
  "database",
  "table",
  "view",
  "materializedView",
  "column",
  "primaryKey",
  "uniqueKey",
  "foreignKey",
  "index",
  "check",
  "trigger",
]);

/** The data source + schema target of the selected node, or null when the selection cannot be drawn. */
function diagramTarget(): { dsId: string; schema: string | null } | null {
  const n = getSelectedNode();
  if (!n || !DIAGRAM_KINDS.has(n.kind)) return null;
  if (n.kind === "schema") return { dsId: n.dsId, schema: n.name };
  if (n.kind === "dataSource" || n.kind === "database") return { dsId: n.dsId, schema: null };
  return { dsId: n.dsId, schema: n.objectRef?.schema ?? null };
}

export const canShowDiagram = (): boolean => diagramTarget() !== null;

const diagramTabId = (dsId: string, schema: string | null): string => `diagram:${dsId}:${schema ?? ""}`;

/** Opens (or focuses) the diagram tab for the selected node. */
export function showDiagram(): void {
  const t = diagramTarget();
  if (!t) return;
  const dsName = explorerDataSources().find((d) => d.id === t.dsId)?.name ?? t.dsId;
  const label = t.schema ? `${t.schema} — Diagram` : "Diagram";
  openTab({
    id: diagramTabId(t.dsId, t.schema),
    kind: "diagram",
    title: `${label} [${dsName}]`,
    icon: "dg/schema",
    data: { dsId: t.dsId, schema: t.schema },
  });
}

const disposeActions = registerActions([
  {
    id: "diagram.show",
    title: "Show Diagram",
    shortcut: "Ctrl+Alt+Shift+U",
    icon: "dg/schema",
    when: explorerFocused,
    enabled: canShowDiagram,
    run: () => showDiagram(),
  },
]);

const disposeSlot = registerSlot("editor.view.diagram", DiagramView);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeActions();
    disposeSlot();
  });
}
