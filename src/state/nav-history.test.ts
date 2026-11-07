// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { canGoBack, canGoForward, goBack, goForward, pushPlace, resetNavHistory } from "./nav-history";
import { activeTabId, closeAllTabs, openTab, removeTab, setPinned, tabs } from "./tabs";

const open = (id: string) => {
  openTab({ id, title: id, kind: "console" });
  pushPlace(id); // the app does this from an effect on the active tab
};

afterEach(async () => {
  for (const t of tabs()) setPinned(t.id, false);
  await closeAllTabs();
  resetNavHistory();
});

describe("navigation history", () => {
  it("goes back and forward through the visited tabs", () => {
    open("a");
    open("b");
    open("c");
    expect(canGoBack()).toBe(true);
    expect(canGoForward()).toBe(false);
    goBack();
    expect(activeTabId()).toBe("b");
    goBack();
    expect(activeTabId()).toBe("a");
    expect(canGoBack()).toBe(false);
    goForward();
    expect(activeTabId()).toBe("b");
    expect(canGoForward()).toBe(true);
  });

  it("a new visit drops the forward part", () => {
    open("a");
    open("b");
    goBack();
    open("c");
    expect(canGoForward()).toBe(false);
    goBack();
    expect(activeTabId()).toBe("a");
  });

  it("skips closed tabs", () => {
    open("a");
    open("b");
    open("c");
    removeTab("b");
    goBack();
    expect(activeTabId()).toBe("a");
  });

  it("ignores repeats of the current place", () => {
    open("a");
    pushPlace("a");
    pushPlace("a");
    expect(canGoBack()).toBe(false);
  });
});
