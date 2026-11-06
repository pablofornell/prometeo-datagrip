/**
 * Settings dialog (operative pages: Appearance, Editor > Font / General > Appearance, Database > Query Execution /
 * Data Editor and Viewer, Keymap). The values live in `src/state/settings.ts` (+ the theme in `state/theme.ts`).
 *
 *   openSettings(pageId?)   open the dialog (or jump to a page of the open one). Page ids: see ./model.ts
 *                           (`appearance`, `editor.font`, `editor.general.appearance`, `database.query-execution`,
 *                           `database.data-editor`, `keymap`).
 *
 * Action: `app.settings` (Ctrl+Alt+S).
 */
import { render } from "solid-js/web";
import { registerAction } from "../../state/actions";
import { loadLocal, saveUiState } from "../../state/persist";
import { SettingsDialog } from "./SettingsDialog";
import "./settings.css";

const LAST_PAGE_KEY = "settings.page";

let jump: ((id: string) => void) | null = null;
let isOpen = false;

export function openSettings(pageId?: string): void {
  if (isOpen) {
    if (pageId) jump?.(pageId);
    return;
  }
  isOpen = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <SettingsDialog
        initialPage={pageId ?? loadLocal<string>(LAST_PAGE_KEY, "appearance")}
        onPage={(id) => saveUiState(LAST_PAGE_KEY, id)}
        register={(f) => (jump = f)}
        onClose={() => {
          isOpen = false;
          jump = null;
          // let Solid finish the current event before the tree is torn down
          queueMicrotask(() => {
            dispose();
            host.remove();
          });
        }}
      />
    ),
    host,
  );
}

registerAction({
  id: "app.settings",
  title: "Settings…",
  shortcut: "Ctrl+Alt+S",
  icon: "settings",
  run: (ctx) => openSettings(typeof ctx === "string" ? ctx : undefined),
});
