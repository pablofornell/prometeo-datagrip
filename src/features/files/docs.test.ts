// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.fn();
const writeFile = vi.fn();
const notify = vi.fn();

vi.mock("../../api/db", () => ({
  readFile: (...a: unknown[]) => readFile(...a),
  writeFile: (...a: unknown[]) => writeFile(...a),
}));
vi.mock("../../components/ui", () => ({ notify: (...a: unknown[]) => notify(...a) }));
vi.mock("../../state/persist", () => ({ saveUiState: vi.fn(), loadLocal: (_key: string, fallback: unknown) => fallback }));
vi.mock("../../state/tabs", () => ({ activateTab: vi.fn(), openTab: vi.fn(), tabs: () => [], updateTab: vi.fn() }));
vi.mock("../table/dialogs", () => ({ askChoice: vi.fn() }));

import { acquireDoc, editDoc, releaseDoc, saveDoc } from "./docs";

describe("scratch autosave errors", () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset();
    notify.mockReset();
    readFile.mockResolvedValue({ text: "select 1", mtimeMs: 1 });
    writeFile.mockResolvedValue(1);
  });

  it("shows one notification per file and reports again after a successful save", async () => {
    await acquireDoc("/tmp/a.sql", true);
    editDoc("/tmp/a.sql", "select 2");
    writeFile.mockRejectedValueOnce(new Error("disk full"));
    expect(await saveDoc("/tmp/a.sql", { quiet: true })).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    // the next change retries; the same failure does not raise a second balloon
    editDoc("/tmp/a.sql", "select 3");
    writeFile.mockRejectedValueOnce(new Error("disk full"));
    expect(await saveDoc("/tmp/a.sql", { quiet: true })).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    // a successful save clears the marker: a later failure is reported again
    writeFile.mockResolvedValueOnce(9);
    expect(await saveDoc("/tmp/a.sql", { quiet: true })).toBe(true);
    editDoc("/tmp/a.sql", "select 4");
    writeFile.mockRejectedValueOnce(new Error("disk full"));
    expect(await saveDoc("/tmp/a.sql", { quiet: true })).toBe(false);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: "error", title: "Cannot save a.sql", body: "disk full" });

    releaseDoc("/tmp/a.sql");
  });
});
