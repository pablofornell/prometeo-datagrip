// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SCHEME_ATTRS, baseColor, editorTokens, parseColor, patchOverride, sanitizeOverrides, schemeRules, schemeVars } from "./colorScheme";

describe("color scheme", () => {
  it("reads the editor tokens of the theme files", () => {
    expect(baseColor("dark", "--dg-editor-keyword")).toBe("#CF8E6D");
    expect(baseColor("light", "--dg-editor-bg")).toBe("#FFFFFF");
    // a token that refers to another one resolves through it
    expect(editorTokens("/* x */ --dg-editor-a: #111111; --dg-editor-b: var(--dg-editor-a);")).toEqual({ "--dg-editor-a": "#111111", "--dg-editor-b": "var(--dg-editor-a)" });
  });

  it("every attribute has a theme colour in both schemes", () => {
    for (const a of SCHEME_ATTRS) for (const s of ["dark", "light"] as const) expect(baseColor(s, a.tokens[0]), a.id + s).toBeDefined();
  });

  it("parses colours", () => {
    expect(parseColor("cf8e6d")).toBe("#CF8E6D");
    expect(parseColor("#abc")).toBe("#AABBCC");
    expect(parseColor("red; x:y")).toBeNull();
  });

  it("puts the foreground edits on the tokens; the other scheme brings its whole editor family", () => {
    expect(schemeVars("dark", "dark", undefined)).toEqual({});
    expect(schemeVars("dark", "dark", { kw: { fg: "#112233" } })).toEqual({ "--dg-editor-keyword": "#112233" });
    const v = schemeVars("light", "dark", {});
    expect(v["--dg-editor-bg"]).toBe("#FFFFFF");
    expect(Object.keys(v).length).toBeGreaterThan(20);
  });

  it("writes rules for the other properties", () => {
    const css = schemeRules({ kw: { bold: true, italic: false, bg: "#010203", effect: "wave", effectColor: "#FF0000" } }, [".sql-editor", ".dg-sql-hl"]);
    expect(css).toBe(
      ".sql-editor .cm-sql-kw,.dg-sql-hl .cm-sql-kw{background-color:#010203;font-weight:700;font-style:normal;text-decoration:underline wavy #FF0000;text-underline-offset:3px;text-decoration-thickness:1px}",
    );
    expect(schemeRules({ kw: { fg: "#112233" } }, [".x"])).toBe("");
  });

  it("drops attributes that end up without edits and malformed stored values", () => {
    expect(patchOverride({ kw: { bold: true } }, "kw", { bold: undefined })).toEqual({});
    expect(patchOverride({}, "str", { fg: "#000000" })).toEqual({ str: { fg: "#000000" } });
    expect(sanitizeOverrides({ dark: { kw: { fg: "javascript:1", bold: true }, nope: { fg: "#000000" } }, light: 5 })).toEqual({ dark: { kw: { bold: true } }, light: {} });
  });
});
