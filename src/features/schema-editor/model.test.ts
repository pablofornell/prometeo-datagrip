// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type TableDef, bindColumnRefs, emptyTable, newColumn, newFk, newIndex, newKey, removeColumnRefs, renameColumnRefs, setColumnRefs } from "./model";

function sample(): TableDef {
  const t = emptyTable("main", "t");
  t.columns = [newColumn({ name: "name", type: "text" }), newColumn({ name: "name2", type: "text" }), newColumn({ name: "city", type: "text" })];
  t.keys = [newKey({ primary: true, columns: ["name"] }), newKey({ columns: ["name2"] })];
  t.fks = [newFk({ columns: ["name2"], refTable: "o", refColumns: ["id"] })];
  t.indexes = [newIndex({ name: "ix", columns: ["name", "lower(city)", "name2"] })];
  bindColumnRefs(t);
  return t;
}

/** What a keystroke does in the Name field. */
const type = (t: TableDef, uid: string, ...names: string[]) => names.forEach((n) => renameColumnRefs(t, uid, n));

describe("column references follow the uid, not the name", () => {
  it("binds the names of the columns and leaves expressions alone", () => {
    const t = sample();
    expect(t.keys[0].columnUids).toEqual([t.columns[0].uid]);
    expect(t.indexes[0].columnUids).toEqual([t.columns[0].uid, "", t.columns[1].uid]);
  });

  it("typing name2 -> name -> name3 leaves the primary key on the other column called name", () => {
    const t = sample();
    const [name, name2] = t.columns;
    type(t, name2.uid, "name", "name3");
    expect(t.columns.map((c) => c.name)).toEqual(["name", "name3", "city"]);
    expect(t.keys[0].columns).toEqual(["name"]);
    expect(t.keys[1].columns).toEqual(["name3"]);
    expect(t.fks[0].columns).toEqual(["name3"]);
    expect(t.indexes[0].columns).toEqual(["name", "lower(city)", "name3"]);
    expect(t.keys[0].columnUids).toEqual([name.uid]);
  });

  it("renaming the first column while the second is called the same for a moment", () => {
    const t = sample();
    const [name] = t.columns;
    type(t, name.uid, "name2", "x"); // duplicate with the second column on the way
    expect(t.keys[0].columns).toEqual(["x"]);
    expect(t.keys[1].columns).toEqual(["name2"]);
    expect(t.indexes[0].columns).toEqual(["x", "lower(city)", "name2"]);
  });

  it("works for entries that were never bound (added in the dialog)", () => {
    const t = sample();
    t.keys.push(newKey({ columns: ["city"] })); // no columnUids
    type(t, t.columns[2].uid, "town");
    expect(t.keys[2].columns).toEqual(["town"]);
  });

  it("removing a column takes only its own entries", () => {
    const t = sample();
    type(t, t.columns[1].uid, "name"); // duplicate names: the second one goes
    removeColumnRefs(t, t.columns[1].uid);
    expect(t.columns.map((c) => c.name)).toEqual(["name", "city"]);
    expect(t.keys.map((k) => k.columns)).toEqual([["name"]]); // the unique key on the removed one is gone
    expect(t.fks).toEqual([]);
    expect(t.indexes[0].columns).toEqual(["name", "lower(city)"]);
  });

  it("picking columns keeps the uids of the entries that stay", () => {
    const t = sample();
    type(t, t.columns[1].uid, "name"); // two columns called name
    const second = t.columns[1].uid;
    t.keys[1].columns = ["name"];
    t.keys[1].columnUids = [second];
    setColumnRefs(t, "keys", t.keys[1].uid, ["name", "city"]);
    expect(t.keys[1].columnUids).toEqual([second, t.columns[2].uid]);
    type(t, second, "other");
    expect(t.keys[1].columns).toEqual(["other", "city"]);
    expect(t.keys[0].columns).toEqual(["name"]);
  });
});
