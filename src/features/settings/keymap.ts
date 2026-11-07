/** Data of the Keymap page: the registered actions grouped like DataGrip's keymap tree, with the user's edits applied. */
import { defaultShortcuts, listActions } from "../../state/actions";
import { type KeymapGroup, type KeymapSource, type Overrides, buildKeymap } from "./keymap-util";

export { filterByShortcut, filterKeymap, allActions, findConflicts, addShortcut, removeShortcut, resetShortcuts, chordFromEvent, normalizeShortcut } from "./keymap-util";
export type { KeymapAction, KeymapGroup, Overrides } from "./keymap-util";

/** Reactive (the registry tracks registrations): call inside a memo. */
export function collectKeymap(overrides: Overrides): KeymapGroup[] {
  const sources: KeymapSource[] = [];
  for (const a of listActions()) if (a.title) sources.push({ id: a.id, title: a.title, icon: a.icon, defaults: defaultShortcuts(a) });
  return buildKeymap(sources, overrides);
}
