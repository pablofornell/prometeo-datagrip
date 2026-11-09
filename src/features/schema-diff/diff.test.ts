import { describe, expect, it } from "vitest";
import type { CompareColumn, CompareForeignKey, CompareIndex, CompareRoutine, CompareSequence, CompareTable, CompareView, Driver, SchemaModel } from "../../api/types";
import { DEFAULT_DIFF_OPTIONS, type DiffNode, diffSchemas, filterDiff, nameKey, pairBy, routineLabel, summarize, visibleRows } from "./diff";

const col = (name: string, dataType = "varchar(50)", extra: Partial<CompareColumn> = {}): CompareColumn => ({
  name,
  position: 1,
  dataType,
  nullable: true,
  default: null,
  extra: null,
  ...extra,
});

const table = (name: string, p: Partial<CompareTable> = {}): CompareTable => ({
  name,
  columns: [],
  primaryKey: null,
  unique: [],
  checks: [],
  foreignKeys: [],
  indexes: [],
  ...p,
});

const model = (driver: Driver, schema: string, p: Partial<SchemaModel> = {}): SchemaModel => ({
  driver,
  schema,
  namePrefix: null,
  tables: [],
  views: [],
  sequences: [],
  routines: [],
  ...p,
});

const view = (name: string, definition: string, materialized = false): CompareView => ({ name, definition, materialized });

const seq = (name: string, p: Partial<CompareSequence> = {}): CompareSequence => ({
  name,
  incrementBy: "1",
  minValue: "1",
  maxValue: "9999",
  cycle: false,
  cacheSize: "20",
  ...p,
});

const routine = (name: string, sourceHash: string, kind = "FUNCTION", signature = ""): CompareRoutine => ({ name, kind, signature, sourceHash });

const fk = (name: string, p: Partial<CompareForeignKey> = {}): CompareForeignKey => ({
  name,
  columns: ["DEPT_ID"],
  refSchema: null,
  refTable: "DEPT",
  refColumns: ["ID"],
  onDelete: "NO ACTION",
  ...p,
});

const idx = (name: string, p: Partial<CompareIndex> = {}): CompareIndex => ({
  name,
  columns: ["NAME"],
  unique: false,
  method: "normal",
  predicate: null,
  ...p,
});

/** The node of a path given by the names of its kinds and labels, e.g. `["table:EMP", "column:ID"]` (ids are unique). */
const find = (root: DiffNode, id: string): DiffNode | undefined => {
  const walk = (n: DiffNode): DiffNode | undefined => (n.id === id ? n : n.children.map(walk).find((x) => x !== undefined));
  return walk(root);
};

