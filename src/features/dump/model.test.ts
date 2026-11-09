import { describe, expect, it } from "vitest";
import {
  defaultDumpOptions,
  dumpFileName,
  dumpFraction,
  dumpOptionsProblem,
  dumpProgressText,
  dumpResultText,
  dumpScopeText,
  groupDigits,
  normalizeDumpOptions,
  parseBatchSize,
  parseCommitEvery,
  phaseLabel,
  routinesLabel,
} from "./model";

describe("dump options", () => {
  it("start from the backend's defaults", () => {
    // the same values as DumpOptions::default() in crates/dbcore/src/dump.rs
    expect(defaultDumpOptions()).toEqual({
      data: true,
      dropIfExists: false,
      includeViews: true,
      includeSequences: true,
      includeRoutines: false,
      targetSchema: null,
      batchSize: 500,
      includeDdl: true,
      commitEvery: 0,
    });
    expect(dumpOptionsProblem(defaultDumpOptions())).toBeNull();
  });

  it("reads commit every N rows as a whole number from 0 to 1000000", () => {
    expect(parseCommitEvery("0")).toBe(0);
    expect(parseCommitEvery(" 5000 ")).toBe(5000);
    expect(parseCommitEvery("1000000")).toBe(1000000);
    expect(parseCommitEvery("1000001")).toBeNull();
    expect(parseCommitEvery("-1")).toBeNull();
    expect(parseCommitEvery("2.5")).toBeNull();
    expect(parseCommitEvery("")).toBeNull();
  });

  it("needs at least the structure or the data", () => {
    const none = { ...defaultDumpOptions(), includeDdl: false, data: false };
    expect(dumpOptionsProblem(none)).toMatch(/Structure/);
    expect(dumpOptionsProblem({ ...none, data: true })).toBeNull();
    expect(dumpOptionsProblem({ ...defaultDumpOptions(), data: false })).toBeNull();
    expect(dumpOptionsProblem({ ...defaultDumpOptions(), includeDdl: false })).toBeNull();
  });

  it("refuses an unusable commit interval only when rows are written", () => {
    const o = defaultDumpOptions();
    expect(dumpOptionsProblem({ ...o, commitEvery: -1 })).toMatch(/Commit every/);
    expect(dumpOptionsProblem({ ...o, commitEvery: 1.5 })).toMatch(/Commit every/);
    expect(dumpOptionsProblem({ ...o, commitEvery: 1000001 })).toMatch(/Commit every/);
    expect(dumpOptionsProblem({ ...o, commitEvery: 0 })).toBeNull();
    expect(dumpOptionsProblem({ ...o, commitEvery: 10 })).toBeNull();
    // no rows, so the INSERT settings (fields disabled in the dialog) do not block the dump
    expect(dumpOptionsProblem({ ...o, data: false, includeDdl: true, batchSize: 0, commitEvery: -1 })).toBeNull();
  });

  it("reads rows per INSERT as a whole number from 1 to 100000", () => {
    expect(parseBatchSize("1")).toBe(1);
    expect(parseBatchSize(" 250 ")).toBe(250);
    expect(parseBatchSize("100000")).toBe(100000);
    expect(parseBatchSize("0")).toBeNull();
    expect(parseBatchSize("100001")).toBeNull();
    expect(parseBatchSize("-3")).toBeNull();
    expect(parseBatchSize("1.5")).toBeNull();
    expect(parseBatchSize("1e3")).toBeNull();
    expect(parseBatchSize("")).toBeNull();
  });

  it("refuses an unusable batch size and says why", () => {
    const o = { ...defaultDumpOptions(), batchSize: 0 };
    expect(dumpOptionsProblem(o)).toMatch(/Rows per INSERT/);
    expect(dumpOptionsProblem({ ...o, batchSize: 1.5 })).toMatch(/Rows per INSERT/);
    expect(dumpOptionsProblem({ ...o, batchSize: 100001 })).toMatch(/Rows per INSERT/);
    expect(dumpOptionsProblem({ ...o, batchSize: 1 })).toBeNull();
  });

  it("checks the target schema name", () => {
    expect(dumpOptionsProblem({ ...defaultDumpOptions(), targetSchema: "  " })).toBeNull();
    expect(dumpOptionsProblem({ ...defaultDumpOptions(), targetSchema: "x".repeat(129) })).toMatch(/128/);
    expect(dumpOptionsProblem({ ...defaultDumpOptions(), targetSchema: "a\nb" })).toMatch(/control characters/);
  });

  it("sends an empty target schema as null, a typed one trimmed", () => {
    expect(normalizeDumpOptions({ ...defaultDumpOptions(), targetSchema: "   " }).targetSchema).toBeNull();
    expect(normalizeDumpOptions({ ...defaultDumpOptions(), targetSchema: " staging " }).targetSchema).toBe("staging");
    const o = defaultDumpOptions();
    expect(normalizeDumpOptions(o)).toEqual(o);
  });

  it("adds the table subset of the request only when there is one", () => {
    expect(normalizeDumpOptions(defaultDumpOptions())).not.toHaveProperty("tables");
    expect(normalizeDumpOptions(defaultDumpOptions(), ["ORDERS", "ITEMS"]).tables).toEqual(["ORDERS", "ITEMS"]);
  });
});

