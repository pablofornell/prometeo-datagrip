/**
 * The IDE settings export (File > Manage IDE Settings): UI settings, keymap, color scheme, theme and tool window
 * layout in one JSON object. No data sources, no secrets. Pure logic: `buildBundle` collects, `parseBundle`
 * validates what a file holds (it may come from anywhere and from another version) and returns only values that
 * are safe to apply.
 */
import { type SchemeOverrides, sanitizeOverrides } from "../../state/colorScheme";
import type { LayoutState, ToolWindowAnchor } from "../../state/layout";
import type { Settings } from "../../state/settings";
import type { ThemePref } from "../../state/theme";

export interface SettingsBundle {
  /** Every setting, including `keymapOverrides` (the keymap) and `colorOverrides` (the color scheme). */
  settings: Record<string, unknown>;
  theme: ThemePref;
  layout: LayoutState;
}

/** What a file yields: only valid entries. `count` is the number of settings values found. */
export interface ParsedBundle {
  settings: Partial<Settings>;
  theme?: ThemePref;
  layout?: LayoutState;
  count: number;
}

export function buildBundle(settings: Settings, theme: ThemePref, layout: LayoutState): SettingsBundle {
  return {
    settings: { ...settings },
    theme,
    layout: { visible: { ...layout.visible }, anchors: { ...layout.anchors }, sizes: { ...layout.sizes }, pinned: { ...layout.pinned } },
  };
}

const THEMES: readonly string[] = ["system", "dark", "light"];
const ANCHORS: readonly string[] = ["left", "right", "bottom"];

/** Allowed values of the settings that are a choice. */
const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = {
  defaultTxMode: ["auto", "manual"],
  execCaretInside: ["ask", "smallest", "largest"],
  sqlKeywordCase: ["keep", "upper", "lower"],
  editorScheme: ["auto", "dark", "light"],
  uiFontFamily: ["inter", "system"],
};

/** Settings that are whole numbers (a fraction in a file is rounded). */
const INTEGERS: readonly string[] = ["gridPageSize", "editorFontSize", "uiFontSize"];

/** Allowed range of the settings that are a number. */
const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  gridPageSize: [0, 1_000_000],
  editorFontSize: [8, 48],
  editorLineHeight: [1, 3],
  uiFontSize: [8, 32],
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The keymap edits as stored may be anything: keep the lists of strings. */
function keymapOf(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (isObject(raw)) for (const [id, v] of Object.entries(raw)) if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[id] = v;
  return out;
}

/** The settings of `raw` that exist in `defaults`, have the right type and an allowed value; the rest is dropped. */
export function sanitizeSettings(raw: unknown, defaults: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {};
  if (!isObject(raw)) return out as Partial<Settings>;
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (key === "colorOverrides") out[key] = sanitizeOverrides(v) satisfies SchemeOverrides;
    else if (key === "keymapOverrides") out[key] = keymapOf(v);
    else if (typeof v !== typeof defaults[key]) continue;
    else if (typeof v === "number") {
      const [lo, hi] = RANGES[key] ?? [-Infinity, Infinity];
      if (Number.isFinite(v)) out[key] = Math.min(hi, Math.max(lo, INTEGERS.includes(key) ? Math.round(v) : v));
    } else if (typeof v === "string") {
      const allowed = CHOICES[key];
      if (!allowed || allowed.includes(v)) out[key] = v;
    } else out[key] = v;
  }
  return out as Partial<Settings>;
}

/**
 * A layout from a file merged over `defaults`: only known tool windows, valid anchors, positive sizes, and one
 * visible window per anchor (the first in `order` wins), like the layout store does when it loads.
 */
export function sanitizeLayout(raw: unknown, defaults: LayoutState, order: readonly string[]): LayoutState | undefined {
  if (!isObject(raw)) return undefined;
  const known = new Set(order);
  const out: LayoutState = { visible: { ...defaults.visible }, anchors: { ...defaults.anchors }, sizes: { ...defaults.sizes }, pinned: { ...defaults.pinned } };
  const each = (src: unknown, f: (id: string, v: unknown) => void) => {
    if (isObject(src)) for (const [id, v] of Object.entries(src)) if (known.has(id)) f(id, v);
  };
  each(raw.visible, (id, v) => typeof v === "boolean" && (out.visible[id] = v));
  each(raw.anchors, (id, v) => typeof v === "string" && ANCHORS.includes(v) && (out.anchors[id] = v as ToolWindowAnchor));
  each(raw.sizes, (id, v) => typeof v === "number" && Number.isFinite(v) && v > 0 && (out.sizes[id] = Math.round(v)));
  each(raw.pinned, (id, v) => typeof v === "boolean" && (out.pinned[id] = v));
  const seen = new Set<string>();
  for (const id of order) {
    if (!out.visible[id]) continue;
    const a = out.anchors[id];
    if (seen.has(a)) out.visible[id] = false;
    else seen.add(a);
  }
  return out;
}

/** Validate the object the backend read from a settings file. */
export function parseBundle(raw: unknown, defaults: Settings, layoutDefaults: LayoutState, windowOrder: readonly string[]): ParsedBundle {
  const o = isObject(raw) ? raw : {};
  const settings = sanitizeSettings(o.settings, defaults);
  return {
    settings,
    theme: typeof o.theme === "string" && THEMES.includes(o.theme) ? (o.theme as ThemePref) : undefined,
    layout: sanitizeLayout(o.layout, layoutDefaults, windowOrder),
    count: Object.keys(settings).length,
  };
}
