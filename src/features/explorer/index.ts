/**
 * Database Explorer tool window: data source tree with lazy introspection, toolbar, context menu,
 * speed search, persisted state. Importing this module registers its slots and actions.
 *
 * Module API (for the editor / grid / dialog features):
 *   getSelectedNode()            selected explorer node (kind, dsId, objectRef, ...)
 *   refreshNode(idOrPath)        reload a node: id string, or [dsId, ...backend path]
 *   revealObject(dsId, ref)      expand + select an object (async)
 *   schemaSnapshotFor(dsId, s?)  reactive cached schemaSnapshot (tables + columns) for completion
 */
import { onRefreshed, reloadDataSources, loadSaved, refreshConnectionState, setLoaded, selectedNode, nodeInfo } from "./core";
import { registerSlot } from "../../state/slots";
import { activeTabId } from "../../state/tabs";
import { createRoot, createEffect, on } from "solid-js";
import { registerExplorerActions } from "./actions";
import { ExplorerBody } from "./ExplorerBody";
import { ExplorerHeaderActions, ExplorerToolbar } from "./ExplorerToolbar";
import { invalidateSnapshots } from "./schema";
import "./explorer.css";

export type { ExplorerNodeInfo } from "./model";
export {
  refreshNode,
  revealObject,
  reloadDataSources,
  refreshConnectionState,
  dataSources as explorerDataSources,
  connected as connectedDataSourceIds,
} from "./core";
export { schemaSnapshotFor, loadSchemaSnapshot } from "./schema";
export { openTable as openTableTab, openDdl as openDdlTab, newConsole, jumpToConsole } from "./commands";

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
    } catch {
      /* backend not ready: the list stays empty */
    }
    setLoaded(true);
  })();
  const reload = () => void reloadDataSources().catch(() => {});
  window.addEventListener(DATA_SOURCES_CHANGED, reload);
  window.addEventListener("focus", () => {
    reload();
  });
  createRoot(() => {
    createEffect(on(activeTabId, () => void refreshConnectionState(), { defer: true }));
  });
}

let disposeActions: (() => void) | undefined;
let disposeSlots: (() => void)[] = [];

// The shell registers its action stubs when <App/> renders, right after the feature modules are imported;
// registering on the next task makes the explorer's implementations the latest (winning) ones.
setTimeout(() => {
  disposeActions?.();
  disposeActions = registerExplorerActions();
  disposeSlots.forEach((d) => d());
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
    disposeSlots.forEach((d) => d());
  });
}
