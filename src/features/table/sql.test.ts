// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ColumnMeta, ObjectRef } from "../../api/types";
import { type GridChange, NEW_ROW } from "../../components/grid/types";
import {
  appendCondition,
  buildCondition,
  limitedSql,
  orderByToSort,
  literal,
  previewSql,
  tableQuerySql,
  qualifiedName,
  selectSql,
  sortToOrderBy,
  toRowChanges,
} from "./sql";

const ref: ObjectRef = { schema: "shop", name: "clients", kind: "table" };
const cols: ColumnMeta[] = [
  { name: "id", typeName: "int4", nullable: false, isPk: true, tableRef: "shop.clients" },
  { name: "Full Name", typeName: "varchar(20)", nullable: true, isPk: false, tableRef: "shop.clients" },
  { name: "active", typeName: "bool", nullable: true, isPk: false, tableRef: "shop.clients" },
];

describe("sql helpers", () => {
  it("quotes names and builds the export query", () => {
    expect(qualifiedName("postgres", ref)).toBe("shop.clients");
    expect(qualifiedName("mysql", { schema: "demo", name: "Order Items" })).toBe("demo.`Order Items`");
    expect(selectSql("postgres", ref, " active = false ", "name desc")).toBe('select * from "shop"."clients" where active = false order by name desc');
    expect(selectSql("postgres", ref, "", "")).toBe('select * from "shop"."clients"');
  });

  it("maps ORDER BY text to header sort and back", () => {
    expect(orderByToSort('"Full Name" desc, id', cols)).toEqual([
      { col: 1, dir: "desc" },
      { col: 0, dir: "asc" },
    ]);
    expect(orderByToSort("clients.id DESC", cols)).toEqual([{ col: 0, dir: "desc" }]);
    expect(orderByToSort("lower(id)", cols)).toEqual([]);
    expect(orderByToSort("nope", cols)).toEqual([]);
    expect(sortToOrderBy("postgres", cols, [{ col: 1, dir: "desc" }, { col: 0, dir: "asc" }])).toBe('"Full Name" desc, "id"');
  });

  it("builds column filter conditions", () => {
    expect(buildCondition("postgres", cols[0], "=", "5")).toBe('"id" = 5');
    expect(buildCondition("postgres", cols[1], "like", "a'b%")).toBe(`"Full Name" like 'a''b%'`);
    expect(buildCondition("postgres", cols[2], "=", "true")).toBe('"active" = true');
    expect(buildCondition("mysql", cols[0], "is null", "")).toBe("`id` is null");
    expect(appendCondition("a = 1", "b = 2")).toBe("a = 1 and b = 2");
    expect(appendCondition("a = 1 or c = 3", "b = 2")).toBe("(a = 1 or c = 3) and b = 2");
  });

  it("escapes backslashes in MySQL string literals (not in PostgreSQL / SQLite)", () => {
    // MySQL reads `\t` / `\'` inside '...' as escapes: `C:\temp` must be sent as 'C:\\temp'
    expect(buildCondition("mysql", cols[1], "=", "C:\\temp")).toBe("`Full Name` = 'C:\\\\temp'");
    expect(buildCondition("mysql", cols[1], "=", "a\\'b")).toBe("`Full Name` = 'a\\\\''b'");
    expect(buildCondition("mysql", cols[1], "like", "C:\\%")).toBe("`Full Name` like 'C:\\\\%'");
    expect(buildCondition("postgres", cols[1], "=", "C:\\temp")).toBe(`"Full Name" = 'C:\\temp'`);
    expect(buildCondition("sqlite", cols[1], "=", "C:\\temp")).toBe(`"Full Name" = 'C:\\temp'`);
    expect(literal("C:\\temp", "varchar", "mysql")).toBe("'C:\\\\temp'");
    expect(literal("C:\\temp", "varchar", "postgres")).toBe("'C:\\temp'");
  });

  it("previews MySQL values with the same escaping", () => {
    const changes: GridChange[] = [{ kind: "update", row: 0, key: { id: 1 }, values: { "Full Name": "C:\\temp" } }];
    expect(previewSql("mysql", ref, cols, changes)).toContain("= 'C:\\\\temp'");
  });

  it("writes the table editor query like DataGrip's Output (LIMIT page size + 1 to detect more rows)", () => {
    expect(tableQuerySql("postgres", ref, "", "", 500, 0)).toBe("SELECT t.* FROM shop.clients t LIMIT 501");
    expect(tableQuerySql("postgres", ref, " id > 5 ", "id desc", 100, 2)).toBe("SELECT t.* FROM shop.clients t WHERE id > 5 ORDER BY id desc LIMIT 101 OFFSET 200");
    expect(tableQuerySql("mysql", { schema: "demo", name: "Order Items", kind: "table" }, "", "", "all", 0)).toBe("SELECT t.* FROM demo.`Order Items` t");
  });

  it("previews changes like DataGrip (DELETE, UPDATE, INSERT)", () => {
    const changes: GridChange[] = [
      { kind: "insert", row: NEW_ROW, key: {}, values: { id: 9, "Full Name": "O'Hara" } },
      { kind: "update", row: 1, key: { id: 35 }, values: { "Full Name": "Valencia", active: null } },
      { kind: "delete", row: 0, key: { id: 16 }, values: {} },
    ];
    expect(previewSql("postgres", ref, cols, changes)).toBe(
      [
        "DELETE\nFROM shop.clients\nWHERE id = 16;",
        `UPDATE shop.clients\nSET "Full Name" = 'Valencia',\n    active = null\nWHERE id = 35;`,
        `INSERT INTO shop.clients (id, "Full Name")\nVALUES (9, 'O''Hara');`,
      ].join("\n\n"),
    );
  });
});

