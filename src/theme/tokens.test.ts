// @vitest-environment node
import { describe, expect, it } from "vitest";
import darkCss from "./dark.css?raw";
import lightCss from "./light.css?raw";

const tokens = (raw: string): Set<string> => {
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  return new Set([...css.matchAll(/^\s*(--dg-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
};

describe("theme tokens", () => {
  it("dark.css and light.css define the same tokens", () => {
    const dark = tokens(darkCss);
    const light = tokens(lightCss);
    expect([...dark].filter((t) => !light.has(t))).toEqual([]);
    expect([...light].filter((t) => !dark.has(t))).toEqual([]);
  });
});

// Component CSS takes its colours from the --dg-* tokens: a hex literal there is either a leftover or a fallback inside var().
const sheets = import.meta.glob("../**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Hex colours in the rule bodies of a sheet, minus `var(--x, #fallback)` fallbacks and mask shapes (alpha only). */
function literals(css: string): string[] {
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/var\(\s*--[a-z0-9-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g, "var()")
    .replace(/(-webkit-)?mask[a-z-]*:[^;]*;/g, "")
    .replace(/url\([^)]*\)/g, "");
  return clean.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
}

describe("hard-coded colours", () => {
  it("the sheets cleaned for SHELL-24 and the new ones have no hex literals", () => {
    const cleaned = ["../components/editor/editor.css", "../features/explorer/explorer.css", "../features/output/output.css", "../features/settings/settings.css", "./appearance.css"];
    for (const f of cleaned) {
      expect(sheets[f], f).toBeDefined();
      expect(literals(sheets[f]), f).toEqual([]);
    }
  });
});
