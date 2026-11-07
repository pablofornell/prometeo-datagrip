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
});
