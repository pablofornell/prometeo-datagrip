/**
 * Database Explorer tool window: data source tree with lazy introspection, toolbar, context menu,
 * speed search, persisted state. Importing this module registers its slots and actions.
 *
 * Module API (for the editor / grid / dialog features):
 *   getSelectedNode()            selected explorer node (kind, dsId, objectRef, ...)
 *   refreshNode(idOrPath)        reload a node: id string, or [dsId, ...backend path]
 *   revealObject(dsId, ref)      expand + select an object (async)
 *   schemaSnapshotFor(dsId, s?)  reactive cached schemaSnapshot (tables + columns) for completion
 *   ensureConnected(dsId)        connects a data source if needed (tree spinner, connection state); idempotent
 */
import { crumbsOfTab, onRefreshed, reloadDataSources, loadSaved, loaded, refreshConnectionState, setLoaded, selectedNode, nodeInfo, dataSources } from "./core";
import { closeStaleTabs } from "./restore";
import { registerSlot } from "../../state/slots";
import { activeTab, activeTabId, tabs, updateTab } from "../../state/tabs";
import { setEditorPath, setFocusArea } from "../../state/status";
import { createRoot, createEffect, on } from "solid-js";
import { onDataSourcesCreated } from "../datasource/events";
import { bootstrapNewDataSources } from "./bootstrap";
import { registerExplorerActions } from "./actions";
import { ExplorerBody } from "./ExplorerBody";
import { ExplorerHeaderActions, ExplorerToolbar } from "./ExplorerToolbar";
import { completionExtrasFor, invalidateSnapshots } from "./schema";
import { setCompletionExtrasProvider } from "../../components/editor";
import "./explorer.css";

export type { ExplorerNodeInfo } from "./model";
export {
  refreshNode,
  revealObject,
  reloadDataSources,
  refreshConnectionState,
  dataSources as explorerDataSources,
  connected as connectedDataSourceIds,
  ensureConnected,
} from "./core";
export { schemaSnapshotFor, loadSchemaSnapshot, synonymsFor } from "./schema";
export { openTable as openTableTab, openDdl as openDdlTab, openDdlRef, openTableRef, newConsole, jumpToConsole, openConsoleTab } from "./commands";
export { showQuickDocRef, type QuickDocTarget } from "./QuickDoc";
export { autoSyncAfter } from "./autosync";

/** The selected explorer node, or undefined when nothing (or a placeholder row) is selected. */
export function getSelectedNode(): import("./model").ExplorerNodeInfo | undefined {
  return nodeInfo(selectedNode());
}

/** Dispatched on `window` by the Data Sources dialog after it saved / deleted a data source. */
export const DATA_SOURCES_CHANGED = "prometeo:datasources-changed";

let started = false;
function start(): void {
  if (started) return;
  started = true;
  onRefreshed(invalidateSnapshots);
  void (async () => {
    await loadSaved();
    try {
      await reloadDataSources();
      // restored tabs of deleted data sources close silently (only with a list we actually got)
      closeStaleTabs(new Set(dataSources().map((d) => d.id)));
    } catch {
      /* backend not ready: the list stays empty */
    }
    setLoaded(true);
  })();
  const reload = () => void reloadDataSources().catch(() => {});
  window.addEventListener(DATA_SOURCES_CHANGED, reload);
  // OK in the Data Sources dialog with new data sources: a console each, connect + introspect in the background
  onDataSourcesCreated((ids) => void bootstrapNewDataSources(ids));
  window.addEventListener("focus", () => {
    reload();
  });
  createRoot(() => {
    createEffect(on(activeTabId, () => void refreshConnectionState(), { defer: true }));
    // editor tabs carry the color of their data source (production / dev cue)
    createEffect(() => {
      if (!loaded()) return;
      const list = dataSources();
      for (const t of tabs()) {
        const dsId = (t.data as { dsId?: string } | undefined)?.dsId;
        if (!dsId) continue;
        const color = list.find((d) => d.id === dsId)?.color ?? undefined;
        if (t.color !== color) updateTab(t.id, { color });
      }
    });
    // the breadcrumb follows the active tab (table / DDL tabs; consoles push their own path) and the data source's name
    createEffect(
      on(
        () => [activeTabId(), dataSources().map((d) => d.name).join("\u0000")],
        ([tabId], prev) => {
          const path = crumbsOfTab(activeTab());
          if (path) setEditorPath(path);
          // a tab was activated: the editor is the context now (DataGrip's breadcrumbs follow the focused component)
          if (tabId && tabId !== prev?.[0]) setFocusArea("editor");
        },
        { defer: true },
      ),
    );
  });
}

let disposeActions: (() => void) | undefined;
let disposeSlots: (() => void)[] = [];
let disposeExtras: (() => void) | undefined;

// The shell registers its action stubs when <App/> renders, right after the feature modules are imported;
// registering on the next task makes the explorer's implementations the latest (winning) ones.
setTimeout(() => {
  disposeActions?.();
  disposeActions = registerExplorerActions();
  disposeSlots.forEach((d) => d());
  disposeExtras?.();
  disposeExtras = setCompletionExtrasProvider((q) => completionExtrasFor(q.sourceLabel));
  disposeSlots = [
    registerSlot("explorer.body", ExplorerBody),
    registerSlot("explorer.toolbar", ExplorerToolbar),
    registerSlot("explorer.headerActions", ExplorerHeaderActions),
  ];
  start();
}, 0);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeActions?.();
    disposeExtras?.();
    disposeSlots.forEach((d) => d());
  });
}
