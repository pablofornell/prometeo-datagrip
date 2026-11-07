// @vitest-environment node
// Valid statements of PostgreSQL / MySQL / SQLite that the inspections must not flag.
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { computeProblems } from "./inspect";
import { lex } from "./lexer";
import { SchemaIndex } from "./schemaIndex";
import { configField, problemsField, setConfig } from "./state";
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

describe("semantic inspection: CTE column lists, upsert and row aliases", () => {
  it("recursive CTE with a column list", () => {
    for (const d of ["postgres", "sqlite", "mysql"] as Dialect[]) {
      expect(problems("with recursive r(n) as (select 1 union all select n+1 from r where n<5) select n from r", d)).toEqual([]);
      expect(problems("with x(k) as (select a from t) select k from x", d)).toEqual([]);
      expect(problems("with x(k) as (select a from t), y as (select k from x) select * from y join x on true", d)).toEqual([]);
    }
  });
  it("PostgreSQL / SQLite ON CONFLICT .. excluded", () => {
    for (const d of ["postgres", "sqlite"] as Dialect[]) {
      expect(problems("insert into t (a, name) values (1, 'x') on conflict (a) do update set name = excluded.name", d)).toEqual([]);
      expect(problems("insert into t (a, name) values (1, 'x') on conflict(a) do update set name = excluded.name where t.a > 1 returning a, name", d)).toEqual([]);
      expect(problems("insert into t (a) values (1) on conflict do nothing", d)).toEqual([]);
    }
  });
  it("MySQL 8 row alias and VALUES()", () => {
    expect(problems("insert into t(a) values (1) as nw on duplicate key update a = nw.a", "mysql")).toEqual([]);
    expect(problems("insert into t(a, b) values (1, 2) as nw(x, y) on duplicate key update a = nw.x, b = nw.y", "mysql")).toEqual([]);
    expect(problems("insert into t(a) values (1) on duplicate key update a = values(a)", "mysql")).toEqual([]);
    expect(problems("insert into t(a) select a from u on duplicate key update a = values(a) + 1", "mysql")).toEqual([]);
  });
  it("RETURNING, UPDATE .. FROM, MERGE and LATERAL joins", () => {
    expect(problems("insert into t(a) values (1) returning a, b as k", "postgres")).toEqual([]);
    expect(problems("update t set a = u.c from u where t.a = u.a returning t.a", "postgres")).toEqual([]);
    expect(problems("update t set a = c from u where t.a = u.a", "sqlite")).toEqual([]);
    expect(problems("merge into t as x using u on x.a = u.a when matched then update set b = u.c when not matched then insert (a, b) values (u.a, u.c)", "postgres")).toEqual([]);
    expect(problems("merge into t using (select a, c from u) s on t.a = s.a when matched then delete", "postgres")).toEqual([]);
    expect(problems("select t.a, l.c from t cross join lateral (select c from u where u.a = t.a) l", "postgres")).toEqual([]);
    expect(problems("select t.a, l.c from t left join lateral (select c from u where u.a = t.a limit 1) l on true", "postgres")).toEqual([]);
    expect(problems("select * from t e, lateral (select count(*) c from u d where d.a = e.a) z limit 1", "postgres")).toEqual([]);
    expect(problems("select t.a, l.c from t join lateral (select c from u where u.a = t.a) l on true", "mysql")).toEqual([]);
  });
  it("still flags what is really unknown", () => {
    expect(problems("with x(k) as (select a from t) select k from nosuch", "postgres").join()).toContain("Unable to resolve table 'nosuch'");
    expect(problems("with recursive r(n) as (select 1 union all select n+1 from rr where n<5) select n from r", "postgres").join()).toContain("Unable to resolve table 'rr'");
    expect(problems("select excluded.a from t", "postgres").join()).toContain("Unable to resolve table 'excluded'");
    expect(problems("insert into t (a) values (1) on conflict (a) do update set a = nosuch.a", "postgres").join()).toContain("Unable to resolve table 'nosuch'");
    expect(problems("insert into t(a) values (1) as nw on duplicate key update a = zz.a", "mysql").join()).toContain("Unable to resolve table 'zz'");
    expect(problems("insert into t(a) values (1) as nw on duplicate key update a = nw.nope", "mysql").join()).toContain("Unable to resolve column 'nope'");
    expect(problems("insert into nosuch(a) values (1) on conflict (a) do update set a = excluded.a", "postgres").join()).toContain("Unable to resolve table 'nosuch'");
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
  it("resolves synonyms and knows the data dictionary", () => {
    const syn = new SchemaIndex(
      {
        schemas: [
          {
            name: "DEMO",
            tables: [{ name: "PRODUCTS", kind: "table", columns: [{ name: "ID", type: "NUMBER" }, { name: "NAME", type: "VARCHAR2" }] }],
            synonyms: [{ name: "SYN_PRODUCTS", target: ["DEMO", "PRODUCTS"] }, { name: "REMOTE_T", target: undefined }, { name: "SYN_GONE", target: ["OTHER", "GONE"] }],
          },
        ],
      },
      "DEMO",
    );
    const run = (sql: string) => analyzeStatement(sql, lex(sql, "oracle"), syn, "oracle").unresolved.map((u) => u.message);
    expect(run("select * from syn_products where rownum < 3")).toEqual([]);
    expect(run("select id, name from syn_products")).toEqual([]);
    expect(run("select nope from syn_products")).toEqual(["Unable to resolve column 'nope'"]);
    expect(run("select * from remote_t")).toEqual([]);
    expect(run("select x.a from syn_gone x")).toEqual([]);
    for (const v of ["all_objects", "user_tables", "dba_users", "v$session", "gv$sql", "sys.all_objects", "public.user_tab_columns", "dual"])
      expect(run(`select count(*) from ${v} a, ${v} b`), v).toEqual([]);
    expect(run("select o.owner, o.object_name from all_objects o where o.owner = 'X'")).toEqual([]);
    expect(run("select * from nosuch")).toEqual(["Unable to resolve table 'nosuch'"]);
    expect(run("select * from demo.nosuch")).toEqual(["Unable to resolve table 'nosuch'"]);
  });
  it("a / line after a PL/SQL unit is not an expression", () => {
    const doc = "create or replace function f(p number) return number is\nbegin\n  return p * 2;\nend f;\n/\ncreate or replace procedure q is\nbegin\n  null;\nend;\n/\nselect 1 from dual;";
    const st = EditorState.create({ doc, extensions: [configField, problemsField] }).update({ effects: setConfig.of({ dialect: "oracle", index, statementFrame: true }) }).state;
    expect(computeProblems(st).map((p) => `${p.kind}:${doc.slice(p.from, p.to)}|${p.message}`)).toEqual([]);
  });
  it("matches upper-case catalog names case-insensitively", () => {
    const up = new SchemaIndex({ schemas: [{ name: "DEMO", tables: [{ name: "EMP", kind: "table", columns: [{ name: "EMPNO", type: "NUMBER" }] }] }] }, "DEMO");
    const r = analyzeStatement("select empno from emp", lex("select empno from emp", "oracle"), up, "oracle");
    expect(r.unresolved).toEqual([]);
    expect(r.resolved.length).toBeGreaterThan(0);
  });
});
