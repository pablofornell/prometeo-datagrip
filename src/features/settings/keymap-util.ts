/** Pure helpers of the Keymap page (no UI imports, unit tested): the grouped action tree, shortcut editing, conflicts. */

export interface KeymapAction {
  id: string;
  title: string;
  icon?: string;
  /** All shortcuts in force, each as its key caps (`["Ctrl", "Enter"]`). */
  shortcuts: string[][];
  /** The same shortcuts in the registry syntax (`"Ctrl+Enter"`). */
  raw: string[];
  /** The shortcuts the action is registered with. */
  defaults: string[];
  /** The user changed the shortcuts of this action (shown in blue). */
  modified: boolean;
}

export interface KeymapGroup {
  name: string;
  /** Unique key of the folder (`Database/Execution`). */
  path: string;
  children: KeymapGroup[];
  actions: KeymapAction[];
}

/** What the tree is built from: an action of the registry with its registered shortcuts. */
export interface KeymapSource {
  id: string;
  title: string;
  icon?: string;
  defaults: string[];
}

export type Overrides = Record<string, string[]>;

export const GROUP_ORDER = ["Editor Actions", "Main Menu", "Tool Windows", "Database", "Other"];
const SUB_ORDER: Record<string, string[]> = {
  "Main Menu": ["File", "View", "Navigate", "Window", "Help"],
  Database: ["Execution", "Transactions", "Data Editor", "Database Explorer", "Extractors"],
};

/** Folder path of an action (DataGrip: Editor Actions, Main Menu > ..., Tool Windows, Database > Execution ...). */
export function groupPathOf(id: string): string[] {
  const [p, rest = ""] = id.split(".");
  if (p === "edit" || p === "code" || p === "editor") return ["Editor Actions"];
  if (p === "toolwindow") return ["Tool Windows"];
  if (p === "sql") return rest === "commit" || rest === "rollback" ? ["Database", "Transactions"] : ["Database", "Execution"];
  if (p === "table") return ["Database", "Data Editor"];
  if (p === "grid" || p === "import") return ["Database", "Extractors"];
  if (p === "db" || p === "explorer") return ["Database", "Database Explorer"];
  if (p === "app") return ["Main Menu", rest === "quickSwitch" ? "Navigate" : "File"];
  if (p === "nav") return ["Main Menu", "Navigate"];
  if (p === "view" || p === "theme") return ["Main Menu", "View"];
  if (p === "window" || p === "tab") return ["Main Menu", "Window"];
  if (p === "help") return ["Main Menu", "Help"];
  return ["Other"];
}

/** Kept for callers that only need the top-level folder. */
export function groupOf(id: string): string {
  return groupPathOf(id)[0];
}

/** `"Ctrl+Alt+Shift+Enter"` -> `["Ctrl", "Alt", "Shift", "Enter"]`; `"Shift Shift"` -> `["Shift", "Shift"]`. */
export function keyCaps(shortcut: string): string[] {
  if (shortcut.includes(" ")) return shortcut.split(" ");
  const parts = shortcut.split("+");
  // a trailing "+" key ("Ctrl++") splits into an empty last part
  if (parts.length > 1 && parts[parts.length - 1] === "") return [...parts.slice(0, -2), "+"];
  return parts;
}

const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];

/** The registry syntax in one canonical spelling (`ctrl+shift+f` -> `Ctrl+Shift+F`), for comparisons and storage. */
export function normalizeShortcut(s: string): string {
  if (s.includes(" ") || s.length === 0) return s;
  const caps = keyCaps(s);
  const key = caps[caps.length - 1];
  const mods = new Set(caps.slice(0, -1).map((m) => m.toLowerCase()));
  const outMods = MOD_ORDER.filter((m) => mods.has(m.toLowerCase()) || (m === "Ctrl" && mods.has("control")) || (m === "Meta" && mods.has("cmd")));
  const k = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  return [...outMods, k].join("+");
}

const KEY_NAMES: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  "+": "Plus",
  "-": "Minus",
  "=": "Equals",
};

export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The shortcut a key event stands for, in the registry syntax; `null` for a lone modifier key. */
export function chordFromEvent(e: KeyEventLike): string | null {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock", "Dead"].includes(e.key)) return null;
  let key: string;
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (e.code === "Backslash") key = "\\";
  else if (e.code === "Slash") key = "/";
  else if (e.code === "Quote") key = "'";
  else if (e.code === "Comma") key = "Comma";
  else if (e.code === "Period") key = ".";
  else if (e.code === "Backquote") key = "`";
  else key = KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean) as string[];
  return [...mods, key].join("+");
}

