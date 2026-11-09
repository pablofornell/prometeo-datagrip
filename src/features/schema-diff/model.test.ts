import { describe, expect, it } from "vitest";
import type { CompareRoutine, CompareTable, Driver, SchemaModel } from "../../api/types";
import { type DiffNode, diffSchemas } from "./diff";
import { allIds, changeText, nodeById, objectRefOf, owningObject, routineOf, summaryText } from "./model";

const table = (name: string, columns: string[] = []): CompareTable => ({
  name,
  columns: columns.map((c, i) => ({ name: c, position: i + 1, dataType: "int", nullable: true, default: null, extra: null })),
  primaryKey: null,
  unique: [],
  checks: [],
  foreignKeys: [],
  indexes: [],
});

const model = (driver: Driver, schema: string, tables: CompareTable[], routines: CompareRoutine[] = []): SchemaModel => ({
  driver,
  schema,
  namePrefix: null,
  tables,
  views: [],
  sequences: [],
  routines,
});

const a = model("postgres", "a", [table("emp", ["id", "gone"]), table("only_a")], [{ name: "f", kind: "FUNCTION", signature: "integer", sourceHash: "1" }]);
const b = model("postgres", "b", [table("emp", ["id", "new"])], [{ name: "f", kind: "FUNCTION", signature: "integer", sourceHash: "2" }]);
const root = diffSchemas(a, b);

describe("owningObject", () => {
  it("returns the object itself for an object and its table for a column", () => {
    expect(owningObject(root, "schema/table:emp")?.name).toBe("emp");
    expect(owningObject(root, "schema/table:emp/column:gone")?.name).toBe("emp");
  });

  it("returns undefined for the root and for unknown ids", () => {
    expect(owningObject(root, "schema")).toBeUndefined();
    expect(owningObject(root, "nope")).toBeUndefined();
  });
});

describe("nodeById and allIds", () => {
  it("finds a node anywhere in the tree", () => {
    expect(nodeById(root, "schema/table:emp/column:new")?.status).toBe("onlyB");
    expect(nodeById(root, "schema")).toBe(root);
  });

  it("lists every id below the root", () => {
    const ids = allIds(root);
    expect(ids).toContain("schema/table:emp/column:gone");
    expect(ids).not.toContain("schema");
  });
});

describe("objectRefOf", () => {
  const emp = nodeById(root, "schema/table:emp") as DiffNode;
  it("names the object on the side it exists", () => {
    expect(objectRefOf(emp, "left", "a")).toEqual({ schema: "a", name: "emp", kind: "table" });
    expect(objectRefOf(emp, "right", "b")).toEqual({ schema: "b", name: "emp", kind: "table" });
  });

  it("is null for an object missing on that side", () => {
    const only = nodeById(root, "schema/table:only_a") as DiffNode;
    expect(objectRefOf(only, "right", "b")).toBeNull();
    expect(objectRefOf(only, "left", "a")).not.toBeNull();
  });

  it("gives a routine its kind and PostgreSQL signature", () => {
    const f = nodeById(root, "schema/routine:FUNCTION:f(integer)") as DiffNode;
    const r = routineOf(a.routines, f) as CompareRoutine;
    expect(objectRefOf(f, "left", "a", r)).toEqual({ schema: "a", name: "f", kind: "function", signature: "integer" });
    expect(objectRefOf(f, "left", "a")).toBeNull();
  });

  it("gives a trigger its table", () => {
    const trg: CompareRoutine = { name: "t1", kind: "TRIGGER", signature: "orders", sourceHash: "x" };
    const node = { id: "x", kind: "routine", name: "t1 on orders", status: "same", changes: [], leftName: "t1", rightName: "t1", children: [] } as DiffNode;
    expect(objectRefOf(node, "left", "s", trg)).toEqual({ schema: "s", name: "t1", kind: "trigger", table: "orders" });
  });
});

describe("labels", () => {
  it("summarizes the counts", () => {
    expect(summaryText({ onlyA: 0, onlyB: 0, changed: 0 })).toBe("no differences");
    expect(summaryText({ onlyA: 3, onlyB: 2, changed: 5 })).toBe("3 only in A, 2 only in B, 5 changed");
  });

  it("shows the change lines, or the status of an object without them", () => {
    const emp = nodeById(root, "schema/table:emp/column:new") as DiffNode;
    expect(changeText(emp)).toBe("only in B");
    expect(changeText({ ...emp, status: "same" })).toBe("");
    expect(changeText({ ...emp, status: "changed", changes: ["type int -> text"] })).toBe("type int -> text");
  });
});

describe("model is shared with the tree", () => {
  it("names the routine as the tree does", () => {
    expect(nodeById(root, "schema/routine:FUNCTION:f(integer)")?.name).toBe("f(integer)");
  });
});
