// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectRef, ResultSet } from "../../api/types";

const col = { name: "id", typeName: "int4", nullable: false, isPk: true, tableRef: "shop.customers" };
const page = (n: number, extra: Partial<ResultSet> = {}): ResultSet => ({ columns: [col], rows: Array.from({ length: n }, (_, i) => [i]), hasMore: false, totalHint: null, ...extra });
const tableData = vi.fn();
const inSession = vi.fn();
vi.mock("../../api/db", () => ({ tableData: (...a: unknown[]) => tableData(...a), isTauri: () => false, applyChanges: vi.fn(), executeCollect: vi.fn(), sessionTxStatus: vi.fn() }));
vi.mock("../../state/settings", () => ({ settings: { gridPageSize: 500 } }));
vi.mock("./session", async (orig) => ({ ...(await orig<typeof import("./session")>()), tableDataInSession: (...a: unknown[]) => inSession(...a) }));
import { createTableSource, type QueryReport } from "./source";
import { tableQuerySql } from "./sql";
import { rowsRetrieved } from "../output/format";

const ref: ObjectRef = { schema: "shop", name: "customers", kind: "table" };

beforeEach(() => {
  tableData.mockReset();
  inSession.mockReset();
});

describe("the table editor reports its queries (for the Output log)", () => {
  it("logs `SELECT t.* FROM shop.customers t LIMIT 501` with the row count", async () => {
    tableData.mockResolvedValue(page(10));
    const reports: QueryReport[] = [];
    const src = createTableSource("d1", ref, {}, () => undefined, { onQuery: (r) => reports.push(r) });
    await src.load();
    expect(reports).toHaveLength(1);
    const q = reports[0].query;
    expect(tableQuerySql("postgres", ref, q.where, q.orderBy, q.pageSize, q.page)).toBe("SELECT t.* FROM shop.customers t LIMIT 501");
    expect(rowsRetrieved(reports[0].rows, reports[0].ms)).toMatch(/^10 rows retrieved starting from 1 in/);
  });
  it("loading All reports the true row count, not the 500 of the first chunk", async () => {
    tableData.mockResolvedValue(page(500, { totalHint: 100000, hasMore: true }));
    const reports: QueryReport[] = [];
    const src = createTableSource("d1", ref, {}, () => undefined, { onQuery: (r) => reports.push(r) });
    await src.load({ pageSize: "all" });
    expect(reports[0].rows).toBe(100000);
    expect(src.rowCount()).toBe(100000);
    expect(tableQuerySql("postgres", ref, "", "", reports[0].query.pageSize, 0)).toBe("SELECT t.* FROM shop.customers t");
  });
  it("reports a failing query with the server message", async () => {
    tableData.mockRejectedValue(new Error('relation "shop.customers" does not exist'));
    const reports: QueryReport[] = [];
    const src = createTableSource("d1", ref, {}, () => undefined, { onQuery: (r) => reports.push(r) });
    await expect(src.load()).rejects.toThrow();
    expect(reports[0].error).toContain("does not exist");
  });
});

describe("a Manual-mode table editor whose session is gone", () => {
  it("reads again through the session the host reopens", async () => {
    inSession.mockRejectedValueOnce(new Error("Session 's1' does not exist")).mockResolvedValueOnce(page(3));
    const onSessionLost = vi.fn(async () => "s2");
    const src = createTableSource("d1", ref, {}, () => "s1", { onSessionLost });
    await src.load();
    expect(onSessionLost).toHaveBeenCalledOnce();
    expect(inSession.mock.calls[1][1]).toBe("s2");
    expect(src.rowCount()).toBe(3);
  });
  it("falls back to the pool when the host could not reopen it", async () => {
    inSession.mockRejectedValueOnce(new Error("Session 's1' does not exist"));
    tableData.mockResolvedValue(page(2));
    const src = createTableSource("d1", ref, {}, () => "s1", { onSessionLost: async () => undefined });
    await src.load();
    expect(src.rowCount()).toBe(2);
  });
  it("does not swallow other errors", async () => {
    inSession.mockRejectedValue(new Error("syntax error"));
    const src = createTableSource("d1", ref, {}, () => "s1", { onSessionLost: vi.fn() });
    await expect(src.load()).rejects.toThrow("syntax error");
  });
});
