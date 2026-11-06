import { lex, type Token } from "./lexer";
import { HARD_KEYWORDS } from "./keywords";
import { splitStatements, type Dialect } from "./split";

/**
 * A small SQL formatter laid out the way DataGrip's default style looks in its console:
 * clauses at the left margin, select-list continuation under the first column (7), JOINs
 * indented by 9, AND/OR of WHERE/HAVING on their own lines indented by 2, sub-queries and
 * CTE bodies in parentheses indented by 4. Keyword case is kept as typed.
 */

const OPCHARS = "<>=!|-+*/%^&~@#";
const JOIN_START = new Set(["left", "right", "inner", "full", "cross", "natural", "join"]);
const JOIN_PART = new Set(["left", "right", "inner", "full", "cross", "natural", "outer", "join", "lateral"]);
const BREAK_CLAUSES = new Set(["select", "from", "where", "having", "limit", "offset", "values", "returning", "window", "insert", "delete", "with", "union", "intersect", "except"]);
const WRAP_COL = 100;

interface Frame {
  base: number;
  query: boolean;
  clause: string;
  /** Column of the continuation indent for comma-wrapped lists. */
  cont: number;
  betweenPending: boolean;
  /** Frame was opened by a function-like word: no space before `(`. */
  tail?: boolean;
}

function mergeOps(src: string, toks: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of toks) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "punct" &&
      t.kind === "punct" &&
      prev.to === t.from &&
      OPCHARS.includes(src[t.from]) &&
      OPCHARS.includes(src[prev.from]) &&
      t.to - prev.from <= 3 &&
      // keep `= -1` style unary minus separate: only merge known compound operators
      ["<=", ">=", "<>", "!=", "||", "->", "->>", "#>", "#>>", "<<", ">>", "&&", "@>", "<@", "~*", "!~", "!~*", "<=>", "==", "**"].includes(src.slice(prev.from, t.to))
    ) {
      prev.to = t.to;
    } else out.push({ ...t });
  }
  return out;
}

