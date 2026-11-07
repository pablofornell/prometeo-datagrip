/**
 * The schema filter as the schema selector popup and Data Sources > Schemas edit it: explicit checked schemas, the
 * `Default schema` row, name patterns (`sch*`, `!temp*`) and an object filter. Pure logic; the stored text is
 * produced / read here, the storage itself is `state/schema-filter.ts`.
 *
 * Stored text (`raw`): absent / "" = the default view (every non-system schema); a JSON array = explicit introspection
 * paths (the original format); a JSON object `{ paths, patterns?, default?, objects? }` when a pattern, the default
 * schema row or an object filter is used.
 */

export interface SchemaItem {
  /** Introspection path: PG `[db, schema]`, MySQL / SQLite `[schema]`. */
  path: string[];
  name: string;
  system: boolean;
  /** The schema the connection starts in (`public`, the connected MySQL database, SQLite `main`). */
  isDefault?: boolean;
}

export interface SchemaFilter {
  /** Schemas checked one by one. */
  paths: string[][];
  /** Name patterns: `sch*` shows matching schemas, `!temp*` hides them. */
  patterns: string[];
  /** The `Default schema` row: the default schema is shown whatever it is called. */
  useDefault: boolean;
  /** Comma separated name patterns of the tables / views shown (empty = all); `!x*` hides. */
  objects: string;
}

export const pathKey = (p: string[]) => p.join("\u0001");

export const EMPTY_FILTER: SchemaFilter = { paths: [], patterns: [], useDefault: false, objects: "" };

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const isPaths = (v: unknown): v is string[][] => Array.isArray(v) && v.every((p) => Array.isArray(p) && p.every((x) => typeof x === "string"));

/** Parses the stored text; `null` = the default view. */
export function parseFilter(raw: string | undefined | null): SchemaFilter | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (isPaths(v)) return { ...EMPTY_FILTER, paths: v };
    if (v && typeof v === "object" && isPaths(v.paths)) {
      return { paths: v.paths, patterns: strs(v.patterns), useDefault: v.default === true, objects: typeof v.objects === "string" ? v.objects : "" };
    }
  } catch {
    /* malformed: the default view */
  }
  return null;
}

/** Text of a filter: undefined when it is the default view for `items`; a plain array when only paths are used. */
export function serializeFilter(f: SchemaFilter, items: SchemaItem[]): string | undefined {
  const plain = !f.patterns.length && !f.useDefault && !f.objects.trim();
  const keys = new Set(f.paths.map(pathKey));
  const dflt = items.filter((i) => !i.system);
  if (plain && keys.size === dflt.length && dflt.every((i) => keys.has(pathKey(i.path)))) return undefined;
  const paths = items.filter((i) => keys.has(pathKey(i.path))).map((i) => i.path);
  if (plain) return JSON.stringify(paths);
  return JSON.stringify({
    paths,
    ...(f.patterns.length ? { patterns: f.patterns } : {}),
    ...(f.useDefault ? { default: true } : {}),
    ...(f.objects.trim() ? { objects: f.objects.trim() } : {}),
  });
}

/** The filter the dialog starts from: the stored one, else every non-system schema checked. */
export function filterOrDefault(raw: string | undefined | null, items: SchemaItem[]): SchemaFilter {
  return parseFilter(raw) ?? { ...EMPTY_FILTER, paths: items.filter((i) => !i.system).map((i) => i.path) };
}

// ---------------------------------------------------------------- patterns

