// @vitest-environment node
// Valid statements of PostgreSQL / MySQL / SQLite that the inspections must not flag.
import { describe, expect, it } from "vitest";
import { lex } from "./lexer";
import { SchemaIndex } from "./schemaIndex";
import { analyzeStatement } from "./semantic";
import { syntaxProblems } from "./syntax";
import type { Dialect } from "./split";
import type { SchemaSnapshot } from "./types";

const schema: SchemaSnapshot = {
  schemas: [
    {
      name: "public",
      tables: [
        { name: "t", kind: "table", columns: [{ name: "a", type: "int" }, { name: "b", type: "int" }, { name: "offset", type: "int" }, { name: "name", type: "text" }] },
        { name: "u", kind: "table", columns: [{ name: "a", type: "int" }, { name: "c", type: "int" }] },
      ],
    },
  ],
};
const index = new SchemaIndex(schema, "public");

const syntax = (sql: string, d: Dialect): string[] => syntaxProblems(sql, lex(sql, d)).map((p) => `${sql.slice(p.from, p.to)}|${p.message}`);
/** Unresolved names of a one-statement script, like the editor's inspection reports them. */
function problems(sql: string, d: Dialect): string[] {
  return analyzeStatement(sql, lex(sql, d), index, d).unresolved.map((u) => `${u.kind}:${sql.slice(u.from, u.to)}|${u.message}`);
}

describe("syntax inspection accepts valid dialect syntax", () => {
  it("RETURNING *", () => {
    for (const d of ["postgres", "sqlite"] as Dialect[]) {
      expect(syntax("insert into t (a) values (1) returning *;", d)).toEqual([]);
      expect(syntax("delete from t where a = 1 returning *", d)).toEqual([]);
      expect(syntax("update t set a = 2 returning *;", d)).toEqual([]);
    }
  });
  it("DISTINCT ON (...) *", () => {
    expect(syntax("select distinct on (a) * from t order by a, b", "postgres")).toEqual([]);
    expect(syntax("select distinct on (a, lower(name)) * from t", "postgres")).toEqual([]);
  });
  it("MySQL select modifiers before *", () => {
    expect(syntax("select straight_join * from t join u on t.a = u.a", "mysql")).toEqual([]);
    expect(syntax("select sql_calc_found_rows * from t limit 10", "mysql")).toEqual([]);
    expect(syntax("select sql_no_cache high_priority * from t", "mysql")).toEqual([]);
  });
  it("ORDER BY .. USING <", () => {
    expect(syntax("select a from t order by a using <", "postgres")).toEqual([]);
    expect(syntax("select a from t order by a using > limit 3", "postgres")).toEqual([]);
  });
  it("a column named offset", () => {
    expect(syntax("select * from t where offset = 1", "mysql")).toEqual([]);
    expect(syntax("select * from t where a = 1 and offset > 3 limit 5 offset 2", "mysql")).toEqual([]);
    expect(syntax("select * from t where offset is null", "mysql")).toEqual([]);
  });
  it("still reports real mistakes", () => {
    expect(syntax("select a.* from t a", "postgres")).toEqual([]);
    expect(syntax("select a * from t", "postgres")).toHaveLength(1);
    expect(syntax("select 1 + from t", "postgres")).toHaveLength(1);
    expect(syntax("select a, from t where", "mysql")).toHaveLength(2);
    expect(syntax("select * from t where", "mysql")).toEqual(["where|<expression> expected"]);
    expect(syntax("select a from t where a = ", "postgres")).toEqual(["=|<expression> expected"]);
    expect(syntax("select a from t where a *", "postgres")).toEqual(["*|<expression> expected"]);
  });
});

describe("semantic inspection does not flag valid names", () => {
  it("PostgreSQL", () => {
    expect(problems("delete from t using u where t.a = u.a", "postgres")).toEqual([]);
    expect(problems("delete from t using u, u as w where t.a = u.a and w.c = 1", "postgres")).toEqual([]);
    expect(problems("select current_role, a from t", "postgres")).toEqual([]);
    expect(problems("select xmlelement(name foo, a) from t", "postgres")).toEqual([]);
    expect(problems("select a from t join u using (a)", "postgres")).toEqual([]);
  });
  it("MySQL", () => {
    expect(problems("select convert(name using utf8mb4) from t", "mysql")).toEqual([]);
    expect(problems("select a from t where b = 1 lock in share mode", "mysql")).toEqual([]);
    expect(problems("select 1 from dual", "mysql")).toEqual([]);
    expect(problems("select utc_timestamp, utc_date from t", "mysql")).toEqual([]);
    expect(problems("delete from t using t join u on t.a = u.a where u.c = 1", "mysql")).toEqual([]);
  });
  it("SQLite", () => {
    expect(problems("select a from t indexed by ix where a = 1", "sqlite")).toEqual([]);
    expect(problems("select a from t not indexed where a = 1", "sqlite")).toEqual([]);
  });
  it("still flags unknown names", () => {
    expect(problems("select nope from t where b = 1", "postgres")).toEqual(["column:nope|Unable to resolve column 'nope'"]);
    expect(problems("delete from t using nosuch where t.a = 1", "postgres").join()).toContain("Unable to resolve table 'nosuch'");
    expect(problems("select 1 from nosuch", "mysql").join()).toContain("Unable to resolve table 'nosuch'");
  });
});
