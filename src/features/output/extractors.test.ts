// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { EXTRACTORS, extractorLabel, extractorMenuItems } from "./extractors";

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
