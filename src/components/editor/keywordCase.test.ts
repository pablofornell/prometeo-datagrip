// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyKeywordCase } from "./keywordCase";

describe("applyKeywordCase", () => {
  const sql = "select o.id, 'select' as \"from\" -- from here\nfrom orders o where o.total > 1;";
  it("keeps the text as typed", () => {
    expect(applyKeywordCase(sql, "postgres", "keep")).toBe(sql);
  });
  it("upper-cases reserved words only", () => {
    expect(applyKeywordCase(sql, "postgres", "upper")).toBe("SELECT o.id, 'select' AS \"from\" -- from here\nFROM orders o WHERE o.total > 1;");
  });
  it("lower-cases reserved words", () => {
    expect(applyKeywordCase("SELECT A.Id FROM T WHERE X IS NULL", "postgres", "lower")).toBe("select A.Id from T where X is null");
  });
  it("leaves a name after a dot alone", () => {
    expect(applyKeywordCase("select t.default from t", "postgres", "upper")).toBe("SELECT t.default FROM t");
  });
  it("upper-cases dialect keywords only where they belong", () => {
    expect(applyKeywordCase("select * from t where a ilike b", "postgres", "upper")).toBe("SELECT * FROM t WHERE a ILIKE b");
    expect(applyKeywordCase("select a from x minus select b from y", "oracle", "upper")).toBe("SELECT a FROM x MINUS SELECT b FROM y");
    expect(applyKeywordCase("select * from t where a ilike b", "oracle", "upper")).toBe("SELECT * FROM t WHERE a ilike b");
  });
  it("keeps non-reserved keywords as typed", () => {
    expect(applyKeywordCase("select key, language, first, last, rows, identity from t", "postgres", "upper")).toBe(
      "SELECT key, language, first, last, rows, identity FROM t",
    );
  });
});
