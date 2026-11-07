// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatScript } from "./format";
import { lex } from "./lexer";
import { SchemaIndex } from "./schemaIndex";
import { analyzeStatement } from "./semantic";
import type { SchemaSnapshot } from "./types";

const schema: SchemaSnapshot = {
  schemas: [
    {
      name: "public",
      tables: [
        { name: "customers", kind: "table", columns: [{ name: "id", type: "integer" }, { name: "first_name", type: "text" }, { name: "country", type: "text" }] },
        { name: "orders", kind: "table", columns: [{ name: "id", type: "integer" }, { name: "customer_id", type: "integer" }, { name: "status", type: "text" }] },
      ],
    },
  ],
};
const idx = new SchemaIndex(schema, "public");

function marks(sql: string): string[] {
  const a = analyzeStatement(sql, lex(sql, "postgres"), idx, "postgres");
  return a.marks.map((m) => `${m.cls}:${sql.slice(m.from, m.to)}`);
}

describe("semantic highlighting", () => {
  it("colors keywords, functions, columns and flags unresolved tables", () => {
    const m = marks("SELECT c.id, count(o.id) FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country = 'ES'");
    expect(m).toContain("kw:SELECT");
    expect(m).toContain("col:id");
    expect(m).toContain("fn:count");
    expect(m).toContain("col:customer_id");
    expect(m).toContain("str:'ES'");
    expect(m.filter((x) => x.startsWith("bad:"))).toEqual([]);
    expect(marks("SELECT * FROM no_such_table")).toContain("bad:no_such_table");
    expect(marks("SELECT x.id FROM customers c")).toContain("bad:x");
    expect(marks("SELECT c.nope FROM customers c")).toContain("bad:nope");
  });
  it("does not flag CTEs and derived tables", () => {
    expect(marks("WITH t AS (SELECT 1) SELECT * FROM t").filter((x) => x.startsWith("bad:"))).toEqual([]);
    expect(marks("SELECT s.a FROM (SELECT 1 a) s").filter((x) => x.startsWith("bad:"))).toEqual([]);
  });
  it("colors types in DDL and casts", () => {
    expect(marks("CREATE TABLE t (a varchar(10), b integer)")).toEqual(expect.arrayContaining(["kw:varchar", "kw:integer"]));
    expect(marks("SELECT 1::integer")).toContain("kw:integer");
  });
});

describe("incomplete input", () => {
  it("treats a dangling qualifier as a schema/alias, not an unresolved table", () => {
    expect(marks("SELECT * FROM public.").filter((x) => x.startsWith("bad:"))).toEqual([]);
    const a = analyzeStatement("SELECT o. FROM orders o", lex("SELECT o. FROM orders o", "postgres"), idx, "postgres");
    expect(a.scope.byName.get("o")?.table?.name).toBe("orders");
  });
  it("resolves columns against an implicit table", () => {
    const t = idx.findTable(["customers"]);
    const sql = "country = 'ES' and nope = 1";
    const a = analyzeStatement(sql, lex(sql, "postgres"), idx, "postgres", [{ parts: ["customers"], table: t, opaque: false }]);
    expect(a.marks.map((m) => `${m.cls}:${sql.slice(m.from, m.to)}`)).toContain("col:country");
  });
});

describe("formatter", () => {
  it("lays out clauses like DataGrip", () => {
    const out = formatScript("select c.id, c.first_name from customers c left join orders o on o.customer_id=c.id where c.country is not null and o.status<>'x' group by c.id order by 1 desc limit 5;", "postgres");
    expect(out).toBe(
      [
        "select c.id, c.first_name",
        "from customers c",
        "         left join orders o on o.customer_id = c.id",
        "where c.country is not null",
        "  and o.status <> 'x'",
        "group by c.id",
        "order by 1 desc",
        "limit 5;",
      ].join("\n"),
    );
  });
  it("starts the main query of a CTE on its own line", () => {
    const out = formatScript("with recursive r(n) as (select 1 union all select n+1 from r where n<5) select n from r;", "postgres");
    expect(out).toBe(["with recursive r(n) as (", "    select 1", "    union all", "    select n + 1", "    from r", "    where n < 5", ")", "select n", "from r;"].join("\n"));
    expect(formatScript(out, "postgres")).toBe(out);
    expect(formatScript("with a as (select 1), b as (select 2) select * from a, b;", "postgres")).toBe(["with a as (", "    select 1", "), b as (", "    select 2", ")", "select *", "from a, b;"].join("\n"));
    expect(formatScript("select * from (select 1 as x) s where s.x in (select 1) and s.x = 2", "postgres")).toContain(") s\nwhere s.x in (");
  });
  it("is idempotent and keeps comments and gaps", () => {
    const src = "-- top\nSELECT a FROM t WHERE x IN (SELECT y FROM u); -- tail\n\nINSERT INTO t (a, b) VALUES (1, -2);";
    const once = formatScript(src, "postgres");
    expect(formatScript(once, "postgres")).toBe(once);
    expect(once).toContain("-- top");
    expect(once).toContain("INSERT INTO t (a, b)");
    expect(once).toContain("VALUES (1, -2)");
  });
});
