/**
 * App settings store (operative settings only). Reactive, persisted with the UI state.
 *
 * Contract for other modules: read with the accessors (`settings.gridPageSize` etc.), never cache the value.
 * The Settings dialog (src/features/settings) is the only writer, through `updateSettings`.
 */
import { createRenderEffect, createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { isTauri } from "../api/tauri";
import { setKeymapOverrides } from "./actions";
import { EMPTY_OVERRIDES, type SchemeId, type SchemeOverrides, sanitizeOverrides, schemeRules, schemeVars } from "./colorScheme";
import { loadLocal, saveUiState } from "./persist";
import { theme } from "./theme";

export interface Settings {
  /** Rows fetched per page in result and table grids (DataGrip default 500). 0 = all. */
  gridPageSize: number;
  /** Editor font size in px (DataGrip default 13). */
  editorFontSize: number;
  /** Editor line height multiplier (DataGrip default 1.2). */
  editorLineHeight: number;
  /** Show line numbers in the SQL editor. */
  editorLineNumbers: boolean;
  /** Text used to show NULL in grids. */
  gridNullText: string;
  /** Default transaction mode of new consoles. */
  defaultTxMode: "auto" | "manual";
  /** What Ctrl+Enter runs when the caret is inside a statement that has an attached comment: ask / the statement / with its comment. */
  execCaretInside: "ask" | "smallest" | "largest";
  /** Alternate shading of every second grid row. */
  gridAlternateRows: boolean;
  /** Show the vertical indent guides in the SQL editor. */
  editorIndentGuides: boolean;
  /** Case of the keywords after Reformat Code: `keep` (as typed), `upper`, `lower`. */
  sqlKeywordCase: "keep" | "upper" | "lower";
  /** Editor color scheme: follow the UI theme or force one of the built-in schemes. */
  editorScheme: "auto" | SchemeId;
  /** Edits of the color scheme attributes, kept per scheme. */
  colorOverrides: SchemeOverrides;
  /** User edits of the keymap: action id -> its complete shortcut list. */
  keymapOverrides: Record<string, string[]>;
  /** Appearance > Use custom font. */
  uiCustomFont: boolean;
  uiFontFamily: "inter" | "system";
  /** UI font size in px (13 = 100 %): scales the whole window. */
  uiFontSize: number;
  /** Appearance > Compact mode: 22 px tree rows and 24 px menu rows. */
  compactMode: boolean;
  /** Appearance > Use project colors in main toolbar (the tint of the data source colour). */
  projectColors: boolean;
  /** Appearance > Display icons in menu items. */
  menuIcons: boolean;
  /** Appearance > Tree Views. */
  treeIndentGuides: boolean;
  treeSmallIndents: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  gridPageSize: 500,
  editorFontSize: 13,
  editorLineHeight: 1.2,
  editorLineNumbers: true,
  gridNullText: "<null>",
  defaultTxMode: "auto",
  execCaretInside: "ask",
  gridAlternateRows: false,
  editorIndentGuides: true,
  sqlKeywordCase: "keep",
  editorScheme: "auto",
  colorOverrides: EMPTY_OVERRIDES,
  keymapOverrides: {},
  uiCustomFont: false,
  uiFontFamily: "inter",
  uiFontSize: 13,
  compactMode: false,
  projectColors: true,
  menuIcons: true,
  treeIndentGuides: false,
  treeSmallIndents: false,
};

const KEY = "settings";
const stored = loadLocal<Partial<Settings>>(KEY, {});
const [settings, setSettings] = createStore<Settings>({
  ...DEFAULT_SETTINGS,
  ...stored,
  colorOverrides: sanitizeOverrides(stored.colorOverrides),
  keymapOverrides: sanitizeKeymap(stored.keymapOverrides),
});

export { settings };

/** The keymap edits as stored may be anything: keep the lists of strings. */
function sanitizeKeymap(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (raw && typeof raw === "object") {
    for (const [id, v] of Object.entries(raw)) if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[id] = v;
  }
  return out;
}

/** The scheme in use: the explicit choice, else the one of the UI theme. */
export const effectiveScheme = (): SchemeId => (settings.editorScheme === "auto" ? theme() : settings.editorScheme);

/** Zoom factor of the window for a UI font size (13 px = 100 %). */
export const uiZoom = (size: number): number => Math.round((size / 13) * 100) / 100;

/** Editor metrics for a font size and line height (DataGrip scale: 13 px at 1.2 = 22 px pitch, 8 px advance). */
export function editorMetrics(fontSize: number, lineHeight: number): { fontSize: number; pitch: number; cell: number } {
  return {
    fontSize,
    pitch: Math.max(10, Math.round(22 * (fontSize / 13) * (lineHeight / 1.2))),
    cell: Math.round(((8 * fontSize) / 13) * 100) / 100,
  };
}

// Editor settings reach the CSS through custom properties on <html> (editor.css reads them); the SqlEditor effect that
// re-measures CodeMirror runs after this render effect, so it always sees the new metrics.
if (typeof document !== "undefined") {
  createRoot(() =>
    createRenderEffect(() => {
      const m = editorMetrics(settings.editorFontSize, settings.editorLineHeight);
      const st = document.documentElement.style;
      st.setProperty("--dg-editor-font-size", m.fontSize + "px");
      st.setProperty("--dg-editor-line-pitch", m.pitch + "px");
      st.setProperty("--dg-editor-cell", m.cell + "px");
    }),
  );
}

// Appearance: switches on <html> that src/theme/appearance.css reads, the UI font, the zoom and the color scheme.
let schemeProps: string[] = [];
let schemeSheet: HTMLStyleElement | undefined;
function applyAppearance(): void {
  const el = document.documentElement;
  const flag = (name: string, on: boolean, off = "off") => (on ? el.removeAttribute(name) : el.setAttribute(name, off));
  if (settings.compactMode) el.setAttribute("data-compact", "");
  else el.removeAttribute("data-compact");
  flag("data-project-colors", settings.projectColors);
  flag("data-menu-icons", settings.menuIcons);
  flag("data-editor-indent-guides", settings.editorIndentGuides);
  if (settings.gridAlternateRows) el.setAttribute("data-grid-alt", "");
  else el.removeAttribute("data-grid-alt");
  if (settings.treeIndentGuides) el.setAttribute("data-tree-guides", "");
  else el.removeAttribute("data-tree-guides");

  // UI font: the family is a token, the size scales the window (the chrome metrics are fixed px)
  el.style.setProperty("--dg-font-ui", settings.uiCustomFont && settings.uiFontFamily === "system" ? 'system-ui, -apple-system, "Segoe UI", sans-serif' : '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif');
  setZoom(settings.uiCustomFont ? uiZoom(settings.uiFontSize) : 1);

  // editor color scheme: tokens on <html>, the remaining properties as a stylesheet
  const sc = effectiveScheme();
  const edits = settings.colorOverrides[sc];
  const vars = schemeVars(sc, theme(), edits);
  for (const k of schemeProps) if (!(k in vars)) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  schemeProps = Object.keys(vars);
  if (!schemeSheet) {
    schemeSheet = document.createElement("style");
    schemeSheet.id = "dg-color-scheme";
    document.head.appendChild(schemeSheet);
  }
  schemeSheet.textContent = schemeRules(edits, [".sql-editor", ".dg-sql-hl"]);
}

let appliedZoom = 1;
function setZoom(z: number): void {
  if (z === appliedZoom) return;
  appliedZoom = z;
  if (isTauri()) {
    void import("@tauri-apps/api/webview").then((m) => m.getCurrentWebview().setZoom(z)).catch(() => {});
  } else {
    (document.documentElement.style as unknown as Record<string, string>).zoom = z === 1 ? "" : String(z);
  }
}

if (typeof document !== "undefined") createRoot(() => createRenderEffect(applyAppearance));

// the registry applies the keymap edits
createRoot(() => createRenderEffect(() => setKeymapOverrides(settings.keymapOverrides)));

export function updateSettings(patch: Partial<Settings>): void {
  setSettings(patch);
  saveUiState(KEY, { ...settings });
}
