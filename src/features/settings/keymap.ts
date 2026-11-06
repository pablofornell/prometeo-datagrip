/** Data of the read-only Keymap page: the registered actions grouped like DataGrip's keymap tree. */
import { listActions } from "../../state/actions";
import { GROUP_ORDER, type KeymapAction, type KeymapGroup, groupOf, keyCaps } from "./keymap-util";

export { filterKeymap } from "./keymap-util";
export type { KeymapAction, KeymapGroup } from "./keymap-util";

/** Reactive (the registry tracks registrations): call inside a memo. */
export function collectKeymap(): KeymapGroup[] {
  const groups = new Map<string, KeymapAction[]>();
  for (const a of listActions()) {
    if (!a.title) continue;
    const sc = Array.isArray(a.shortcut) ? a.shortcut : a.shortcut ? [a.shortcut] : [];
    const g = groupOf(a.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ id: a.id, title: a.title.replace(/…$|\.\.\.$/, ""), icon: a.icon, shortcuts: sc.map(keyCaps) });
  }
  return GROUP_ORDER.filter((g) => groups.has(g)).map((name) => ({ name, actions: groups.get(name)! }));
}
