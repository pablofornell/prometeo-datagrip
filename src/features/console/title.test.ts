// @vitest-environment node
import { describe, expect, it } from "vitest";
import { qualifiedTitle, singleTable } from "./title";

describe("result tab names", () => {
  it("finds the single table of a plain select", () => {
    expect(singleTable("SELECT * FROM sales.invoices i WHERE i.paid = false", "postgres")).toEqual(["sales", "invoices"]);
    expect(singleTable("select id from customers order by 1 limit 5", "sqlite")).toEqual(["customers"]);
    expect(singleTable('select * from "My Table" as t', "postgres")).toEqual(["My Table"]);
    expect(singleTable("select * from `db`.`t`;", "mysql")).toEqual(["db", "t"]);
  });
  it("rejects joins, subqueries and set operations", () => {
    expect(singleTable("select * from a join b on a.id = b.id", "postgres")).toBeNull();
    expect(singleTable("select * from a, b", "postgres")).toBeNull();
    expect(singleTable("select * from (select 1) t", "postgres")).toBeNull();
    expect(singleTable("select 1 union select 2", "postgres")).toBeNull();
    expect(singleTable("select count(*) from a group by x", "postgres")).toBeNull();
    expect(singleTable("select 1", "postgres")).toBeNull();
    expect(singleTable("update t set a = 1", "postgres")).toBeNull();
  });
  it("qualifies like DataGrip", () => {
    expect(qualifiedTitle(["sales", "invoices"], "postgres", "postgres", "public")).toBe("postgres.sales.invoices");
    expect(qualifiedTitle(["customers"], "sqlite", "", "main")).toBe("main.customers");
    expect(qualifiedTitle(["orders"], "mysql", "demo", "demo")).toBe("demo.orders");
    expect(qualifiedTitle(["t"], "postgres", "postgres", null)).toBe("postgres.public.t");
  });
});
