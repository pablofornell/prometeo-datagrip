// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

let layout: typeof import("./layout");

beforeAll(async () => {
  (globalThis as Record<string, unknown>).window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined };
  (globalThis as Record<string, unknown>).document = { activeElement: null, querySelector: () => null };
  layout = await import("./layout");
});

beforeEach(() => {
  for (const t of layout.TOOL_WINDOWS) layout.hideToolWindow(t.id);
  for (const t of layout.TOOL_WINDOWS) layout.moveToolWindow(t.id, t.anchor);
  layout.setBodyBox(1600, 900);
});

describe("anchors and slot sharing", () => {
  it("showing a window hides the one at the same anchor (Services <-> Database Output)", () => {
    layout.showToolWindow("output", false);
    layout.showToolWindow("services", false);
    expect(layout.layout.visible.output).toBe(false);
    expect(layout.layout.visible.services).toBe(true);
    expect(layout.visibleAt("bottom")).toBe("services");
    layout.showToolWindow("output", false);
    expect(layout.visibleAt("bottom")).toBe("output");
  });

  it("windows at different anchors are shown together", () => {
    layout.showToolWindow("explorer", false);
    layout.showToolWindow("files", false);
    layout.showToolWindow("output", false);
    expect(layout.visibleAt("left")).toBe("explorer");
    expect(layout.visibleAt("right")).toBe("files");
    expect(layout.visibleAt("bottom")).toBe("output");
  });

  it("Move To changes the anchor and replaces the window shown there", () => {
    layout.showToolWindow("explorer", false);
    layout.showToolWindow("files", false);
    layout.moveToolWindow("files", "left");
    expect(layout.anchorOf("files")).toBe("left");
    expect(layout.visibleAt("left")).toBe("files");
    expect(layout.layout.visible.explorer).toBe(false);
    expect(layout.visibleAt("right")).toBeUndefined();
  });

  it("a hidden window can be moved without showing it", () => {
    layout.moveToolWindow("output", "right");
    expect(layout.anchorOf("output")).toBe("right");
    expect(layout.layout.visible.output).toBe(false);
  });
});

describe("sizes", () => {
  it("are kept per window and clamped to what fits", () => {
    layout.showToolWindow("explorer", false);
    layout.setToolWindowSize("explorer", 300);
    layout.setToolWindowSize("files", 400);
    expect(layout.effectiveSize("left")).toBe(300);
    layout.setToolWindowSize("explorer", 5000);
    expect(layout.effectiveSize("left")).toBe(layout.maxSizeOf("left"));
    expect(layout.effectiveSize("right")).toBe(0);
    layout.showToolWindow("files", false);
    expect(layout.effectiveSize("right")).toBe(400);
    // the right dock keeps its width, the left one gives way
    expect(layout.effectiveSize("left")).toBeLessThanOrEqual(1600 - 13 - 240 - 5 - 400 - 5);
  });

  it("Resize stretches the edge facing the editor and ignores the other directions", () => {
    layout.showToolWindow("explorer", false);
    layout.setToolWindowSize("explorer", 300);
    layout.stretchToolWindow("explorer", "right");
    expect(layout.effectiveSize("left")).toBeGreaterThan(300);
    const grown = layout.effectiveSize("left");
    layout.stretchToolWindow("explorer", "top");
    expect(layout.effectiveSize("left")).toBe(grown);
    layout.stretchToolWindow("explorer", "left");
    expect(layout.effectiveSize("left")).toBe(300);
    expect(layout.stretchDirsOf("output")).toEqual(["top", "bottom"]);
  });
});

describe("Hide All Windows", () => {
  it("restores the set that was visible", () => {
    layout.showToolWindow("explorer", false);
    layout.showToolWindow("output", false);
    layout.hideAllToolWindows();
    expect(layout.TOOL_WINDOWS.some((t) => layout.layout.visible[t.id])).toBe(false);
    layout.hideAllToolWindows();
    expect(layout.layout.visible.explorer).toBe(true);
    expect(layout.layout.visible.output).toBe(true);
    expect(layout.layout.visible.files).toBe(false);
  });

  it("forgets the set when the user opens a window in between", () => {
    layout.showToolWindow("explorer", false);
    layout.showToolWindow("output", false);
    layout.hideAllToolWindows();
    layout.showToolWindow("files", false);
    layout.hideAllToolWindows();
    expect(layout.TOOL_WINDOWS.some((t) => layout.layout.visible[t.id])).toBe(false);
    layout.hideAllToolWindows();
    expect(layout.layout.visible.files).toBe(true);
    expect(layout.layout.visible.explorer).toBe(false);
  });

  it("falls back to the Explorer when nothing was remembered", () => {
    layout.hideAllToolWindows();
    expect(layout.layout.visible.explorer).toBe(true);
  });
});

describe("maximize and pins", () => {
  it("maximize toggles only for a visible window and clears when it is hidden", () => {
    layout.toggleMaximizeToolWindow("output");
    expect(layout.maximizedToolWindow()).toBeNull();
    layout.showToolWindow("output", false);
    layout.toggleMaximizeToolWindow("output");
    expect(layout.maximizedToolWindow()).toBe("output");
    layout.hideToolWindow("output");
    expect(layout.maximizedToolWindow()).toBeNull();
  });

  it("showing or focusing another window leaves the maximized state (the maximized one hides the rest)", () => {
    layout.showToolWindow("explorer", false);
    layout.showToolWindow("output", false);
    layout.toggleMaximizeToolWindow("output");
    expect(layout.maximizedToolWindow()).toBe("output");
    layout.showToolWindow("explorer", false);
    expect(layout.maximizedToolWindow()).toBeNull();
    layout.toggleMaximizeToolWindow("output");
    layout.focusToolWindow("explorer");
    expect(layout.maximizedToolWindow()).toBeNull();
    // the maximized window itself keeps its state when it is shown / focused again
    layout.toggleMaximizeToolWindow("output");
    layout.showToolWindow("output", false);
    layout.focusToolWindow("output");
    expect(layout.maximizedToolWindow()).toBe("output");
  });

  it("maximizing moves the focus into the window", () => {
    layout.showToolWindow("output", false);
    layout.toggleMaximizeToolWindow("output");
    expect(layout.activeToolWindow()).toBe("output");
  });

  it("pinned windows make the toolbar, in DataGrip's order", () => {
    expect(layout.toolbarWindows().map((t) => t.id)).toEqual(["explorer", "output", "files"]);
    layout.setToolWindowPinned("services", true);
    expect(layout.toolbarWindows().map((t) => t.id)).toContain("services");
    layout.setToolWindowPinned("services", false);
  });

  it("lists every tool window for the View menu", () => {
    expect(layout.toolWindowMenuItems().map((i) => (i as { action: string }).action)).toEqual([
      "toolwindow.explorer",
      "toolwindow.files",
      "toolwindow.output",
      "toolwindow.notifications",
      "toolwindow.services",
      "toolwindow.run",
    ]);
  });
});
