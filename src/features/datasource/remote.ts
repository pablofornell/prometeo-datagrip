/** Helpers that talk to a SAVED data source (database / schema listing for the dialog). */
import { connect, connectedDataSources, disconnect, introspect } from "../../api/db";
import type { TreeNode } from "../../api/db";

/** Connect `id` for the duration of `fn`; disconnect afterwards unless it was already connected. */
export async function withConnection<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const was = (await connectedDataSources().catch(() => [] as string[])).includes(id);
  await connect(id);
  try {
    return await fn();
  } finally {
    if (!was) await disconnect(id).catch(() => undefined);
  }
}

/** Top level nodes of a saved data source: databases (PG), schemas (MySQL / SQLite). */
export const listTopLevel = (id: string): Promise<TreeNode[]> => withConnection(id, () => introspect(id, []));

/** Names of the databases to suggest in the Database combo. */
export async function listDatabases(id: string): Promise<string[]> {
  const nodes = await listTopLevel(id);
  return nodes.filter((n) => n.kind === "database" || n.kind === "schema").map((n) => n.name);
}
