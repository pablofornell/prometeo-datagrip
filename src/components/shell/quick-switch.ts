/**
 * "Quick Switch Scheme" (Ctrl+`) and the list popups it leads to: Theme… and Keymap… (also in the gear menu).
 * Numbered list popups centered in the window; digits pick directly, hovering a theme previews it live.
 */
import { runAction } from "../../state/actions";
import { type ThemePref, setThemePref, theme, themePref } from "../../state/theme";
import { type MenuItem, openMenu } from "../ui/Menu";

const sep: MenuItem = { type: "separator" };

const THEMES: { pref: ThemePref; label: string }[] = [
  { pref: "dark", label: "Islands Dark" },
  { pref: "light", label: "Islands Light" },
  { pref: "system", label: "Sync with OS" },
];

const applyPreview = (pref: ThemePref): void => {
  const t = pref === "system" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches === false ? "light" : "dark") : pref;
  document.documentElement.setAttribute("data-theme", t);
};

/** Theme… list popup: the current theme is preselected, the highlighted row previews live, Enter / digit applies. */
export function openThemePopup(): void {
  const items: MenuItem[] = [
    { label: THEMES[0].label, run: () => setThemePref("dark") },
    { label: THEMES[1].label, run: () => setThemePref("light") },
    sep,
    { label: THEMES[2].label, run: () => setThemePref("system") },
  ];
  const rows = [0, 1, 3]; // item index of each theme (the separator sits between)
  openMenu(items, {
    title: "Theme…",
    numbered: true,
    center: true,
    minWidth: 215,
    selected: rows[THEMES.findIndex((t) => t.pref === themePref())],
    onHighlight: (i) => {
      const k = rows.indexOf(i);
      if (k >= 0) applyPreview(THEMES[k].pref);
    },
    // Closing without a choice drops the preview; a chosen theme is applied right after (setThemePref).
    onClose: () => document.documentElement.setAttribute("data-theme", theme()),
  });
}

/** Keymap… popup: a link to Settings > Keymap. */
export function openKeymapPopup(): void {
  openMenu(
    [{ label: "Configure Keymap…", run: () => void runAction("app.settings", "keymap") }],
    { title: "Keymap", compact: true, center: true, minWidth: 215, selected: 0 },
  );
}

/** Ctrl+`: the in-scope switchable schemes. */
export function openQuickSwitch(): void {
  openMenu(
    [
      { label: "Theme…", run: openThemePopup },
      { label: "Keymap…", run: openKeymapPopup },
    ],
    { title: "Switch", numbered: true, center: true, minWidth: 215, selected: 0 },
  );
}
