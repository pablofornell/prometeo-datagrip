/**
 * Column references inside the SQL that a SQLite rebuild recreates verbatim (triggers, expression / partial indexes):
 * token-aware rewrite for renamed columns, so that `new.v` becomes `new.w` and strings, comments and other tables'
 * columns stay as they are.
 */

type Tok = { kind: "word" | "quoted" | "other"; text: string; start: number; end: number };

/** Words, quoted identifiers and punctuation; string literals and comments are skipped (they are not references). */
function tokens(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) i++;
    else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      i = j + 1;
    } else if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length && !(sql[j] === close && (ch === "[" || sql[j + 1] !== close))) j += sql[j] === close && ch !== "[" ? 2 : 1;
      out.push({ kind: "quoted", text: sql.slice(i, j + 1), start: i, end: j + 1 });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      out.push({ kind: "word", text: sql.slice(i, j), start: i, end: j });
      i = j;
    } else {
      out.push({ kind: "other", text: ch, start: i, end: i + 1 });
      i++;
    }
  }
  return out;
}

function unquote(t: Tok): string {
  if (t.kind !== "quoted") return t.text;
  const q = t.text[0];
  const body = t.text.slice(1, -1);
  return q === "[" ? body : body.split(q + q).join(q);
}

export interface Rewrite {
  sql: string;
  /** Old names that appear where the rewrite cannot tell whose column it is (left as they are). */
  loose: string[];
  /** Names of removed columns that the statement still refers to. */
  gone: string[];
}

/**
 * Renames the columns in `sql`. `map` is old name -> new name, or `null` for a dropped column (only reported).
 * Always renamed: `new.x` / `old.x` and the `update of x, y` list of a trigger. A bare word that is the old name
 * elsewhere is renamed when `bare` (an index: every bare name after the table is a column of the table) and otherwise
 * left and reported in `loose` (a trigger body can use a column of another table).
 */
export function rewriteColumns(
  sql: string,
  map: Map<string, string | null>,
  quote: (name: string) => string,
  opts: { bare?: boolean; from?: number } = {},
): Rewrite {
  const lower = new Map([...map].map(([k, v]) => [k.toLowerCase(), v]));
  const toks = tokens(sql);
  const loose = new Set<string>();
  const gone = new Set<string>();
  let out = "";
  let at = 0;
  let updateOf = false;
  toks.forEach((t, i) => {
    const prev = toks[i - 1];
    const prev2 = toks[i - 2];
    const after = toks[i + 1];
    if (t.kind === "word") {
      const w = t.text.toLowerCase();
      if (w === "of" && prev?.kind === "word" && prev.text.toLowerCase() === "update") updateOf = true;
      else if (updateOf && w === "on") updateOf = false;
    }
    if (t.kind === "other" || t.start < (opts.from ?? 0)) return;
    const name = unquote(t);
    if (!lower.has(name.toLowerCase())) return;
    const next = lower.get(name.toLowerCase());
    const dotted = prev?.text === "." && prev.kind === "other";
    const owner = dotted && prev2 && prev2.kind !== "other" ? unquote(prev2).toLowerCase() : "";
    const sure = owner === "new" || owner === "old" || (updateOf && !dotted);
    if (dotted && !sure) return; // `other.x`: a column of something else
    if (!sure && !opts.bare) {
      if (after?.text === "(") return; // a function that happens to be called like the column
      // keywords and function names that equal a column name are noise, but we cannot tell them apart
      loose.add(name);
      return;
    }
    if (next == null) {
      gone.add(name);
      return;
    }
    const q = t.kind === "quoted" ? (t.text[0] === "[" ? `[${next}]` : t.text[0] === "`" ? "`" + next.replace(/`/g, "``") + "`" : '"' + next.replace(/"/g, '""') + '"') : quote(next);
    out += sql.slice(at, t.start) + q;
    at = t.end;
  });
  return { sql: out + sql.slice(at), loose: [...loose], gone: [...gone] };
}

/** `create trigger [if not exists] name ...` -> name. */
export function triggerName(sql: string): string {
  const m = /create\s+(?:temp(?:orary)?\s+)?trigger\s+(?:if\s+not\s+exists\s+)?(?:\w+\.)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)/i.exec(sql);
  return m ? m[1].replace(/^["`[]|["`\]]$/g, "") : "";
}

/** Position of the `(` that opens the column list of a `create index ... on table (...)`; 0 if not found. */
export function indexColumnsStart(sql: string): number {
  const toks = tokens(sql);
  let seenOn = false;
  for (const t of toks) {
    if (t.kind === "word" && t.text.toLowerCase() === "on") seenOn = true;
    else if (seenOn && t.kind === "other" && t.text === "(") return t.start;
  }
  return 0;
}
