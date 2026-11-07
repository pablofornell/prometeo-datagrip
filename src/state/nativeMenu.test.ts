// @vitest-environment node
import { describe, expect, it } from "vitest";
import { allowsNativeMenu, installNativeMenuGuard } from "./nativeMenu";

describe("native context menu guard", () => {
  it("keeps the native menu in text fields only", () => {
    expect(allowsNativeMenu({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(allowsNativeMenu({ tagName: "INPUT" })).toBe(true);
    expect(allowsNativeMenu({ tagName: "INPUT", type: "password" })).toBe(true);
    expect(allowsNativeMenu({ tagName: "TEXTAREA" })).toBe(true);
    expect(allowsNativeMenu({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(allowsNativeMenu({ tagName: "DIV" })).toBe(false); // a dialog backdrop
    expect(allowsNativeMenu({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(allowsNativeMenu({ tagName: "BUTTON" })).toBe(false);
    expect(allowsNativeMenu(null)).toBe(false);
  });

  it("cancels the event outside text fields, in release builds only", () => {
    const handlers: ((e: Event) => void)[] = [];
    const fake = { addEventListener: (_: string, h: (e: Event) => void) => handlers.push(h) } as never;
    const fire = (target: object) => {
      let prevented = false;
      handlers.forEach((h) => h({ target, preventDefault: () => (prevented = true) } as unknown as Event));
      return prevented;
    };
    installNativeMenuGuard(false, fake);
    expect(handlers).toHaveLength(0);
    installNativeMenuGuard(true, fake);
    expect(fire({ tagName: "DIV" })).toBe(true);
    expect(fire({ tagName: "INPUT", type: "text" })).toBe(false);
  });
});
