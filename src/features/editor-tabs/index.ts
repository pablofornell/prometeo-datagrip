/**
 * Editor tab actions: split editor (Split Right / Split Down / Unsplit / Move to Opposite Group) and Reopen Closed Tab.
 * Ids: `editor.splitRight`, `editor.splitDown`, `editor.unsplit`, `editor.unsplitAll`, `editor.moveToOpposite`, `tab.reopen`.
 * The tab model lives in src/state/tabs.ts; the panes are rendered by src/components/shell/EditorArea.tsx.
 */
import { registerActions } from "../../state/actions";
import { registerSlot } from "../../state/slots";
import {
  activeTabId,
  canReopenTab,
  isSplit,
  moveToOppositePane,
  reopenClosedTab,
  splitTab,
  unsplit,
  unsplitAll,
} from "../../state/tabs";
import { dsOf } from "../console/ds";
import { explorerDataSources } from "../explorer";
import { EmptyEditor } from "./EmptyEditor";

const hasTab = () => !!activeTabId();

/** A closed console of a data source that was deleted meanwhile is not worth reopening. */
const stillValid = (t: { data?: unknown }): boolean => {
  const dsId = (t.data as { dsId?: string } | undefined)?.dsId;
  return !dsId || explorerDataSources().length === 0 || !!dsOf(dsId);
};

const dispose = registerActions([
  { id: "editor.splitRight", title: "Split Right", icon: "split-vertically", enabled: hasTab, run: () => splitTab(activeTabId()!, "right") },
  { id: "editor.splitDown", title: "Split Down", icon: "split-horizontally", enabled: hasTab, run: () => splitTab(activeTabId()!, "down") },
  { id: "editor.unsplit", title: "Unsplit", enabled: isSplit, run: () => unsplit() },
  { id: "editor.unsplitAll", title: "Unsplit All", enabled: isSplit, run: () => unsplitAll() },
  { id: "editor.moveToOpposite", title: "Move Tab to Opposite Group", enabled: () => isSplit() && hasTab(), run: () => moveToOppositePane(activeTabId()!) },
  { id: "tab.reopen", title: "Reopen Closed Tab", shortcut: "Ctrl+Shift+T", enabled: canReopenTab, run: () => void reopenClosedTab(stillValid) },
]);

registerSlot("editor.empty", EmptyEditor);

if (import.meta.hot) import.meta.hot.dispose(dispose);