export function formatStatement(src: string, dialect: Dialect): string {
  const toks = mergeOps(src, lex(src, dialect));
  const frames: Frame[] = [{ base: 0, query: true, clause: "", cont: 0, betweenPending: false }];
  let out = "";
  let lineStart = true;
  let prev: Token | undefined;
  let prevL = "";
  let pendingBreak = false; // after a line comment
  const text = (t: Token): string => src.slice(t.from, t.to);
  const top = (): Frame => frames[frames.length - 1];
  const col = (): number => out.length - (out.lastIndexOf("\n") + 1);
  const nl = (indent: number): void => {
    out = out.replace(/[ \t]+$/, "") + "\n" + " ".repeat(Math.max(0, indent));
    lineStart = true;
  };
  const isWord = (t: Token | undefined): boolean => !!t && (t.kind === "word" || t.kind === "qident");

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const s = text(t);
    const l = t.kind === "word" ? s.toLowerCase() : s;
    const next = toks[k + 1];
    const nextL = next && next.kind === "word" ? text(next).toLowerCase() : "";
    const f = top();

    if (t.kind === "comment") {
      if (pendingBreak) nl(f.base);
      else if (!lineStart) out += " ";
      out += s;
      lineStart = false;
      pendingBreak = s.startsWith("--") || s.startsWith("#");
      prev = t;
      prevL = l;
      continue;
    }

    // ---- line breaks before clause keywords
    let breakIndent: number | null = null;
    if (t.kind === "word" && f.query) {
      const call = next?.kind === "punct" && text(next) === "(";
      if (BREAK_CLAUSES.has(l) && !(l === "from" && prevL === "distinct") && !(l === "select" && lineStart) && !(l === "insert" && prevL === "on")) {
        if (!(l === "with" && prev && out.length > 0 && prevL !== ";")) breakIndent = f.base;
        if (l === "values" && prevL === ")") breakIndent = f.base;
        if (l === "limit" || l === "offset") breakIndent = f.base;
        if (l === "union" || l === "intersect" || l === "except") breakIndent = f.base;
        if (l === "select" && ["union", "all", "intersect", "except", "distinct"].includes(prevL) && prevL !== "distinct") breakIndent = f.base;
      } else if ((l === "group" || l === "order") && nextL === "by") breakIndent = f.base;
      else if (l === "update" && out.trim() === "") breakIndent = null;
      else if (l === "set" && !["update", "do"].includes(prevL) && f.clause !== "select") breakIndent = f.base;
      else if (JOIN_START.has(l) && !JOIN_PART.has(prevL) && !(call && (l === "left" || l === "right")) && f.clause === "from") breakIndent = f.base + 9;
      else if ((l === "and" || l === "or") && (f.clause === "where" || f.clause === "having")) {
        if (l === "and" && f.betweenPending) f.betweenPending = false;
        else breakIndent = f.base + 2;
      }
      if (l === "between") f.betweenPending = true;
    }
    if (breakIndent !== null && out.trim() !== "") {
      nl(breakIndent);
      pendingBreak = false;
    } else if (pendingBreak) {
      nl(f.base + (f.clause === "select" ? 7 : 4));
    }
    pendingBreak = false;

    // ---- spacing
    if (!lineStart && prev) {
      const pt = prev.kind === "punct" ? text(prev) : "";
      const ppL = toks[k - 2] && toks[k - 2].kind === "word" ? text(toks[k - 2]).toLowerCase() : "";
      let space = true;
      if (pt === "(" || pt === "[" || pt === "." || pt === "::") space = false;
      else if (t.kind === "punct") {
        if ([",", ";", ")", ".", "]", "::"].includes(s)) space = false;
        else if (s === "(") {
          if (isWord(prev)) {
            const spaced = HARD_KEYWORDS.has(prevL) || ["using", "over", "filter", "within"].includes(prevL) || ["into", "table", "view", "join", "from", "update", "references", "index", "on", "as"].includes(ppL);
            space = spaced;
          } else space = !(prev.kind === "param");
        } else if (s === "[") space = !(isWord(prev) || pt === ")" || pt === "]");
      }
      // unary sign: no space after a sign that has no left operand
      if (space && (pt === "-" || pt === "+")) {
        const before = toks[k - 2];
        const bt = before ? text(before) : "";
        const unary = !before || (before.kind === "punct" && bt !== ")" && bt !== "]") || (before.kind === "word" && HARD_KEYWORDS.has(bt.toLowerCase()));
        if (unary) space = false;
      }
      if (space) out += " ";
    }
    out += s;
    lineStart = false;

    // ---- state updates
    if (t.kind === "word") {
      if (["select", "from", "where", "having", "set", "values", "returning", "limit", "offset", "on", "with"].includes(l) && f.query) {
        f.clause = l;
        if (l === "select") f.cont = f.base + 7;
      } else if ((l === "group" || l === "order") && nextL === "by") f.clause = l;
      else if (JOIN_START.has(l) && f.query && f.clause !== "select") f.clause = "from";
      else if (l === "on" && f.query) f.clause = "on";
    }
    if (t.kind === "punct") {
      if (s === "(") {
        const q = nextL === "select" || nextL === "with" || (nextL === "values" && f.clause !== "from");
        const innerBase = f.base + 4;
        frames.push({ base: q ? innerBase : f.base, query: q, clause: "", cont: 0, betweenPending: false, tail: !q });
        if (q) {
          nl(innerBase);
          prev = t;
          prevL = l;
          continue;
        }
      } else if (s === ")" && frames.length > 1) {
        const closed = frames.pop() as Frame;
        if (closed.query) {
          // put `)` on its own line at the outer base
          out = out.slice(0, out.length - 1).replace(/[ \t]+$/, "");
          nl(top().base);
          out += ")";
        }
      } else if (s === "," && f.query && next) {
        // wrap long select / from lists under their first item
        if ((f.clause === "select" || f.clause === "from") && col() > WRAP_COL) {
          nl(f.clause === "select" ? f.cont : f.base + 5);
        }
      } else if (s === ";") {
        // statement terminator inside the text (shouldn't happen when split per statement)
      }
    }
    prev = t;
    prevL = l;
  }
  return out.replace(/[ \t]+$/gm, "");
}

/** Format a whole script: each statement is reformatted, the text between statements is kept. */
export function formatScript(sql: string, dialect: Dialect): string {
  const stmts = splitStatements(sql, dialect);
  let out = "";
  let pos = 0;
  for (const st of stmts) {
    out += sql.slice(pos, st.start);
    out += formatStatement(st.text, dialect);
    pos = st.end;
  }
  return out + sql.slice(pos);
}
