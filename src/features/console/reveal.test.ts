// @vitest-environment node
import { Text } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlEditorHandle } from "../../components/editor";

// the registry reads the active tab only: the tabs store is not needed here
vi.mock("../../state/tabs", () => ({ activeTab: () => undefined }));

import { registerEditor, revealLine, unregisterEditor } from "./registry";

/** An editor handle over `lines`: the doc and a spy for the reveal (the handle's own `view` is a stand-in). */
function fakeEditor(lines: string[]) {
  const revealRange = vi.fn();
  const handle = { view: { state: { doc: Text.of(lines) } }, revealRange } as unknown as SqlEditorHandle;
  return { handle, revealRange };
}

describe("line reveal of a console or file tab", () => {
  beforeEach(() => {
    unregisterEditor("tab-a");
    unregisterEditor("tab-b");
  });

  it("selects the line of a mounted editor at once", () => {
    const ed = fakeEditor(["select 1;", "select 2;", "select 3;"]);
    registerEditor("tab-a", ed.handle);
    revealLine("tab-a", 2);
    expect(ed.revealRange).toHaveBeenCalledWith({ from: 10, to: 19 });
  });

  it("keeps a line asked for before the editor mounted, and reveals it when the editor mounts", () => {
    revealLine("tab-b", 3);
    const ed = fakeEditor(["a", "bb", "ccc"]);
    expect(ed.revealRange).not.toHaveBeenCalled();
    registerEditor("tab-b", ed.handle);
    expect(ed.revealRange).toHaveBeenCalledTimes(1);
    expect(ed.revealRange).toHaveBeenCalledWith({ from: 5, to: 8 });
    // the request was used up: a later mount does not repeat it
    const again = fakeEditor(["x"]);
    registerEditor("tab-b", again.handle);
    expect(again.revealRange).not.toHaveBeenCalled();
  });

  it("keeps the line inside the text", () => {
    const ed = fakeEditor(["a", "b"]);
    registerEditor("tab-a", ed.handle);
    revealLine("tab-a", 99);
    expect(ed.revealRange).toHaveBeenLastCalledWith({ from: 2, to: 3 });
    revealLine("tab-a", 0);
    expect(ed.revealRange).toHaveBeenLastCalledWith({ from: 0, to: 1 });
  });

  it("waits for a new editor when the old one has gone (its view is destroyed)", () => {
    const old = fakeEditor(["a", "b"]);
    registerEditor("tab-a", old.handle);
    unregisterEditor("tab-a");
    revealLine("tab-a", 2);
    expect(old.revealRange).not.toHaveBeenCalled();
    const fresh = fakeEditor(["a", "b"]);
    registerEditor("tab-a", fresh.handle);
    expect(fresh.revealRange).toHaveBeenCalledWith({ from: 2, to: 3 });
  });

  it("treats an editor whose view is gone as not mounted", () => {
    const destroyed = { view: undefined, revealRange: vi.fn() } as unknown as SqlEditorHandle;
    registerEditor("tab-a", destroyed);
    revealLine("tab-a", 1);
    expect((destroyed as unknown as { revealRange: ReturnType<typeof vi.fn> }).revealRange).not.toHaveBeenCalled();
  });
});
