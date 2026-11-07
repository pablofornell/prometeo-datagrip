// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hasPane, leaf, leaves, oppositePane, removeLeaf, splitIds, splitLeaf } from "./panes";

describe("pane tree", () => {
  it("splits a leaf and keeps reading order", () => {
    const t = splitLeaf(leaf("p1"), "p1", "right", "p2", "s1");
    expect(leaves(t)).toEqual(["p1", "p2"]);
    const t2 = splitLeaf(t, "p2", "down", "p3", "s2");
    expect(leaves(t2)).toEqual(["p1", "p2", "p3"]);
    expect(splitIds(t2)).toEqual(["s1", "s2"]);
    expect(t2).toMatchObject({ kind: "split", dir: "right", b: { kind: "split", dir: "down" } });
  });

  it("splitting an unknown pane changes nothing", () => {
    const t = leaf("p1");
    expect(splitLeaf(t, "zz", "right", "p2", "s1")).toBe(t);
  });

  it("removing a pane promotes its sibling; the last pane cannot be removed", () => {
    const t = splitLeaf(splitLeaf(leaf("p1"), "p1", "right", "p2", "s1"), "p2", "down", "p3", "s2");
    const r = removeLeaf(t, "p2")!;
    expect(leaves(r)).toEqual(["p1", "p3"]);
    expect(splitIds(r)).toEqual(["s1"]);
    expect(removeLeaf(leaf("p1"), "p1")).toBeNull();
    expect(removeLeaf(leaf("p1"), "zz")).toEqual(leaf("p1"));
  });

  it("opposite pane wraps around", () => {
    const t = splitLeaf(leaf("p1"), "p1", "right", "p2", "s1");
    expect(oppositePane(t, "p1")).toBe("p2");
    expect(oppositePane(t, "p2")).toBe("p1");
    expect(oppositePane(leaf("p1"), "p1")).toBeNull();
    expect(hasPane(t, "p2")).toBe(true);
    expect(hasPane(t, "p9")).toBe(false);
  });
});
