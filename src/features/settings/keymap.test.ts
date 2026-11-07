// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type KeymapGroup,
  type KeymapSource,
  addShortcut,
  allActions,
  buildKeymap,
  chordFromEvent,
  filterByShortcut,
  filterKeymap,
  findConflicts,
  groupOf,
  groupPathOf,
  keyCaps,
  normalizeShortcut,
  removeShortcut,
  resetShortcuts,
} from "./keymap-util";

const ev = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("keymap helpers", () => {
  it("splits shortcuts into key caps", () => {
    expect(keyCaps("Ctrl+Alt+Shift+Enter")).toEqual(["Ctrl", "Alt", "Shift", "Enter"]);
    expect(keyCaps("Shift Shift")).toEqual(["Shift", "Shift"]);
    expect(keyCaps("F4")).toEqual(["F4"]);
    expect(keyCaps("Ctrl++")).toEqual(["Ctrl", "+"]);
  });

  it("groups actions into DataGrip's folders", () => {
    expect(groupOf("edit.copy")).toBe("Editor Actions");
    expect(groupPathOf("sql.execute")).toEqual(["Database", "Execution"]);
    expect(groupPathOf("sql.commit")).toEqual(["Database", "Transactions"]);
    expect(groupPathOf("table.addRow")).toEqual(["Database", "Data Editor"]);
    expect(groupPathOf("toolwindow.output")).toEqual(["Tool Windows"]);
    expect(groupPathOf("app.settings")).toEqual(["Main Menu", "File"]);
    expect(groupPathOf("nav.back")).toEqual(["Main Menu", "Navigate"]);
    expect(groupPathOf("zzz.x")).toEqual(["Other"]);
  });

  it("normalizes the shortcut spelling", () => {
    expect(normalizeShortcut("shift+ctrl+f")).toBe("Ctrl+Shift+F");
    expect(normalizeShortcut("Alt+Ctrl+Left")).toBe("Ctrl+Alt+Left");
    expect(normalizeShortcut("Shift Shift")).toBe("Shift Shift");
  });

  it("turns key events into registry shortcuts", () => {
    expect(chordFromEvent(ev("f", "KeyF", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+F");
    expect(chordFromEvent(ev("ArrowLeft", "ArrowLeft", { altKey: true }))).toBe("Alt+Left");
    expect(chordFromEvent(ev("F4", "F4"))).toBe("F4");
    expect(chordFromEvent(ev("5", "Digit5", { altKey: true }))).toBe("Alt+5");
    expect(chordFromEvent(ev(",", "Comma", { ctrlKey: true }))).toBe("Ctrl+Comma");
    expect(chordFromEvent(ev(" ", "Space", { ctrlKey: true }))).toBe("Ctrl+Space");
    expect(chordFromEvent(ev("Shift", "ShiftLeft", { shiftKey: true }))).toBeNull();
  });

  const sources: KeymapSource[] = [
    { id: "sql.execute", title: "Execute…", defaults: ["Ctrl+Enter"] },
    { id: "db.refresh", title: "Refresh", defaults: ["Ctrl+F5"] },
    { id: "app.settings", title: "Settings…", defaults: ["Ctrl+Alt+S"] },
    { id: "edit.copy", title: "Copy", defaults: ["Ctrl+C", "Ctrl+Insert"] },
    { id: "table.submit", title: "Submit", defaults: ["Ctrl+Enter"] },
  ];
  const tree = (o = {}): KeymapGroup[] => buildKeymap(sources, o);

  it("builds the folder tree in DataGrip order", () => {
    const t = tree();
    expect(t.map((g) => g.name)).toEqual(["Editor Actions", "Main Menu", "Database"]);
    expect(t[2].children.map((g) => g.name)).toEqual(["Execution", "Data Editor", "Database Explorer"]);
    expect(t[1].children[0].actions[0].title).toBe("Settings");
  });

  it("filters by title or shortcut and drops empty folders", () => {
    expect(allActions(filterKeymap(tree(), "exec")).map((a) => a.id)).toEqual(["sql.execute"]);
    expect(allActions(filterKeymap(tree(), "ctrl+alt")).map((a) => a.id)).toEqual(["app.settings"]);
    expect(allActions(filterKeymap(tree(), "f5")).map((a) => a.id)).toEqual(["db.refresh"]);
    expect(filterKeymap(tree(), "nomatch")).toEqual([]);
    const t = tree();
    expect(filterKeymap(t, "")).toBe(t);
  });

  it("finds actions by an exact shortcut", () => {
    expect(allActions(filterByShortcut(tree(), "ctrl+enter")).map((a) => a.id)).toEqual(["sql.execute", "table.submit"]);
    expect(allActions(filterByShortcut(tree(), "Ctrl+F"))).toEqual([]);
  });

  it("reports the actions that already use a shortcut", () => {
    expect(findConflicts(tree(), "db.refresh", "Ctrl+Enter").map((a) => a.id)).toEqual(["sql.execute", "table.submit"]);
    expect(findConflicts(tree(), "sql.execute", "Ctrl+Enter").map((a) => a.id)).toEqual(["table.submit"]);
    expect(findConflicts(tree(), "db.refresh", "Ctrl+Shift+Z")).toEqual([]);
  });

  it("adds, removes and resets shortcuts as overrides", () => {
    let o = addShortcut(tree(), {}, "db.refresh", "Ctrl+Shift+R");
    expect(o).toEqual({ "db.refresh": ["Ctrl+F5", "Ctrl+Shift+R"] });
    const t = tree(o);
    expect(allActions(t).find((a) => a.id === "db.refresh")!.modified).toBe(true);
    o = removeShortcut(t, o, "db.refresh", "Ctrl+F5");
    expect(o).toEqual({ "db.refresh": ["Ctrl+Shift+R"] });
    expect(resetShortcuts(o, "db.refresh")).toEqual({});
    // putting the defaults back leaves no override
    o = removeShortcut(tree(o), o, "db.refresh", "Ctrl+Shift+R");
    expect(o).toEqual({ "db.refresh": [] });
    o = addShortcut(tree(o), o, "db.refresh", "Ctrl+F5");
    expect(o).toEqual({});
  });

  it("takes the shortcut from the conflicting actions when asked to", () => {
    const o = addShortcut(tree(), {}, "db.refresh", "Ctrl+Enter", ["sql.execute", "table.submit"]);
    expect(o).toEqual({ "db.refresh": ["Ctrl+F5", "Ctrl+Enter"], "sql.execute": [], "table.submit": [] });
    // "Leave": both keep it
    expect(addShortcut(tree(), {}, "db.refresh", "Ctrl+Enter")).toEqual({ "db.refresh": ["Ctrl+F5", "Ctrl+Enter"] });
  });
});
