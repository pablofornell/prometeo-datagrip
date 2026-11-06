/**
 * Navigation popups: Search Everywhere (Shift Shift, toolbar search button) and Go to Database Object (Ctrl+N).
 * Importing this module registers the actions `nav.searchEverywhere` and `nav.gotoObject` (the registry prefers an
 * implemented action over the shell's stub whatever the registration order).
 */
import { registerActions } from "../../state/actions";
import { ACTION_IDS } from "../../state/core-actions";
import { openSearch } from "./SearchPopup";
import "./navigate.css";

const dispose = registerActions([
  { id: ACTION_IDS.searchEverywhere, title: "Search Everywhere", shortcut: "Shift Shift", icon: "search", run: () => openSearch("all") },
  { id: ACTION_IDS.gotoObject, title: "Go to Database Object…", shortcut: "Ctrl+N", run: () => openSearch("db") },
]);

if (import.meta.hot) import.meta.hot.dispose(dispose);
