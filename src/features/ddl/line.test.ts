// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ddlLineOf } from "./line";

const ddl = [
  "CREATE OR REPLACE PACKAGE BODY \"SHOP\".\"UF_PKG\" AS",
  "  function total_of (p number) return number is",
  "    n number;",
  "  begin",
  "    select count(*) into n from uf_orders where customer_id = p;",
  "    return n;",
  "  end;",
  "END UF_PKG;",
].join("\n");

describe("ddlLineOf", () => {
  it("finds the line by its text, whatever the indentation and the header lines the DBMS adds", () => {
    expect(ddlLineOf(ddl, "select count(*) into n from uf_orders where customer_id = p;", 1)).toBe(5);
  });

  it("takes the match nearest to the line the usage names when the text repeats", () => {
    const text = ["begin", "  return 1;", "end;", "begin", "  return 1;", "end;"].join("\n");
    expect(ddlLineOf(text, "return 1;", 6)).toBe(5);
    expect(ddlLineOf(text, "return 1;", 2)).toBe(2);
  });

  it("matches a clipped hint by its start", () => {
    const long = `select ${"x, ".repeat(80)}total from uf_orders`;
    const text = ["create view v as", `   ${long}`].join("\n");
    expect(ddlLineOf(text, `${long.slice(0, 200)}…`, 1)).toBe(2);
  });

  it("falls back to the given line, kept inside the text, when nothing matches or there is no hint", () => {
    expect(ddlLineOf(ddl, "no such line", 3)).toBe(3);
    expect(ddlLineOf(ddl, undefined, 40)).toBe(8);
    expect(ddlLineOf(ddl, "   ", 0)).toBe(1);
    expect(ddlLineOf("", undefined, 2)).toBe(1);
  });

  it("ignores the line endings of the text", () => {
    expect(ddlLineOf("a\r\n  return n;\r\nend;", "return n;", 1)).toBe(2);
  });
});
