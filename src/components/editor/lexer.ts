import type { Dialect } from "./split";

export type TokKind = "comment" | "string" | "number" | "word" | "qident" | "punct" | "param";

export interface Token {
  kind: TokKind;
  from: number;
  to: number;
}

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x0b;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
export const isIdentStart = (c: number): boolean => isAlpha(c) || c === 0x5f || c >= 0x80;
export const isIdentPart = (c: number): boolean => isAlpha(c) || isDigit(c) || c === 0x5f || c === 0x24 || c >= 0x80;

function skipQuoted(s: string, i: number, q: number, backslash: boolean): number {
  const n = s.length;
  i += 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (backslash && c === 0x5c) {
      i += 2;
      continue;
    }
    if (c === q) {
      if (i + 1 < n && s.charCodeAt(i + 1) === q) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return n;
}

function skipBlock(s: string, i: number, nested: boolean): number {
  const n = s.length;
  let depth = 1;
  i += 2;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x2a && s.charCodeAt(i + 1) === 0x2f) {
      i += 2;
      if (--depth === 0) return i;
    } else if (nested && c === 0x2f && s.charCodeAt(i + 1) === 0x2a) {
      depth++;
      i += 2;
    } else i++;
  }
  return n;
}

/** Tokenize `s` (whitespace is skipped). Never throws; unterminated constructs run to the end. */
export function lex(s: string, d: Dialect): Token[] {
  const out: Token[] = [];
  const n = s.length;
  let i = 0;
  const push = (kind: TokKind, from: number, to: number): void => {
    out.push({ kind, from, to });
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isWs(c)) {
      i++;
      continue;
    }
    const c1 = i + 1 < n ? s.charCodeAt(i + 1) : 0;
    // comments
    if (c === 0x2d && c1 === 0x2d && (d !== "mysql" || i + 2 >= n || isWs(s.charCodeAt(i + 2)))) {
      let j = i;
      while (j < n && s.charCodeAt(j) !== 0x0a) j++;
      push("comment", i, j);
      i = j;
      continue;
    }
    if (c === 0x23 && d === "mysql") {
      let j = i;
      while (j < n && s.charCodeAt(j) !== 0x0a) j++;
      push("comment", i, j);
      i = j;
      continue;
    }
    if (c === 0x2f && c1 === 0x2a) {
      const j = skipBlock(s, i, d === "postgres");
      push("comment", i, j);
      i = j;
      continue;
    }
    if (c === 0x27) {
      const bs = d === "mysql" || (d === "postgres" && i > 0 && /[eE]/.test(s[i - 1]) && (i < 2 || !isIdentPart(s.charCodeAt(i - 2))));
      const j = skipQuoted(s, i, 0x27, bs);
      push("string", i, j);
      i = j;
      continue;
    }
    if (c === 0x22) {
      const j = skipQuoted(s, i, 0x22, d === "mysql");
      push(d === "mysql" ? "string" : "qident", i, j);
      i = j;
      continue;
    }
    if (c === 0x60 && d !== "postgres") {
      const j = skipQuoted(s, i, 0x60, false);
      push("qident", i, j);
      i = j;
      continue;
    }
    if (c === 0x5b && d === "sqlite") {
      let j = i;
      while (j < n && s.charCodeAt(j) !== 0x5d) j++;
      j = Math.min(j + 1, n);
      push("qident", i, j);
      i = j;
      continue;
    }
    if (c === 0x24 && d === "postgres") {
      // $1 parameter or $tag$ ... $tag$
      if (isDigit(c1)) {
        let j = i + 1;
        while (j < n && isDigit(s.charCodeAt(j))) j++;
        push("param", i, j);
        i = j;
        continue;
      }
      let j = i + 1;
      if (c1 !== 0x24) while (j < n && isIdentPart(s.charCodeAt(j)) && s.charCodeAt(j) !== 0x24) j++;
      if (j < n && s.charCodeAt(j) === 0x24 && (c1 === 0x24 || isIdentStart(c1))) {
        const tag = s.slice(i, j + 1);
        const k = s.indexOf(tag, j + 1);
        const e = k < 0 ? n : k + tag.length;
        push("string", i, e);
        i = e;
        continue;
      }
    }
    if (isDigit(c) || (c === 0x2e && isDigit(c1) && !(out.length && out[out.length - 1].to === i && out[out.length - 1].kind === "word"))) {
      let j = i;
      if (c === 0x30 && (c1 === 0x78 || c1 === 0x58)) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(s[j])) j++;
      } else {
        while (j < n && isDigit(s.charCodeAt(j))) j++;
        if (s.charCodeAt(j) === 0x2e && isDigit(s.charCodeAt(j + 1) || 0)) {
          j++;
          while (j < n && isDigit(s.charCodeAt(j))) j++;
        } else if (s.charCodeAt(j) === 0x2e && !isIdentStart(s.charCodeAt(j + 1) || 0) && s.charCodeAt(j + 1) !== 0x2e) {
          j++; // "10."
        }
        if ((s[j] === "e" || s[j] === "E") && (isDigit(s.charCodeAt(j + 1) || 0) || ((s[j + 1] === "+" || s[j + 1] === "-") && isDigit(s.charCodeAt(j + 2) || 0)))) {
          j += 2;
          while (j < n && isDigit(s.charCodeAt(j))) j++;
        }
      }
      push("number", i, j);
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(s.charCodeAt(j))) j++;
      // string prefixes: E'..', B'..', X'..', N'..'
      if (j === i + 1 && s.charCodeAt(j) === 0x27 && /[eEbBxXnN]/.test(s[i]) && (d !== "sqlite" || /[xX]/.test(s[i]))) {
        const bs = d === "mysql" || /[eE]/.test(s[i]);
        const e = skipQuoted(s, j, 0x27, bs);
        push("string", i, e);
        i = e;
        continue;
      }
      push("word", i, j);
      i = j;
      continue;
    }
    if (c === 0x3a && c1 === 0x3a) {
      push("punct", i, i + 2);
      i += 2;
      continue;
    }
    if ((c === 0x3a || c === 0x40) && (isIdentStart(c1) || (c === 0x40 && c1 === 0x40) || (c === 0x3a && isDigit(c1)))) {
      let j = i + 1;
      if (c1 === 0x40) j++;
      while (j < n && isIdentPart(s.charCodeAt(j))) j++;
      push("param", i, j);
      i = j;
      continue;
    }
    if (c === 0x3f) {
      push("param", i, i + 1);
      i++;
      continue;
    }
    push("punct", i, i + 1);
    i++;
  }
  return out;
}
