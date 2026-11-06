/**
 * Reactive schema snapshot cache for completion / "go to object": one `schemaSnapshot` call per
 * data source (and schema), refreshed whenever the explorer refreshes that data source.
 *
 *   const objects = () => schemaSnapshotFor(dsId);   // tracked; [] until loaded
 */
import { type Accessor, type Setter, createSignal } from "solid-js";
import { type SnapshotObject, schemaSnapshot } from "../../api/db";
import { ensureConnected } from "./core";

interface Entry {
  dsId: string;
  schema: string | null;
  get: Accessor<SnapshotObject[] | undefined>;
  set: Setter<SnapshotObject[] | undefined>;
  loading?: Promise<SnapshotObject[]>;
  failedAt?: number;
}

const entries = new Map<string, Entry>();
const RETRY_MS = 5000;

const keyOf = (dsId: string, schema: string | null) => `${dsId}\u0000${schema ?? ""}`;

function entryFor(dsId: string, schema: string | null): Entry {
  const key = keyOf(dsId, schema);
  let e = entries.get(key);
  if (!e) {
    const [get, set] = createSignal<SnapshotObject[] | undefined>(undefined);
    e = { dsId, schema, get, set };
    entries.set(key, e);
  }
  return e;
}

function load(e: Entry): Promise<SnapshotObject[]> {
  if (e.loading) return e.loading;
  e.loading = (async () => {
    try {
      await ensureConnected(e.dsId);
      const data = await schemaSnapshot(e.dsId, e.schema);
      e.failedAt = undefined;
      e.set(data);
      return data;
    } catch {
      e.failedAt = Date.now();
      return e.get() ?? [];
    } finally {
      e.loading = undefined;
    }
  })();
  return e.loading;
}

/**
 * Tables / views of a data source with their columns (all non-system schemas, or just `schema`).
 * Reactive: returns `[]` until the first load finishes, then the loaded list; it is replaced after
 * `db.refresh` on that data source. The first read triggers the load.
 */
export function schemaSnapshotFor(dsId: string, schema?: string | null): SnapshotObject[] {
  const e = entryFor(dsId, schema ?? null);
  const v = e.get();
  if (v === undefined && !e.loading && (e.failedAt === undefined || Date.now() - e.failedAt > RETRY_MS)) void load(e);
  return v ?? [];
}

/** Promise variant: loads (once) and resolves with the snapshot. */
export function loadSchemaSnapshot(dsId: string, schema?: string | null): Promise<SnapshotObject[]> {
  const e = entryFor(dsId, schema ?? null);
  const v = e.get();
  return v !== undefined ? Promise.resolve(v) : load(e);
}

/** Reloads the snapshots of a data source that were requested before (called on refresh). */
export function invalidateSnapshots(dsId: string): void {
  for (const e of entries.values()) if (e.dsId === dsId && e.get() !== undefined) void load(e);
}
