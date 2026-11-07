/**
 * Navigation popups: Search Everywhere (Shift Shift, toolbar search button), Go to Database Object (Ctrl+N) and
 * Find Action (Ctrl+Shift+A, the Actions tab of the same popup).
 * Importing this module registers the actions `nav.searchEverywhere`, `nav.gotoObject`, `nav.findAction`, `nav.recentFiles` (Ctrl+E) and `nav.switcher` (Ctrl+Tab) (the registry prefers an
 * implemented action over the shell's stub whatever the registration order).
 */
import { registerActions } from "../../state/actions";
import { ACTION_IDS } from "../../state/core-actions";
import { openRecentFiles } from "./RecentFiles";
import { openSearch } from "./SearchPopup";
import "./navigate.css";
import "./RecentFiles.css";

const dispose = registerActions([
  { id: ACTION_IDS.searchEverywhere, title: "Search Everywhere", shortcut: "Shift Shift", icon: "search", run: () => openSearch("all") },
  { id: ACTION_IDS.gotoObject, title: "Go to Database Object…", shortcut: "Ctrl+N", run: () => openSearch("db") },
  { id: "nav.recentFiles", title: "Recent Files", shortcut: "Ctrl+E", run: () => openRecentFiles("recent") },
  { id: "nav.switcher", title: "Switcher", shortcut: ["Ctrl+Tab", "Ctrl+Shift+Tab"], run: () => openRecentFiles("switch") },
  { id: "nav.findAction", title: "Find Action…", shortcut: "Ctrl+Shift+A", run: () => openSearch("action") },
]);

if (import.meta.hot) import.meta.hot.dispose(dispose);
