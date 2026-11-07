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
