/**
 * App settings store (operative settings only). Reactive, persisted with the UI state.
 *
 * Contract for other modules: read with the accessors (`settings.gridPageSize` etc.), never cache the value.
 * The Settings dialog (src/features/settings) is the only writer, through `updateSettings`.
 */
import { createRenderEffect, createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { loadLocal, saveUiState } from "./persist";

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
}

export const DEFAULT_SETTINGS: Settings = {
  gridPageSize: 500,
  editorFontSize: 13,
  editorLineHeight: 1.2,
  editorLineNumbers: true,
  gridNullText: "<null>",
  defaultTxMode: "auto",
};

const KEY = "settings";
const [settings, setSettings] = createStore<Settings>({ ...DEFAULT_SETTINGS, ...loadLocal<Partial<Settings>>(KEY, {}) });

export { settings };

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

export function updateSettings(patch: Partial<Settings>): void {
  setSettings(patch);
  saveUiState(KEY, { ...settings });
}
