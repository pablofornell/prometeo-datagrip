// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { closeAllTabs, confirmCloseAll, closeOtherTabs, closeTab, openTab, registerBeforeClose, setPinned, tabs, activeTabId } from "./tabs";

const open = (id: string) => openTab({ id, title: id, kind: "console" });
const ids = () => tabs().map((t) => t.id);

afterEach(async () => {
  for (const t of tabs()) setPinned(t.id, false);
  await closeAllTabs();
});

describe("tab store beforeClose hook", () => {
  it("closes without hooks", async () => {
    open("a");
    open("b");
    expect(await closeTab("b")).toBe(true);
    expect(ids()).toEqual(["a"]);
    expect(activeTabId()).toBe("a");
  });

  it("a veto keeps the tab for closeTab, closeOtherTabs and closeAllTabs", async () => {
    open("a");
    open("b");
    open("c");
    const off = registerBeforeClose((t) => t.id !== "b");
    expect(await closeTab("b")).toBe(false);
    expect(await closeOtherTabs("a")).toBe(false);
    expect(ids()).toContain("b");
    // close all stops at the first veto: "a" is gone, "b" and the tabs after it stay
    expect(await closeAllTabs()).toBe(false);
    expect(ids()).toEqual(["b", "c"]);
    off();
    expect(await closeAllTabs()).toBe(true);
    expect(ids()).toEqual([]);
  });

  it("awaits an async hook and receives the tab", async () => {
    open("a");
    const seen: string[] = [];
    const off = registerBeforeClose(async (t) => {
      await Promise.resolve();
      seen.push(t.title);
      return true;
    });
    expect(await closeTab("a")).toBe(true);
    expect(seen).toEqual(["a"]);
    off();
  });

  it("pinned tabs survive close others / close all", async () => {
    open("a");
    open("b");
    setPinned("a", true);
    await closeAllTabs();
    expect(ids()).toEqual(["a"]);
  });
});

describe("confirmCloseAll (quitting the app)", () => {
  it("asks the hooks about every tab and closes none; a veto stops it", async () => {
    open("a");
    open("b");
    open("c");
    const asked: string[] = [];
    const off = registerBeforeClose((t) => (asked.push(t.id), t.id !== "b"));
    expect(await confirmCloseAll()).toBe(false);
    expect(asked).toEqual(["a", "b"]);
    expect(ids()).toEqual(["a", "b", "c"]);
    off();
    expect(await confirmCloseAll()).toBe(true);
  });
});