const globRe = (g: string) => new RegExp("^" + g.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");

/** `yes` when a positive pattern matches and no negative one does, `no` when a negative one matches, else `none`. */
export function patternVerdict(name: string, patterns: string[]): "yes" | "no" | "none" {
  let yes = false;
  for (const p of patterns) {
    const t = p.trim();
    if (!t) continue;
    if (t.startsWith("!")) {
      if (globRe(t.slice(1)).test(name)) return "no";
    } else if (globRe(t).test(name)) yes = true;
  }
  return yes ? "yes" : "none";
}

/** Splits `a, b*,!c` into trimmed non-empty tokens. */
export const splitPatterns = (text: string): string[] => text.split(",").map((t) => t.trim()).filter(Boolean);

// ---------------------------------------------------------------- state of one schema

export type CheckState = "on" | "mixed" | "off";

const explicit = (f: SchemaFilter, i: SchemaItem) => f.paths.some((p) => pathKey(p) === pathKey(i.path));

/** Whether the explorer lists the schema. */
export function isVisible(f: SchemaFilter, i: SchemaItem): boolean {
  const v = patternVerdict(i.name, f.patterns);
  if (v === "no") return false;
  return explicit(f, i) || v === "yes" || (f.useDefault && !!i.isDefault);
}

/** Checkbox state: checked = chosen explicitly or by a pattern, mixed = shown only as the default schema. */
export function checkState(f: SchemaFilter, i: SchemaItem): CheckState {
  const v = patternVerdict(i.name, f.patterns);
  if (v === "no") return "off";
  if (explicit(f, i) || v === "yes") return "on";
  return f.useDefault && i.isDefault ? "mixed" : "off";
}

/** The filter after (un)checking one schema. */
export function toggleItem(f: SchemaFilter, i: SchemaItem, on: boolean): SchemaFilter {
  const keep = f.paths.filter((p) => pathKey(p) !== pathKey(i.path));
  const negative = `!${i.name}`;
  let patterns = f.patterns;
  if (on) {
    patterns = patterns.filter((p) => p.toLowerCase() !== negative.toLowerCase());
    return { ...f, paths: [...keep, i.path], patterns };
  }
  // switching off something a pattern or the default row shows: hide it by name
  const shownOtherwise = patternVerdict(i.name, f.patterns) === "yes" || (f.useDefault && !!i.isDefault);
  if (shownOtherwise) patterns = [...patterns, negative];
  return { ...f, paths: keep, patterns };
}

/** State of a group row (`All schemas`, a database): from the visibility of its schemas. */
export function groupState(f: SchemaFilter, items: SchemaItem[]): CheckState {
  const n = items.filter((i) => isVisible(f, i)).length;
  return n === 0 ? "off" : n === items.length ? "on" : "mixed";
}

/** The filter after (un)checking a group row. Off clears the patterns of those schemas too. */
export function toggleGroup(f: SchemaFilter, items: SchemaItem[], on: boolean): SchemaFilter {
  const keys = new Set(items.map((i) => pathKey(i.path)));
  const rest = f.paths.filter((p) => !keys.has(pathKey(p)));
  if (on) return { ...f, paths: [...rest, ...items.map((i) => i.path)] };
  return { ...f, paths: rest, patterns: [], useDefault: false };
}

// ---------------------------------------------------------------- the `Schema pattern:` text

/** The filter as the text field shows it: explicitly checked schemas (`db:schema` for PostgreSQL), then the patterns. */
export function patternText(f: SchemaFilter, items: SchemaItem[]): string {
  const names = items.filter((i) => explicit(f, i)).map((i) => (i.path.length > 1 ? `${i.path[0]}:${i.name}` : i.name));
  return [...names, ...f.patterns].join(",");
}

/** Reads the text back: tokens naming a schema check it, the others are patterns. The default row is kept. */
export function parsePatternText(text: string, items: SchemaItem[], prev: SchemaFilter): SchemaFilter {
  const paths: string[][] = [];
  const patterns: string[] = [];
  for (const t of splitPatterns(text)) {
    const bare = t.includes(":") ? t.slice(t.indexOf(":") + 1) : t;
    const hit = items.find((i) => i.name === bare && (!t.includes(":") || i.path[0] === t.slice(0, t.indexOf(":"))));
    if (hit && !t.startsWith("!")) paths.push(hit.path);
    else patterns.push(t);
  }
  return { ...prev, paths, patterns };
}
