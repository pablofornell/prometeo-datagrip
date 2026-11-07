/**
 * Data source folders (Database Explorer > New > Folder, Move). A UI-state grouping like the schema filter: the
 * folder names and which folder each data source sits in are kept per user, never in the connection settings, so
 * moving a data source never reconnects it.
 *
 * Stored value: `{ folders: string[], group: { [dataSourceId]: folderName } }`.
 */
import { createSignal } from "solid-js";
import { loadLocal, saveUiState } from "./persist";

interface Stored {
  folders: string[];
  group: Record<string, string>;
}

const KEY = "dsFolders";
const [state, setState] = createSignal<Stored>(loadLocal<Stored>(KEY, { folders: [], group: {} }));

const commit = (next: Stored): void => {
  setState(next);
  saveUiState(KEY, next);
};

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/** Folder names, alphabetical. */
export const dsFolders = (): string[] => [...state().folders].sort(byName);

/** The folder a data source sits in (`undefined` = top level). Only existing folders count. */
export const dsGroupOf = (dsId: string): string | undefined => {
  const g = state().group[dsId];
  return g && state().folders.includes(g) ? g : undefined;
};

/** Creates a folder; returns its (trimmed) name, or null when the name is empty or taken (case-insensitive). */
export function addDsFolder(name: string): string | null {
  const n = name.trim();
  if (!n || state().folders.some((f) => f.toLowerCase() === n.toLowerCase())) return null;
  commit({ ...state(), folders: [...state().folders, n] });
  return n;
}

/** Renames a folder (its data sources follow). False when the new name is empty or taken. */
export function renameDsFolder(from: string, to: string): boolean {
  const n = to.trim();
  const taken = state().folders.some((f) => f !== from && f.toLowerCase() === n.toLowerCase());
  if (!n || taken || !state().folders.includes(from)) return false;
  const group = Object.fromEntries(Object.entries(state().group).map(([id, g]) => [id, g === from ? n : g]));
  commit({ folders: state().folders.map((f) => (f === from ? n : f)), group });
  return true;
}

/** Removes a folder; its data sources go back to the top level. */
export function removeDsFolder(name: string): void {
  const group = Object.fromEntries(Object.entries(state().group).filter(([, g]) => g !== name));
  commit({ folders: state().folders.filter((f) => f !== name), group });
}

/** Moves a data source into a folder (`null` = top level). */
export function moveToDsFolder(dsId: string, folder: string | null): void {
  const group = { ...state().group };
  if (folder && state().folders.includes(folder)) group[dsId] = folder;
  else delete group[dsId];
  commit({ ...state(), group });
}

/** Forgets a removed data source. */
export function forgetDsGroup(dsId: string): void {
  if (!(dsId in state().group)) return;
  const group = { ...state().group };
  delete group[dsId];
  commit({ ...state(), group });
}

/** Tests: replace the state. */
export function resetDsFolders(v: Stored = { folders: [], group: {} }): void {
  setState(v);
}
