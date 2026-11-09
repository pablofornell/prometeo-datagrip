/**
 * The JSON tab of the value viewer: parsing, the paths of the nodes and the rows of the collapsible tree.
 * Pure functions, no DOM.
 */

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonRow {
  /** JSONPath-like address of the node: `$`, `$.name`, `$[0]`, `$["first name"]`. */
  path: string;
  depth: number;
  /** Member name, array index, or `null` for the root. */
  label: string | null;
  kind: JsonKind;
  /** Containers: the member count ("3 keys", "1 item"). Scalars: the JSON text (long strings cut). */
  summary: string;
  /** The node has members (object or array), so it can be expanded. */
  expandable: boolean;
  value: unknown;
}

const MAX_SUMMARY = 200;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Parses `text`; `null` when it is not JSON. */
export function parseJsonText(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** Is `value` a value the tree is worth showing for (an object or an array)? */
export function isContainer(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

export function kindOf(value: unknown): JsonKind {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    default:
      return "number";
  }
}

/** Path of a member of `parent`: `.name` for identifiers, `["any name"]` otherwise, `[0]` for array items. */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function members(value: unknown): [string | number, unknown][] {
  if (Array.isArray(value)) return value.map((v, i) => [i, v]);
  return Object.entries(value as Record<string, unknown>);
}

function summaryOf(value: unknown): string {
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length} items`;
  if (isContainer(value)) {
    const n = Object.keys(value as object).length;
    return n === 1 ? "1 key" : `${n} keys`;
  }
  if (typeof value === "string") return JSON.stringify(value.length > MAX_SUMMARY ? value.slice(0, MAX_SUMMARY) + "…" : value);
  return String(value);
}

/**
 * The rows of the tree that are visible: the root, and the members of every container whose path is in `expanded`
 * (depth first, in document order).
 */
export function flattenJson(root: unknown, expanded: ReadonlySet<string>): JsonRow[] {
  const out: JsonRow[] = [];
  const walk = (value: unknown, path: string, depth: number, label: string | null) => {
    const expandable = isContainer(value);
    out.push({ path, depth, label, kind: kindOf(value), summary: summaryOf(value), expandable, value });
    if (!expandable || !expanded.has(path)) return;
    for (const [key, child] of members(value)) {
      walk(child, childPath(path, key), depth + 1, String(key));
    }
  };
  walk(root, "$", 0, null);
  return out;
}

/** Paths of every container of `root` (what "Expand All" opens). */
export function containerPaths(root: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (!isContainer(value)) return;
    out.push(path);
    for (const [key, child] of members(value)) walk(child, childPath(path, key));
  };
  walk(root, "$");
  return out;
}

/** The value of a node as text for the clipboard: a string as it is, anything else as indented JSON. */
export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}
