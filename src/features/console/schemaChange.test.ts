// @vitest-environment node
import { describe, expect, it } from "vitest";
import { schemaChange } from "./editable";

describe("schemaChange: only a statement that STARTS with SET search_path / SET SCHEMA / USE changes the schema", () => {
  it("does not match `set` / `use` inside other statements (the old /\\b(set|use)\\b/ on the whole script did)", () => {
    expect(schemaChange("update t set a = 1 where id = 2", "postgres")).toBeNull();
    expect(schemaChange("update t set a = 1", "mysql")).toBeNull();
    expect(schemaChange("select 'use x' from t", "mysql")).toBeNull();
    expect(schemaChange("insert into t(use_it) values (1) on conflict do update set a = 1", "postgres")).toBeNull();
    expect(schemaChange("select * from settings", "postgres")).toBeNull();
    expect(schemaChange("set statement_timeout = 5", "postgres")).toBeNull();
    expect(schemaChange("use main", "sqlite")).toBeNull();
  });
  it("reads the new schema", () => {
    expect(schemaChange("SET search_path TO shop, public", "postgres")).toEqual({ schema: "shop" });
    expect(schemaChange("set search_path = \"My Schema\"", "postgres")).toEqual({ schema: "My Schema" });
    expect(schemaChange("-- c\nset session search_path to 'a'", "postgres")).toEqual({ schema: "a" });
    expect(schemaChange("set schema 'x'", "postgres")).toEqual({ schema: "x" });
    expect(schemaChange("USE `demo`", "mysql")).toEqual({ schema: "demo" });
    expect(schemaChange("use demo", "mysql")).toEqual({ schema: "demo" });
  });
  it("flags a change whose target it cannot read", () => {
    expect(schemaChange("set search_path to default", "postgres")).toEqual({ schema: null });
    expect(schemaChange("reset search_path", "postgres")).toEqual({ schema: null });
    expect(schemaChange("discard all", "postgres")).toEqual({ schema: null });
  });
});
