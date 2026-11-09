/**
 * Find Usages, pure part: grouping of the usages by kind (DataGrip's order) and the word search over the SQL texts
 * (open and saved consoles, scratch and opened `.sql` files). No backend, no DOM.
 */
import type { Usage, UsageKind } from "../../api/db";

/** The groups of the result, in the order they are listed. */
export const USAGE_GROUPS: readonly { kind: UsageKind; label: string }[] = [
  { kind: "view", label: "Views" },
  { kind: "materializedView", label: "Materialized Views" },
  { kind: "function", label: "Functions" },
  { kind: "procedure", label: "Procedures" },
  { kind: "package", label: "Packages" },
  { kind: "packageBody", label: "Package Bodies" },
  { kind: "trigger", label: "Triggers" },
  { kind: "foreignKey", label: "Foreign Keys" },
  { kind: "synonym", label: "Synonyms" },
  { kind: "index", label: "Indexes" },
];

export interface UsageGroup {
  kind: UsageKind;
  label: string;
  items: Usage[];
}

/** Schema, then name, then line (objects without lines last), then detail. */
export function compareUsage(a: Usage, b: Usage): number {
  return (
    cmp(a.schema, b.schema) ||
    cmp(a.name, b.name) ||
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
    cmp(a.detail, b.detail)
  );
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Usages grouped by kind in `USAGE_GROUPS` order; kinds without usages are left out. Input is not modified. */
export function groupUsages(list: readonly Usage[]): UsageGroup[] {
  const byKind = new Map<UsageKind, Usage[]>();
  for (const u of list) {
    const bucket = byKind.get(u.kind);
    if (bucket) bucket.push(u);
    else byKind.set(u.kind, [u]);
  }
  const out: UsageGroup[] = [];
  for (const g of USAGE_GROUPS) {
    const items = byKind.get(g.kind);
    if (items?.length) out.push({ kind: g.kind, label: g.label, items: [...items].sort(compareUsage) });
  }
  return out;
}

/** A SQL text to search: an open or saved console (`console`), or a `.sql` file (`path`). */
export interface SqlText {
  name: string;
  text: string;
  console: boolean;
  dsId?: string;
  path?: string;
  scratch?: boolean;
}

/** A line of a SQL text that names the searched word. `line` is 1-based, `text` is the trimmed line. */
export interface TextHit {
  name: string;
  line: number;
  text: string;
  console: boolean;
  dsId?: string;
  path?: string;
  scratch?: boolean;
}

/** Identifier characters of the backend's word rule (`contains_word` in usages.rs). */
const IDENT = "\\p{L}\\p{N}_$#";

/** Matches `word` as a whole identifier, case-insensitively: not inside `invoices_archive` or `my_invoices`. */
export function wordPattern(word: string): RegExp {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![${IDENT}])${esc}(?![${IDENT}])`, "iu");
}

/** Every line of every text that names `word`, in the order of the texts, at most `max` hits. */
export function searchSqlText(texts: readonly SqlText[], word: string, max = 500): TextHit[] {
  const w = word.trim();
  if (!w) return [];
  const re = wordPattern(w);
  const out: TextHit[] = [];
  for (const t of texts) {
    const lines = t.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      out.push({ name: t.name, line: i + 1, text: lines[i].trim(), console: t.console, dsId: t.dsId, path: t.path, scratch: t.scratch });
      if (out.length >= max) return out;
    }
  }
  return out;
}
