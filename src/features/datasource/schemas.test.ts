// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resetVisibleSchemasCache } from "../../state/schema-filter";
import { configFromForm, formFromDataSource, reconnectPart, reconnectsOnSave, savedPart } from "./model";
import { isSchemaVisible, parseVisibleSchemas, saveVisibleSchemas, visibleSchemas, visibleSchemasRaw } from "./schemas";

const ds = (options: Record<string, string> = {}) =>
  ({ id: "d1", name: "pg", driver: "postgres", host: "localhost", port: 5432, database: "postgres", user: "u", file: "", urlOverride: null, options, color: null, readOnly: false, hasPassword: true, passwordStorage: "none" }) as never;

beforeEach(() => resetVisibleSchemasCache());

describe("the schema filter is a UI setting, not a data source option", () => {
  it("nothing stored and no legacy option: every non-system schema", () => {
    expect(visibleSchemas(ds())).toBeNull();
    expect(isSchemaVisible(ds(), ["postgres", "anything"])).toBe(true);
  });
  it("reads a legacy options.visibleSchemas as the fallback (migration)", () => {
    const legacy = ds({ visibleSchemas: JSON.stringify([["postgres", "sales"]]) });
    expect(visibleSchemas(legacy)).toEqual([["postgres", "sales"]]);
    expect(isSchemaVisible(legacy, ["postgres", "sales"])).toBe(true);
    expect(isSchemaVisible(legacy, ["postgres", "public"])).toBe(false);
  });
  it("the stored value wins over the legacy option, also when it says 'everything'", () => {
    const legacy = ds({ visibleSchemas: JSON.stringify([["postgres", "sales"]]) });
    saveVisibleSchemas("d1", JSON.stringify([["postgres", "public"]]));
    expect(visibleSchemas(legacy)).toEqual([["postgres", "public"]]);
    saveVisibleSchemas("d1", undefined);
    expect(visibleSchemasRaw(legacy)).toBe("");
    expect(visibleSchemas(legacy)).toBeNull();
  });
  it("ignores malformed text", () => {
    expect(parseVisibleSchemas("{nope")).toBeNull();
    expect(parseVisibleSchemas('[["a"],"b"]')).toBeNull();
  });
});

describe("the Data Sources dialog form", () => {
  it("shows the filter (stored, else legacy) but never sends it to the backend", () => {
    saveVisibleSchemas("d1", JSON.stringify([["postgres", "sales"]]));
    const form = formFromDataSource(ds({ visibleSchemas: "[[\"x\"]]", comment: "c" }));
    expect(form.options.visibleSchemas).toBe(JSON.stringify([["postgres", "sales"]]));
    const cfg = configFromForm(form, "d1");
    expect(cfg.options).toEqual({ comment: "c" });
  });
  it("a filter-only change does not touch the saved part nor the reconnect part", () => {
    const form = formFromDataSource(ds());
    const before = JSON.stringify(form);
    form.options.visibleSchemas = '[["postgres","public"]]';
    const after = JSON.stringify(form);
    expect(savedPart(after)).toBe(savedPart(before));
    expect(reconnectPart(after)).toBe(reconnectPart(before));
    expect(after).not.toBe(before);
  });
  it("a rename needs a save but no reconnect; a host change needs both", () => {
    const form = formFromDataSource(ds());
    const before = JSON.stringify(form);
    const renamed = JSON.stringify({ ...form, name: "other" });
    expect(savedPart(renamed)).not.toBe(savedPart(before));
    expect(reconnectPart(renamed)).toBe(reconnectPart(before));
    const moved = JSON.stringify({ ...form, host: "db2" });
    expect(reconnectPart(moved)).not.toBe(reconnectPart(before));
  });
});

describe("reconnectsOnSave mirrors the backend's connection fingerprint", () => {
  const base = { id: "d1", name: "pg", host: "h", port: 1, color: null, options: { a: "1" } } as never;
  it("name / color / password do not reconnect", () => {
    expect(reconnectsOnSave(base, { ...(base as object), name: "x", color: "#fff", password: "p" } as never)).toBe(false);
  });
  it("any options key does: that is why visibleSchemas must not be one", () => {
    expect(reconnectsOnSave(base, { ...(base as object), options: { a: "1", visibleSchemas: "[]" } } as never)).toBe(true);
    expect(reconnectsOnSave(base, { ...(base as object), host: "h2" } as never)).toBe(true);
    expect(reconnectsOnSave(base, { ...(base as object), options: { a: "1" } } as never)).toBe(false);
  });
});
