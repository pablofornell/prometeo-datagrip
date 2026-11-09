/**
 * Reactive schema snapshot cache for completion / "go to object": one `schemaSnapshot` call per
 * data source (and schema), refreshed whenever the explorer refreshes that data source.
 *
 *   const objects = () => schemaSnapshotFor(dsId);   // tracked; [] until loaded
 */
import { type Accessor, type Setter, createSignal } from "solid-js";
import { type SnapshotObject, type TreeNode, schemaSnapshot } from "../../api/db";
import type { CompletionExtras } from "../../components/editor";
import { dataSources, dsOf, ensureConnected, rawIntrospect, showSystemObjects } from "./core";

interface Entry {
  dsId: string;
  schema: string | null;
  get: Accessor<SnapshotObject[] | undefined>;
  set: Setter<SnapshotObject[] | undefined>;
  /** Last load failure message, for views that offer a retry (undefined once a load succeeds). */
  error: Accessor<string | undefined>;
  setError: Setter<string | undefined>;
  loading?: Promise<SnapshotObject[]>;
  failedAt?: number;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : "The schema could not be loaded.");

const entries = new Map<string, Entry>();
const RETRY_MS = 5000;

const keyOf = (dsId: string, schema: string | null) => `${dsId}\u0000${schema ?? ""}`;

