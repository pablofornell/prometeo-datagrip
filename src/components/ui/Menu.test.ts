import { describe, expect, it } from "vitest";
import type { MenuItem } from "./Menu";
import { mnemonicIndex, pruneItems } from "./menu-util";

const sep: MenuItem = { type: "separator" };

describe("mnemonicIndex", () => {
  it("prefers the start of a word, then the first occurrence", () => {
    expect(mnemonicIndex("Close Other Tabs", "O")).toBe(6);
    expect(mnemonicIndex("Comment with Line Comment", "L")).toBe(13);
    expect(mnemonicIndex("Cut", "t")).toBe(2);
    expect(mnemonicIndex("Exit", "q")).toBe(-1);
  });
});

describe("pruneItems", () => {
  it("drops optional items whose action is not registered and tidies separators", () => {
    const out = pruneItems([
      { label: "A", run: () => {} },
      sep,
      { action: "nope.missing", optional: true },
      sep,
      { label: "B", run: () => {} },
      sep,
      { action: "nope.missing2", optional: true },
    ]);
    expect(out.map((i) => i.type ?? (i as { label?: string }).label)).toEqual(["A", "separator", "B"]);
  });

  it("drops a submenu left without items, keeps non-optional unknown actions (shown disabled)", () => {
    const out = pruneItems([
      { label: "Sub", children: [{ action: "nope.x", optional: true }, sep] },
      { action: "nope.y" },
      { label: "Keep", children: [{ label: "Child", run: () => {} }] },
    ]);
    expect(out).toHaveLength(2);
    expect((out[0] as { action?: string }).action).toBe("nope.y");
    expect((out[1] as { label?: string }).label).toBe("Keep");
  });
});
