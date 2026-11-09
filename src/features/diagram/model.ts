/**
 * Database diagram model: turns the flat schema snapshot (`schemaSnapshot`) into nodes (tables/views with
 * measured sizes) and edges (foreign keys), the pure data the layout and SVG renderer consume.
 *
 * The foreign-key contract is `SnapshotObject.foreignKeys?: SnapshotForeignKey[]` (see crates/dbcore/src/model.rs);
 * the frontend types (`api/types.ts`) may not expose it yet, so we define the shape here and treat a missing
 * field as `[]`. An FK whose target is not part of the selection still marks its columns as keys, but draws no edge.
 */
import type { NodeKind } from "../../api/types";

export interface DiagramForeignKey {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

/** The shape of a snapshot object the diagram needs (structurally what `SnapshotObject` is or will be). */
export interface DiagramInputObject {
  schema: string;
  name: string;
  kind: NodeKind;
  columns: { name: string; typeName: string; isPk: boolean }[];
  foreignKeys?: DiagramForeignKey[];
}

export interface DiagramColumn {
  name: string;
  typeName: string;
  isPk: boolean;
  /** The column is part of a foreign key (drawn with the blue key marker even when the edge is not). */
  isFk: boolean;
}

export interface DiagramNode {
  /** Stable index into the model's node array (also the DOM `data-table-id`). */
  index: number;
  /** `schema.name`: the stable identity dragged positions are keyed by. */
  key: string;
  schema: string;
  name: string;
  kind: NodeKind;
  columns: DiagramColumn[];
  width: number;
  height: number;
}

export interface DiagramEdge {
  id: string;
  /** Referencing table (the FK owner, the "many" side). */
  from: number;
  /** Referenced table (the "one" side). */
  to: number;
  label: string;
  columns: string[];
  refColumns: string[];
  self: boolean;
}

export interface DiagramModel {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export type ColumnsMode = "all" | "keys" | "none";

export interface DiagramOptions {
  columns: ColumnsMode;
  showTypes: boolean;
}

// ---------------------------------------------------------------- geometry metrics (shared with svg.ts)

export const DGM = {
  /** Approximate width of one character of the column/table name (12px monospace). */
  charW: 7.2,
  rowH: 18,
  headerH: 26,
  padX: 10,
  padBottom: 8,
  /** Gap between the name column and the type column. */
  colGap: 14,
  /** Reserved width of the key-icon column (PK/FK marker). */
  iconW: 12,
  minW: 120,
} as const;

/** The columns a node shows for the current mode. */
export function visibleColumns(columns: readonly DiagramColumn[], mode: ColumnsMode): DiagramColumn[] {
  if (mode === "all") return [...columns];
  if (mode === "none") return [];
  return columns.filter((c) => c.isPk || c.isFk);
}

/** Width / height of a table box for the given columns and options (the layout uses these, so they must be deterministic). */
export function measureTable(
  name: string,
  columns: readonly { name: string; typeName: string; isPk: boolean; isFk: boolean }[],
  opts: DiagramOptions,
): { width: number; height: number } {
  const vis = visibleColumns(columns, opts.columns);
  let nameW = name.length;
  let typeW = 0;
  for (const c of vis) nameW = Math.max(nameW, c.name.length);
  if (opts.showTypes) for (const c of vis) typeW = Math.max(typeW, c.typeName.length);
  const width = DGM.padX + DGM.iconW + nameW * DGM.charW + (opts.showTypes ? DGM.colGap + typeW * DGM.charW : 0) + DGM.padX;
  const height = DGM.headerH + vis.length * DGM.rowH + DGM.padBottom;
  return { width: Math.max(DGM.minW, Math.ceil(width)), height: Math.ceil(height) };
}

const keyOf = (schema: string, name: string): string => `${schema}\u0000${name}`;

/**
 * The identity a dragged node position is stored under; stable across snapshot reloads and reorders.
 * NUL cannot occur in a schema or table name, so `a.b` + `c` and `a` + `b.c` stay distinct.
 */
export const nodeKey = (schema: string, name: string): string => `${schema}\u0000${name}`;

/**
 * Keeps only the dragged positions whose table still exists (keyed by `nodeKey`), so a reload does not move a
 * position onto a different table. Returns the same map when nothing was dropped.
 */
export function prunePositions(
  positions: Map<string, { x: number; y: number }>,
  nodes: readonly { key: string }[],
): Map<string, { x: number; y: number }> {
  const keys = new Set(nodes.map((n) => n.key));
  let changed = false;
  const out = new Map<string, { x: number; y: number }>();
  for (const [key, pos] of positions) {
    if (keys.has(key)) out.set(key, pos);
    else changed = true;
  }
  return changed ? out : positions;
}

/**
 * Builds the diagram model. Nodes are sorted by (schema, name) and edges by (from, to, label), so the result is
 * deterministic for a given snapshot regardless of its input order. Missing / duplicate objects are handled safely.
 */
/**
 * The objects of a diagram of some tables: those tables plus their direct FK neighbours (tables they reference and
 * tables that reference them), so each selected table shows its relations. `tables` undefined: every object.
 */
export function subsetOf<T extends DiagramInputObject>(objects: readonly T[], tables: readonly string[] | undefined): T[] {
  if (!tables) return [...objects];
  const picked = new Set(tables.map((t) => t.toLowerCase()));
  const keep = new Set(picked);
  for (const o of objects) {
    const name = o.name.toLowerCase();
    for (const fk of o.foreignKeys ?? []) {
      const ref = fk.refTable.toLowerCase();
      if (picked.has(name)) keep.add(ref);
      if (picked.has(ref)) keep.add(name);
    }
  }
  return objects.filter((o) => keep.has(o.name.toLowerCase()));
}

export function buildDiagram(objects: readonly DiagramInputObject[], opts: DiagramOptions): DiagramModel {
  const sorted = [...objects].sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));

  const byKey = new Map<string, number>();
  const nodes: DiagramNode[] = [];
  for (const o of sorted) {
    const key = keyOf(o.schema, o.name);
    if (byKey.has(key)) continue;
    const index = nodes.length;
    byKey.set(key, index);
    const fkCols = new Set<string>();
    for (const fk of o.foreignKeys ?? []) for (const c of fk.columns) fkCols.add(c);
    const columns: DiagramColumn[] = o.columns.map((c) => ({ name: c.name, typeName: c.typeName, isPk: c.isPk, isFk: fkCols.has(c.name) }));
    const { width, height } = measureTable(o.name, columns, opts);
    nodes.push({ index, key: nodeKey(o.schema, o.name), schema: o.schema, name: o.name, kind: o.kind, columns, width, height });
  }

  const edges: DiagramEdge[] = [];
  let eid = 0;
  for (const o of sorted) {
    const from = byKey.get(keyOf(o.schema, o.name));
    if (from === undefined) continue;
    for (const fk of o.foreignKeys ?? []) {
      const to = byKey.get(keyOf(fk.refSchema, fk.refTable));
      if (to === undefined) continue; // target outside the selection: no edge, columns still marked above
      edges.push({
        id: `e${eid++}`,
        from,
        to,
        label: fk.name,
        columns: [...fk.columns],
        refColumns: [...fk.refColumns],
        self: from === to,
      });
    }
  }
  edges.sort((a, b) => a.from - b.from || a.to - b.to || a.label.localeCompare(b.label));

  return { nodes, edges };
}
