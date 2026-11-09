import type { Cell } from "../types";

/** The full value of a cell, as `fetch_cell` returns it (`text` or `base64`, at most the cap; `len` is the whole size). */
export interface CellFull {
  kind: "text" | "binary";
  text?: string;
  base64?: string;
  len: number;
  truncated: boolean;
}

/**
 * Where the value viewer reads the full value of a table cell: the row's primary key and the column. Only table data
 * has one; query results show the preview the grid holds.
 */
export interface CellSource {
  fetch(key: Record<string, Cell>, column: string): Promise<CellFull>;
}
