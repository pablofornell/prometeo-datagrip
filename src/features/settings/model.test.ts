// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PAGES, filterTree, findNode, firstLeaf, pathOf, visibleRows } from "./model";

const ids = (ns: { id: string; children?: any[] }[]): string[] => ns.flatMap((n) => [n.id, ...(n.children ? ids(n.children) : [])]);

describe("settings page tree", () => {
  it("has no out-of-scope pages", () => {
    const all = ids(PAGES).join(" ");
    expect(all).not.toMatch(/plugin|account|update|sync|ai\b|telemetry/i);
  });

  it("finds a page by its option text and keeps the ancestors", () => {
    const t = filterTree("line numbers");
    expect(ids(t)).toEqual(["editor", "editor.general", "editor.general.appearance"]);
  });

  it("a group title match keeps all its children", () => {
    expect(ids(filterTree("database"))).toEqual(["database", "database.query-execution", "database.data-editor"]);
  });

  it("matches the font page by title and by option", () => {
    expect(ids(filterTree("font"))).toContain("editor.font");
    expect(ids(filterTree("page size"))).toEqual(["database", "database.data-editor"]);
  });

  it("returns nothing for an unknown query and everything for an empty one", () => {
    expect(filterTree("zzzzqq")).toEqual([]);
    expect(filterTree("  ")).toBe(PAGES);
  });

  it("builds visible rows from the expanded set", () => {
    const rows = visibleRows(PAGES, (id) => id === "editor");
    expect(rows.map((r) => r.node.id)).toEqual(["database", "appearance-behavior", "keymap", "editor", "editor.general", "editor.font"]);
    expect(rows.find((r) => r.node.id === "editor.general")?.depth).toBe(1);
  });

  it("path and first leaf", () => {
    expect(pathOf("editor.general.appearance")!.map((n) => n.title)).toEqual(["Editor", "General", "Appearance"]);
    expect(findNode("keymap")?.title).toBe("Keymap");
    expect(firstLeaf(filterTree("theme"))?.id).toBe("appearance");
  });
});
