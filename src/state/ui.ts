import { createSignal } from "solid-js";

/** Visibility of the About dialog (Help > About). */
export const [aboutOpen, setAboutOpen] = createSignal(false);
/** Main menu bar expanded inline in the toolbar (hamburger / Alt+\). */
export const [menuBarOpen, setMenuBarOpen] = createSignal(false);

/** A modal dialog or full-window search / history popup is open: the main menu (Alt+letter, Alt+\) must not open over it. */
export const isModalOpen = (): boolean =>
  document.body.classList.contains("dg-modal-open") || !!document.querySelector(".dg-dialog-overlay, .dgn-backdrop, .dgc-h-backdrop");
