// @vitest-environment node
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { computeProblems } from "./inspect";
import { lex } from "./lexer";
import { resolveAt } from "./navigate";
import { SchemaIndex } from "./schemaIndex";
import { analyzeStatement } from "./semantic";
import { configField, problemsField, setConfig } from "./state";
import { syntaxProblems } from "./syntax";
import type { SchemaSnapshot } from "./types";

const schema: SchemaSnapshot = {
  schemas: [
    {
      name: "main",
      tables: [
        { name: "products", kind: "table", columns: [{ name: "id", type: "INTEGER", key: "pk" }, { name: "name", type: "TEXT" }, { name: "price", type: "REAL" }, { name: "category_id", type: "INTEGER" }, { name: "stock", type: "INTEGER" }] },
        { name: "categories", kind: "table", columns: [{ name: "id", type: "INTEGER", key: "pk" }, { name: "title", type: "TEXT" }] },
        { name: "order_items", kind: "table", columns: [{ name: "order_id", type: "INTEGER" }, { name: "product_id", type: "INTEGER" }, { name: "quantity", type: "INTEGER" }] },
      ],
    },
  ],
};
const index = new SchemaIndex(schema, "main");

const syntax = (sql: string): string[] => syntaxProblems(sql, lex(sql, "sqlite")).map((p) => `${sql.slice(p.from, p.to)}|${p.message}`);

function stateOf(sql: string): EditorState {
  const st = EditorState.create({ doc: sql, extensions: [configField, problemsField] });
  return st.update({ effects: setConfig.of({ dialect: "sqlite", index, statementFrame: true }) }).state;
}
const problems = (sql: string): string[] => computeProblems(stateOf(sql)).map((p) => `${p.kind}:${sql.slice(p.from, p.to)}|${p.message}`);

describe("syntax inspection", () => {
  it("flags a dangling comma and a missing operand", () => {
    expect(syntax("SELECT name, FROM products WHERE;")).toEqual([
      "FROM|<expression> expected, got 'FROM'",
      ";|<expression> expected, got ';'",
    ]);
    expect(syntax("select name, price from products where price >;")).toEqual([";|<expression> expected, got ';'"]);
    expect(syntax("select * from products where")).toEqual(["where|<expression> expected"]);
    expect(syntax("select a from t order by")).toEqual(["by|<expression> expected"]);
    expect(syntax("select * from")).toEqual(["from|<table name> expected"]);
    expect(syntax("insert into t (a, ) values (1)")).toEqual([")|<expression> expected, got ')'"]);
  });
  it("flags unbalanced parentheses", () => {
    expect(syntax("select count(* from t;")).toEqual([";|')' expected, got ';'"]);
    expect(syntax("select 1)")).toEqual([")|Unmatched ')'"]);
  });
  it("accepts valid SQL", () => {
    for (const sql of [
      "SELECT * FROM products WHERE price > 5 ORDER BY name DESC LIMIT 10;",
      "select count(*), t.* from t where a is not null and b in (1, 2) group by c having count(*) > 1",
      "select a, b from t where x = -1 and y like '%a%' or z between 1 and 2",
      "insert into t (a, b) values (1, 'x') on conflict do nothing",
      "select 2 * 3, a * b from t",
      "select case when a then 1 else 2 end from t",
      "delimiter //",
      "\\d products",
      "",
    ])
      expect(syntax(sql), sql).toEqual([]);
  });
});

describe("unresolved names", () => {
  it("reports tables and columns with DataGrip's messages", () => {
    expect(problems("SELECT * FROM custmers;")).toEqual(["unresolved:custmers|Unable to resolve table 'custmers'"]);
    expect(problems("select name, colour from products;")).toEqual(["unresolved:colour|Unable to resolve column 'colour'"]);
    expect(problems("select p.colour from products p")).toEqual(["unresolved:colour|Unable to resolve column 'colour'"]);
    expect(problems("select x.id from products p")).toEqual(["unresolved:x|Unable to resolve table 'x'"]);
  });
  it("does not report what it cannot judge", () => {
    for (const sql of [
      "select name, price from products where price > 1 order by name;",
      "select name n, price * 2 as double from products order by double",
      "select count(*) c from products group by category_id order by c",
      "select extract(year from created) from products",
      "with a as (select 1 x) select x from a",
      "select current_date, true, null from products",
      "select name, price from (select * from products) q",
      "select category_id as cat from products where cat is null",
      "select p.name, c.title as category, count(*) n, sum(oi.quantity * p.price) total from products p join categories c on c.id = p.category_id left join order_items oi on oi.product_id = p.id where p.price > 10 and p.stock is not null group by c.title, p.name having count(*) > 0 order by n desc, total limit 5;",
      "update products set price = price * 1.1 where category_id in (select id from categories where title = 'x');",
      "delete from order_items where quantity = 0",
    ])
      expect(problems(sql).filter((p) => p.startsWith("unresolved")), sql).toEqual([]);
  });
  it("is off for an empty schema", () => {
    const st = EditorState.create({ doc: "select a from b", extensions: [configField] });
    expect(computeProblems(st)).toEqual([]);
  });
  it("exposes resolution for the analysis", () => {
    const sql = "select p.name, price from products p join categories c on c.id = p.category_id";
    const a = analyzeStatement(sql, lex(sql, "sqlite"), index, "sqlite");
    const names = a.resolved.map((r) => `${sql.slice(r.from, r.to)}->${r.table.name}${r.column ? "." + r.column.name : ""}`);
    expect(names).toContain("products->products");
    expect(names).toContain("name->products.name");
    expect(names).toContain("price->products.price");
    expect(names).toContain("categories->categories");
    expect(names).toContain("c->categories"); // alias used as qualifier
  });
});

describe("resolveAt", () => {
  const st = stateOf("select p.name, price from products p;");
  it("finds tables, aliases and columns under the caret", () => {
    const at = (needle: string, k = 0) => resolveAt(st, st.doc.toString().indexOf(needle) + k);
    expect(at("products p")).toMatchObject({ kind: "table", schema: "main", name: "products" });
    expect(at("name")).toMatchObject({ name: "products", column: { name: "name", type: "TEXT" } });
    expect(at("price", 2)).toMatchObject({ column: { name: "price" } });
    expect(at("p.name")).toMatchObject({ name: "products", column: undefined }); // the alias leads to the table
    expect(at("select")).toBeNull();
  });
  it("does nothing for unresolved names", () => {
    const s2 = stateOf("select * from custmers;");
    expect(resolveAt(s2, 16)).toBeNull();
  });
});
