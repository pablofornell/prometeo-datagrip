/**
 * Deterministic layered layout for the database diagram.
 *
 * Ranks run parents-first (referenced tables sit to the left of the tables that reference them, reversing the FK
 * direction parent -> child), computed as longest-path ranks with a cycle-safe DFS. Within each rank the tables are
 * ordered by barycenter sweeps to reduce edge crossings. Isolated tables (no edges) are packed into a grid after the
 * connected components. No external layout dependency.
 */
import type { DiagramModel } from "./model";

export interface NodeBox {
  index: number;
  /** `schema.name` of the node (the key dragged positions use). */
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  /** One box per node, sorted by index. */
  nodes: NodeBox[];
  width: number;
  height: number;
}

const HGAP = 48; // between ranks
const VGAP = 24; // between tables in a rank
const COMP_GAP = 72; // between connected components
const GRID_GAP = 48; // between isolated tables in the grid

type Adj = Map<number, Set<number>>;

const add = (m: Adj, k: number, v: number): void => {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
};

/** Referenced tables of `from` (its "parents") and referencing tables of `to` (its "children"). */
function adjacency(model: DiagramModel): { refs: Adj; children: Adj } {
  const refs: Adj = new Map();
  const children: Adj = new Map();
  for (const e of model.edges) {
    add(refs, e.from, e.to);
    add(children, e.to, e.from);
  }
  return { refs, children };
}

/** Longest-path ranks within `indices`, cycle-safe (back edges are ignored). Sources get rank 0. */
function ranks(indices: number[], refs: Adj): Map<number, number> {
  const rank = new Map<number, number>();
  const state = new Map<number, number>(); // 0 unvisited, 1 on stack, 2 done
  const inSet = new Set(indices);
  const dfs = (i: number): number => {
    const st = state.get(i) ?? 0;
    if (st === 2) return rank.get(i)!;
    if (st === 1) return 0; // back edge of a cycle: contributes no depth
    state.set(i, 1);
    let best = 0;
    for (const p of refs.get(i) ?? []) if (inSet.has(p)) best = Math.max(best, dfs(p) + 1);
    state.set(i, 2);
    rank.set(i, best);
    return best;
  };
  for (const i of indices) dfs(i);
  return rank;
}

/** Reorders `layer` so that its nodes sit near the average position of their neighbours in `neighbourLayer`. */
function barycenter(layer: number[], neighbourLayer: number[], adj: Adj): number[] {
  const pos = new Map<number, number>();
  neighbourLayer.forEach((n, i) => pos.set(n, i));
  const scored = layer.map((node, idx) => {
    const nbs = adj.get(node);
    let sum = 0;
    let count = 0;
    if (nbs) for (const nb of nbs) {
      const p = pos.get(nb);
      if (p !== undefined) {
        sum += p;
        count++;
      }
    }
    return { node, bary: count ? sum / count : idx, idx };
  });
  scored.sort((a, b) => a.bary - b.bary || a.idx - b.idx);
  return scored.map((s) => s.node);
}

/** Local coordinates (top-left at 0,0) of one connected component. */
function layoutComponent(indices: number[], model: DiagramModel, refs: Adj, children: Adj): { pos: Map<number, { x: number; y: number }>; width: number; height: number } {
  const rank = ranks(indices, refs);
  const maxRank = indices.reduce((m, i) => Math.max(m, rank.get(i)!), 0);
  const layers: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const i of indices) layers[rank.get(i)!].push(i);
  for (const l of layers) l.sort((a, b) => a - b);

  for (let pass = 0; pass < 4; pass++) {
    if (pass % 2 === 0) {
      for (let r = 1; r < layers.length; r++) layers[r] = barycenter(layers[r], layers[r - 1], refs);
    } else {
      for (let r = layers.length - 2; r >= 0; r--) layers[r] = barycenter(layers[r], layers[r + 1], children);
    }
  }

  const layerW = layers.map((l) => l.reduce((m, i) => Math.max(m, model.nodes[i].width), 0));
  const layerH = layers.map((l) => l.reduce((s, i) => s + model.nodes[i].height, 0) + (l.length - 1) * VGAP);
  const maxH = layerH.reduce((m, h) => Math.max(m, h), 0);

  const pos = new Map<number, { x: number; y: number }>();
  let x = 0;
  for (let r = 0; r < layers.length; r++) {
    let y = (maxH - layerH[r]) / 2;
    for (const i of layers[r]) {
      pos.set(i, { x, y });
      y += model.nodes[i].height + VGAP;
    }
    x += layerW[r] + HGAP;
  }
  return { pos, width: Math.max(0, x - HGAP), height: maxH };
}

export function layoutDiagram(model: DiagramModel): LayoutResult {
  const n = model.nodes.length;
  const { refs, children } = adjacency(model);

  // Union-find over edges -> connected components (tables with at least one edge).
  const parent = new Array(n).fill(0).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const touched = new Set<number>();
  for (const e of model.edges) {
    union(e.from, e.to);
    touched.add(e.from);
    touched.add(e.to);
  }

  const comps = new Map<number, number[]>();
  for (const i of touched) {
    const root = find(i);
    let list = comps.get(root);
    if (!list) comps.set(root, (list = []));
    list.push(i);
  }
  for (const list of comps.values()) list.sort((a, b) => a - b);
  const compKeys = [...comps.keys()].sort((a, b) => comps.get(a)![0] - comps.get(b)![0]);

  const pos: { x: number; y: number }[] = new Array(n).fill(null).map(() => ({ x: 0, y: 0 }));
  let cursorX = 0;
  let maxY = 0;

  for (const key of compKeys) {
    const idx = comps.get(key)!;
    const { pos: local, width, height } = layoutComponent(idx, model, refs, children);
    for (const i of idx) {
      const p = local.get(i)!;
      pos[i] = { x: cursorX + p.x, y: p.y };
    }
    cursorX += width + COMP_GAP;
    maxY = Math.max(maxY, height);
  }

  // Isolated tables: a roughly square grid after the components.
  const isolated = model.nodes.filter((_, i) => !touched.has(i));
  if (isolated.length) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(isolated.length)));
    const cellW = isolated.reduce((m, nd) => Math.max(m, nd.width), 0) + GRID_GAP;
    const cellH = isolated.reduce((m, nd) => Math.max(m, nd.height), 0) + GRID_GAP;
    isolated.forEach((nd, k) => {
      const col = k % cols;
      const row = Math.floor(k / cols);
      pos[nd.index] = { x: cursorX + col * cellW, y: row * cellH };
    });
    cursorX += cols * cellW;
    maxY = Math.max(maxY, Math.ceil(isolated.length / cols) * cellH);
  }

  return {
    nodes: model.nodes.map((nd) => ({ index: nd.index, key: nd.key, x: pos[nd.index].x, y: pos[nd.index].y, width: nd.width, height: nd.height })),
    width: Math.max(0, cursorX - (comps.size ? COMP_GAP : 0) - (isolated.length ? GRID_GAP : 0)),
    height: Math.max(0, maxY),
  };
}
