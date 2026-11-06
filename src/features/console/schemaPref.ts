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

const PATH_KEY = "console.searchPath";
let pathCache: Record<string, string> | undefined;
const paths = () => (pathCache ??= loadLocal<Record<string, string>>(PATH_KEY, {}));

/**
 * The value list of the `SET search_path` the user ran in a console, verbatim (`"$user", public`): a reopened session
 * runs it again, which one schema name could not express.
 */
export function savedSearchPath(dsId: string, consoleName: string): string | null {
  return paths()[keyOf(dsId, consoleName)] ?? null;
}

/** `null` forgets it (RESET / DEFAULT, or the schema was switched some other way). */
export function saveSearchPath(dsId: string, consoleName: string, path: string | null): void {
  const m = { ...paths() };
  if (path) m[keyOf(dsId, consoleName)] = path;
  else delete m[keyOf(dsId, consoleName)];
  if (JSON.stringify(m) === JSON.stringify(paths())) return;
  pathCache = m;
  saveUiState(PATH_KEY, m);
}