const ids = (root: DiffNode): string[] => {
  const out: string[] = [];
  const walk = (n: DiffNode) => {
    out.push(n.id);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
};

describe("nameKey", () => {
  it("matches MySQL names case-insensitively", () => {
    expect(nameKey("mysql", "Orders")).toBe(nameKey("mysql", "ORDERS"));
  });

  it("matches Oracle unquoted names only: a quoted lower-case name is another name", () => {
    expect(nameKey("oracle", "EMP")).toBe("EMP");
    expect(nameKey("oracle", "emp")).toBe("emp");
    expect(nameKey("oracle", "emp")).not.toBe(nameKey("oracle", "EMP"));
  });

  it("keeps the case on PostgreSQL and SQLite", () => {
    expect(nameKey("postgres", "Orders")).not.toBe(nameKey("postgres", "orders"));
    expect(nameKey("sqlite", "Orders")).toBe("Orders");
  });
});

describe("pairBy", () => {
  it("pairs by key, left items first, then the right-only ones", () => {
    const pairs = pairBy([{ k: "a", v: 1 }, { k: "b", v: 2 }], [{ k: "c", v: 3 }, { k: "a", v: 4 }], (x) => x.k);
    expect(pairs.map((p) => [p.key, p.left?.v ?? null, p.right?.v ?? null])).toEqual([
      ["a", 1, 4],
      ["b", 2, null],
      ["c", null, 3],
    ]);
  });

  it("pairs duplicate keys in order", () => {
    const pairs = pairBy([{ k: "x", v: 1 }, { k: "x", v: 2 }], [{ k: "x", v: 3 }], (x) => x.k);
    expect(pairs.map((p) => [p.left?.v ?? null, p.right?.v ?? null])).toEqual([
      [1, 3],
      [2, null],
    ]);
  });
});

describe("diffSchemas", () => {
  it("reports identical models as the same", () => {
    const a = model("postgres", "s", { tables: [table("t", { columns: [col("id", "integer")] })] });
    const b = model("postgres", "s", { tables: [table("t", { columns: [col("id", "integer")] })] });
    const root = diffSchemas(a, b);
    expect(root.status).toBe("same");
    expect(summarize(root)).toEqual({ onlyA: 0, onlyB: 0, changed: 0 });
  });

  it("marks objects only in A or only in B, with their content on the same side", () => {
    const a = model("postgres", "a", { tables: [table("only_a", { columns: [col("x")] })], views: [view("v_a", "select 1")] });
    const b = model("postgres", "b", { tables: [table("only_b", { columns: [col("y")] })] });
    const root = diffSchemas(a, b);
    expect(find(root, "schema/table:only_a")?.status).toBe("onlyA");
    expect(find(root, "schema/table:only_a/column:x")?.status).toBe("onlyA");
    expect(find(root, "schema/table:only_b")?.status).toBe("onlyB");
    expect(find(root, "schema/table:only_b")?.leftName).toBeNull();
    expect(find(root, "schema/view:v_a")?.status).toBe("onlyA");
    expect(summarize(root)).toEqual({ onlyA: 3, onlyB: 2, changed: 0 });
    expect(root.status).toBe("changed");
  });

  it("reports a column whose type changed, with the two types", () => {
    const a = model("oracle", "A", { tables: [table("EMP", { columns: [col("NAME", "VARCHAR2(50)")] })] });
    const b = model("oracle", "B", { tables: [table("EMP", { columns: [col("NAME", "VARCHAR2(80)")] })] });
    const root = diffSchemas(a, b);
    const column = find(root, "schema/table:EMP/column:NAME");
    expect(column?.status).toBe("changed");
    expect(column?.changes).toEqual(["type VARCHAR2(50) -> VARCHAR2(80)"]);
    expect(find(root, "schema/table:EMP")?.status).toBe("changed");
  });

  it("reports nullability and default changes", () => {
    const a = model("postgres", "s", { tables: [table("t", { columns: [col("c", "integer", { nullable: false, default: "0" })] })] });
    const b = model("postgres", "s", { tables: [table("t", { columns: [col("c", "integer", { nullable: true, default: null })] })] });
    const c = find(diffSchemas(a, b), "schema/table:t/column:c");
    expect(c?.changes).toEqual(["nullable NOT NULL -> NULL", "default 0 -> none"]);
  });

  it("ignores column positions by default and reports them when asked", () => {
    const a = model("postgres", "s", { tables: [table("t", { columns: [col("a"), col("b")] })] });
    const b = model("postgres", "s", { tables: [table("t", { columns: [col("b"), col("a")] })] });
    expect(diffSchemas(a, b).status).toBe("same");
    const strict = diffSchemas(a, b, { ...DEFAULT_DIFF_OPTIONS, ignoreColumnOrder: false });
    expect(find(strict, "schema/table:t/column:a")?.changes).toEqual(["position 1 -> 2"]);
    expect(find(strict, "schema/table:t/column:b")?.changes).toEqual(["position 2 -> 1"]);
  });

  it("does not report a position change when a column is added in the middle", () => {
    const a = model("postgres", "s", { tables: [table("t", { columns: [col("a"), col("b")] })] });
    const b = model("postgres", "s", { tables: [table("t", { columns: [col("a"), col("new"), col("b")] })] });
    const strict = diffSchemas(a, b, { ...DEFAULT_DIFF_OPTIONS, ignoreColumnOrder: false });
    expect(find(strict, "schema/table:t/column:new")?.status).toBe("onlyB");
    expect(find(strict, "schema/table:t/column:b")?.status).toBe("same");
  });

  it("matches Oracle names by the rules of nameKey", () => {
    const a = model("oracle", "A", { tables: [table("EMP")] });
    const b = model("oracle", "B", { tables: [table("emp")] });
    const root = diffSchemas(a, b);
    expect(find(root, "schema/table:EMP")?.status).toBe("onlyA");
    expect(find(root, "schema/table:emp")?.status).toBe("onlyB");
  });

  it("matches MySQL names ignoring case", () => {
    const a = model("mysql", "shop", { tables: [table("Orders", { columns: [col("id", "int")] })] });
    const b = model("mysql", "shop2", { tables: [table("ORDERS", { columns: [col("id", "int")] })] });
    expect(diffSchemas(a, b).status).toBe("same");
  });

  it("pairs constraints by name, or by definition when names are ignored", () => {
    const a = model("postgres", "s", {
      tables: [table("t", { columns: [col("a")], unique: [{ name: "uq_a", columns: ["a"] }] })],
    });
    const b = model("postgres", "s", {
      tables: [table("t", { columns: [col("a")], unique: [{ name: "t_a_key", columns: ["a"] }] })],
    });
    const byName = diffSchemas(a, b);
    expect(find(byName, "schema/table:t/unique:uq_a")?.status).toBe("onlyA");
    expect(find(byName, "schema/table:t/unique:t_a_key")?.status).toBe("onlyB");
    expect(diffSchemas(a, b, { ...DEFAULT_DIFF_OPTIONS, ignoreConstraintNames: true }).status).toBe("same");
  });

  it("reports a foreign key whose delete rule changed", () => {
    const a = model("postgres", "s", { tables: [table("emp", { columns: [col("dept_id")], foreignKeys: [fk("fk_dept", { onDelete: "CASCADE" })] })] });
    const b = model("postgres", "s", { tables: [table("emp", { columns: [col("dept_id")], foreignKeys: [fk("fk_dept")] })] });
    const node = find(diffSchemas(a, b), "schema/table:emp/foreignKey:fk_dept");
    expect(node?.status).toBe("changed");
    expect(node?.changes).toEqual(["definition (DEPT_ID) references DEPT(ID) on delete cascade -> (DEPT_ID) references DEPT(ID)"]);
  });

  it("reports an index that became unique", () => {
    const a = model("oracle", "A", { tables: [table("T", { columns: [col("NAME")], indexes: [idx("IX_NAME", { unique: true })] })] });
    const b = model("oracle", "B", { tables: [table("T", { columns: [col("NAME")], indexes: [idx("IX_NAME")] })] });
    expect(find(diffSchemas(a, b), "schema/table:T/index:IX_NAME")?.status).toBe("changed");
  });

  it("compares views by their text, ignoring white space and a trailing semicolon", () => {
    const a = model("postgres", "s", { views: [view("v", "select  a,\n b from t;")] });
    const same = model("postgres", "s", { views: [view("v", "select a, b from t")] });
    const other = model("postgres", "s", { views: [view("v", "select a from t")] });
    expect(diffSchemas(a, same).status).toBe("same");
    const node = find(diffSchemas(a, other), "schema/view:v");
    expect(node?.status).toBe("changed");
    expect(node?.changes).toEqual(["text differs"]);
  });

  it("reports the sequence options that differ", () => {
    const a = model("oracle", "A", { sequences: [seq("S_ID", { incrementBy: "1", cacheSize: "20" })] });
    const b = model("oracle", "B", { sequences: [seq("S_ID", { incrementBy: "5", cacheSize: "0" })] });
    expect(find(diffSchemas(a, b), "schema/sequence:S_ID")?.changes).toEqual(["increment 1 -> 5", "cache 20 -> 0"]);
  });

  it("compares routines by fingerprint and names overloads and triggers", () => {
    const a = model("postgres", "s", { routines: [routine("f", "aa"), routine("f", "bb", "FUNCTION", "integer"), routine("trg", "cc", "TRIGGER", "orders")] });
    const b = model("postgres", "s", { routines: [routine("f", "ab"), routine("f", "bb", "FUNCTION", "integer"), routine("trg", "cc", "TRIGGER", "orders")] });
    const root = diffSchemas(a, b);
    const changed = root.children.filter((c) => c.kind === "routine" && c.status === "changed");
    expect(changed.map((c) => c.name)).toEqual(["f"]);
    expect(changed[0].changes).toEqual(["source differs"]);
    expect(routineLabel(routine("f", "x", "FUNCTION", "integer"))).toBe("f(integer)");
    expect(routineLabel(routine("trg", "x", "TRIGGER", "orders"))).toBe("trg on orders");
  });

  it("notes a driver change at the root", () => {
    const root = diffSchemas(model("postgres", "s"), model("oracle", "S"));
    expect(root.changes).toEqual(["DBMS postgres -> oracle"]);
    expect(root.status).toBe("changed");
  });

  it("keeps ids unique when two constraints have the same label", () => {
    const u = { name: "", columns: ["a"] };
    const a = model("sqlite", "main", { tables: [table("t", { columns: [col("a")], unique: [u, u] })] });
    const b = model("sqlite", "main", { tables: [table("t", { columns: [col("a")] })] });
    const ids1 = ids(diffSchemas(a, b));
    expect(new Set(ids1).size).toBe(ids1.length);
  });
});

describe("filterDiff and visibleRows", () => {
  const a = model("postgres", "a", {
    tables: [table("t", { columns: [col("keep"), col("gone")] }), table("only_a")],
  });
  const b = model("postgres", "b", {
    tables: [table("t", { columns: [col("keep"), col("new")] }), table("only_b")],
  });
  const root = diffSchemas(a, b);

  it("keeps the ancestors of the matching nodes", () => {
    const left = filterDiff(root, "leftOnly");
    expect(left.children.map((c) => c.name)).toEqual(["only_a", "t"]);
    expect(left.children.find((c) => c.name === "t")?.children.map((c) => c.name)).toEqual(["gone"]);
    const right = filterDiff(root, "rightOnly");
    expect(right.children.map((c) => c.name)).toEqual(["only_b", "t"]);
    expect(right.children.find((c) => c.name === "t")?.children.map((c) => c.name)).toEqual(["new"]);
  });

  it("the differences filter drops the same objects", () => {
    const d = filterDiff(root, "differences");
    expect(d.children.map((c) => c.name).sort()).toEqual(["only_a", "only_b", "t"]);
    expect(filterDiff(root, "all").children.length).toBe(root.children.length);
  });

  it("lists the rows of the expanded nodes only", () => {
    const collapsed = visibleRows(root, new Set());
    expect(collapsed.map((r) => r.node.name)).toEqual(expect.arrayContaining(["t", "only_a", "only_b"]));
    expect(collapsed.some((r) => r.node.name === "gone")).toBe(false);
    const expanded = visibleRows(root, new Set([find(root, "schema/table:t")?.id ?? ""]));
    expect(expanded.find((r) => r.node.name === "gone")?.depth).toBe(1);
  });
});