describe("toRowChanges", () => {
  it("orders delete, update, insert and keeps the key with a primary key", () => {
    const out = toRowChanges(
      [
        { kind: "insert", row: NEW_ROW, key: {}, values: { id: 1 } },
        { kind: "update", row: 0, key: { id: 2 }, values: { active: true } },
        { kind: "delete", row: 1, key: { id: 3 }, values: {} },
      ],
      cols,
    );
    expect(out.map((c) => c.kind)).toEqual(["delete", "update", "insert"]);
    expect(out[0]).toEqual({ kind: "delete", key: { id: 3 } });
    expect(out[1]).toEqual({ kind: "update", key: { id: 2 }, values: { active: true } });
  });

  it("sends the row locator of the change's row index instead of the key for tables without a primary key", () => {
    const nopk = [{ name: "a" }, { name: "b" }];
    // two identical rows (0 and 1): the index, not the values, tells which one changed
    const locators = ["t:(0,1)", "t:(0,2)", "t:(0,3)"];
    const out = toRowChanges(
      [
        { kind: "update", row: 1, key: { a: 1, b: "x" }, values: { b: "y" } },
        { kind: "delete", row: 0, key: { a: 1, b: "x" }, values: {} },
        { kind: "update", row: 2, key: { a: 2, b: null }, values: { b: "z" } },
        { kind: "insert", row: NEW_ROW, key: {}, values: { a: 5 } },
      ],
      nopk,
      (row) => locators[row],
    );
    expect(out).toEqual([
      { kind: "delete", rowLocator: "t:(0,1)" },
      { kind: "update", values: { b: "y" }, rowLocator: "t:(0,2)" },
      { kind: "update", values: { b: "z" }, rowLocator: "t:(0,3)" },
      { kind: "insert", values: { a: 5 } },
    ]);
  });

  it("refuses an update whose original row is gone", () => {
    expect(() => toRowChanges([{ kind: "update", row: 0, key: {}, values: { a: 1 } }], cols)).toThrow(/no longer loaded/);
  });
});

describe("Oracle", () => {
  const oref: ObjectRef = { schema: "DEMO", name: "EMP", kind: "table" };
  it("writes upper-case names bare and quotes the others", () => {
    expect(qualifiedName("oracle", oref)).toBe("DEMO.EMP");
    expect(qualifiedName("oracle", { schema: "DEMO", name: "Order Items" })).toBe('DEMO."Order Items"');
    expect(qualifiedName("oracle", { schema: "DEMO", name: "USER" })).toBe('DEMO."USER"');
    expect(selectSql("oracle", oref, "", "")).toBe('select * from "DEMO"."EMP"');
  });
  it("pages with OFFSET .. FETCH NEXT (one more row than the page)", () => {
    expect(tableQuerySql("oracle", oref, "", "", 500, 0)).toBe("SELECT t.* FROM DEMO.EMP t OFFSET 0 ROWS FETCH NEXT 501 ROWS ONLY");
    expect(tableQuerySql("oracle", oref, "SAL > 1", "ENAME", 100, 2)).toBe("SELECT t.* FROM DEMO.EMP t WHERE SAL > 1 ORDER BY ENAME OFFSET 200 ROWS FETCH NEXT 101 ROWS ONLY");
    expect(tableQuerySql("oracle", oref, "", "", "all", 0)).toBe("SELECT t.* FROM DEMO.EMP t");
  });
  it("date and timestamp literals are ANSI literals; raw is hextoraw", () => {
    expect(literal("2024-05-06", "DATE", "oracle")).toBe("date '2024-05-06'");
    expect(literal("2024-05-06 07:08:09", "DATE", "oracle")).toBe("timestamp '2024-05-06 07:08:09'");
    expect(literal("2024-05-06T07:08:09.5", "TIMESTAMP(6)", "oracle")).toBe("timestamp '2024-05-06 07:08:09.5'");
    expect(literal({ $bin: "cafe", len: 2 }, "RAW", "oracle")).toBe("hextoraw('cafe')");
    expect(literal("o'neil", "VARCHAR2", "oracle")).toBe("'o''neil'");
  });
});

describe("limitedSql (the Export Data preview)", () => {
  it("pages in the dialect of the data source", () => {
    expect(limitedSql("postgres", "select * from t", 10)).toBe("select * from t limit 10");
    expect(limitedSql("mysql", "select * from t;", 10)).toBe("select * from t limit 10");
    expect(limitedSql("sqlite", "select * from t order by a\n", 10)).toBe("select * from t order by a limit 10");
    // Oracle has no LIMIT (ORA-03047 at the `limit`)
    expect(limitedSql("oracle", "SELECT * FROM DEMO.ORDERS", 10)).toBe("SELECT * FROM DEMO.ORDERS fetch first 10 rows only");
    expect(limitedSql("oracle", "select * from t order by a;  ", 10)).toBe("select * from t order by a fetch first 10 rows only");
  });
});
