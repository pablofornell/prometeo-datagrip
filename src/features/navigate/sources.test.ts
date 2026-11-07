import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "../../api/db";
import { storeVisibleSchemas, resetVisibleSchemasCache } from "../../state/schema-filter";
import { type Entry, collectSettings, isEntryVisible, searchText } from "./sources";

// sources.ts reaches the explorer, the menus and the action registry; none of that is needed here
vi.mock("../explorer", () => ({ connectedDataSourceIds: () => new Set(), explorerDataSources: () => [], loadSchemaSnapshot: async () => [], schemaSnapshotFor: () => [] }));
vi.mock("../../components/shell/menus", () => ({ MAIN_MENU: [], GEAR_MENU: [] }));
vi.mock("../../state/core-actions", () => ({ ACTION_IDS: {} }));
vi.mock("../../state/actions", () => ({ getAction: () => undefined, actionShortcut: () => undefined }));
vi.mock("../../components/ui", () => ({}));

const ds = { id: "ds1", name: "pg", driver: "postgres", options: {} } as unknown as DataSource;
const e = (schema: string, kind: Entry["kind"] = "table"): Entry => ({ group: "db", kind, name: "t", lower: "t", dsId: "ds1", schema });
const line = (text: string, n: number): Entry => ({ group: "text", kind: "text", name: text, lower: text.toLowerCase(), dsId: "ds1", file: "console", line: n });

describe("isEntryVisible", () => {
  it("follows the schema selector of the data source", () => {
    resetVisibleSchemasCache();
    expect(isEntryVisible(e("shop"), ds)).toBe(true);
    storeVisibleSchemas("ds1", JSON.stringify([["postgres", "sales"]]));
    expect(isEntryVisible(e("sales"), ds)).toBe(true);
    expect(isEntryVisible(e("shop"), ds)).toBe(false);
    expect(isEntryVisible(e("shop", "dataSource"), ds)).toBe(true);
    resetVisibleSchemasCache();
  });
});

describe("searchText", () => {
  it("finds every occurrence, case-insensitively", () => {
    const hits = searchText([line("SELECT * FROM sales.invoices", 1), line("select 1", 2)], "from SALES", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].ranges).toEqual([[9, 19]]);
  });
  it("honours the limit and ignores an empty query", () => {
    expect(searchText([line("a", 1), line("a", 2)], "a", 1)).toHaveLength(1);
    expect(searchText([line("a", 1)], "  ", 5)).toEqual([]);
  });
});

describe("collectSettings", () => {
  it("lists page titles and option labels with their page", () => {
    const all = collectSettings();
    const font = all.find((x) => x.name === "Font" && x.pageId === "editor.font");
    expect(font?.right).toMatch(/^Settings > .*Font$/);
    expect(all.every((x) => x.kind === "setting" && x.pageId)).toBe(true);
  });
});
