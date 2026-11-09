import { describe, expect, it } from "vitest";
import { childPath, containerPaths, flattenJson, isContainer, kindOf, parseJsonText, valueText } from "./json";

const doc = {
  name: "Ada",
  "first name": "A",
  tags: ["x", { deep: true }],
  empty: {},
  n: 1.5,
  nil: null,
};

describe("parseJsonText", () => {
  it("returns the value, or null when the text is not JSON", () => {
    expect(parseJsonText('{"a": [1]}')).toEqual({ value: { a: [1] } });
    expect(parseJsonText("42")).toEqual({ value: 42 });
    expect(parseJsonText("{a: 1}")).toBeNull();
    expect(parseJsonText("")).toBeNull();
  });

  it("tells containers from scalars", () => {
    expect(isContainer({})).toBe(true);
    expect(isContainer([])).toBe(true);
    expect(isContainer(null)).toBe(false);
    expect(isContainer("s")).toBe(false);
    expect(kindOf(null)).toBe("null");
    expect(kindOf([])).toBe("array");
    expect(kindOf({})).toBe("object");
    expect(kindOf(true)).toBe("boolean");
    expect(kindOf(2)).toBe("number");
  });
});

describe("childPath", () => {
  it("uses dots for identifiers, brackets for other names and indexes", () => {
    expect(childPath("$", "name")).toBe("$.name");
    expect(childPath("$.a", "b_2$")).toBe("$.a.b_2$");
    expect(childPath("$", "first name")).toBe('$["first name"]');
    expect(childPath("$", 'say "hi"')).toBe('$["say \\"hi\\""]');
    expect(childPath("$.tags", 0)).toBe("$.tags[0]");
    expect(childPath("$", "2nd")).toBe('$["2nd"]');
  });
});

describe("flattenJson", () => {
  it("shows only the root when nothing is expanded", () => {
    const rows = flattenJson(doc, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "$", depth: 0, label: null, kind: "object", expandable: true, summary: "6 keys" });
  });

  it("lists the members of the expanded containers, depth first", () => {
    const rows = flattenJson(doc, new Set(["$", "$.tags"]));
    expect(rows.map((r) => r.path)).toEqual(["$", "$.name", '$["first name"]', "$.tags", "$.tags[0]", "$.tags[1]", "$.empty", "$.n", "$.nil"]);
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(byPath["$.tags"]).toMatchObject({ depth: 1, label: "tags", summary: "2 items" });
    expect(byPath["$.tags[1]"]).toMatchObject({ depth: 2, label: "1", kind: "object" });
    expect(byPath["$.name"]).toMatchObject({ kind: "string", summary: '"Ada"', expandable: false });
    expect(byPath["$.n"].summary).toBe("1.5");
    expect(byPath["$.nil"].summary).toBe("null");
    expect(byPath["$.empty"].summary).toBe("0 keys");
  });

  it("does not open a node whose path is not in the set", () => {
    const rows = flattenJson(doc, new Set(["$"]));
    expect(rows.map((r) => r.path)).toEqual(["$", "$.name", '$["first name"]', "$.tags", "$.empty", "$.n", "$.nil"]);
  });

  it("cuts long string summaries", () => {
    const rows = flattenJson({ s: "x".repeat(500) }, new Set(["$"]));
    expect(rows[1].summary.length).toBeLessThan(210);
    expect(rows[1].summary.endsWith('…"')).toBe(true);
  });

  it("handles a top-level array and a scalar", () => {
    expect(flattenJson([1], new Set(["$"])).map((r) => [r.path, r.summary])).toEqual([
      ["$", "1 item"],
      ["$[0]", "1"],
    ]);
    expect(flattenJson("s", new Set())).toEqual([expect.objectContaining({ path: "$", expandable: false, summary: '"s"' })]);
  });
});

describe("containerPaths", () => {
  it("lists every container, for Expand All", () => {
    expect(containerPaths(doc)).toEqual(["$", "$.tags", "$.tags[1]", "$.empty"]);
    expect(containerPaths(5)).toEqual([]);
  });
});

describe("valueText", () => {
  it("copies a string as it is and other values as indented JSON", () => {
    expect(valueText("plain")).toBe("plain");
    expect(valueText({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(valueText(null)).toBe("null");
  });
});
