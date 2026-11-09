/**
 * Find Usages: what a request is about (the caret's name in a SQL editor, the explorer selection, the table or DDL tab
 * in front), and what a result opens (its DDL, or the console / file of a text line).
 */
import { EditorView } from "@codemirror/view";
import type { NodeKind, ObjectRef, Usage } from "../../api/db";
import { type NavTarget, resolveAt } from "../../components/editor/navigate";
import { notify } from "../../components/ui";
import { activeTab, updateTab } from "../../state/tabs";
import { revealLine } from "../console/registry";
import { getSelectedNode, openConsoleTab, openDdlRef } from "../explorer";
import { fileTabId, openFileTab } from "../files/docs";
import type { TextHit } from "./model";

/** The object to find the usages of, and the data source it lives in. */
export interface UsageRequest {
  dsId: string;
  object: ObjectRef;
}

/** The object of a name the SQL editor resolved (a column is the column of its table). */
export function objectOfTarget(t: NavTarget): ObjectRef {
  if (t.column) return { schema: t.schema, name: t.column.name, kind: "column", table: t.name };
  return { schema: t.schema, name: t.name, kind: t.kind as NodeKind };
}

const dsIdOfTab = (): string | undefined => (activeTab()?.data as { dsId?: string } | undefined)?.dsId;

/** The request of the focused component: a name at the SQL caret, the explorer selection, or the object of the tab in front. */
export function requestFromFocus(): UsageRequest | undefined {
  const el = document.activeElement as HTMLElement | null;
  const editor = el?.closest?.(".cm-editor") as HTMLElement | null | undefined;
  if (editor) {
    const view = EditorView.findFromDOM(editor);
    const dsId = dsIdOfTab();
    const t = view ? resolveAt(view.state, view.state.selection.main.head) : null;
    return t && dsId ? { dsId, object: objectOfTarget(t) } : undefined;
  }
  if (el?.closest?.(".dg-explorer-tree")) {
    const n = getSelectedNode();
    return n?.objectRef ? { dsId: n.dsId, object: n.objectRef } : undefined;
  }
  const data = activeTab()?.data as { dsId?: string; objectRef?: ObjectRef } | undefined;
  return data?.dsId && data.objectRef ? { dsId: data.dsId, object: data.objectRef } : undefined;
}

export const isUsageRequest = (x: unknown): x is UsageRequest =>
  typeof x === "object" && x !== null && typeof (x as UsageRequest).dsId === "string" && typeof (x as UsageRequest).object === "object";

/** The DDL reference of a usage: a foreign key opens the table that holds it, a routine body opens its routine. */
export function refOfUsage(u: Usage): ObjectRef {
  switch (u.kind) {
    case "foreignKey":
      return { schema: u.schema, name: u.name, kind: "table" };
    case "trigger":
      return { schema: u.schema, name: u.name, kind: "trigger", table: u.table };
    case "index":
      return { schema: u.schema, name: u.name, kind: "index", table: u.table };
    case "packageBody":
      return { schema: u.schema, name: u.name, kind: "package" };
    default:
      return { schema: u.schema, name: u.name, kind: u.kind as NodeKind };
  }
}

/**
 * Opens the DDL of the object that uses the searched one. A usage with a line opens the DDL at that line: the line and
 * its text go into the data of the DDL tab (DdlView reveals them).
 */
export async function openUsage(dsId: string, u: Usage): Promise<void> {
  const ref = refOfUsage(u);
  await openDdlRef(dsId, ref);
  // openDdlRef has focused the DDL tab it opened: nothing to do when the tab in front is not that one (a failed connection)
  const tab = activeTab();
  if (!u.line || !tab || tab.kind !== "ddl") return;
  const data = tab.data as { objectRef?: ObjectRef; line?: number } | undefined;
  const at = data?.objectRef;
  if (!at || at.name !== ref.name || (at.schema ?? null) !== (ref.schema ?? null)) return;
  updateTab(tab.id, { data: { ...data, line: u.line, lineText: u.detail } });
}

/** Opens the console or the file a text line comes from, with the caret on that line. */
export function openHit(h: TextHit): void {
  let tabId: string | null = null;
  if (h.console) {
    if (!h.dsId) return;
    openConsoleTab(h.dsId, h.name);
    tabId = activeTab()?.id ?? null;
  } else if (h.path) {
    openFileTab({ path: h.path, name: h.name }, !!h.scratch);
    tabId = fileTabId(h.path);
  }
  if (tabId) revealLine(tabId, h.line);
}

/** Alt+F7 and the menus: the request given, else the one of the focus; a notice when there is none. */
export function startFindUsages(ctx?: unknown): void {
  const req = isUsageRequest(ctx) ? ctx : requestFromFocus();
  if (!req) {
    notify({
      kind: "info",
      title: "Find Usages",
      body: "Put the caret on the name of a table, view, routine, column or synonym, or select such an object in the Database Explorer.",
    });
    return;
  }
  void import("./FindPopup").then((m) => m.openFindPopup(req));
}
