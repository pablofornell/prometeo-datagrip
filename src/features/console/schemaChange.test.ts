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
    expect(schemaChange("SET search_path TO shop", "postgres")).toEqual({ schema: "shop", searchPath: "shop" });
    expect(schemaChange("set search_path = \"My Schema\"", "postgres")).toEqual({ schema: "My Schema", searchPath: '"My Schema"' });
    expect(schemaChange("-- c\nset session search_path to 'a'", "postgres")).toEqual({ schema: "a", searchPath: "'a'" });
    expect(schemaChange("set schema 'x'", "postgres")).toEqual({ schema: "x", searchPath: "'x'" });
    expect(schemaChange("USE `demo`", "mysql")).toEqual({ schema: "demo" });
    expect(schemaChange("use demo", "mysql")).toEqual({ schema: "demo" });
  });
  it("flags a change whose target it cannot read", () => {
    expect(schemaChange("set search_path to default", "postgres")).toEqual({ schema: null, searchPath: null });
    expect(schemaChange("reset search_path", "postgres")).toEqual({ schema: null, searchPath: null });
    expect(schemaChange("discard all", "postgres")).toEqual({ schema: null, searchPath: null });
  });
  it("a search_path list does not name a schema: `$user` and pg_temp are not the current schema (the server says which is)", () => {
    expect(schemaChange('SET search_path TO "$user", public', "postgres")).toEqual({ schema: null, searchPath: '"$user", public' });
    expect(schemaChange("set search_path to pg_temp, public;", "postgres")).toEqual({ schema: null, searchPath: "pg_temp, public" });
    expect(schemaChange("set search_path = shop, public", "postgres")).toEqual({ schema: null, searchPath: "shop, public" });
    expect(schemaChange('set search_path to "$user"', "postgres")).toEqual({ schema: null, searchPath: '"$user"' });
    expect(schemaChange("set search_path to pg_temp", "postgres")).toEqual({ schema: null, searchPath: "pg_temp" });
  });
});
