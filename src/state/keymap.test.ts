// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// the keymap and the layout only need a few DOM globals: stub them (the suite runs in node)
type Handler = (e: unknown) => void;
const handlers: Handler[] = [];
let focused: unknown = null;
const stubDom = () => {
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (_t: string, h: Handler) => handlers.push(h),
    removeEventListener: () => {},
    localStorage: undefined,
  };
  (globalThis as Record<string, unknown>).document = {
    get activeElement() {
      return focused;
    },
    querySelector: () => null,
  };
};

const key = (k: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}, code = k) => {
  const e = { key: k, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, defaultPrevented: false, target: { tagName: "DIV" }, ...mods, preventDefault() { e.defaultPrevented = true; } };
  for (const h of handlers) h(e);
  return e;
};

let actions: typeof import("./actions");
let layout: typeof import("./layout");

beforeAll(async () => {
  stubDom();
  actions = await import("./actions");
  layout = await import("./layout");
  actions.installKeymap();
});

afterEach(() => {
  focused = null;
});

describe("shortcut dispatch", () => {
  it("Ctrl+F4 runs the action registered for it", () => {
    const run = vi.fn();
    const dispose = actions.registerAction({ id: "t.close", title: "Close", shortcut: "Ctrl+F4", run });
    const e = key("F4", { ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    dispose();
  });

  it("a key already handled by a focused component is not dispatched again", () => {
    const run = vi.fn();
    const dispose = actions.registerAction({ id: "t.close2", title: "Close", shortcut: "Ctrl+F4", run });
    const e = { key: "F4", code: "F4", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, defaultPrevented: true, target: { tagName: "DIV" } };
    for (const h of handlers) h(e);
    expect(run).not.toHaveBeenCalled();
    dispose();
  });
});

describe("Shift+Escape hides the tool window that has focus", () => {
  const host = (id: string) => ({ closest: (sel: string) => (sel === "[data-toolwindow]" ? { dataset: { toolwindow: id } } : null) });

  it("explorer focused: only the explorer is hidden", () => {
    layout.showToolWindow("explorer", false);
    layout.showToolWindow("output", false);
    focused = host("explorer");
    layout.hideActiveToolWindow();
    expect(layout.layout.visible.explorer).toBe(false);
    expect(layout.layout.visible.output).toBe(true);
  });

  it("output focused: only the output is hidden", () => {
    layout.showToolWindow("explorer", false);
    layout.showToolWindow("output", false);
    focused = host("output");
    layout.hideActiveToolWindow();
    expect(layout.layout.visible.output).toBe(false);
    expect(layout.layout.visible.explorer).toBe(true);
  });

  it("focus outside any tool window: the last active one is hidden", () => {
    layout.showToolWindow("explorer", false);
    layout.showToolWindow("output", false);
    layout.markActiveToolWindow("explorer");
    focused = { closest: () => null };
    layout.hideActiveToolWindow();
    expect(layout.layout.visible.explorer).toBe(false);
    expect(layout.layout.visible.output).toBe(true);
  });
});
