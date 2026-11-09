/**
 * Database diagram feature: registers the `editor.view.diagram` editor slot and the `diagram.show` action
 * (Ctrl+Alt+Shift+U, guarded to the explorer). The diagram opens on the selected explorer node: a schema draws
 * that schema, a data source / database draws every table, and a table (or one of its children) draws its schema.
 * Several selected tables (or views) of one schema draw just those tables (`tables` in the tab data).
 * Model building, layout and SVG rendering are pure modules (model.ts / layout.ts / svg.ts) covered by vitest.
 */
import type { NodeKind } from "../../api/types";
import { registerActions } from "../../state/actions";
import { registerSlot } from "../../state/slots";
import { openTab } from "../../state/tabs";
import { explorerDataSources, getSelectedNode, selectedNodes } from "../explorer";
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

/** Kinds whose several selected nodes (all in one schema) draw just those tables. */
const TABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["table", "view", "materializedView"]);

/**
 * The data source + schema target of the selection, or null when it cannot be drawn. Several selected nodes are drawn
 * only when they are all tables (or views) of one data source and schema: `tables` names them.
 */
export function diagramTarget(): { dsId: string; schema: string | null; tables?: string[] } | null {
  const many = selectedNodes();
  if (many.length > 1) {
    const [first] = many;
    const schema = first.objectRef?.schema ?? null;
    const sameSchema = many.every((n) => TABLE_KINDS.has(n.kind) && n.dsId === first.dsId && (n.objectRef?.schema ?? null) === schema);
    return sameSchema ? { dsId: first.dsId, schema, tables: many.map((n) => n.name) } : null;
  }
  const n = getSelectedNode();
  if (!n || !DIAGRAM_KINDS.has(n.kind)) return null;
  if (n.kind === "schema") return { dsId: n.dsId, schema: n.name };
  if (n.kind === "dataSource" || n.kind === "database") return { dsId: n.dsId, schema: null };
  return { dsId: n.dsId, schema: n.objectRef?.schema ?? null };
}

export const canShowDiagram = (): boolean => diagramTarget() !== null;

const diagramTabId = (dsId: string, schema: string | null, tables?: string[]): string =>
  `diagram:${dsId}:${schema ?? ""}${tables ? ":" + tables.join(",") : ""}`;

/** Opens (or focuses) the diagram tab for the selected node, or for the selected tables. */
export function showDiagram(): void {
  const t = diagramTarget();
  if (!t) return;
  const dsName = explorerDataSources().find((d) => d.id === t.dsId)?.name ?? t.dsId;
  const what = t.tables ? `${t.tables.length} tables` : t.schema;
  const label = what ? `${what} — Diagram` : "Diagram";
  openTab({
    id: diagramTabId(t.dsId, t.schema, t.tables),
    kind: "diagram",
    title: `${label} [${dsName}]`,
    icon: "dg/schema",
    data: { dsId: t.dsId, schema: t.schema, ...(t.tables ? { tables: t.tables } : {}) },
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
