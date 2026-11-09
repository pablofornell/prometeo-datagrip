/**
 * File > Manage IDE Settings > Export Settings… / Import Settings…
 *
 * One JSON file with the UI settings, keymap, color scheme, theme and tool window layout (see ./bundle.ts). It holds
 * no data source and no secret. The file is written and read by the backend through the native save / open dialogs.
 * Importing asks first, then applies the values and saves them like the Settings dialog does.
 */
import { produce } from "solid-js/store";
import { chooseExportPath } from "../../api/db";
import { invoke } from "../../api/tauri";
import { notify } from "../../components/ui";
import { DEFAULT_LAYOUT, TOOL_WINDOWS, layout, setLayout } from "../../state/layout";
import { saveUiState } from "../../state/persist";
import { DEFAULT_SETTINGS, settings, updateSettings } from "../../state/settings";
import { setThemePref, themePref } from "../../state/theme";
import { askChoice } from "../table/dialogs";
import { buildBundle, parseBundle } from "./bundle";

export const SETTINGS_FILE_NAME = "prometeo-settings.json";

export async function exportSettings(): Promise<void> {
  try {
    const path = await chooseExportPath(SETTINGS_FILE_NAME, "json");
    if (!path) return;
    await invoke("export_settings", { settings: buildBundle(settings, themePref(), layout), path });
    notify({ title: "Settings exported", body: `Written to ${path}. Data sources and passwords are not included.`, kind: "info" });
  } catch (e) {
    notify({ title: "Cannot export the settings", body: String(e), kind: "error" });
  }
}

export async function importSettings(): Promise<void> {
  try {
    const path = await invoke<string | null>("choose_open_json");
    if (!path) return;
    const raw = await invoke<unknown>("import_settings", { path });
    const p = parseBundle(raw, DEFAULT_SETTINGS, DEFAULT_LAYOUT, TOOL_WINDOWS.map((t) => t.id));
    if (!p.count && !p.theme && !p.layout) {
      notify({ title: "Nothing to import", body: "The file has no settings this version knows.", kind: "info" });
      return;
    }
    const answer = await askChoice({
      title: "Import Settings",
      message: `Replace your IDE settings (${p.count} option${p.count === 1 ? "" : "s"}${p.layout ? ", tool window layout" : ""}${p.theme ? ", theme" : ""}) with the ones in this file? Your data sources are not changed.`,
      choices: [
        { label: "Import", value: "import", primary: true },
        { label: "Cancel", value: "cancel" },
      ],
      cancel: "cancel",
    });
    if (answer !== "import") return;
    if (p.count) updateSettings(p.settings);
    if (p.theme) setThemePref(p.theme);
    if (p.layout) {
      const next = p.layout;
      setLayout(produce((s) => Object.assign(s, next)));
      saveUiState("layout", { visible: { ...next.visible }, anchors: { ...next.anchors }, sizes: { ...next.sizes }, pinned: { ...next.pinned } });
    }
    notify({ title: "Settings imported", body: "The imported settings are in use.", kind: "info" });
  } catch (e) {
    notify({ title: "Cannot import the settings", body: String(e), kind: "error" });
  }
}
