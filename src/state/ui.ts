import { createSignal } from "solid-js";

/** Visibility of the About dialog (Help > About). */
export const [aboutOpen, setAboutOpen] = createSignal(false);
/** Main menu bar expanded inline in the toolbar (hamburger / Alt+\). */
export const [menuBarOpen, setMenuBarOpen] = createSignal(false);
