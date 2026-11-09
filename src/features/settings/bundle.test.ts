import { describe, expect, it } from "vitest";
import type { LayoutState } from "../../state/layout";
import type { Settings } from "../../state/settings";
import { buildBundle, parseBundle, sanitizeLayout, sanitizeSettings } from "./bundle";

const DEFAULTS = {
  gridPageSize: 500,
  editorFontSize: 13,
  editorLineHeight: 1.2,
  editorLineNumbers: true,
  gridNullText: "<null>",
  defaultTxMode: "auto",
  execCaretInside: "ask",
  sqlKeywordCase: "keep",
  editorScheme: "auto",
  colorOverrides: { dark: {}, light: {} },
  keymapOverrides: {},
  uiFontSize: 13,
} as unknown as Settings;

const LAYOUT: LayoutState = {
  visible: { explorer: true },
  anchors: { explorer: "left", files: "right", output: "bottom", services: "bottom" },
  sizes: { explorer: 490, files: 520, output: 480, services: 480 },
  pinned: { explorer: true, files: true, output: true, services: false },
};
const ORDER = ["explorer", "files", "output", "services"];

describe("sanitizeSettings", () => {
  it("keeps valid values and drops unknown keys, wrong types and values out of the allowed set", () => {
    const r = sanitizeSettings(
      { gridPageSize: 100, editorLineNumbers: false, gridNullText: "NULL", defaultTxMode: "manual", sqlKeywordCase: "shout", bogus: 1, editorFontSize: "big" },
      DEFAULTS,
    );
    expect(r).toEqual({ gridPageSize: 100, editorLineNumbers: false, gridNullText: "NULL", defaultTxMode: "manual" });
  });

  it("clamps numbers and refuses NaN / Infinity", () => {
    const r = sanitizeSettings({ editorFontSize: 400, uiFontSize: 1, editorLineHeight: Infinity, gridPageSize: -5 }, DEFAULTS);
    expect(r).toEqual({ editorFontSize: 48, uiFontSize: 8, gridPageSize: 0 });
  });

  it("rounds the settings that are whole numbers", () => {
    const r = sanitizeSettings({ gridPageSize: 99.6, editorFontSize: 13.4, uiFontSize: 14.5, editorLineHeight: 1.25 }, DEFAULTS);
    expect(r).toEqual({ gridPageSize: 100, editorFontSize: 13, uiFontSize: 15, editorLineHeight: 1.25 });
  });

  it("keeps the keymap as lists of strings and the color overrides in their shape", () => {
    const r = sanitizeSettings(
      { keymapOverrides: { "a.b": ["Ctrl+X"], bad: [1], worse: "x" }, colorOverrides: { dark: { kw: { fg: "#112233", bold: true, evil: "x" }, nope: { fg: "#000000" } }, light: 5 } },
      DEFAULTS,
    );
    expect(r.keymapOverrides).toEqual({ "a.b": ["Ctrl+X"] });
    expect(r.colorOverrides).toEqual({ dark: { kw: { fg: "#112233", bold: true } }, light: {} });
  });

  it("is empty for something that is not an object", () => {
    expect(sanitizeSettings(null, DEFAULTS)).toEqual({});
    expect(sanitizeSettings([1], DEFAULTS)).toEqual({});
  });
});

describe("sanitizeLayout", () => {
  it("merges over the defaults and ignores unknown windows and bad values", () => {
    const r = sanitizeLayout({ visible: { files: true, ghost: true }, anchors: { files: "left", output: "top" }, sizes: { files: 333.4, explorer: -1, output: "x" }, pinned: { services: true } }, LAYOUT, ORDER)!;
    expect(r.anchors.output).toBe("bottom");
    expect(r.anchors.files).toBe("left");
    expect(r.sizes).toMatchObject({ files: 333, explorer: 490, output: 480 });
    expect(r.pinned.services).toBe(true);
    expect(r.visible.ghost).toBeUndefined();
  });

  it("shows one window per anchor: the first in the registry order", () => {
    const r = sanitizeLayout({ visible: { explorer: true, files: true }, anchors: { files: "left" } }, LAYOUT, ORDER)!;
    expect(r.visible).toMatchObject({ explorer: true, files: false });
  });

  it("is undefined when the file has no layout", () => {
    expect(sanitizeLayout(undefined, LAYOUT, ORDER)).toBeUndefined();
    expect(sanitizeLayout("x", LAYOUT, ORDER)).toBeUndefined();
  });
});

describe("bundle round trip", () => {
  it("what buildBundle writes parseBundle reads back", () => {
    const settings = { ...DEFAULTS, gridPageSize: 250, keymapOverrides: { "x.y": ["F5"] } };
    const bundle = buildBundle(settings, "light", LAYOUT);
    const json = JSON.parse(JSON.stringify(bundle));
    const p = parseBundle(json, DEFAULTS, LAYOUT, ORDER);
    expect(p.settings).toEqual(settings);
    expect(p.theme).toBe("light");
    expect(p.layout).toEqual(LAYOUT);
    expect(p.count).toBe(Object.keys(DEFAULTS).length);
  });

  it("holds no data source, only settings, theme and layout", () => {
    expect(Object.keys(buildBundle(DEFAULTS, "dark", LAYOUT)).sort()).toEqual(["layout", "settings", "theme"]);
  });

  it("ignores a theme it does not know", () => {
    expect(parseBundle({ theme: "neon" }, DEFAULTS, LAYOUT, ORDER)).toEqual({ settings: {}, theme: undefined, layout: undefined, count: 0 });
  });
});
