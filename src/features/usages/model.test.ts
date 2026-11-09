// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Usage } from "../../api/db";
import { groupUsages, searchSqlText, type SqlText, wordPattern } from "./model";

const u = (kind: Usage["kind"], schema: string, name: string, line: number | null = null, detail = `references ${name}`): Usage => ({
  schema,
  name,
  kind,
  detail,
  line,
  table: null,
});

describe("groupUsages", () => {
  it("groups by kind in DataGrip's order and leaves out empty kinds", () => {
    const groups = groupUsages([
      u("trigger", "shop", "orders_audit"),
      u("function", "shop", "total_of", 3),
      u("view", "shop", "v_orders"),
      u("function", "shop", "count_orders", 1),
    ]);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Views", 1],
      ["Functions", 2],
      ["Triggers", 1],
    ]);
  });

  it("sorts the items of a group by schema, name and line; objects without a line come first among their name", () => {
    const groups = groupUsages([
      u("function", "shop", "b", 9),
      u("function", "app", "z"),
      u("function", "shop", "b", 2),
      u("function", "shop", "a"),
    ]);
    expect(groups[0].items.map((i) => `${i.schema}.${i.name}:${i.line ?? "-"}`)).toEqual(["app.z:-", "shop.a:-", "shop.b:2", "shop.b:9"]);
  });

  it("keeps the foreign keys and the synonyms in their own groups and does not modify its input", () => {
    const input = [u("synonym", "pub", "syn_orders"), u("foreignKey", "shop", "order_items", null, "fk (order_id) references orders (id)")];
    const before = JSON.stringify(input);
    const groups = groupUsages(input);
    expect(groups.map((g) => g.label)).toEqual(["Foreign Keys", "Synonyms"]);
    expect(groups[0].items[0].detail).toBe("fk (order_id) references orders (id)");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("returns no groups for no usages", () => {
    expect(groupUsages([])).toEqual([]);
  });
});

describe("wordPattern", () => {
  it("matches the name as a whole word, case-insensitively", () => {
    const re = wordPattern("invoices");
    expect(re.test("select * from INVOICES")).toBe(true);
    expect(re.test("from shop.invoices i")).toBe(true);
    expect(re.test('from "invoices"')).toBe(true);
    expect(re.test("from invoices_archive")).toBe(false);
    expect(re.test("from my_invoices")).toBe(false);
    expect(re.test("from invoices2")).toBe(false);
    expect(re.test("from éinvoices")).toBe(false);
  });

  it("escapes regular expression characters in the name", () => {
    expect(wordPattern("a.b").test("select a.b from t")).toBe(true);
    expect(wordPattern("a.b").test("select axb from t")).toBe(false);
    expect(wordPattern("c$1").test("x c$1 y")).toBe(true);
  });
});

describe("searchSqlText", () => {
  const texts: SqlText[] = [
    { name: "report", text: "-- monthly\nselect count(*)\n  from Invoices i\n where i.total > 0\n", console: true, dsId: "ora" },
    { name: "scratch-1.sql", text: "select 1;\nselect * from invoices_archive;\n", console: false, path: "C:/s/scratch-1.sql", scratch: true },
    { name: "empty", text: "", console: true, dsId: "pg" },
  ];

  it("lists every line that names the word, with the 1-based line and the trimmed text", () => {
    const hits = searchSqlText(texts, "invoices");
    expect(hits).toEqual([{ name: "report", line: 3, text: "from Invoices i", console: true, dsId: "ora", path: undefined, scratch: undefined }]);
  });

  it("keeps the origin of the text (console or file, data source, path, scratch flag)", () => {
    const hits = searchSqlText(texts, "archive");
    expect(hits).toHaveLength(0);
    const hit = searchSqlText(texts, "select")[0];
    expect(hit).toMatchObject({ name: "report", line: 2, console: true, dsId: "ora" });
    expect(searchSqlText(texts, "invoices_archive")).toEqual([
      { name: "scratch-1.sql", line: 2, text: "select * from invoices_archive;", console: false, dsId: undefined, path: "C:/s/scratch-1.sql", scratch: true },
    ]);
  });

  it("handles Windows line endings and an empty word", () => {
    const crlf: SqlText[] = [{ name: "w", text: "a\r\nselect Invoices\r\n", console: true }];
    expect(searchSqlText(crlf, "invoices").map((h) => h.line)).toEqual([2]);
    expect(searchSqlText(texts, "   ")).toEqual([]);
  });

  it("stops at the limit", () => {
    const many: SqlText[] = [{ name: "m", text: Array.from({ length: 10 }, () => "x y").join("\n"), console: true }];
    expect(searchSqlText(many, "y", 4)).toHaveLength(4);
  });
});
