import { describe, expect, it } from "vitest";
import type { DataSourceImportSummary } from "../../api/types";
import { passwordStorageWarning } from "./passwordStorage";
import { describeImport } from "./transfer";

const one = (over: Partial<DataSourceImportSummary["imported"][number]> = {}) => ({
  id: "1",
  name: "prod",
  originalName: "prod",
  renamed: false,
  needsPassword: false,
  remotePaths: [] as string[],
  ...over,
});

describe("describeImport", () => {
  it("reports a clean import as info", () => {
    const r = describeImport({ imported: [one(), one({ id: "2", name: "dev", originalName: "dev" })], skipped: [] });
    expect(r.kind).toBe("info");
    expect(r.body).toBe("Imported 2 data sources: prod, dev.");
  });

  it("lists renames, the passwords to enter and the skipped entries", () => {
    const r = describeImport({
      imported: [one({ name: "prod (2)", renamed: true, needsPassword: true })],
      skipped: [{ name: "bad", reason: "unknown variant" }],
    });
    expect(r.kind).toBe("warning");
    expect(r.title).toBe("Data sources imported");
    expect(r.body).toContain("Imported 1 data source: prod (2).");
    expect(r.body).toContain("Renamed because the name was taken: prod to prod (2).");
    expect(r.body).toContain("enter one for prod (2)");
    expect(r.body).toContain("Skipped 1: bad (unknown variant).");
  });

  it("warns about paths on other machines", () => {
    const r = describeImport({ imported: [one({ remotePaths: ["\\nas\share\a.db"] })], skipped: [] });
    expect(r.kind).toBe("warning");
    expect(r.body).toContain("Network paths found");
    expect(r.body).toContain("prod (\\nas\share\a.db)");
  });

  it("says so when nothing could be imported", () => {
    expect(describeImport({ imported: [], skipped: [] })).toMatchObject({ kind: "info", title: "Nothing imported" });
    expect(describeImport({ imported: [], skipped: [{ name: "x", reason: "bad" }] }).kind).toBe("error");
  });

  it("shortens a long list", () => {
    const many = Array.from({ length: 9 }, (_, i) => one({ id: String(i), name: `n${i}`, originalName: `n${i}` }));
    expect(describeImport({ imported: many, skipped: [] }).body).toContain("n5, and 3 more");
  });
});

describe("passwordStorageWarning", () => {
  it("is silent while the keyring holds the passwords", () => {
    expect(passwordStorageWarning("keyring", false, "C:\\cfg")).toBeNull();
    expect(passwordStorageWarning(undefined, false)).toBeNull();
  });

  it("warns when new passwords go to the file", () => {
    expect(passwordStorageWarning("file", false, "C:\\Users\\me\\cfg\\")).toBe(
      "The OS keyring is not available: passwords are saved unencrypted in C:\\Users\\me\\cfg\\data-sources.json, readable by your account only.",
    );
    expect(passwordStorageWarning("file", false, "/home/me/.config/app")).toContain("/home/me/.config/app/data-sources.json");
    expect(passwordStorageWarning("file", false, null)).toContain("in data-sources.json");
  });

  it("is silent while the keyring has not been needed yet", () => {
    expect(passwordStorageWarning(null, false, "C:\cfg")).toBeNull();
  });

  it("warns about a password that is still in the file", () => {
    expect(passwordStorageWarning("keyring", true)).toContain("move to the OS keyring");
  });
});
