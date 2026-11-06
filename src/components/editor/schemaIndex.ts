import type { SchemaColumn, SchemaRoutine, SchemaSnapshot } from "./types";

export interface TableIdx {
  schema: string;
  name: string;
  kind: string;
  columns: SchemaColumn[];
  byName: Map<string, SchemaColumn>;
}

export interface SchemaIdx {
  name: string;
  tables: Map<string, TableIdx>;
  list: TableIdx[];
  routines: SchemaRoutine[];
}

/** Case-insensitive lookup structure over a {@link SchemaSnapshot}. */
export class SchemaIndex {
  readonly schemas = new Map<string, SchemaIdx>();
  readonly list: SchemaIdx[] = [];
  readonly database?: string;
  constructor(snapshot: SchemaSnapshot | undefined, readonly defaultSchema?: string) {
    this.database = snapshot?.database;
    for (const s of snapshot?.schemas ?? []) {
      const idx: SchemaIdx = { name: s.name, tables: new Map(), list: [], routines: s.routines ?? [] };
      for (const t of s.tables) {
        const ti: TableIdx = {
          schema: s.name,
          name: t.name,
          kind: t.kind,
          columns: t.columns,
          byName: new Map(t.columns.map((c) => [c.name.toLowerCase(), c])),
        };
        idx.tables.set(t.name.toLowerCase(), ti);
        idx.list.push(ti);
      }
      this.schemas.set(s.name.toLowerCase(), idx);
      this.list.push(idx);
    }
  }

  get empty(): boolean {
    return this.list.length === 0;
  }

  hasSchema(name: string): boolean {
    return this.schemas.has(name.toLowerCase());
  }

  /** `parts` are lower-case, unquoted: `[table]`, `[schema, table]` or `[db, schema, table]`. */
  findTable(parts: string[]): TableIdx | undefined {
    if (parts.length === 0) return undefined;
    const t = parts[parts.length - 1];
    if (parts.length >= 2) return this.schemas.get(parts[parts.length - 2])?.tables.get(t);
    if (this.defaultSchema) {
      const hit = this.schemas.get(this.defaultSchema.toLowerCase())?.tables.get(t);
      if (hit) return hit;
    }
    for (const s of this.list) {
      const hit = s.tables.get(t);
      if (hit) return hit;
    }
    return undefined;
  }
}

const cache = new WeakMap<SchemaSnapshot, Map<string, SchemaIndex>>();

export function schemaIndexFor(snapshot: SchemaSnapshot | undefined, defaultSchema?: string): SchemaIndex {
  if (!snapshot) return new SchemaIndex(undefined, defaultSchema);
  let m = cache.get(snapshot);
  if (!m) cache.set(snapshot, (m = new Map()));
  const key = defaultSchema ?? "";
  let idx = m.get(key);
  if (!idx) m.set(key, (idx = new SchemaIndex(snapshot, defaultSchema)));
  return idx;
}
