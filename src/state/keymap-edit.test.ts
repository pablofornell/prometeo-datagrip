// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// the dispatcher only needs a few DOM globals: stub them (the suite runs in node)
type Handler = (e: unknown) => void;
const handlers: Handler[] = [];

const key = (k: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}, code = k) => {
  const e = { key: k, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, defaultPrevented: false, target: { tagName: "DIV" }, ...mods, preventDefault() { e.defaultPrevented = true; } };
  for (const h of handlers) h(e);
  return e;
};

let actions: typeof import("./actions");

beforeAll(async () => {
  (globalThis as Record<string, unknown>).window = { addEventListener: (_t: string, h: Handler) => handlers.push(h), removeEventListener: () => {} };
  actions = await import("./actions");
  actions.installKeymap();
});

afterEach(() => actions.setKeymapOverrides({}));

describe("user keymap edits", () => {
  it("an edited action answers to its new shortcut only", () => {
    const run = vi.fn();
    const dispose = actions.registerAction({ id: "t.edit1", title: "Edit 1", shortcut: "Ctrl+Alt+F9", run });
    actions.setKeymapOverrides({ "t.edit1": ["Ctrl+Alt+F10"] });
    key("F9", { ctrlKey: true, altKey: true });
    expect(run).not.toHaveBeenCalled();
    key("F10", { ctrlKey: true, altKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(actions.actionShortcut(actions.getAction("t.edit1"))).toBe("Ctrl+Alt+F10");
    dispose();
  });

  it("removing every shortcut leaves the action without a key", () => {
    const run = vi.fn();
    const dispose = actions.registerAction({ id: "t.edit2", title: "Edit 2", shortcut: "Ctrl+Alt+F9", run });
    actions.setKeymapOverrides({ "t.edit2": [] });
    key("F9", { ctrlKey: true, altKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(actions.actionShortcut(actions.getAction("t.edit2"))).toBeUndefined();
    dispose();
  });

  it("resetting brings the registered shortcut back", () => {
    const run = vi.fn();
    const dispose = actions.registerAction({ id: "t.edit3", title: "Edit 3", shortcut: "Ctrl+Alt+F9", run });
    actions.setKeymapOverrides({ "t.edit3": [] });
    actions.setKeymapOverrides({});
    key("F9", { ctrlKey: true, altKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("a menu-only action is dispatched only for the keys the user added", () => {
    const run = vi.fn();
    const dispose = actions.registerAction({ id: "t.edit4", title: "Edit 4", shortcut: "Ctrl+Alt+F9", menuOnly: true, run });
    key("F9", { ctrlKey: true, altKey: true }); // the focused component handles its own key
    expect(run).not.toHaveBeenCalled();
    actions.setKeymapOverrides({ "t.edit4": ["Ctrl+Alt+F9", "Ctrl+Alt+F11"] });
    key("F9", { ctrlKey: true, altKey: true });
    expect(run).not.toHaveBeenCalled();
    key("F11", { ctrlKey: true, altKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    dispose();
  });
});
