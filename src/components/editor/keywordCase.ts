import { HARD_KEYWORDS } from "./keywords";
import { lex } from "./lexer";
import type { Dialect } from "./split";

/** Settings > Editor > Code Style > SQL > Keywords case. */
export type KeywordCase = "keep" | "upper" | "lower";

/** Reserved words that are safe to re-case anywhere (a column is never called `primary` or `constraint`). */
const STATEMENT_WORDS = new Set(
  `primary foreign references unique check default constraint add column rename to begin commit rollback
  transaction truncate returning cascade restrict if grant revoke explain analyze recursive over partition
  window filter materialized temporary temp trigger function procedure sequence interval`.split(/\s+/),
);

/** The text with its reserved words in the requested case (names, strings and comments are untouched). */
export function applyKeywordCase(text: string, dialect: Dialect, mode: KeywordCase): string {
  if (mode === "keep") return text;
  let out = "";
  let pos = 0;
  const toks = lex(text, dialect);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "word") continue;
    const w = text.slice(t.from, t.to);
    const lw = w.toLowerCase();
    if (!HARD_KEYWORDS.has(lw) && !STATEMENT_WORDS.has(lw)) continue;
    // `t.left`, `schema.table`, `x.select`: a name after a dot is not a keyword
    if (i > 0 && text[toks[i - 1].to - 1] === "." && toks[i - 1].to === t.from) continue;
    const next = mode === "upper" ? w.toUpperCase() : lw;
    if (next === w) continue;
    out += text.slice(pos, t.from) + next;
    pos = t.to;
  }
  return out + text.slice(pos);
}
