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

describe("Oracle", () => {
  const ora = (sql: string) => problems(sql, "oracle");
  it("syntax inspection accepts Oracle constructs", () => {
    for (const sql of [
      "select * from t, u where t.a = u.a (+)",
      "select * from t, u where t.a(+) = u.a",
      "select level from dual connect by level <= 5",
      "select a, prior b from t start with b is null connect by nocycle prior a = b",
      "select seq.nextval, rownum, sysdate from dual",
      "select * from t order by a offset 5 rows fetch next 3 rows only",
      "select q'[it's]', n'x' from dual",
      "select a from t minus select a from u",
      "select nvl(a, 0), decode(b, 1, 'x', 'y'), to_char(sysdate, 'YYYY') from t",
      "merge into t using u on (t.a = u.a) when matched then update set t.b = u.c when not matched then insert (a) values (u.a)",
      "select a from t where rownum <= 10 for update skip locked",
      "select :id from dual",
    ])
      expect(syntax(sql, "oracle"), sql).toEqual([]);
  });
  it("semantic inspection does not flag DUAL, ROWNUM, SYSDATE, sequences, outer joins and PL/SQL", () => {
    for (const sql of [
      "select sysdate, systimestamp, rownum, user from dual",
      "select rownum, sysdate, a from t where rownum <= 5",
      "select t.rowid, a from t",
      "insert into t (a) values (my_seq.nextval)",
      "select my_seq.currval from dual",
      "select t.a, u.c from t, u where t.a = u.a (+)",
      "select a from t start with b is null connect by prior a = b",
      "select level, a from t connect by level <= 3",
      "begin select count(*) into v_n from t; end;",
      "declare v_n number; begin select count(*) into v_n from t; dbms_output.put_line(v_n); end;",
      "create or replace trigger trg before insert on t for each row begin :new.a := 1; end;",
      "select a from t fetch first 3 rows only",
    ])
      expect(ora(sql), sql).toEqual([]);
  });
  it("still flags unknown names", () => {
    expect(ora("select nope from t where b = 1")).toEqual(["column:nope|Unable to resolve column 'nope'"]);
    expect(ora("select 1 from nosuch").join()).toContain("Unable to resolve table 'nosuch'");
  });
  it("matches upper-case catalog names case-insensitively", () => {
    const up = new SchemaIndex({ schemas: [{ name: "DEMO", tables: [{ name: "EMP", kind: "table", columns: [{ name: "EMPNO", type: "NUMBER" }] }] }] }, "DEMO");
    const r = analyzeStatement("select empno from emp", lex("select empno from emp", "oracle"), up, "oracle");
    expect(r.unresolved).toEqual([]);
    expect(r.resolved.length).toBeGreaterThan(0);
  });
});
