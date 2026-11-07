/** The saved run configurations (persisted with the UI state, like the open tabs). */
import { createSignal } from "solid-js";
import { loadLocal, saveUiState } from "../../state/persist";
import { type RunConfig, newConfig, sanitize, uniqueName } from "./model";

const [configs, setConfigs] = createSignal<RunConfig[]>(sanitize(loadLocal<unknown>("runConfigs", [])));
export { configs };

function commit(next: RunConfig[]): void {
  setConfigs(next);
  saveUiState("runConfigs", next);
}

export const configById = (id: string): RunConfig | undefined => configs().find((c) => c.id === id);

/** Inserts or replaces by id. */
export function saveConfig(c: RunConfig): void {
  const list = configs();
  commit(list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c]);
}

export function removeConfig(id: string): void {
  commit(configs().filter((c) => c.id !== id));
}

/** The configuration of a script file (the temporary one made by "Run '<file>'"), if any. */
export const configOfFile = (path: string): RunConfig | undefined => configs().find((c) => c.mode === "files" && c.files.length === 1 && c.files[0] === path);

export function copyConfig(c: RunConfig): RunConfig {
  const { id: _id, ...rest } = c;
  return newConfig({ ...rest, targets: c.targets.map((t) => ({ ...t })), files: [...c.files], name: uniqueName(c.name, configs().map((x) => x.name)), temporary: false });
}
