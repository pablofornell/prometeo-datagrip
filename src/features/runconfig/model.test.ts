import { describe, expect, it } from "vitest";
import { initSql, newConfig, sanitize, uniqueName, validate } from "./model";

describe("run configuration model", () => {
  const known = new Set(["a", "b"]);
  it("validates like DataGrip's footer", () => {
    expect(validate(newConfig({ name: "x" }), known)).toBe("No configured target data sources");
    expect(validate(newConfig({ name: "x", targets: [{ dsId: "zzz" }], files: ["/a.sql"] }), known)).toBe("No configured target data sources");
    expect(validate(newConfig({ name: "x", targets: [{ dsId: "a" }] }), known)).toBe("No script files specified");
    expect(validate(newConfig({ name: "x", targets: [{ dsId: "a" }], files: ["/a.sql"] }), known)).toBeNull();
    expect(validate(newConfig({ name: "x", mode: "text", targets: [{ dsId: "a" }], text: "  " }), known)).toBe("Script text is empty");
    expect(validate(newConfig({ name: " ", targets: [{ dsId: "a" }], files: ["/a.sql"] }), known)).toBe("The name must not be empty");
  });
  it("makes unique names", () => {
    expect(uniqueName("scratch.sql", [])).toBe("scratch.sql");
    expect(uniqueName("scratch.sql", ["scratch.sql"])).toBe("scratch.sql (1)");
    expect(uniqueName("scratch.sql", ["scratch.sql", "scratch.sql (1)"])).toBe("scratch.sql (2)");
  });
  it("builds the schema statement of a target", () => {
    expect(initSql("postgres", "public")).toEqual(['SET search_path TO "public"']);
    expect(initSql("postgres", 'we"ird')).toEqual(['SET search_path TO "we""ird"']);
    expect(initSql("mysql", "demo")).toEqual(["USE `demo`"]);
    expect(initSql("sqlite", "main")).toEqual([]);
    expect(initSql("postgres", undefined)).toEqual([]);
  });
  it("sanitizes stored configurations", () => {
    expect(sanitize(null)).toEqual([]);
    const [c] = sanitize([{ id: "x", name: "n", targets: [{ dsId: "a" }, 5], files: ["/a", 3] }, "junk", { name: "no id" }]);
    expect(c.id).toBe("x");
    expect(c.targets).toEqual([{ dsId: "a" }]);
    expect(c.files).toEqual(["/a"]);
    expect(c.showPage).toBe(true);
  });
});
