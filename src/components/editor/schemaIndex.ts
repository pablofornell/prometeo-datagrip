import type { SchemaColumn, SchemaForeignKey, SchemaRoutine, SchemaSnapshot, SchemaSynonym } from "./types";

export interface TableIdx {
  schema: string;
  name: string;
  kind: string;
  columns: SchemaColumn[];
  byName: Map<string, SchemaColumn>;
  /** Foreign keys of this table (used by JOIN completion). */
  foreignKeys: SchemaForeignKey[];
}

export interface SchemaIdx {
  name: string;
  tables: Map<string, TableIdx>;
  list: TableIdx[];
  routines: SchemaRoutine[];
  /** Synonyms by lower-case name. */
  synonyms: Map<string, SchemaSynonym>;
}

/** Case-insensitive lookup structure over a {@link SchemaSnapshot}. */
export class SchemaIndex {
  readonly schemas = new Map<string, SchemaIdx>();
  readonly list: SchemaIdx[] = [];
  readonly database?: string;
  constructor(snapshot: SchemaSnapshot | undefined, readonly defaultSchema?: string) {
    this.database = snapshot?.database;
    for (const s of snapshot?.schemas ?? []) {
      const idx: SchemaIdx = { name: s.name, tables: new Map(), list: [], routines: s.routines ?? [], synonyms: new Map((s.synonyms ?? []).map((x) => [x.name.toLowerCase(), x])) };
      for (const t of s.tables) {
        const ti: TableIdx = {
          schema: s.name,
          name: t.name,
          kind: t.kind,
          columns: t.columns,
          byName: new Map(t.columns.map((c) => [c.name.toLowerCase(), c])),
          foreignKeys: t.foreignKeys ?? [],
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

  /** `parts` are lower-case, unquoted: `[table]`, `[schema, table]` or `[db, schema, table]`. A synonym resolves to its target. */
  findTable(parts: string[], depth = 0): TableIdx | undefined {
    if (parts.length === 0) return undefined;
    const t = parts[parts.length - 1];
    const direct = this.lookup(parts, (s) => s.tables.get(t));
    if (direct) return direct;
    const syn = this.synonym(parts);
    // a chain of synonyms is followed a few levels (a loop must not hang the inspection)
    return syn?.target && depth < 4 ? this.findTable(syn.target.map((x) => x.toLowerCase()), depth + 1) : undefined;
  }

  /** The synonym `parts` names (its target may be outside the snapshot, or a database link). */
  synonym(parts: string[]): SchemaSynonym | undefined {
    if (parts.length === 0) return undefined;
    const t = parts[parts.length - 1];
    return this.lookup(parts, (s) => s.synonyms.get(t));
  }

  private lookup<T>(parts: string[], get: (s: SchemaIdx) => T | undefined): T | undefined {
    if (parts.length >= 2) {
      const s = this.schemas.get(parts[parts.length - 2]);
      return s && get(s);
    }
    if (this.defaultSchema) {
      const s = this.schemas.get(this.defaultSchema.toLowerCase());
      const hit = s && get(s);
      if (hit) return hit;
    }
    for (const s of this.list) {
      const hit = get(s);
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
