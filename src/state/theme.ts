/** Theme switch: "system" follows the OS color scheme (default), "dark"/"light" are explicit overrides. */
import { createMemo, createRoot, createSignal } from "solid-js";
import { loadLocal, saveUiState } from "./persist";

export type ThemePref = "system" | "dark" | "light";
export type ThemeName = "dark" | "light";

const mq =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

const [pref, setPrefSignal] = createSignal<ThemePref>(loadLocal<ThemePref>("theme", "system"));
const [systemDark, setSystemDark] = createSignal(mq ? mq.matches : true);
mq?.addEventListener("change", (e) => setSystemDark(e.matches));

/** Effective theme actually applied to `<html data-theme>`. */
export const theme = createRoot(() => {
  const t = createMemo<ThemeName>(() =>
    pref() === "system" ? (systemDark() ? "dark" : "light") : (pref() as ThemeName),
  );
  return t;
});

export const themePref = pref;

function apply(): void {
  document.documentElement.setAttribute("data-theme", theme());
}

export function setThemePref(p: ThemePref): void {
  setPrefSignal(p);
  saveUiState("theme", p);
  apply();
}

/** Call once before the first render (index.tsx). Keeps `data-theme` in sync with OS changes. */
export function initTheme(): void {
  apply();
  mq?.addEventListener("change", apply);
}
