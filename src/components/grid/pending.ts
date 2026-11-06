/** Pending-changes model (uncommitted edits / inserted rows / deleted rows) behind a version signal. */
import { createSignal } from "solid-js";
import { type Cell, type GridChange, type GridColumn, NEW_ROW } from "./types";

export interface InsertedRow {
  /** column index -> value; a missing entry is "unset" (shown as <null>, omitted from the INSERT). */
  values: Map<number, Cell>;
}

export function sameCell(a: Cell, b: Cell): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

export function createPending() {
  const edits = new Map<number, Map<number, Cell>>();
  const deleted = new Set<number>();
  let inserted: InsertedRow[] = [];
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  return {
    /** Tracked: read inside effects/memos to re-run when anything changes. */
    version,
    get insertedCount() {
      version();
      return inserted.length;
    },
    inserted(i: number): InsertedRow | undefined {
      return inserted[i];
    },
    /** Source rows with pending edits (live view). */
    editedRows(): IterableIterator<[number, Map<number, Cell>]> {
      return edits.entries();
    },
    deletedRows(): Iterable<number> {
      return deleted;
    },
    isEmpty(): boolean {
      return inserted.length === 0 && edits.size === 0 && deleted.size === 0;
    },
    hasEdits(): boolean {
      return edits.size > 0;
    },
    edit(src: number, col: number): { value: Cell } | undefined {
      const m = edits.get(src);
      if (!m || !m.has(col)) return undefined;
      return { value: m.get(col) };
    },
    rowEdits(src: number): Map<number, Cell> | undefined {
      return edits.get(src);
    },
    isDeleted(src: number): boolean {
      return deleted.has(src);
    },
    /** Number of pending statements. */
    count(): number {
      return inserted.length + edits.size + deleted.size;
    },
    setEdit(src: number, col: number, value: Cell, original: Cell) {
      let m = edits.get(src);
      if (sameCell(value, original)) {
        if (m) {
          m.delete(col);
          if (m.size === 0) edits.delete(src);
        }
      } else {
        if (!m) edits.set(src, (m = new Map()));
        m.set(col, value);
      }
      bump();
    },
    setInsertedValue(idx: number, col: number, value: Cell) {
      inserted[idx]?.values.set(col, value);
      bump();
    },
    /** New rows go to the top (DataGrip). */
    addInserted(values?: Map<number, Cell>) {
      inserted = [{ values: values ?? new Map() }, ...inserted];
      bump();
    },
    removeInserted(idx: number) {
      inserted = inserted.filter((_, i) => i !== idx);
      bump();
    },
    setDeleted(src: number, on: boolean) {
      if (on) deleted.add(src);
      else deleted.delete(src);
      bump();
    },
    revertRow(src: number) {
      edits.delete(src);
      deleted.delete(src);
      bump();
    },
    revertAll() {
      edits.clear();
      deleted.clear();
      inserted = [];
      bump();
    },
    /** Pending statements in dbcore `RowChange` shape. `original(src)` returns the loaded row. */
    toChanges(columns: GridColumn[], original: (src: number) => Cell[] | undefined): GridChange[] {
      const out: GridChange[] = [];
      const keyCols = columns.some((c) => c.isPk) ? columns.map((c, i) => (c.isPk ? i : -1)).filter((i) => i >= 0) : columns.map((_, i) => i);
      const keyOf = (src: number): Record<string, Cell> => {
        const row = original(src);
        const key: Record<string, Cell> = {};
        if (row) for (const i of keyCols) key[columns[i].name] = row[i] ?? null;
        return key;
      };
      for (const [src, m] of edits) {
        if (deleted.has(src)) continue;
        const values: Record<string, Cell> = {};
        for (const [c, v] of m) values[columns[c].name] = v;
        out.push({ kind: "update", row: src, key: keyOf(src), values });
      }
      for (let i = inserted.length - 1; i >= 0; i--) {
        const values: Record<string, Cell> = {};
        for (const [c, v] of inserted[i].values) values[columns[c].name] = v;
        out.push({ kind: "insert", row: NEW_ROW, key: {}, values });
      }
      for (const src of deleted) out.push({ kind: "delete", row: src, key: keyOf(src), values: {} });
      return out;
    },
  };
}

export type Pending = ReturnType<typeof createPending>;
