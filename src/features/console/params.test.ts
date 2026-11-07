// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findParams, literalOf, paramList, substitute } from "./params";

const keys = (sql: string, d: "postgres" | "mysql" | "sqlite" = "sqlite"): string[] => findParams(sql, d).map((r) => r.key);

describe("findParams", () => {
  it("finds ?, :name, $1, ${name} and #name#", () => {
    expect(keys("select * from t where a = ? and b = ?")).toEqual(["?1", "?2"]);
    expect(keys("select * from t where a = :id or b = :name")).toEqual([":id", ":name"]);
    expect(keys("select $1, $2, $1", "postgres")).toEqual(["$1", "$2", "$1"]);
    expect(paramList(findParams("select $1, $2, $1", "postgres"))).toEqual(["$1", "$2"]);
    expect(keys("select ${limit}, #owner#", "postgres")).toEqual(["${limit}", "#owner#"]);
  });

  it("ignores strings, comments, casts, quoted names and user variables", () => {
    expect(keys("select '?', ':x', \"?\" -- ? :y\n, 1 /* :z */")).toEqual([]);
    expect(keys("select a::int, b::text from t", "postgres")).toEqual([]);
    expect(keys("select @v, @@sql_mode", "mysql")).toEqual([]);
    expect(keys("select '#a#', 1", "postgres")).toEqual([]);
  });

  it("does not take the jsonb operator for a parameter", () => {
    expect(keys("select * from t where data ? 'k' and id = ?", "postgres")).toEqual(["?1"]);
    expect(keys("select * from t where data ?| array['a']", "postgres")).toEqual([]);
  });
});

describe("substitute", () => {
  it("replaces every occurrence and maps positions back", () => {
    const sql = "select * from t where a = :id and b = :id";
    const refs = findParams(sql, "sqlite");
    const out = substitute(sql, refs, { ":id": { value: "42", type: "number" } });
    expect(out.sql).toBe("select * from t where a = 42 and b = 42");
    expect(out.unmap(out.sql.indexOf("and"))).toBe(sql.indexOf("and"));
    const longer = substitute(sql, refs, { ":id": { value: "o'x", type: "string" } });
    expect(longer.sql).toBe("select * from t where a = 'o''x' and b = 'o''x'");
    expect(longer.unmap(longer.sql.indexOf("and"))).toBe(sql.indexOf("and"));
    expect(longer.unmap(longer.sql.length)).toBe(sql.length);
  });

  it("validates the types", () => {
    expect(literalOf({ value: " null ", type: "sql" })).toBe("null");
    expect(literalOf({ value: "", type: "sql" })).toBeNull();
    expect(literalOf({ value: "abc", type: "number" })).toBeNull();
    expect(literalOf({ value: "-1.5e3", type: "number" })).toBe("-1.5e3");
    expect(literalOf({ value: "", type: "string" })).toBe("''");
  });
});
