// @vitest-environment node
// Mirrors the unit tests of crates/dbcore/src/split.rs.
import { describe, expect, it } from "vitest";
import { splitStatements, statementAt, type Dialect } from "./split";

const PG: Dialect = "postgres";
const MY: Dialect = "mysql";
const LITE: Dialect = "sqlite";
const ORA: Dialect = "oracle";

const texts = (sql: string, d: Dialect): string[] => splitStatements(sql, d).map((s) => s.text);

describe("splitStatements", () => {
  it("basic_split", () => {
    expect(texts("select 1; select 2;\n\nselect 3", PG)).toEqual(["select 1", "select 2", "select 3"]);
  });

  it("empty_and_comment_only", () => {
    expect(texts("", PG)).toEqual([]);
    expect(texts(" ;; -- hi\n /* x */ ; ", PG)).toEqual([]);
  });

  it("semicolon_in_strings_and_idents", () => {
    expect(texts(`select 'a;b', "c;d" ; select 'it''s;'`, PG)).toEqual([`select 'a;b', "c;d"`, "select 'it''s;'"]);
  });

  it("comments_hide_semicolons", () => {
    const sql = "select 1 -- not; here\n; /* a; /* nested; */ still; */ select 2";
    expect(texts(sql, PG)).toEqual(["select 1 -- not; here", "select 2"]);
    // MySQL block comments do not nest: the ';' after the first */ ends the statement
    expect(texts("select /* a; */ 1; select 2", MY)).toEqual(["select /* a; */ 1", "select 2"]);
  });

  it("leading_comments_are_not_part_of_the_statement", () => {
    const s = splitStatements("-- hello\n/* x */ select 1;", PG);
    expect(s).toHaveLength(1);
    expect(s[0].text).toBe("select 1");
    expect(s[0].start).toBe(17);
  });

  it("pg_dollar_quoting", () => {
    let sql = "create function f() returns int as $$ begin; select 1; end; $$ language plpgsql; select 2;";
    let t = texts(sql, PG);
    expect(t).toHaveLength(2);
    expect(t[0].endsWith("language plpgsql")).toBe(true);
    sql = "do $body$ begin raise notice $$x;$$; end $body$; select $1, a$b from t;";
    t = texts(sql, PG);
    expect(t).toHaveLength(2);
    expect(t[1]).toBe("select $1, a$b from t");
  });

  it("pg_escape_strings", () => {
    expect(texts("select E'a\\';b'; select 2", PG)).toEqual(["select E'a\\';b'", "select 2"]);
    // plain string: backslash is literal, so the quote closes
    expect(texts("select 'a\\'; select 2", PG)).toEqual(["select 'a\\'", "select 2"]);
  });

  it("pg_begin_atomic", () => {
    const sql = "create function f() returns int begin atomic select case when true then 1 end; end; select 1";
    const t = texts(sql, PG);
    expect(t).toHaveLength(2);
    expect(t[0].endsWith("end")).toBe(true);
    // plain BEGIN is a transaction statement
    expect(texts("begin; select 1; commit;", PG)).toHaveLength(3);
  });

  it("mysql_quotes_and_backslash", () => {
    expect(texts("select 'a\\'b;c', `x;y`; select 2 # c; d", MY)).toEqual(["select 'a\\'b;c', `x;y`", "select 2 # c; d"]);
    // "--" without trailing space is not a comment in MySQL
    expect(texts("select 1--1; select 2", MY)).toEqual(["select 1--1", "select 2"]);
  });

  it("mysql_delimiter", () => {
    const sql = "DELIMITER //\ncreate procedure p() begin select 1; select 2; end//\nDELIMITER ;\nselect 3;";
    const t = texts(sql, MY);
    expect(t).toHaveLength(2);
    expect(t[0].startsWith("create procedure p()")).toBe(true);
    expect(t[0].endsWith("end")).toBe(true);
    expect(t[1]).toBe("select 3");
  });

  it("mysql_compound_without_delimiter", () => {
    const sql =
      "create procedure p() begin if x then select 1; end if; case when 1 then select 2; end case; select 3; end; select 4";
    const t = texts(sql, MY);
    expect(t).toHaveLength(2);
    expect(t[1]).toBe("select 4");
  });

  it("mysql_executable_comment_at_start", () => {
    expect(texts("/*!40101 SET NAMES utf8 */;\nselect 1;", MY)).toEqual(["/*!40101 SET NAMES utf8 */", "select 1"]);
  });

  it("sqlite_trigger_body", () => {
    const sql =
      "create trigger tr after insert on t begin update x set a = case when 1 then 2 end; insert into log values (1); end; select 1;";
    const t = texts(sql, LITE);
    expect(t).toHaveLength(2);
    expect(t[0].endsWith("end")).toBe(true);
    expect(t[1]).toBe("select 1");
    expect(texts("begin; select 1; commit", LITE)).toHaveLength(3);
  });

  it("sqlite_brackets_and_backticks", () => {
    expect(texts("select [a;b], `c;d` from t; select 2", LITE)).toEqual(["select [a;b], `c;d` from t", "select 2"]);
  });

  it("unterminated_constructs_do_not_panic", () => {
    for (const sql of ["select 'abc", 'select "abc', "select /* abc", "select $$ abc", "select $a$ x", "select `a"]) {
      for (const d of [PG, MY, LITE]) {
        expect(splitStatements(sql, d), `${sql} ${d}`).toHaveLength(1);
      }
    }
  });

  it("offsets_are_utf16", () => {
    // JS strings are UTF-16: "é" = 1 unit, "😀" = 2 units (Rust: start_utf16/end_utf16)
    const sql = "select 'é😀';  select 2";
    const s = splitStatements(sql, PG);
    expect(s).toHaveLength(2);
    expect([s[0].start, s[0].end]).toEqual([0, 12]);
    expect(sql.slice(s[1].start, s[1].end)).toBe("select 2");
    expect(s[1].start).toBe(15);
    expect(s[1].end).toBe(23);
  });
});

