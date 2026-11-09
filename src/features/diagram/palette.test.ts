import { describe, expect, it } from "vitest";
import { FALLBACK_FONT_MONO, FALLBACK_FONT_UI, resolvePalette } from "./palette";

const read = (vars: Record<string, string>) => (name: string): string => vars[name] ?? "";

describe("resolvePalette", () => {
  it("resolves colours and concrete font stacks from the theme variables", () => {
    const p = resolvePalette(
      read({
        "--dg-editor-bg": "#010203",
        "--dg-font-mono": '"Test Mono", monospace',
        "--dg-font-ui": '"Test UI", sans-serif',
      }),
    );
    expect(p.background).toBe("#010203");
    expect(p.fontMono).toBe('"Test Mono", monospace');
    expect(p.fontUi).toBe('"Test UI", sans-serif');
  });

  it("falls back to concrete fonts when the variables are missing", () => {
    const p = resolvePalette(() => "");
    expect(p.fontMono).toBe(FALLBACK_FONT_MONO);
    expect(p.fontUi).toBe(FALLBACK_FONT_UI);
    expect(p.fontMono).not.toContain("var(");
    expect(p.fontUi).not.toContain("var(");
  });
});
