// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnMeta, DataSource } from "../../api/types";

// orders(id pk, customer_id, total) in every schema
let keys: { kind: string; extra: { columns: string[] } }[] = [];
vi.mock("../../api/db", () => ({
  introspect: async (_id: string, path: string[]) => {
    const last = path[path.length - 1];
    if (last === "tables") return [{ name: "orders", path: [...path, "orders"], extra: { schema: path[path.length - 2] } }];
    if (last === "columns") return ["id", "customer_id", "total"].map((n) => ({ name: n, extra: {} }));
    if (last === "keys") return keys;
    return [];
  },
}));
import { keyedChanges } from "../output/edit";
import { resolveEdit, selectItems } from "./editable";

const ds = (driver: DataSource["driver"]) => ({ id: "x", driver, database: "demo", readOnly: false }) as DataSource;
const m = (name: string, tableRef: string | null): ColumnMeta => ({ name, tableRef, typeName: "int", nullable: true, isPk: false });

beforeEach(() => {
  keys = [{ kind: "primaryKey", extra: { columns: ["id"] } }];
});

describe("editable results through aliases", () => {
  it("PG: `customer_id as id` is not the key and not editable (it updated the wrong order)", async () => {
    const meta = [m("id", "public.orders"), m("total", "public.orders")];
    expect(await resolveEdit(ds("postgres"), meta, "select customer_id as id, total from orders", "public")).toBeNull();
  });
  it("PG: a renamed column stays read-only while the key is intact", async () => {
    const meta = [m("id", "public.orders"), m("total", "public.orders")];
    const e = await resolveEdit(ds("postgres"), meta, "select id, customer_id as total from orders", "public");
    expect(e?.editable).toEqual([true, false]);
    expect(e?.key).toEqual(["id"]);
  });
  it("MySQL / SQLite: `id + 1 as id` and `case ... end as id` are expressions", async () => {
    const meta = [m("id", null), m("total", null)];
    expect(await resolveEdit(ds("mysql"), meta, "select id + 1 as id, total from orders", "demo")).toBeNull();
    expect(await resolveEdit(ds("sqlite"), meta, "select case when 1 then id end as id, total from orders", null)).toBeNull();
    expect(await resolveEdit(ds("mysql"), meta, "select -id as id, total from orders", "demo")).toBeNull();
    expect(await resolveEdit(ds("mysql"), meta, "select cast(id as signed) as id, total from orders", "demo")).toBeNull();
    expect(await resolveEdit(ds("sqlite"), meta, "select id || '' as id, total from orders", null)).toBeNull();
  });
  it("plain references stay editable: col, t.col, col as col, star, star + extras", async () => {
    const plain = async (driver: DataSource["driver"], sql: string, names: string[]) =>
      resolveEdit(ds(driver), names.map((n) => m(n, driver === "postgres" ? "public.orders" : null)), sql, "public");
    expect((await plain("postgres", "select id, total from orders", ["id", "total"]))?.editable).toEqual([true, true]);
    expect((await plain("postgres", "select o.id, o.total from orders o", ["id", "total"]))?.editable).toEqual([true, true]);
    expect((await plain("mysql", "select id as id, total from orders", ["id", "total"]))?.editable).toEqual([true, true]);
    expect((await plain("sqlite", "select * from orders", ["id", "customer_id", "total"]))?.editable).toEqual([true, true, true]);
    expect((await plain("sqlite", "select o.* from orders o", ["id", "customer_id", "total"]))?.key).toEqual(["id"]);
    expect((await plain("sqlite", "select total, * from orders", ["total", "id", "customer_id", "total"]))).toBeNull(); // duplicate name
    expect((await plain("sqlite", "select 1 as one, * from orders", ["one", "id", "customer_id", "total"]))?.editable).toEqual([false, true, true, true]);
  });
  it("the key built from the loaded row is the real id, not the aliased column", async () => {
    // with the old name-only matching this gave key {"id":7} (customer 7's id) for order 1
    const meta = [m("id", "public.orders"), m("total", "public.orders")];
    const e = await resolveEdit(ds("postgres"), meta, "select customer_id as id, total from orders", "public");
    expect(e).toBeNull();
    const ok = await resolveEdit(ds("postgres"), [m("id", "public.orders"), m("total", "public.orders")], "select id, total from orders", "public");
    expect(keyedChanges(ok!, meta, [[1, 10]], [{ kind: "update", row: 0, key: {}, values: { total: 0 } }])[0].key).toEqual({ id: 1 });
  });
});

describe("selectItems", () => {
  it("reads the select list", () => {
    expect(selectItems("select id, t.total as total, o.*, count(*) c, x y from orders t", "postgres")).toEqual([
      { star: false, column: "id", alias: null },
      { star: false, column: "total", alias: "total" },
      { star: true },
      { star: false, column: null, alias: null },
      { star: false, column: "x", alias: "y" },
    ]);
    expect(selectItems("select `id` as `id` from `orders`", "mysql")).toEqual([{ star: false, column: "id", alias: "id" }]);
  });
});
