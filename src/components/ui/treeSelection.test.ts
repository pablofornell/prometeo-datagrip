// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NO_SELECTION, type TreeSelection, dropHidden, orderedIds, rangeSelection, selectAll, singleSelection, toggleSelection } from "./treeSelection";

const order = ["a", "b", "c", "d", "e"];
const ids = (s: TreeSelection): string[] => [...s.ids].sort();

describe("tree selection: plain selection and Ctrl+click", () => {
  it("a plain selection is exactly one row (lead and anchor), nothing for null", () => {
    expect(singleSelection("c")).toEqual({ ids: new Set(["c"]), anchor: "c", lead: "c" });
    expect(singleSelection(null)).toBe(NO_SELECTION);
    expect(ids(NO_SELECTION)).toEqual([]);
  });

  it("Ctrl+click adds a row and makes it the lead and the anchor", () => {
    const s = toggleSelection(toggleSelection(singleSelection("a"), "c"), "e");
    expect(ids(s)).toEqual(["a", "c", "e"]);
    expect(s.lead).toBe("e");
    expect(s.anchor).toBe("e");
  });

  it("Ctrl+click on a selected row removes it and keeps the others", () => {
    const s = toggleSelection({ ids: new Set(["a", "c", "e"]), anchor: "e", lead: "e" }, "c");
    expect(ids(s)).toEqual(["a", "e"]);
    expect(s.lead).toBe("e");
    expect(s.anchor).toBe("e");
  });

  it("removing the lead moves the lead and the anchor to a row still selected", () => {
    const s = toggleSelection({ ids: new Set(["a", "c", "e"]), anchor: "e", lead: "e" }, "e");
    expect(ids(s)).toEqual(["a", "c"]);
    expect(s.lead).toBe("c");
    expect(s.anchor).toBe("c");
  });

  it("removing the last selected row leaves nothing selected", () => {
    expect(toggleSelection(singleSelection("b"), "b")).toBe(NO_SELECTION);
  });
});

describe("tree selection: ranges (Shift+click, Shift+arrows)", () => {
  it("Shift+click selects the rows from the anchor to the clicked row, both included", () => {
    const s = rangeSelection(singleSelection("b"), order, "d");
    expect(ids(s)).toEqual(["b", "c", "d"]);
    expect(s.anchor).toBe("b");
    expect(s.lead).toBe("d");
  });

  it("the range works upwards too, and replaces the previous selection", () => {
    const base = toggleSelection(singleSelection("a"), "e"); // anchor e
    const s = rangeSelection(base, order, "c");
    expect(ids(s)).toEqual(["c", "d", "e"]);
    expect(s.anchor).toBe("e");
  });

  it("Shift+arrows move the lead and keep the anchor: the range grows and shrinks", () => {
    let s = singleSelection("b");
    s = rangeSelection(s, order, "c");
    s = rangeSelection(s, order, "d");
    expect(ids(s)).toEqual(["b", "c", "d"]);
    s = rangeSelection(s, order, "c");
    expect(ids(s)).toEqual(["b", "c"]);
    expect(s.lead).toBe("c");
    expect(s.anchor).toBe("b");
  });

  it("without an anchor among the visible rows the range is a plain selection", () => {
    const s = rangeSelection({ ids: new Set(["zz"]), anchor: "zz", lead: "zz" }, order, "d");
    expect(ids(s)).toEqual(["d"]);
    expect(s.anchor).toBe("d");
  });

  it("a row that is not shown cannot be a range end", () => {
    expect(ids(rangeSelection(singleSelection("b"), order, "nope"))).toEqual(["nope"]);
  });
});

describe("tree selection: select all (Ctrl+A)", () => {
  it("selects every visible row and keeps the lead and the anchor when they are visible", () => {
    const s = selectAll({ ids: new Set(["c"]), anchor: "b", lead: "c" }, order);
    expect(ids(s)).toEqual(order);
    expect(s.lead).toBe("c");
    expect(s.anchor).toBe("b");
  });

  it("moves the lead and the anchor to the first row when they are not visible", () => {
    const s = selectAll({ ids: new Set(["gone"]), anchor: "gone", lead: "gone" }, order);
    expect(s.lead).toBe("a");
    expect(s.anchor).toBe("a");
  });

  it("changes nothing when there are no rows", () => {
    const s = singleSelection("a");
    expect(selectAll(s, [])).toBe(s);
  });
});

describe("tree selection: rows that stop being shown (collapse, filter, refresh)", () => {
  // p has the children a and b; x and y are root rows
  const parent: Record<string, string | undefined> = { a: "p", b: "p", p: undefined, x: undefined, y: undefined };
  const shownAncestorIn = (shown: string[]) => (id: string) => {
    let p = parent[id];
    while (p !== undefined && !shown.includes(p)) p = parent[p];
    return p;
  };

  it("a collapse drops the hidden children and moves the lead to their shown parent, which becomes selected", () => {
    const sel: TreeSelection = { ids: new Set(["a", "b", "y"]), anchor: "a", lead: "b" };
    const shown = ["p", "x", "y"];
    const s = dropHidden(sel, (id) => !shown.includes(id) && id in parent && parent[id] !== undefined, shownAncestorIn(shown));
    expect(ids(s)).toEqual(["p", "y"]);
    expect(s.lead).toBe("p");
    expect(s.anchor).toBe("p");
  });

  it("a row deleted by a refresh leaves the selection; the lead moves to another selected row when no ancestor is shown", () => {
    const sel: TreeSelection = { ids: new Set(["x", "y"]), anchor: "x", lead: "y" };
    const s = dropHidden(sel, (id) => id === "y", () => undefined);
    expect(ids(s)).toEqual(["x"]);
    expect(s.lead).toBe("x");
    expect(s.anchor).toBe("x");
  });

  it("the selection of the rows that are still there is kept as it is", () => {
    const sel: TreeSelection = { ids: new Set(["x", "y"]), anchor: "x", lead: "y" };
    expect(dropHidden(sel, () => false, () => undefined)).toBe(sel);
  });

  it("empties the selection when nothing shown is left", () => {
    const sel: TreeSelection = { ids: new Set(["x"]), anchor: "x", lead: "x" };
    expect(dropHidden(sel, () => true, () => undefined)).toBe(NO_SELECTION);
  });
});

describe("tree selection: order", () => {
  it("lists the selected ids in tree order, the ones that are not shown last", () => {
    const sel: TreeSelection = { ids: new Set(["zz", "d", "a"]), anchor: "a", lead: "d" };
    expect(orderedIds(sel, order)).toEqual(["a", "d", "zz"]);
  });
});
