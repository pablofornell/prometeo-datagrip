import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  type SchemaItem,
  checkState,
  filterOrDefault,
  groupState,
  isVisible,
  parseFilter,
  parsePatternText,
  patternText,
  patternVerdict,
  serializeFilter,
  toggleGroup,
  toggleItem,
} from "./schemaModel";

const it_ = (name: string, o: Partial<SchemaItem> = {}): SchemaItem => ({ path: ["db", name], name, system: false, isDefault: false, ...o });
const items = [it_("information_schema", { system: true }), it_("inventory"), it_("pg_catalog", { system: true }), it_("public", { isDefault: true }), it_("sales")];

describe("stored text", () => {
  it("absent = the default view: every non-system schema checked", () => {
    const f = filterOrDefault(undefined, items);
    expect(f.paths.map((p) => p[1])).toEqual(["inventory", "public", "sales"]);
    expect(serializeFilter(f, items)).toBeUndefined();
  });
  it("a plain choice stays the original JSON array", () => {
    const f = { ...EMPTY_FILTER, paths: [["db", "sales"]] };
    expect(serializeFilter(f, items)).toBe('[["db","sales"]]');
    expect(parseFilter('[["db","sales"]]')).toEqual(f);
  });
  it("patterns, the default row and object filter use the object form and round-trip", () => {
    const f = { paths: [["db", "sales"]], patterns: ["inv*", "!temp*"], useDefault: true, objects: "tmp_*" };
    const raw = serializeFilter(f, items)!;
    expect(JSON.parse(raw)).toEqual({ paths: [["db", "sales"]], patterns: ["inv*", "!temp*"], default: true, objects: "tmp_*" });
    expect(parseFilter(raw)).toEqual(f);
  });
  it("malformed text is the default view", () => {
    expect(parseFilter("{nope")).toBeNull();
    expect(parseFilter('{"paths": 3}')).toBeNull();
  });
});

describe("patterns", () => {
  it("globs are case-insensitive; a negative one wins", () => {
    expect(patternVerdict("Sales_2024", ["sales*"])).toBe("yes");
    expect(patternVerdict("temp1", ["*", "!temp*"])).toBe("no");
    expect(patternVerdict("x", ["y*"])).toBe("none");
    expect(patternVerdict("a.b", ["a.b"])).toBe("yes");
  });
});

describe("check state", () => {
  const f = { ...EMPTY_FILTER, paths: [["db", "sales"]], useDefault: true, patterns: ["inv*"] };
  it("explicit and pattern matches are checked, the default schema alone is mixed", () => {
    expect(checkState(f, items[4])).toBe("on");
    expect(checkState(f, items[1])).toBe("on");
    expect(checkState(f, items[3])).toBe("mixed");
    expect(checkState(f, items[0])).toBe("off");
    expect(isVisible(f, items[3])).toBe(true);
  });
  it("unchecking a pattern match hides it by name; checking it again undoes that", () => {
    const off = toggleItem(f, items[1], false);
    expect(off.patterns).toContain("!inventory");
    expect(isVisible(off, items[1])).toBe(false);
    const on = toggleItem(off, items[1], true);
    expect(on.patterns).not.toContain("!inventory");
    expect(isVisible(on, items[1])).toBe(true);
  });
  it("unchecking a schema chosen one by one removes it", () => {
    const off = toggleItem(f, items[4], false);
    expect(isVisible(off, items[4])).toBe(false);
  });
  it("group rows", () => {
    expect(groupState(EMPTY_FILTER, items)).toBe("off");
    expect(groupState(toggleGroup(EMPTY_FILTER, items, true), items)).toBe("on");
    expect(groupState({ ...EMPTY_FILTER, paths: [["db", "sales"]] }, items)).toBe("mixed");
    expect(groupState(toggleGroup(f, items, false), items)).toBe("off");
  });
});

describe("the Schema pattern field", () => {
  it("shows the chosen schemas then the patterns, and reads them back", () => {
    const f = { ...EMPTY_FILTER, paths: [["db", "public"], ["db", "sales"]], patterns: ["!temp*"] };
    const text = patternText(f, items);
    expect(text).toBe("db:public,db:sales,!temp*");
    const back = parsePatternText(text, items, f);
    expect(back.paths).toEqual(f.paths);
    expect(back.patterns).toEqual(["!temp*"]);
  });
  it("names without the database and globs work too", () => {
    const f = parsePatternText("sales, inv*", items, EMPTY_FILTER);
    expect(f.paths).toEqual([["db", "sales"]]);
    expect(f.patterns).toEqual(["inv*"]);
  });
});
