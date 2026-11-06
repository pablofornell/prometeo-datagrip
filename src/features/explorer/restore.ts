/** Restored editor tabs whose data source was deleted while the app was closed. */
import { type EditorTab, removeTab, tabs } from "../../state/tabs";

const OBJECT_TABS = new Set<EditorTab["kind"]>(["table", "ddl", "console"]);

/**
 * Closes, without a word, the restored table / DDL / console tabs whose data source no longer exists
 * (a balloon per dead tab would be a storm at startup). Tabs of existing data sources stay: if only the
 * object is gone, the tab itself shows the error. Returns the ids of the closed tabs.
 */
export function closeStaleTabs(existingDataSourceIds: ReadonlySet<string>): string[] {
  const stale = tabs().filter((t) => {
    if (!OBJECT_TABS.has(t.kind)) return false;
    const dsId = (t.data as { dsId?: unknown } | undefined)?.dsId;
    return typeof dsId !== "string" || !existingDataSourceIds.has(dsId);
  });
  for (const t of stale) removeTab(t.id);
  return stale.map((t) => t.id);
}
