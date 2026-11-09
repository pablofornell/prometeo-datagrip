// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatStatement, isProcedural } from "./format";

describe("isProcedural", () => {
  it("detects PostgreSQL dollar-quoted routine bodies", () => {
    expect(isProcedural("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;", "postgres")).toBe(true);
  });
  it("detects MySQL DELIMITER scripts and CREATE PROCEDURE bodies", () => {
    expect(isProcedural("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;", "mysql")).toBe(true);
    expect(isProcedural("CREATE PROCEDURE p() BEGIN SELECT 1; END", "mysql")).toBe(true);
  });
  it("detects bare PL/SQL blocks", () => {
    expect(isProcedural("BEGIN NULL; END;", "oracle")).toBe(true);
    expect(isProcedural("DECLARE x INT; BEGIN NULL; END;", "oracle")).toBe(true);
  });
  it("leaves plain SQL alone", () => {
    expect(isProcedural("SELECT 1", "postgres")).toBe(false);
    expect(isProcedural("CREATE TABLE t (id int)", "postgres")).toBe(false);
  });
  it("ignores dollar-quotes and BEGIN/DECLARE inside string literals and comments", () => {
    expect(isProcedural("SELECT '$name$' AS x FROM t;", "postgres")).toBe(false);
    expect(isProcedural("SELECT 'begin declare' FROM t;", "postgres")).toBe(false);
    expect(isProcedural("-- $body$ create function\nSELECT 1;", "postgres")).toBe(false);
  });
});

describe("formatStatement", () => {
  it("keeps procedural code untouched", () => {
    const body = "CREATE PROCEDURE p() BEGIN SELECT 1; END";
    expect(formatStatement(body, "mysql")).toBe(body);
    expect(formatStatement("BEGIN\n  x := 1;\nEND;", "oracle")).toBe("BEGIN\n  x := 1;\nEND;");
  });
  it("reformats plain SQL", () => {
    expect(formatStatement("select 1 from t where a=1 and b=2", "postgres")).toBe("select 1\nfrom t\nwhere a = 1\n  and b = 2");
  });
});
