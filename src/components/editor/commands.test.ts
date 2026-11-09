// @vitest-environment node
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { callAt, callScanStart, clipHistory, completeStatement, recordClip, signatureOf } from "./commands";
import { configField } from "./state";

/** Runs a command on a fake view and returns the resulting text and caret. */
function run(doc: string, head: number, cmd: (v: EditorView) => boolean): { doc: string; head: number } {
  const state = EditorState.create({ doc, selection: { anchor: head }, extensions: [configField] });
  let out = { doc, head };
  const view = {
    state,
    dispatch: (spec: { changes: { from: number; insert: string }[]; selection: { anchor: number } }) => {
      const tr = state.update({ changes: spec.changes, selection: spec.selection });
      out = { doc: tr.newDoc.toString(), head: tr.newSelection.main.head };
    },
  };
  cmd(view as never);
  return out;
}

describe("complete statement", () => {
  it("adds the missing semicolon and opens a line below", () => {
    expect(run("select 1", 3, completeStatement)).toEqual({ doc: "select 1;\n", head: 10 });
    expect(run("select 1;", 3, completeStatement)).toEqual({ doc: "select 1;\n", head: 10 });
    expect(run("    select 1\nfrom t", 6, completeStatement).doc).toBe("    select 1\nfrom t;\n    ");
  });
});

describe("parameter info", () => {
  it("finds the call around the caret and the argument index", () => {
    const t = "select substr(name, 2, ";
    expect(callAt(t, t.length)).toEqual({ name: "substr", current: 2 });
    const n = "select coalesce(a, lower(b), ";
    expect(callAt(n, n.length)).toEqual({ name: "coalesce", current: 2 });
    expect(callAt("select 1", 8)).toBeNull();
    expect(callAt("select f(1); select ", 20)).toBeNull();
  });

  it("looks the signature up in the built-ins", () => {
    const state = EditorState.create({ doc: "", extensions: [configField] });
    expect(signatureOf(state, "COUNT")?.args).toEqual(["*"]);
    expect(signatureOf(state, "nope")).toBeNull();
  });

  it("bounds the call scan to the current statement", () => {
    const doc = "select g(1, 2);\nselect f(";
    const state = EditorState.create({ doc, extensions: [configField] });
    expect(callScanStart(state, doc.length)).toBe("select g(1, 2);\n".length);
  });

  it("caps the call scan at ~4000 chars", () => {
    const doc = "select 1;\n" + "x".repeat(9000);
    const state = EditorState.create({ doc, extensions: [configField] });
    expect(callScanStart(state, doc.length)).toBe(doc.length - 4000);
  });
});

describe("paste history", () => {
  it("keeps the last ten texts, newest first, without doubles", () => {
    for (let i = 0; i < 12; i++) recordClip(`text ${i}`);
    recordClip("text 5");
    expect(clipHistory()).toHaveLength(10);
    expect(clipHistory()[0]).toBe("text 5");
    expect(clipHistory().filter((t) => t === "text 5")).toHaveLength(1);
  });
});
