// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type KeymapGroup, filterKeymap, groupOf, keyCaps } from "./keymap-util";

describe("keymap helpers", () => {
  it("splits shortcuts into key caps", () => {
    expect(keyCaps("Ctrl+Alt+Shift+Enter")).toEqual(["Ctrl", "Alt", "Shift", "Enter"]);
    expect(keyCaps("Shift Shift")).toEqual(["Shift", "Shift"]);
    expect(keyCaps("F4")).toEqual(["F4"]);
    expect(keyCaps("Ctrl++")).toEqual(["Ctrl", "+"]);
  });

  it("groups actions by id prefix", () => {
    expect(groupOf("edit.copy")).toBe("Editor Actions");
    expect(groupOf("sql.execute")).toBe("Database");
    expect(groupOf("toolwindow.output")).toBe("Tool Windows");
    expect(groupOf("app.settings")).toBe("Main Menu");
    expect(groupOf("zzz.x")).toBe("Other");
  });

  const groups: KeymapGroup[] = [
    { name: "Database", actions: [{ id: "sql.execute", title: "Execute", shortcuts: [["Ctrl", "Enter"]] }, { id: "db.refresh", title: "Refresh", shortcuts: [["Ctrl", "F5"]] }] },
    { name: "Main Menu", actions: [{ id: "app.settings", title: "Settings", shortcuts: [["Ctrl", "Alt", "S"]] }] },
  ];

  it("filters by title or shortcut and drops empty groups", () => {
    expect(filterKeymap(groups, "exec")[0].actions.map((a) => a.id)).toEqual(["sql.execute"]);
    expect(filterKeymap(groups, "ctrl+alt")[0].name).toBe("Main Menu");
    expect(filterKeymap(groups, "f5")[0].actions[0].id).toBe("db.refresh");
    expect(filterKeymap(groups, "nomatch")).toEqual([]);
    expect(filterKeymap(groups, "")).toBe(groups);
  });
});
