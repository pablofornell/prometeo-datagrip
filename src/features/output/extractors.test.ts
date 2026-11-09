// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SnapshotObject } from "../../api/types";
import { EXPORT_CHARSETS, EXTRACTORS, extractorLabel, extractorMenuItems, primaryKeyColumns, replacedNotice } from "./extractors";

describe("data extractors", () => {
  it("every extractor has a unique id and the popup lists them in the three sections", () => {
    expect(new Set(EXTRACTORS.map((x) => x.id)).size).toBe(EXTRACTORS.length);
    const items = extractorMenuItems("csv", () => {});
    const headers = items.filter((i) => i.type === "header").map((i) => (i as { label: string }).label);
    expect(headers).toEqual(["Built-in", "CSV", "Other"]);
    const rows = items.filter((i) => !i.type) as { label: string; checked?: boolean }[];
    expect(rows.map((r) => r.label)).toEqual(EXTRACTORS.map((x) => x.label));
    expect(rows.filter((r) => r.checked).map((r) => r.label)).toEqual(["CSV"]);
    expect(rows.slice(0, 3).map((r) => r.label)).toEqual(["SQL Inserts", "SQL Updates", "Where Clause"]);
  });
  it("picking a row reports its format", () => {
    const pick = vi.fn();
    const row = (extractorMenuItems("csv", pick).find((i) => !i.type && i.label === "XML") as { run: () => void }).run;
    row();
    expect(pick).toHaveBeenCalledWith("xml");
  });
  it("the toolbar says SQL for the INSERT / UPDATE extractors", () => {
    expect(extractorLabel("sqlInsert")).toBe("SQL");
    expect(extractorLabel("sqlUpdate")).toBe("SQL");
    expect(extractorLabel("csvPipe")).toBe("Pipe-separated");
    expect(extractorLabel("json")).toBe("JSON");
  });
});

describe("export charsets and the replaced-characters notice", () => {
  it("offers the four file encodings of the backend, UTF-8 first", () => {
    expect(EXPORT_CHARSETS.map((c) => c.value)).toEqual(["utf8", "utf8Bom", "windows1252", "utf16Le"]);
    expect(EXPORT_CHARSETS.map((c) => c.label)).toEqual(["UTF-8", "UTF-8 with BOM", "Windows-1252", "UTF-16LE"]);
  });
  it("says nothing when no character was replaced", () => {
    expect(replacedNotice(0)).toBe("");
  });
  it("counts the replaced characters in the singular and the plural", () => {
    expect(replacedNotice(1)).toBe('1 character was replaced with "?" (not in Windows-1252)');
    expect(replacedNotice(12)).toBe('12 characters were replaced with "?" (not in Windows-1252)');
  });
});

describe("primary key of a table export", () => {
  const col = (name: string, isPk = false) => ({ name, typeName: "integer", isPk });
  const objects: SnapshotObject[] = [
    { schema: "shop", name: "orders", kind: "table", columns: [col("id", true), col("total")] },
    { schema: "shop", name: "lines", kind: "table", columns: [col("order_id", true), col("line_no", true), col("sku")] },
    { schema: "shop", name: "log", kind: "table", columns: [col("at"), col("msg")] },
    { schema: "shop", name: "v_orders", kind: "view", columns: [col("id", true)] },
    { schema: "other", name: "orders", kind: "table", columns: [col("code", true)] },
  ];
  it("lists the primary key columns of the table, composite keys included", () => {
    expect(primaryKeyColumns(objects, { schema: "shop", name: "orders" })).toEqual(["id"]);
    expect(primaryKeyColumns(objects, { schema: "shop", name: "lines" })).toEqual(["order_id", "line_no"]);
  });
  it("is null without a primary key, for a view and for an unknown table", () => {
    expect(primaryKeyColumns(objects, { schema: "shop", name: "log" })).toBeNull();
    expect(primaryKeyColumns(objects, { schema: "shop", name: "v_orders" })).toBeNull();
    expect(primaryKeyColumns(objects, { schema: "shop", name: "missing" })).toBeNull();
  });
  it("matches the schema when the reference has one, and any schema when it has none", () => {
    expect(primaryKeyColumns(objects, { schema: "other", name: "orders" })).toEqual(["code"]);
    expect(primaryKeyColumns(objects, { name: "orders" })).toEqual(["id"]);
    expect(primaryKeyColumns(objects, { schema: null, name: "lines" })).toEqual(["order_id", "line_no"]);
  });
});
