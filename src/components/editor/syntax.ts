/**
 * Syntax inspection over the tokens of ONE statement: a dangling comma, an operator or keyword without its
 * operand and unbalanced parentheses. It only reports what is certain: anything it does not understand is accepted.
 */
import type { Token } from "./lexer";

export interface SyntaxProblem {
  from: number;
  to: number;
  message: string;
}

const OPERATORS = new Set(["=", "<", ">", "+", "-", "/", "%", "|", "&", "^", "~", "!"]);
/** Words after which an expression must follow. */
const NEEDS_EXPRESSION = new Set(["where", "having", "by", "and", "or", "not", "on", "when", "then", "else", "in", "like", "ilike", "between", "is", "limit", "offset"]);
const NEEDS_TABLE = new Set(["from", "join", "into"]);
/** Words that start the next clause: nothing before them may be left open. */
const CLAUSE = new Set(["from", "where", "group", "order", "having", "limit", "offset", "union", "intersect", "except"]);
/** A keyword before `*` makes it the select-all star, not a multiplication. */
const HEAD = new Set(["select", "distinct", "all", "by", "where", "and", "or", "when", "then", "else", "on", "in", "having", "not", "limit", "offset", "like", "is", "between", "as", "from", "join"]);

export function syntaxProblems(text: string, toks: Token[]): SyntaxProblem[] {
  const sig = toks.filter((t) => t.kind !== "comment");
  const n = sig.length;
  if (n === 0) return [];
  const raw = sig.map((t) => text.slice(t.from, t.to));
  const lw = sig.map((t, i) => (t.kind === "word" ? raw[i].toLowerCase() : raw[i]));
  // meta commands and anything not starting like SQL are not judged
  if ((sig[0].kind !== "word" && !(sig[0].kind === "punct" && raw[0] === "(")) || lw[0] === "delimiter") return [];
  const isP = (i: number, p: string): boolean => i >= 0 && i < n && sig[i].kind === "punct" && raw[i] === p;
  const isW = (i: number): boolean => i >= 0 && i < n && sig[i].kind === "word";
  const out: SyntaxProblem[] = [];
  const seen = new Set<number>();
  const add = (i: number, message: string): void => {
    if (seen.has(sig[i].from)) return;
    seen.add(sig[i].from);
    out.push({ from: sig[i].from, to: sig[i].to, message });
  };
  /** The next token is where an operand should be but something else is: report it (or the last token at the end). */
  const missing = (i: number, what: string): void => {
    const j = i + 1;
    if (j >= n) return add(i, `${what} expected`);
    const stop = isP(j, ";") || isP(j, ")") || (isW(j) && CLAUSE.has(lw[j]));
    if (stop) add(j, `${what} expected, got '${raw[j]}'`);
  };
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isP(i, "(")) stack.push(i);
    else if (isP(i, ")")) {
      if (stack.length) stack.pop();
      else add(i, "Unmatched ')'");
    }
    if (isP(i, ",")) {
      if (isP(i - 1, "(") || isP(i - 1, ",") || (isW(i - 1) && lw[i - 1] === "select")) add(i, `<expression> expected, got ','`);
      else missing(i, "<expression>");
    } else if (sig[i].kind === "punct" && OPERATORS.has(raw[i])) {
      missing(i, "<expression>");
    } else if (isP(i, "*") && i > 0 && (sig[i - 1].kind !== "punct" || isP(i - 1, ")")) && !(isW(i - 1) && HEAD.has(lw[i - 1]))) {
      missing(i, "<expression>");
    } else if (isW(i)) {
      if (NEEDS_EXPRESSION.has(lw[i])) missing(i, "<expression>");
      else if (NEEDS_TABLE.has(lw[i])) missing(i, "<table name>");
      else if (lw[i] === "as") missing(i, "<identifier>");
    }
  }
  if (stack.length) {
    add(n - 1, isP(n - 1, ";") ? `')' expected, got ';'` : `')' expected`);
  }
  return out.sort((a, b) => a.from - b.from);
}

