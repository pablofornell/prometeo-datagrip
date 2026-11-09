import { describe, expect, it } from "vitest";
import { baseName, initSql, newConfig, sanitize, scriptOptionsOf, scriptResult, stopsAfterFailure, uniqueName, validate } from "./model";

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

describe("file runs of a configuration", () => {
  it("passes the stop and transaction options on, and reads the file as UTF-8", () => {
    expect(scriptOptionsOf(newConfig())).toEqual({ stopOnError: true, singleTransaction: true, encoding: "UTF-8" });
    expect(scriptOptionsOf({ stopOnError: false, singleTransaction: true })).toEqual({
      stopOnError: false,
      singleTransaction: true,
      encoding: "UTF-8",
    });
  });
  it("gives configurations saved before the options the defaults", () => {
    const [c] = sanitize([{ id: "old", name: "n", targets: [], files: ["/a.sql"] }]);
    expect(c.stopOnError).toBe(true);
    expect(c.singleTransaction).toBe(true);
  });
  it("words the balloon of a finished file run, with the first error and its line", () => {
    const ok = { ok: 3, failed: 0, firstError: null, cancelled: false, rolledBack: false, ddlCommitted: false, elapsedMs: 5 };
    expect(scriptResult(ok, "dump.sql", true)).toEqual({ kind: "success", title: "dump.sql finished", body: "3 statements ran." });
    const bad = { ok: 2, failed: 1, firstError: { message: "no such table: x", line: 3 }, cancelled: false, rolledBack: false, ddlCommitted: false, elapsedMs: 5 };
    expect(scriptResult(bad, "dump.sql", true)).toEqual({
      kind: "error",
      title: "dump.sql failed",
      body: "2 statements ran, then the run stopped at the error. Line 3: no such table: x",
    });
    expect(scriptResult(bad, "dump.sql", false)).toEqual({
      kind: "warning",
      title: "dump.sql finished with errors",
      body: "2 statements ran, 1 statement failed. Line 3: no such table: x",
    });
    expect(scriptResult({ ...bad, ok: 1, rolledBack: true }, "dump.sql", true).body).toBe(
      "1 statement failed: the transaction was rolled back, nothing was kept. Line 3: no such table: x",
    );
    const cut = { ok: 4, failed: 0, firstError: null, cancelled: true, rolledBack: false, ddlCommitted: false, elapsedMs: 5 };
    expect(scriptResult(cut, "dump.sql", true)).toEqual({ kind: "warning", title: "dump.sql cancelled", body: "4 statements ran before the cancel." });
  });
  it("does not claim that nothing was kept when the server committed DDL", () => {
    const rolled = { ok: 3, failed: 1, firstError: { message: "ORA-00001", line: 4 }, cancelled: false, rolledBack: true, ddlCommitted: true, elapsedMs: 5 };
    expect(scriptResult(rolled, "dump.sql", true).body).toBe(
      "1 statement failed: the transaction was rolled back (DDL statements are committed by the server and stay). Line 4: ORA-00001",
    );
    expect(scriptResult({ ...rolled, cancelled: true }, "dump.sql", true).body).toBe("3 statements rolled back (DDL statements are committed by the server and stay).");
    expect(scriptResult({ ...rolled, ddlCommitted: false }, "dump.sql", true).body).toContain("nothing was kept");
  });
  it("stops the remaining files and targets after a failure only when it stops at errors", () => {
    expect(stopsAfterFailure({ mode: "files", stopOnError: true }, 1)).toBe(true);
    expect(stopsAfterFailure({ mode: "files", stopOnError: true }, 0)).toBe(false);
    expect(stopsAfterFailure({ mode: "files", stopOnError: false }, 3)).toBe(false);
    expect(stopsAfterFailure({ mode: "text", stopOnError: true }, 3)).toBe(false);
  });
  it("takes the file name of a Windows or a POSIX path", () => {
    expect(baseName("/home/me/a.sql")).toBe("a.sql");
    expect(baseName("C:\\Users\\me\\dump.sql")).toBe("dump.sql");
    expect(baseName("C:/Users/me\\mixed.sql")).toBe("mixed.sql");
    expect(baseName("plain.sql")).toBe("plain.sql");
  });
});
