import { describe, expect, it } from "vitest";
import {
  autoMatch,
  createTableSql,
  existingRows,
  formatKindOf,
  insertSql,
  mappingProblem,
  newRows,
  requestColumns,
  resultMessage,
  sqlTypeFor,
  tableNameForFile,
} from "./model";

const result = { imported: 0, failed: 0, errors: [], errorFile: null, errorFileError: null, cancelled: false, rolledBack: false, createdTable: false, elapsedMs: 1 };

describe("import model", () => {
  it("names a table after the file", () => {
    expect(tableNameForFile("import-sample.csv")).toBe("import_sample");
    expect(tableNameForFile("2024 sales (final).tsv")).toBe("t_2024_sales_final");
    expect(tableNameForFile("..csv")).toBe("imported_data");
  });

  it("recognises the format presets", () => {
    expect(formatKindOf(",")).toBe("csv");
    expect(formatKindOf("\t")).toBe("tsv");
    expect(formatKindOf("~")).toBe("custom");
  });

  it("maps inferred types to the dialect", () => {
    expect(sqlTypeFor("postgres", "double")).toBe("double precision");
    expect(sqlTypeFor("sqlite", "double")).toBe("double");
    expect(sqlTypeFor("mysql", "timestamp")).toBe("datetime");
    expect(sqlTypeFor("postgres", "timestamp")).toBe("timestamp");
    expect(sqlTypeFor("postgres", "bigint")).toBe("bigint");
  });

  it("matches columns by name, else by position", () => {
    expect(autoMatch(["id", "Name", "x"], ["name", "id"])).toEqual([1, 0, null]);
    expect(autoMatch(["a", "b", "c"], ["x", "y"])).toEqual([0, 1, null]);
  });

  it("builds the request columns", () => {
    const d = "postgres" as const;
    const file = [
      { name: "id", inferredType: "integer" as const },
      { name: "price", inferredType: "double" as const },
    ];
    const fresh = newRows(d, file);
    expect(requestColumns(fresh, ["id", "price"], true)).toEqual([
      { name: "id", type: "integer", source: 0 },
      { name: "price", type: "double precision", source: 1 },
    ]);
    fresh[1].from = "skip";
    expect(requestColumns(fresh, ["id", "price"], true)).toEqual([{ name: "id", type: "integer", source: 0 }]);

    const existing = existingRows([
      { name: "price", type: "numeric" },
      { name: "note", type: "text" },
    ]);
    expect(requestColumns(existing, ["id", "price"], false)).toEqual([
      { name: "price", type: "numeric", source: 1 },
      { name: "note", type: "text", source: null },
    ]);
    existing[1].from = 0;
    expect(requestColumns(existing, ["id", "price"], false)[1].source).toBe(0);
  });

  it("explains an unusable mapping", () => {
    const rows = newRows("sqlite", [{ name: "a", inferredType: "text" }]);
    expect(mappingProblem(rows, ["a"], true, "t")).toBeNull();
    expect(mappingProblem(rows, ["a"], true, " ")).toMatch(/table name/);
    rows[0].from = "skip";
    expect(mappingProblem(rows, ["a"], true, "t")).toMatch(/No column is mapped/);
    const dup = [
      { name: "a", type: "text", from: 0 as const },
      { name: "A", type: "text", from: 0 as const },
    ];
    expect(mappingProblem(dup, ["a"], true, "t")).toMatch(/twice/);
  });

  it("writes the DDL and the insert", () => {
    expect(createTableSql("postgres", "public", "t", [{ name: "id", type: "integer" }, { name: 'a"b', type: "text" }])).toBe(
      'create table "public"."t" (\n    "id" integer,\n    "a""b" text\n)',
    );
    expect(createTableSql("mysql", null, "t", [{ name: "id", type: "int" }])).toBe("create table `t` (\n    `id` int\n)");
    expect(insertSql("sqlite", "main", "t", ["a", "b"])).toBe('insert into "main"."t" ("a", "b")\nvalues (?, ?)');
  });

  it("words the result balloon", () => {
    expect(resultMessage({ ...result, imported: 1 }, "t")).toMatchObject({ kind: "success", body: "1 row imported to t" });
    const failed = { ...result, imported: 2, failed: 7, errors: Array.from({ length: 7 }, (_, i) => ({ row: i + 2, message: "bad" })), errorFile: "/tmp/e.txt" };
    const m = resultMessage(failed, "t");
    expect(m.kind).toBe("warning");
    expect(m.body).toContain("2 rows imported to t, 7 rows failed.");
    expect(m.body).toContain("Row 2: bad");
    expect(m.body).toContain("and 2 more errors");
    expect(m.body).toContain("/tmp/e.txt");
    expect(resultMessage({ ...result, cancelled: true, rolledBack: true }, "t").kind).toBe("warning");
    expect(resultMessage({ ...result, rolledBack: true, failed: 1, errors: [{ row: 3, message: "x" }] }, "t").kind).toBe("error");
  });
});
