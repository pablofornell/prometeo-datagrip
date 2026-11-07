// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../ui/Menu";

// the menu structure is pure data: keep the explorer / import feature modules (and their DOM needs) out of it
vi.mock("../../features/explorer/core", () => ({ selectedNode: () => undefined }));
vi.mock("../../features/import/target", () => ({ importTargetOf: () => null }));

let MAIN_MENU: typeof import("./menus").MAIN_MENU;

beforeAll(async () => {
  const doc = { activeElement: null, querySelector: () => null, addEventListener: () => {} };
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = { addEventListener: () => {}, removeEventListener: () => {}, localStorage: undefined, document: doc };
  ({ MAIN_MENU } = await import("./menus"));
});

/** Letters (lower-cased) that share a mnemonic among the items of one menu level. */
function clashes(items: MenuItem[], where: string): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const it of items) {
    if (it.type) continue;
    const label = it.label ?? it.action ?? "?";
    const m = it.mnemonic?.toLowerCase();
    if (m) {
      const prev = seen.get(m);
      if (prev) out.push(`${where}: "${m}" used by ${prev} and ${label}`);
      else seen.set(m, label);
    }
    if (it.children) out.push(...clashes(it.children, `${where} > ${label}`));
  }
  return out;
}

describe("main menu mnemonics", () => {
  it("are unique among the bar entries", () => {
    const letters = MAIN_MENU.map((m) => m.mnemonic.toLowerCase());
    expect(new Set(letters).size).toBe(letters.length);
  });

  it("are unique inside every menu and submenu", () => {
    const all = MAIN_MENU.flatMap((m) => clashes(m.items, m.label));
    expect(all).toEqual([]);
  });
});
