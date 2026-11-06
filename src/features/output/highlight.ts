/** Syntax coloring of the SQL echoed in the log (same lexer and keyword table as the editor). */
import type { Dialect } from "../../components/editor";
import { keywordsFor } from "../../components/editor/keywords";
import { lex } from "../../components/editor/lexer";

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const kwCache = new Map<Dialect, Set<string>>();

/** HTML of `sql` with `<span class="k|s|n|c">` around keywords, strings, numbers and comments. */
export function highlightSql(sql: string, dialect: Dialect): string {
  let kw = kwCache.get(dialect);
  if (!kw) kwCache.set(dialect, (kw = keywordsFor(dialect)));
  let out = "";
  let pos = 0;
  for (const t of lex(sql, dialect)) {
    out += escapeHtml(sql.slice(pos, t.from));
    const text = sql.slice(t.from, t.to);
    const cls = t.kind === "string" ? "s" : t.kind === "number" ? "n" : t.kind === "comment" ? "c" : t.kind === "word" && kw.has(text.toLowerCase()) ? "k" : "";
    out += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
    pos = t.to;
  }
  return out + escapeHtml(sql.slice(pos));
}
