// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPending } from "./pending";
import { NEW_ROW, type GridColumn } from "./types";

const cols: GridColumn[] = [
  { name: "a", typeName: "int4" },
  { name: "b", typeName: "text" },
];
const rows = [
  [1, "x"],
  [1, "x"], // identical to row 0: only the index tells them apart
  [2, null],
];

describe("pending changes", () => {
  it("carry the index of the row in the source (inserts are marked new)", () => {
    const p = createPending();
    p.setEdit(1, 1, "y", "x");
    p.setDeleted(2, true);
    p.addInserted(new Map([[0, 7]]));
    const out = p.toChanges(cols, (i) => rows[i]);
    expect(out.map((c) => [c.kind, c.row])).toEqual([
      ["update", 1],
      ["insert", NEW_ROW],
      ["delete", 2],
    ]);
    expect(out[0].key).toEqual({ a: 1, b: "x" });
  });
});
