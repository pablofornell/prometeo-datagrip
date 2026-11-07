/**
 * The webview's own context menu ("Reload", "Inspect Element", ...) is not part of the app: a right click on the
 * backdrop of a dialog or on any other plain area must show nothing. The text fields keep it (native copy / paste).
 * The app's own menus are opened by the handlers of the components; this guard only cancels what is left over.
 */

/** The bit of an element `allowsNativeMenu` looks at (an `Element` in the app, a stub in the tests). */
export interface MenuTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  readOnly?: boolean;
}

const TEXT_INPUTS = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);

/** Right click on a text input, a textarea or an editable region: the native copy / paste menu stays. */
export function allowsNativeMenu(t: MenuTarget | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toLowerCase();
  if (tag === "textarea") return true;
  return tag === "input" && TEXT_INPUTS.has((t.type ?? "").toLowerCase());
}

/**
 * Cancels the native context menu app-wide except on text fields. `enabled` is false in dev builds (the inspector
 * stays reachable); it listens on `window`, after the components' own handlers ran.
 */
export function installNativeMenuGuard(enabled: boolean, target: Pick<Window, "addEventListener"> = window): () => void {
  if (!enabled) return () => {};
  const onMenu = (e: Event) => {
    if (!allowsNativeMenu(e.target as MenuTarget | null)) e.preventDefault();
  };
  target.addEventListener("contextmenu", onMenu);
  return () => (target as Window).removeEventListener("contextmenu", onMenu);
}
