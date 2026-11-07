// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resetVisibleSchemasCache } from "../../state/schema-filter";
import { configFromForm, formFromDataSource, normalizedForm, reconnectsOnApply, reconnectsOnSave, savedPart } from "./model";
import { isSchemaVisible, parseVisibleSchemas, saveVisibleSchemas, visibleSchemaNodes, visibleSchemas, visibleSchemasRaw } from "./schemas";

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
    expect(reconnectsOnApply(JSON.parse(after), "d1", ds())).toBe(false);
    expect(after).not.toBe(before);
  });
  it("a rename needs a save but no reconnect; a host change needs both", () => {
    const form = formFromDataSource(ds());
    const before = JSON.stringify(form);
    const renamed = JSON.stringify({ ...form, name: "other" });
    expect(savedPart(renamed)).not.toBe(savedPart(before));
    expect(reconnectsOnApply(JSON.parse(renamed), "d1", ds())).toBe(false);
    expect(reconnectsOnApply({ ...form, host: "db2" }, "d1", ds())).toBe(true);
  });
});

describe("reconnectsOnSave mirrors the backend's connection fingerprint", () => {
  const base = { id: "d1", name: "pg", host: "h", port: 1, color: null, options: { a: "1" } } as never;
  it("name / color / password do not reconnect", () => {
    expect(reconnectsOnSave(base, { ...(base as object), name: "x", color: "#fff", password: "p" } as never)).toBe(false);
  });
  it("any options key does, except the view-only ones (visibleSchemas)", () => {
    expect(reconnectsOnSave(base, { ...(base as object), options: { a: "1", visibleSchemas: "[]" } } as never)).toBe(false);
    expect(reconnectsOnSave(base, { ...(base as object), options: { a: "1", b: "2" } } as never)).toBe(true);
    expect(reconnectsOnSave(base, { ...(base as object), host: "h2" } as never)).toBe(true);
    expect(reconnectsOnSave(base, { ...(base as object), options: { a: "1" } } as never)).toBe(false);
  });
});

describe("a legacy data source that still has options.visibleSchemas", () => {
  const legacy = () => ds({ visibleSchemas: '[["postgres","public"]]', comment: "c", custom: "x" });
  it("a rename sends the stored options unchanged and does not reconnect", () => {
    const stored = legacy();
    const form = formFromDataSource(stored);
    const base = JSON.stringify(normalizedForm(form));
    form.name = "pg renamed";
    const now = JSON.stringify(normalizedForm(form));
    expect(savedPart(now)).not.toBe(savedPart(base)); // needs a save
    const sent = configFromForm(form, "d1", stored);
    expect(sent.options).toEqual((stored as { options: object }).options);
    expect(reconnectsOnSave(stored as never, sent)).toBe(false);
    expect(reconnectsOnApply(form, "d1", stored)).toBe(false);
  });
  it("without the stored copy (a new source) the key is not sent", () => {
    expect(configFromForm(formFromDataSource(legacy()), null).options).toEqual({ comment: "c", custom: "x" });
  });
  it("what is compared is what is sent: a changed option or host reconnects", () => {
    const stored = legacy();
    const form = formFromDataSource(stored);
    form.options.custom = "y";
    expect(reconnectsOnApply(form, "d1", stored)).toBe(true);
    const moved = formFromDataSource(stored);
    moved.host = "db2";
    expect(reconnectsOnApply(moved, "d1", stored)).toBe(true);
  });
  it("a filter change in the form does not alter the legacy key that is sent", () => {
    const stored = legacy();
    const form = formFromDataSource(stored);
    form.options.visibleSchemas = '[["postgres","sales"]]';
    expect((configFromForm(form, "d1", stored).options as Record<string, string>).visibleSchemas).toBe('[["postgres","public"]]');
    expect(reconnectsOnApply(form, "d1", stored)).toBe(false);
  });
  it("a stored empty option stays as stored (not dropped, so no reconnect)", () => {
    const stored = ds({ empty: "" });
    expect(reconnectsOnApply(formFromDataSource(stored), "d1", stored)).toBe(false);
  });
});

describe("the console's schema switcher follows the schema filter", () => {
  const ora = { id: "o1", driver: "oracle", database: "FREEPDB1", user: "demo", options: {} } as never;
  const node = (name: string, system = false, isDefault = false) => ({ kind: "schema", path: [name], extra: { system, default: isDefault } });
  const all = [node("DEMO", false, true), node("SYSTEM", true), node("SYS", true)];
  it("default view: the non-system schemas only", () => {
    expect(visibleSchemaNodes(ora, all).map((n) => n.path[0])).toEqual(["DEMO"]);
  });
  it("a schema added through the picker (an Oracle-maintained one) is offered too", () => {
    saveVisibleSchemas("o1", JSON.stringify({ paths: [["DEMO"], ["SYSTEM"]] }));
    expect(visibleSchemaNodes(ora, all).map((n) => n.path[0])).toEqual(["DEMO", "SYSTEM"]);
  });
});