describe("dump file name", () => {
  it("is the schema name with .sql", () => {
    expect(dumpFileName("sales")).toBe("sales.sql");
    expect(dumpFileName("my schema")).toBe("my_schema.sql");
    expect(dumpFileName("  shop  ")).toBe("shop.sql");
    expect(dumpFileName("")).toBe("dump.sql");
    expect(dumpFileName("...")).toBe("dump.sql");
    expect(dumpFileName("a/b\\c")).toBe("a_b_c.sql");
  });
});

describe("dump labels and progress", () => {
  it("names the routines option after what the driver really dumps", () => {
    expect(routinesLabel("postgres")).toBe("Triggers");
    expect(routinesLabel("mysql")).toBe("Routines and triggers");
    expect(routinesLabel("sqlite")).toBe("Routines and triggers");
  });

  it("gives each backend phase a sentence and passes unknown ones through", () => {
    expect(phaseLabel("tables")).toBe("Writing tables");
    expect(phaseLabel("foreign keys")).toBe("Writing foreign keys");
    expect(phaseLabel("something new")).toBe("something new");
  });

  it("groups digits in thousands", () => {
    expect(groupDigits(0)).toBe("0");
    expect(groupDigits(999)).toBe("999");
    expect(groupDigits(1000)).toBe("1,000");
    expect(groupDigits(1234567)).toBe("1,234,567");
  });

  it("gives the share of the tables written, 0 while the total is unknown", () => {
    expect(dumpFraction({ phase: "tables", tablesDone: 3, tablesTotal: 12, rows: 0 })).toBeCloseTo(0.25);
    expect(dumpFraction({ phase: "tables", tablesDone: 0, tablesTotal: 0, rows: 0 })).toBe(0);
    expect(dumpFraction({ phase: "tables", tablesDone: 5, tablesTotal: 4, rows: 0 })).toBe(1);
  });

  it("says which table and how many rows a progress event is at", () => {
    expect(dumpProgressText({ phase: "tables", tablesDone: 3, tablesTotal: 12, rows: 1234 })).toBe("Writing tables: table 3 of 12, 1,234 rows");
    expect(dumpProgressText({ phase: "data", tablesDone: 1, tablesTotal: 1, rows: 1 })).toBe("Writing rows: table 1 of 1, 1 row");
    expect(dumpProgressText({ phase: "schema", tablesDone: 0, tablesTotal: 0, rows: 0 })).toBe("Reading the schema: 0 tables, 0 rows");
  });

  it("names the table being written, its place in the run and its rows", () => {
    expect(dumpProgressText({ phase: "data", tablesDone: 2, tablesTotal: 5, rows: 1234, table: "ORDERS" })).toBe(
      "Dumping ORDERS (2 of 5) — 1,234 rows",
    );
    expect(dumpProgressText({ phase: "data", tablesDone: 1, tablesTotal: 1, rows: 1, table: "t" })).toBe("Dumping t (1 of 1) — 1 row");
    // between tables the table is absent again
    expect(dumpProgressText({ phase: "tables", tablesDone: 2, tablesTotal: 5, rows: 1234, table: null })).toBe("Writing tables: table 2 of 5, 1,234 rows");
  });

  it("says what the dialog's source is: the schema, or the tables of it", () => {
    expect(dumpScopeText("sales")).toBe("sales");
    expect(dumpScopeText("sales", ["ORDERS"])).toBe("1 table of sales");
    expect(dumpScopeText("sales", ["ORDERS", "ITEMS", "USERS"])).toBe("3 tables of sales");
  });

  it("describes a finished dump", () => {
    expect(dumpResultText({ tables: 1, rows: 1 })).toBe("1 table, 1 row");
    expect(dumpResultText({ tables: 3, rows: 1234567 })).toBe("3 tables, 1,234,567 rows");
    expect(dumpResultText({ tables: 0, rows: 0 })).toBe("0 tables, 0 rows");
  });
});
