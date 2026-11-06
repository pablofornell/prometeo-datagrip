/** The schema chosen in a console's switcher, remembered per console across restarts (UI state `console.schemas`). */
import { loadLocal, saveUiState } from "../../state/persist";

const KEY = "console.schemas";
let cache: Record<string, string> | undefined;

const all = () => (cache ??= loadLocal<Record<string, string>>(KEY, {}));
const keyOf = (dsId: string, consoleName: string) => `${dsId}\u0000${consoleName}`;

export function savedSchema(dsId: string, consoleName: string): string | null {
  return all()[keyOf(dsId, consoleName)] ?? null;
}

/** `null` forgets the choice (the schema was dropped, or the session default applies again). */
export function saveSchema(dsId: string, consoleName: string, schema: string | null): void {
  const m = { ...all() };
  if (schema) m[keyOf(dsId, consoleName)] = schema;
  else delete m[keyOf(dsId, consoleName)];
  if (JSON.stringify(m) === JSON.stringify(all())) return;
  cache = m;
  saveUiState(KEY, m);
}