/** The tree: top-level folders in DataGrip order, sub-folders in theirs, actions in registration order. */
export function buildKeymap(sources: KeymapSource[], overrides: Overrides): KeymapGroup[] {
  const root: KeymapGroup[] = [];
  const folder = (list: KeymapGroup[], name: string, path: string): KeymapGroup => {
    let g = list.find((x) => x.name === name);
    if (!g) list.push((g = { name, path, children: [], actions: [] }));
    return g;
  };
  for (const s of sources) {
    if (!s.title) continue;
    const raw = overrides[s.id] ?? s.defaults;
    const path = groupPathOf(s.id);
    let list = root;
    let g!: KeymapGroup;
    path.forEach((name, i) => {
      g = folder(list, name, path.slice(0, i + 1).join("/"));
      list = g.children;
    });
    g.actions.push({
      id: s.id,
      title: s.title.replace(/…$|\.\.\.$/, ""),
      icon: s.icon,
      raw,
      defaults: s.defaults,
      shortcuts: raw.map(keyCaps),
      modified: s.id in overrides,
    });
  }
  const rank = (order: string[], n: string) => (order.includes(n) ? order.indexOf(n) : order.length);
  const sortRec = (list: KeymapGroup[], order: string[]) => {
    list.sort((a, b) => rank(order, a.name) - rank(order, b.name));
    for (const g of list) sortRec(g.children, SUB_ORDER[g.name] ?? []);
  };
  sortRec(root, GROUP_ORDER);
  return root;
}

/** Every action of the tree, flattened. */
export function allActions(groups: KeymapGroup[]): KeymapAction[] {
  return groups.flatMap((g) => [...g.actions, ...allActions(g.children)]);
}

function prune(groups: KeymapGroup[], keep: (a: KeymapAction) => boolean): KeymapGroup[] {
  return groups
    .map((g) => ({ ...g, children: prune(g.children, keep), actions: g.actions.filter(keep) }))
    .filter((g) => g.children.length > 0 || g.actions.length > 0);
}

/** Groups reduced to the actions whose title or shortcut contains the query (empty query: unchanged). */
export function filterKeymap(groups: KeymapGroup[], query: string): KeymapGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return prune(
    groups,
    (a) => a.title.toLowerCase().includes(q) || a.shortcuts.some((s) => s.join("+").toLowerCase().includes(q) || s.join(" ").toLowerCase().includes(q)),
  );
}

/** Groups reduced to the actions that have exactly this shortcut ("Find Actions by Shortcut"). */
export function filterByShortcut(groups: KeymapGroup[], shortcut: string): KeymapGroup[] {
  const want = normalizeShortcut(shortcut);
  return prune(groups, (a) => a.raw.some((s) => normalizeShortcut(s) === want));
}

/** The other actions that already use `shortcut`. */
export function findConflicts(groups: KeymapGroup[], id: string, shortcut: string): KeymapAction[] {
  const want = normalizeShortcut(shortcut);
  return allActions(groups).filter((a) => a.id !== id && a.raw.some((s) => normalizeShortcut(s) === want));
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => normalizeShortcut(x) === normalizeShortcut(b[i]));

/** `list` becomes the shortcut list of `id`; the override disappears when it equals the registered default. */
export function setShortcuts(overrides: Overrides, id: string, defaults: string[], list: string[]): Overrides {
  const next = { ...overrides };
  if (sameList(list, defaults)) delete next[id];
  else next[id] = list;
  return next;
}

/** Adds `shortcut` to `id`; the actions in `takeFrom` lose it (the "Remove" answer of the conflicts dialog). */
export function addShortcut(groups: KeymapGroup[], overrides: Overrides, id: string, shortcut: string, takeFrom: string[] = []): Overrides {
  const want = normalizeShortcut(shortcut);
  const acts = new Map(allActions(groups).map((a) => [a.id, a]));
  let next = overrides;
  for (const other of takeFrom) {
    const a = acts.get(other);
    if (a) next = setShortcuts(next, other, a.defaults, a.raw.filter((s) => normalizeShortcut(s) !== want));
  }
  const me = acts.get(id);
  if (!me || me.raw.some((s) => normalizeShortcut(s) === want)) return next;
  return setShortcuts(next, id, me.defaults, [...me.raw, want]);
}

/** Removes one shortcut of `id`. */
export function removeShortcut(groups: KeymapGroup[], overrides: Overrides, id: string, shortcut: string): Overrides {
  const me = allActions(groups).find((a) => a.id === id);
  if (!me) return overrides;
  const want = normalizeShortcut(shortcut);
  return setShortcuts(overrides, id, me.defaults, me.raw.filter((s) => normalizeShortcut(s) !== want));
}

/** Back to the registered shortcuts of `id`. */
export function resetShortcuts(overrides: Overrides, id: string): Overrides {
  const next = { ...overrides };
  delete next[id];
  return next;
}
