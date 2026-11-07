// @vitest-environment node
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { joinLines, sortLines, toggleCase } from "./edit-actions";

function run(cmd: StateCommand, doc: string, sel: [number, number?]): { doc: string; state: EditorState } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(sel[0], sel[1] ?? sel[0]) });
  cmd({ state, dispatch: (tr) => (state = tr.state) });
  return { doc: state.doc.toString(), state };
}

describe("editor commands of the Edit menu", () => {
  it("toggle case upper-cases the word at the caret, then lower-cases it", () => {
    expect(run(toggleCase, "select name", [8]).doc).toBe("select NAME");
    expect(run(toggleCase, "select NAME", [8]).doc).toBe("select name");
    expect(run(toggleCase, "select name", [0, 6]).doc).toBe("SELECT name");
  });

  it("join lines merges the caret line with the next one and the selected lines", () => {
    expect(run(joinLines, "select 1\n   from t", [2]).doc).toBe("select 1 from t");
    expect(run(joinLines, "a\n b\n c\nd", [0, 7]).doc).toBe("a b c\nd");
    expect(run(joinLines, "only", [1]).doc).toBe("only");
  });

  it("sort lines orders the selected lines, or all lines without a multi-line selection", () => {
    expect(run(sortLines, "c\nb\na", [0]).doc).toBe("a\nb\nc");
    expect(run(sortLines, "z\nc\nb\na", [2, 5]).doc).toBe("z\nb\nc\na");
  });
});

describe("enabled state of Paste / Delete by focus target", () => {
  const fake = (attrs: string[]) => ({
    closest: (sel: string) => (sel === ".dgg" ? self : null),
    hasAttribute: (n: string) => attrs.includes(n),
  });
  let self: ReturnType<typeof fake>;

  async function enabled(id: string, active: unknown): Promise<boolean> {
    class Stub {}
    const g = globalThis as Record<string, unknown>;
    g.HTMLTextAreaElement = Stub;
    g.HTMLInputElement = Stub;
    g.document = { activeElement: active };
    const { registerEditActions } = await import("./edit-actions");
    const { getAction, isActionEnabled } = await import("./actions");
    const off = registerEditActions();
    try {
      return isActionEnabled(getAction(id));
    } finally {
      off();
    }
  }

  const grid = (editable: boolean) => {
    const el = {
      closest: (sel: string) => (sel === ".dgg" ? el : sel === ".cm-editor" ? null : null),
      hasAttribute: (n: string) => editable && n === "data-editable",
    };
    return el;
  };

  it("a read-only result grid cannot paste or delete, an editable one can", async () => {
    self = fake([]);
    expect(await enabled("edit.paste", grid(false))).toBe(false);
    expect(await enabled("edit.delete", grid(false))).toBe(false);
    expect(await enabled("edit.paste", grid(true))).toBe(true);
    expect(await enabled("edit.delete", grid(true))).toBe(true);
  });

  it("Copy and Select All stay available in a read-only grid", async () => {
    expect(await enabled("edit.copy", grid(false))).toBe(true);
    expect(await enabled("edit.selectAll", grid(false))).toBe(true);
  });
});
