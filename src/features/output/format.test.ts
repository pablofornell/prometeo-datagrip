// @vitest-environment node
import { describe, expect, it } from "vitest";
import { completedIn, firstKeyword, formatDuration, leadingComment, logTimestamp, reportsCount, rowsAffected, rowsRetrieved, summary, underlinePosition } from "./format";

describe("output log wording", () => {
  it("formats the timestamp like DataGrip", () => {
    expect(logTimestamp(new Date(2026, 10, 6, 13, 38, 47, 330))).toBe("[2026-11-06 13:38:47:330]");
  });
  it("formats durations", () => {
    expect(formatDuration(902)).toBe("902 ms");
    expect(formatDuration(1234)).toBe("1 s 234 ms");
    expect(formatDuration(65_000)).toBe("1 m 5 s");
  });
  it("rows retrieved", () => {
    expect(rowsRetrieved(18, 902, 21, 881)).toBe("18 rows retrieved starting from 1 in 902 ms (execution: 21 ms, fetching: 881 ms)");
    expect(rowsRetrieved(1, 5)).toBe("1 row retrieved starting from 1 in 5 ms");
    expect(rowsRetrieved(18, 1, 1, 0)).toBe("18 rows retrieved starting from 1 in 1 ms (execution: 1 ms, fetching: < 1 ms)");
    expect(rowsRetrieved(0, 5, 3, 2)).toBe("0 rows retrieved in 5 ms (execution: 3 ms, fetching: 2 ms)");
  });
  it("affected / completed / summary", () => {
    expect(rowsAffected(2, 4)).toBe("2 rows affected in 4 ms");
    expect(rowsAffected(1, 4)).toBe("1 row affected in 4 ms");
    expect(completedIn(12)).toBe("completed in 12 ms");
    expect(summary(3, 3, 0, 23, 65)).toBe("Summary: 3 of 3 statements executed in 23 ms (65 symbols in file)");
    expect(summary(2, 3, 1, 23)).toBe("Summary: 2 of 3 statements executed, 1 failed in 23 ms");
  });
  it("classifies statements", () => {
    expect(firstKeyword("-- x\n  /* y */ (select 1)")).toBe("SELECT");
    expect(reportsCount("create table t(a int)")).toBe(false);
    expect(reportsCount("update t set a=1")).toBe(true);
    expect(reportsCount("declare x number; begin null; end;", "oracle")).toBe(false);
    expect(reportsCount("call p(1)", "oracle")).toBe(false);
    expect(reportsCount("call p(1)", "mysql")).toBe(true);
  });
  it("names results by the leading comment", () => {
    expect(leadingComment("-- Top customers by revenue\nSELECT 1")).toBe("Top customers by revenue");
    expect(leadingComment("SELECT 1")).toBeNull();
  });
});

describe("rowsRetrieved from", () => {
  it("starts at the page offset", () => {
    expect(rowsRetrieved(500, 12, undefined, undefined, 501)).toBe("500 rows retrieved starting from 501 in 12 ms");
  });
});

describe("underlinePosition", () => {
  it("underlines the missing table, not the schema in front of it", () => {
    const sql = "select * from shop.no_such_table";
    const msg = 'relation "shop.no_such_table" does not exist';
    // PostgreSQL reports position 15 (the `s` of `shop`)
    expect(underlinePosition(sql, 15, msg)).toBe(20);
    expect(sql.slice(20 - 1)).toBe("no_such_table");
  });
  it("works on the backend's real message (`[42P01] ERROR: relation ... does not exist\n  Position: 15`)", () => {
    const sql = "select * from shop.no_such_table";
    expect(underlinePosition(sql, 15, '[42P01] ERROR: relation "shop.no_such_table" does not exist\n  Position: 15')).toBe(20);
    expect(underlinePosition('select * from "My Schema".t', 15, '[42P01] ERROR: relation "My Schema.t" does not exist')).toBe(27);
  });
  it("keeps every other position", () => {
    expect(underlinePosition("select * from nope", 15, 'relation "nope" does not exist')).toBe(15);
    expect(underlinePosition("selec 1", 1, 'syntax error at or near "selec"')).toBe(1);
    expect(underlinePosition("select 1", null, "boom")).toBeUndefined();
  });
  it("works after an emoji (UTF-16 positions)", () => {
    const sql = "select '😀' from s.t";
    expect(underlinePosition(sql, sql.indexOf("s.t") + 1, 'relation "s.t" does not exist')).toBe(sql.indexOf("t", sql.indexOf("s.t") + 2) + 1);
  });
});
