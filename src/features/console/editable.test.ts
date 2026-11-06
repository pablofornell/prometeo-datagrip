// @vitest-environment node
import { describe, expect, it } from "vitest";
import { keyedChanges } from "../output/edit";
import { plainSelect, tableOf } from "./editable";

const pg = (tableRef: string | null) => ({ tableRef });

describe("editable results", () => {
  it("accepts plain single-table selects", () => {
    expect(tableOf([pg(null)], "select id, name from customers where id < 5 order by 1 limit 10", "sqlite")).toEqual(["customers"]);
    expect(tableOf([pg("shop.customers"), pg("shop.customers")], "select * from shop.customers c", "postgres")).toEqual(["shop", "customers"]);
    expect(tableOf([pg(null)], "SELECT t.* FROM `demo`.`orders` t", "mysql")).toEqual(["demo", "orders"]);
  });
  it("rejects joins, aggregates, distinct and set operations", () => {
    expect(tableOf([pg("s.a"), pg("s.a")], "select * from s.a x join s.a y on x.id = y.id", "postgres")).toBeNull();
    expect(plainSelect("select distinct name from t", "postgres")).toBe(false);
    expect(plainSelect("select max(id) as id from t", "mysql")).toBe(false);
    expect(plainSelect("select max(id) as id from t", "postgres")).toBe(true); // PG: the column has no tableRef
    expect(plainSelect("select * from t where id in (select 1)", "mysql")).toBe(true);
    expect(plainSelect("select id from t group by id", "sqlite")).toBe(false);
    expect(plainSelect("select id, row_number() over (order by id) from t", "postgres")).toBe(false);
  });
  it("rejects a view (PG reports its base table)", () => {
    expect(tableOf([pg("shop.orders")], "select * from shop.v_orders", "postgres")).toBeNull();
  });
});

describe("keyedChanges", () => {
  const edit = { table: { name: "t", kind: "table" as const }, key: ["id"], editable: [true, true, false] };
  const meta = [{ name: "id" }, { name: "name" }, { name: "total" }];
  const rows = [
    [1, "a", 10],
    [2, "b", 20],
  ];
  it("keys update / delete by the table key only", () => {
    const out = keyedChanges(
      edit,
      meta,
      rows,
      [
        { kind: "update", row: 1, key: { id: 2, name: "b", total: 20 }, values: { name: "x" } },
        { kind: "insert", row: -1, key: {}, values: { name: "n" } },
      ],
    );
    expect(out[0].key).toEqual({ id: 2 });
    expect(out[1].key).toEqual({});
  });
  it("throws when the original row is gone", () => {
    expect(() => keyedChanges(edit, meta, rows, [{ kind: "delete", row: 5, key: {}, values: {} }])).toThrow();
  });
});
