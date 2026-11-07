// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  activeTabId,
  canReopenTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  closeTabsSide,
  cycleTab,
  focusPane,
  focusedPane,
  isSplit,
  moveTabToPane,
  moveToOppositePane,
  openTab,
  paneActiveId,
  paneIds,
  paneOf,
  paneTabs,
  recentTabs,
  reopenClosedTab,
  setPinned,
  setTabLimit,
  splitTab,
  tabs,
  unsplit,
  unsplitAll,
} from "./tabs";

const open = (id: string) => openTab({ id, title: id, kind: "console" });
const ids = (pane: string) => paneTabs(pane).map((t) => t.id);

afterEach(async () => {
  for (const t of tabs()) setPinned(t.id, false);
  await closeAllTabs();
  unsplitAll();
  setTabLimit(10);
});

describe("split editor", () => {
  it("Split Right moves the tab into a new focused pane", () => {
    open("a");
    open("b");
    const first = focusedPane();
    splitTab("b", "right");
    expect(isSplit()).toBe(true);
    expect(paneIds()).toHaveLength(2);
    expect(paneOf("b")).not.toBe(first);
    expect(focusedPane()).toBe(paneOf("b"));
    expect(activeTabId()).toBe("b");
    expect(paneActiveId(first)).toBe("a");
  });

  it("a new tab opens in the focused pane; clicking a pane switches the active tab", () => {
    open("a");
    open("b");
    const first = focusedPane();
    splitTab("b", "down");
    open("c");
    expect(paneOf("c")).toBe(paneOf("b"));
    focusPane(first);
    expect(activeTabId()).toBe("a");
    open("d");
    expect(paneOf("d")).toBe(first);
  });

  it("closing the last tab of a pane removes the split", async () => {
    open("a");
    open("b");
    splitTab("b", "right");
    await closeTab("b");
    expect(isSplit()).toBe(false);
    expect(activeTabId()).toBe("a");
  });

  it("splitting the only tab leaves an empty pane that is dropped when the other one empties", async () => {
    open("a");
    splitTab("a", "right");
    expect(paneIds()).toHaveLength(2);
    expect(ids(paneIds()[0])).toEqual([]);
    await closeTab("a");
    expect(isSplit()).toBe(false);
    expect(activeTabId()).toBeNull();
  });

  it("move to the opposite group; an emptied source pane collapses", () => {
    open("a");
    open("b");
    splitTab("b", "right");
    moveToOppositePane("a");
    expect(isSplit()).toBe(false);
    expect(paneTabs(focusedPane()).map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(activeTabId()).toBe("a");
  });

  it("moveTabToPane inserts before a given tab", () => {
    open("a");
    open("b");
    open("c");
    splitTab("c", "right");
    const right = paneOf("c")!;
    moveTabToPane("a", right, "c");
    expect(ids(right)).toEqual(["a", "c"]);
  });

  it("unsplit joins the focused pane into the other one and keeps the active tab", () => {
    open("a");
    open("b");
    splitTab("b", "right");
    unsplit();
    expect(isSplit()).toBe(false);
    expect(activeTabId()).toBe("b");
    expect(tabs().map((t) => t.pane)).toEqual([focusedPane(), focusedPane()]);
  });

  it("Close Other Tabs and tab cycling stay inside the pane", async () => {
    open("a");
    open("b");
    open("c");
    splitTab("c", "right");
    open("d");
    await closeOtherTabs("d");
    expect(tabs().map((t) => t.id).sort()).toEqual(["a", "b", "d"]);
    focusPane(paneOf("a")!);
    expect(activeTabId()).toBe("b");
    cycleTab(1);
    expect(activeTabId()).toBe("a");
    cycleTab(1);
    expect(activeTabId()).toBe("b");
  });

  it("closes tabs to the left / right", async () => {
    for (const x of ["a", "b", "c", "d"]) open(x);
    await closeTabsSide("b", "right");
    expect(tabs().map((t) => t.id)).toEqual(["a", "b"]);
    await closeTabsSide("b", "left");
    expect(tabs().map((t) => t.id)).toEqual(["b"]);
  });
});

describe("closed tabs and recents", () => {
  it("reopens the last closed tab", async () => {
    open("a");
    open("b");
    await closeTab("b");
    expect(canReopenTab()).toBe(true);
    expect(reopenClosedTab()).toBe(true);
    expect(tabs().map((t) => t.id)).toEqual(["a", "b"]);
    expect(activeTabId()).toBe("b");
  });

  it("skips stale closed tabs", async () => {
    open("a");
    open("b");
    await closeTab("b");
    await closeTab("a");
    expect(reopenClosedTab((t) => t.id !== "a")).toBe(true);
    expect(tabs().map((t) => t.id)).toEqual(["b"]);
  });

  it("lists open tabs by recent activation, the active one first", () => {
    open("a");
    open("b");
    open("c");
    focusPane(focusedPane());
    openTab({ id: "a", title: "a", kind: "console" });
    expect(recentTabs().map((t) => t.id).slice(0, 3)).toEqual(["a", "c", "b"]);
  });
});

describe("tab limit", () => {
  it("closes the least recently used unpinned tab beyond the limit", async () => {
    setTabLimit(3);
    open("a");
    open("b");
    open("c");
    setPinned("a", true);
    open("d");
    open("e");
    await Promise.resolve();
    await Promise.resolve();
    expect(tabs().map((t) => t.id)).toEqual(["a", "c", "d", "e"]);
  });
});