describe("oracle", () => {
  it("splits plain SQL on ';' and treats double quotes as identifiers", () => {
    expect(texts(`select 'a;b', "c;d" from dual; select 2 from dual`, ORA)).toEqual([`select 'a;b', "c;d" from dual`, "select 2 from dual"]);
    // no backticks, no backslash escapes
    expect(texts("select 'a\\' from dual; select 2 from dual", ORA)).toEqual(["select 'a\\' from dual", "select 2 from dual"]);
  });

  it("q'[..]' alternative quoting hides ';' and quotes", () => {
    expect(texts("select q'[it's; fine]' from dual; select 2 from dual", ORA)).toEqual(["select q'[it's; fine]' from dual", "select 2 from dual"]);
    expect(texts("select Q'{a;b}', nq'!c;d!' from dual; select 2", ORA)).toEqual(["select Q'{a;b}', nq'!c;d!' from dual", "select 2"]);
    // a column called q is not a q-quote
    expect(texts("select q from t; select 'x' from dual", ORA)).toEqual(["select q from t", "select 'x' from dual"]);
  });

  it("a line with only '/' ends a PL/SQL unit; ';' inside does not", () => {
    const proc = "create or replace procedure p is\nbegin\n  update t set a = 1;\n  commit;\nend;";
    const t = texts(`${proc}\n/\nselect 1 from dual;\n`, ORA);
    expect(t).toEqual([proc, "select 1 from dual"]);
    const pkg = "create or replace package body pk as\n  procedure a is begin null; end;\nend pk;";
    expect(texts(`${pkg}\n/\ncreate table x (a int);`, ORA)).toEqual([pkg, "create table x (a int)"]);
    const trg = "CREATE OR REPLACE EDITIONABLE TRIGGER trg before insert on t for each row begin :new.id := 1; end;";
    expect(texts(`${trg}\n/`, ORA)).toEqual([trg]);
    const decl = "declare x number; begin select 1 into x from dual; end;";
    expect(texts(`${decl}\n/\nselect 2 from dual`, ORA)).toEqual([decl, "select 2 from dual"]);
  });

  it("an anonymous BEGIN block ends at its own END; (and a '/' after it is ignored)", () => {
    const blk = "begin\n  if 1 = 1 then null; end if;\n  for i in 1..2 loop null; end loop;\n  x := case when 1 = 1 then 1 end;\nend;";
    expect(texts(`${blk} select 1 from dual;`, ORA)).toEqual([blk, "select 1 from dual"]);
    expect(texts(`${blk}\n/\nselect 1 from dual;`, ORA)).toEqual([blk, "select 1 from dual"]);
    expect(texts("begin begin null; end; null; end; select 3 from dual", ORA)).toEqual(["begin begin null; end; null; end;", "select 3 from dual"]);
  });

  it("'/' alone also ends a plain statement and is dropped after one", () => {
    expect(texts("select 1 from dual\n/\nselect 2 from dual\n/", ORA)).toEqual(["select 1 from dual", "select 2 from dual"]);
    expect(texts("select 1 from dual;\n/\n", ORA)).toEqual(["select 1 from dual"]);
    // division and comments are not terminators
    expect(texts("select 4\n/ 2 from dual;\nselect 1 from dual /* a\n/\n*/ ;", ORA)).toEqual(["select 4\n/ 2 from dual", "select 1 from dual /* a\n/\n*/"]);
  });

  it("CREATE TABLE / TYPE (not a body) with FUNCTION in its text stay plain statements", () => {
    expect(texts("create table t (function int); select 1 from dual", ORA)).toEqual(["create table t (function int)", "select 1 from dual"]);
    expect(texts("create type t as table of number; select 1 from dual", ORA)).toEqual(["create type t as table of number", "select 1 from dual"]);
  });

  it("does not panic on unterminated constructs", () => {
    for (const sql of ["select q'[abc", 'select "abc', "select /* abc", "begin null;", "create procedure p is begin null"])
      expect(splitStatements(sql, ORA), sql).toHaveLength(1);
  });
});

describe("statementAt", () => {
  it("statement_at_cases", () => {
    const sql = "select 1;\n\nselect 2;\nselect 3";
    const at = (c: number): string | undefined => statementAt(sql, c, PG)?.text;
    expect(at(0)).toBe("select 1");
    expect(at(8)).toBe("select 1");
    expect(at(9)).toBe("select 1"); // right after ';'
    expect(at(10)).toBe("select 1"); // blank gap -> previous
    expect(at(11)).toBe("select 2");
    expect(at(19)).toBe("select 2");
    expect(at(20)).toBe("select 2"); // right after its ';'
    expect(at(21)).toBe("select 3");
    expect(at(sql.length)).toBe("select 3");
    expect(statementAt("  -- nothing\n", 3, PG)).toBeNull();
    // leading blank -> first statement
    expect(statementAt("\n\nselect 1", 0, PG)?.text).toBe("select 1");
  });

  it("statement_at_utf16_unit", () => {
    const sql = "select '😀'; select 2";
    // utf16 offset 16 is inside "select 2"
    expect(statementAt(sql, 16, PG)?.text).toBe("select 2");
    expect(statementAt(sql, 3, PG)?.text).toBe("select '😀'");
  });
});
