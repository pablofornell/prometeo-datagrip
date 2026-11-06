/** Pure helpers of the Keymap page (no UI imports, unit tested). */

export interface KeymapAction {
  id: string;
  title: string;
  icon?: string;
  /** All shortcuts, each as its key caps (`["Ctrl", "Enter"]`). */
  shortcuts: string[][];
}

export interface KeymapGroup {
  name: string;
  actions: KeymapAction[];
}

export const GROUP_ORDER = ["Editor Actions", "Main Menu", "Tool Windows", "Database", "Other"];

export function groupOf(id: string): string {
  const p = id.split(".")[0];
  if (p === "edit" || p === "code") return "Editor Actions";
  if (p === "toolwindow") return "Tool Windows";
  if (["db", "sql", "table", "grid", "explorer"].includes(p)) return "Database";
  if (["app", "window", "tab", "theme", "help", "nav"].includes(p)) return "Main Menu";
  return "Other";
}

/** `"Ctrl+Alt+Shift+Enter"` -> `["Ctrl", "Alt", "Shift", "Enter"]`; `"Shift Shift"` -> `["Shift", "Shift"]`. */
export function keyCaps(shortcut: string): string[] {
  if (shortcut.includes(" ")) return shortcut.split(" ");
  const parts = shortcut.split("+");
  // a trailing "+" key ("Ctrl++") splits into an empty last part
  if (parts.length > 1 && parts[parts.length - 1] === "") return [...parts.slice(0, -2), "+"];
  return parts;
}


/** Groups reduced to the actions whose title or shortcut contains the query (empty query: unchanged). */
export function filterKeymap(groups: KeymapGroup[], query: string): KeymapGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({
      name: g.name,
      actions: g.actions.filter(
        (a) => a.title.toLowerCase().includes(q) || a.shortcuts.some((s) => s.join("+").toLowerCase().includes(q) || s.join(" ").toLowerCase().includes(q)),
      ),
    }))
    .filter((g) => g.actions.length > 0);
}