function entryFor(dsId: string, schema: string | null): Entry {
  const key = keyOf(dsId, schema);
  let e = entries.get(key);
  if (!e) {
    const [get, set] = createSignal<SnapshotObject[] | undefined>(undefined);
    const [getError, setError] = createSignal<string | undefined>(undefined);
    e = { dsId, schema, get, set, error: getError, setError };
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
      e.setError(undefined);
      e.set(data);
      return data;
    } catch (err) {
      e.failedAt = Date.now();
      e.setError(errorText(err));
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

/**
 * Reactive last load error of the snapshot (undefined while never failed / after a success). Additive: existing
 * callers keep using `schemaSnapshotFor`; views that can offer a retry read this.
 */
export function schemaSnapshotErrorFor(dsId: string, schema?: string | null): string | undefined {
  return entryFor(dsId, schema ?? null).error();
}

/** Reloads the snapshots of a data source that were requested before (called on refresh). */
export function invalidateSnapshots(dsId: string): void {
  for (const e of entries.values()) if (e.dsId === dsId && e.get() !== undefined) void load(e);
  const x = extrasEntries.get(dsId);
  if (x && x.get() !== undefined) void loadExtras(dsId);
  const y = synonymEntries.get(dsId);
  if (y && y.get() !== undefined) void loadSynonyms(dsId);
}

// ---------------------------------------------------------------- Oracle synonyms (the editor resolves them like their targets)

/** A synonym of `schema`; `target` is `[schema, name]` (none for a database link). */
export interface SnapshotSynonym {
  schema: string;
  name: string;
  target?: string[];
}

interface SynonymEntry {
  get: Accessor<SnapshotSynonym[] | undefined>;
  set: Setter<SnapshotSynonym[] | undefined>;
  loading?: Promise<void>;
  failedAt?: number;
}
const synonymEntries = new Map<string, SynonymEntry>();

async function buildSynonyms(dsId: string): Promise<SnapshotSynonym[]> {
  await ensureConnected(dsId);
  const wanted = new Set((await loadSchemaSnapshot(dsId)).map((o) => o.schema));
  const out: SnapshotSynonym[] = [];
  await Promise.all(
    (await rawIntrospect(dsId, [], true).catch(() => []))
      .filter((n) => n.kind === "schema" && wanted.has(n.name))
      .map(async (schema) => {
        const folder = (await rawIntrospect(dsId, schema.path, false).catch(() => [])).find((f) => f.extra.folder === "synonyms");
        if (!folder) return;
        for (const n of await rawIntrospect(dsId, folder.path, false).catch(() => [])) {
          const name = n.extra.targetName as string | undefined;
          const owner = (n.extra.targetSchema as string | null | undefined) ?? schema.name;
          out.push({ schema: schema.name, name: n.name, target: n.extra.dbLink || !name ? undefined : [owner, name] });
        }
      }),
  );
  return out;
}

function loadSynonyms(dsId: string): Promise<void> {
  let e = synonymEntries.get(dsId);
  if (!e) {
    const [get, set] = createSignal<SnapshotSynonym[] | undefined>(undefined);
    synonymEntries.set(dsId, (e = { get, set }));
  }
  if (e.loading) return e.loading;
  const entry = e;
  entry.loading = buildSynonyms(dsId)
    .then((x) => {
      entry.failedAt = undefined;
      entry.set(x);
    })
    .catch(() => {
      entry.failedAt = Date.now();
    })
    .finally(() => {
      entry.loading = undefined;
    });
  return entry.loading;
}

/** Synonyms of an Oracle data source's schemas, for the editor's inspections. Reactive; `[]` until loaded (other DBMSs: always `[]`). */
export function synonymsFor(dsId: string): SnapshotSynonym[] {
  if (dsOf(dsId)?.driver !== "oracle") return [];
  let e = synonymEntries.get(dsId);
  if (!e) {
    void loadSynonyms(dsId);
    e = synonymEntries.get(dsId)!;
  }
  const v = e.get();
  if (v === undefined && !e.loading && e.failedAt !== undefined && Date.now() - e.failedAt > RETRY_MS) void loadSynonyms(dsId);
  return v ?? [];
}

// ---------------------------------------------------------------- sequences and routines (completion extras)

interface ExtrasEntry {
  get: Accessor<CompletionExtras | undefined>;
  set: Setter<CompletionExtras | undefined>;
  loading?: Promise<void>;
  failedAt?: number;
}
const extrasEntries = new Map<string, ExtrasEntry>();

/** `(cid integer, name text): numeric` -> args `cid integer`, returns `numeric`. */
export function splitSignature(hint: string | null | undefined): { args: string; returns?: string } {
  const m = /^\((.*)\)\s*(?::\s*(.*))?$/s.exec((hint ?? "").trim());
  return m ? { args: m[1].trim(), returns: m[2]?.trim() || undefined } : { args: "" };
}

const kids = (dsId: string, path: string[], showSystem: boolean): Promise<TreeNode[]> => rawIntrospect(dsId, path, showSystem).catch(() => []);

async function buildExtras(dsId: string): Promise<CompletionExtras> {
  await ensureConnected(dsId);
  const driver = dsOf(dsId)?.driver;
  // the schemas the table snapshot knows (non-system, like the tree shows them)
  const wanted = new Set((await loadSchemaSnapshot(dsId)).map((o) => o.schema));
  let level = await kids(dsId, [], driver === "postgres" ? showSystemObjects() : true);
  if (driver === "postgres") {
    const dbs = level.filter((n) => n.kind === "database" && (n.hasChildren || n.extra.current));
    level = (await Promise.all(dbs.map((d) => kids(dsId, d.path, true)))).flat();
  }
  const out: CompletionExtras = { schemas: [] };
  await Promise.all(
    level
      .filter((n) => n.kind === "schema" && wanted.has(n.name))
      .map(async (schema) => {
        const folders = await kids(dsId, schema.path, showSystemObjects());
        const seq = folders.find((f) => f.extra.folder === "sequences");
        const rou = folders.find((f) => f.extra.folder === "routines");
        const [seqs, routs] = await Promise.all([
          seq ? kids(dsId, seq.path, showSystemObjects()) : Promise.resolve([]),
          rou ? kids(dsId, rou.path, showSystemObjects()) : Promise.resolve([]),
        ]);
        const routines = routs
          .filter((r) => r.kind === "function" || r.kind === "procedure" || r.kind === "routine")
          .map((r) => ({ name: r.name, ...splitSignature(r.hint) }));
        if (seqs.length || routines.length) out.schemas.push({ name: schema.name, sequences: seqs.map((s) => s.name), routines });
      }),
  );
  out.schemas.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function loadExtras(dsId: string): Promise<void> {
  let e = extrasEntries.get(dsId);
  if (!e) {
    const [get, set] = createSignal<CompletionExtras | undefined>(undefined);
    extrasEntries.set(dsId, (e = { get, set }));
  }
  if (e.loading) return e.loading;
  const entry = e;
  entry.loading = buildExtras(dsId)
    .then((x) => {
      entry.failedAt = undefined;
      entry.set(x);
    })
    .catch(() => {
      entry.failedAt = Date.now();
    })
    .finally(() => {
      entry.loading = undefined;
    });
  return entry.loading;
}

/**
 * Sequences and routines (with their signature) of the data source named `sourceLabel`, for the SQL editor's
 * completion (registered as the editor's extras provider). Reactive; the first read starts the load.
 */
export function completionExtrasFor(sourceLabel: string | undefined): CompletionExtras | undefined {
  const ds = dataSources().find((d) => d.name === sourceLabel);
  if (!ds) return undefined;
  let e = extrasEntries.get(ds.id);
  if (!e) {
    void loadExtras(ds.id);
    e = extrasEntries.get(ds.id)!;
  }
  const v = e.get();
  if (v === undefined && !e.loading && e.failedAt !== undefined && Date.now() - e.failedAt > RETRY_MS) void loadExtras(ds.id);
  return v;
}
