/**
 * What happens after OK in the Data Sources dialog created data sources (DataGrip): each one gets a query
 * console tab (the last one is active) and is connected and introspected in the background, with the status bar
 * progress and the tree spinner meanwhile.
 */
import { createConsole } from "../../api/db";
import { notify } from "../../components/ui";
import { beginIntrospection, dsName, dsOf, markFullIntrospection, nodes, reloadDataSources, startLoad } from "./core";
import { openConsoleTab } from "./commands";
import { loadSchemaSnapshot } from "./schema";

/** Connects, lists the top level and warms the completion data of one data source; progress goes to its task. */
async function introspectNew(dsId: string): Promise<void> {
  const root = nodes.get(dsId);
  if (!root) return;
  markFullIntrospection(dsId, 0);
  const { task, end } = beginIntrospection(dsId);
  try {
    task.progress(0.1);
    await startLoad(root); // connects; failures are reported there (error row + balloon)
    task.progress(0.6);
    if (root.children?.[0]?.data.kind === "error") return;
    await loadSchemaSnapshot(dsId);
    task.progress(1);
  } finally {
    end();
  }
}

export async function bootstrapNewDataSources(ids: string[]): Promise<void> {
  try {
    await reloadDataSources();
  } catch {
    return;
  }
  const created = ids.filter((id) => dsOf(id));
  for (const id of created) {
    try {
      openConsoleTab(id, await createConsole(id));
    } catch (e) {
      notify({ kind: "error", title: `Cannot create a query console for ${dsName(id)}`, body: String((e as Error)?.message ?? e) });
    }
  }
  await Promise.all(created.map((id) => introspectNew(id)));
}
