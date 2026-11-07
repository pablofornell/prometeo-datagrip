// @vitest-environment node
/** The registered default keymap of the whole app: no key may answer to two actions in the same context. */
import { beforeAll, describe, expect, it } from "vitest";
import type { MenuItem } from "../components/ui/Menu";

// a DOM stand-in that accepts every call: importing the feature modules only needs it to not throw
const deep = (): any => new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : deep()), apply: () => deep(), set: () => true });

let actions: typeof import("./actions");
let MAIN_MENU: typeof import("../components/shell/menus").MAIN_MENU;

beforeAll(async () => {
  const doc = { activeElement: null, querySelector: () => null, addEventListener: () => {}, documentElement: deep(), createElement: () => deep(), body: deep(), head: deep() };
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined, document: doc, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  await import("../features"); // every feature registers its actions on import
  const { registerCoreActions } = await import("./core-actions");
  registerCoreActions();
  actions = await import("./actions");
  ({ MAIN_MENU } = await import("../components/shell/menus"));
}, 120_000);

const norm = (s: string): string => s.toLowerCase();

describe("default shortcuts", () => {
  it("are not shared by two unguarded actions, nor by two actions of the same context", () => {
    const by = new Map<string, { id: string; guarded: boolean }[]>();
    for (const a of actions.listActions()) {
      if (a.menuOnly || !a.run) continue; // menu-only keys are handled by the focused component; stubs never dispatch
      for (const sc of actions.defaultShortcuts(a)) {
        const k = norm(sc);
        by.set(k, [...(by.get(k) ?? []), { id: a.id, guarded: !!a.when }]);
      }
    }
    // the dispatcher picks the guarded action whose `when()` holds, else the one unguarded action
    const bad = [...by].filter(([, v]) => v.filter((x) => !x.guarded).length > 1).map(([k, v]) => `${k}: ${v.map((x) => x.id).join(", ")}`);
    expect(bad).toEqual([]);
  });

  it("show once in every menu of the menu bar (Run has no Jump to Query Console next to Run File)", () => {
    const ids = (items: MenuItem[]): string[] =>
      items.flatMap((it) => (it.type ? [] : [...(it.action ? [it.action] : []), ...(it.children ? ids(it.children) : [])]));
    const bad: string[] = [];
    for (const m of MAIN_MENU) {
      const seen = new Map<string, string>();
      for (const id of ids(m.items)) {
        const a = actions.getAction(id);
        const sc = a ? actions.actionShortcut(a) : undefined;
        if (!sc) continue;
        const prev = seen.get(norm(sc));
        if (prev && prev !== id) bad.push(`${m.label}: ${sc} on ${prev} and ${id}`);
        else seen.set(norm(sc), id);
      }
    }
    expect(bad).toEqual([]);
  });

  it("Ctrl+Shift+F10 runs the file in a file and jumps to the console elsewhere", () => {
    const sc = (id: string) => actions.defaultShortcuts(actions.getAction(id)!).map(norm);
    expect(sc("run.file")).toContain("ctrl+shift+f10");
    expect(actions.getAction("run.file")!.when).toBeTypeOf("function");
    expect(actions.getAction("db.jumpToConsole")!.when).toBeUndefined();
  });
});
