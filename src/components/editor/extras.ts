/**
 * Completion extras: sequences and routines of a data source, supplied by a provider that the host registers
 * (the explorer does). The editor merges them into its `schema` prop, so hosts that only pass the table /
 * view snapshot still get sequences, routines with their signature and the built-ins in completion.
 */
import { createSignal } from "solid-js";
import type { Dialect } from "./split";
import type { SchemaNode, SchemaRoutine, SchemaSnapshot } from "./types";

export interface CompletionExtras {
  schemas: { name: string; sequences?: string[]; routines?: SchemaRoutine[] }[];
}

export interface ExtrasQuery {
  dialect: Dialect;
  /** `sourceLabel` of the editor (the data source name). */
  sourceLabel?: string;
}

export type ExtrasProvider = (q: ExtrasQuery) => CompletionExtras | undefined;

let provider: ExtrasProvider | undefined;
const [version, setVersion] = createSignal(0);

/** Registers (or clears) the provider; the editors re-read it. Returns the disposer. */
export function setCompletionExtrasProvider(p: ExtrasProvider | undefined): () => void {
  provider = p;
  setVersion((v) => v + 1);
  return () => {
    if (provider === p) {
      provider = undefined;
      setVersion((v) => v + 1);
    }
  };
}

/** Reactive: tracks the provider and whatever signals it reads. */
export function completionExtras(q: ExtrasQuery): CompletionExtras | undefined {
  version();
  return provider?.(q);
}

const merged = new WeakMap<SchemaSnapshot, WeakMap<CompletionExtras, SchemaSnapshot>>();

/** The snapshot plus the extras (same object back when there is nothing to add: the schema index is cached on it). */
export function withExtras(snapshot: SchemaSnapshot | undefined, extras: CompletionExtras | undefined): SchemaSnapshot | undefined {
  if (!snapshot || !extras || !extras.schemas.length) return snapshot;
  let m = merged.get(snapshot);
  if (!m) merged.set(snapshot, (m = new WeakMap()));
  let out = m.get(extras);
  if (out) return out;
  const schemas: SchemaNode[] = snapshot.schemas.map((s) => ({ ...s, tables: [...s.tables], routines: [...(s.routines ?? [])] }));
  for (const x of extras.schemas) {
    let s = schemas.find((n) => n.name.toLowerCase() === x.name.toLowerCase());
    if (!s) schemas.push((s = { name: x.name, tables: [], routines: [] }));
    for (const q of x.sequences ?? []) if (!s.tables.some((t) => t.name === q)) s.tables.push({ name: q, kind: "sequence", columns: [] });
    for (const r of x.routines ?? []) s.routines!.push(r);
  }
  m.set(extras, (out = { ...snapshot, schemas }));
  return out;
}
