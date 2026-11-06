/**
 * SQL statement splitter and "statement at caret" lookup.
 *
 * Port of `crates/dbcore/src/split.rs` (keep both in sync, including the test cases in
 * `split.test.ts` which mirror the Rust tests). Offsets are UTF-16 code units, which is what
 * CodeMirror and JavaScript strings use. Rust works on UTF-8 bytes and treats every byte >= 0x80
 * as an identifier character; here every code unit >= 0x80 is one, which behaves the same.
 *
 * Dialect aware, best effort. Handled:
 * - all: `'..'` strings, `".."` identifiers, `--` and block comments;
 * - PostgreSQL: `$tag$ ... $tag$` dollar quoting, `E'..\'..'` escape strings, nested block
 *   comments, `CREATE FUNCTION .. BEGIN ATOMIC .. END`;
 * - MySQL: backticks, `#` and `-- ` comments, backslash escapes, `DELIMITER xx` lines,
 *   `BEGIN .. END` bodies of `CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT`;
 * - SQLite: backticks, `[bracket]` identifiers, `CREATE TRIGGER .. BEGIN .. END;` bodies.
 */

export type Dialect = "postgres" | "mysql" | "sqlite";

export interface Statement {
  index: number;
  /** Statement text without the trailing delimiter and surrounding whitespace. */
  text: string;
  start: number;
  end: number;
  /** End including the delimiter that terminated the statement. */
  fullEnd: number;
}

interface Raw {
  start: number;
  end: number;
  fullEnd: number;
}

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
const isAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isIdentStart = (c: number): boolean => isAlpha(c) || c === 0x5f || c >= 0x80;
const isIdent = (c: number): boolean => isAlpha(c) || isDigit(c) || c === 0x5f || c === 0x24 || c >= 0x80;

const Q_SINGLE = 0x27;
const Q_DOUBLE = 0x22;
const Q_BACKTICK = 0x60;

class Scanner {
  delimiter = ";";
  constructor(readonly s: string, readonly d: Dialect) {}

  /** `i` points at the opening quote. Returns the index after the closing quote (or EOF). */
  skipQuoted(i: number, q: number, backslash: boolean): number {
    const s = this.s;
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

  skipLine(i: number): number {
    const s = this.s;
    while (i < s.length && s.charCodeAt(i) !== 0x0a) i += 1;
    return i;
  }

  skipBlockComment(i: number): number {
    const s = this.s;
    const n = s.length;
    const nested = this.d === "postgres";
    let depth = 1;
    i += 2;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 0x2a && i + 1 < n && s.charCodeAt(i + 1) === 0x2f) {
        depth -= 1;
        i += 2;
        if (depth === 0) return i;
      } else if (nested && c === 0x2f && i + 1 < n && s.charCodeAt(i + 1) === 0x2a) {
        depth += 1;
        i += 2;
      } else {
        i += 1;
      }
    }
    return n;
  }

  /** If a comment starts at `i`, the index after it. */
  commentEnd(i: number, atStmtStart: boolean): number | null {
    const s = this.s;
    const n = s.length;
    const c = s.charCodeAt(i);
    if (c === 0x2d && i + 1 < n && s.charCodeAt(i + 1) === 0x2d) {
      if (this.d === "mysql") {
        // MySQL requires whitespace / control char / EOL after "--"
        const ok = i + 2 >= n || isWs(s.charCodeAt(i + 2)) || s.charCodeAt(i + 2) < 0x20;
        if (!ok) return null;
      }
      return this.skipLine(i);
    }
    if (c === 0x23 && this.d === "mysql") return this.skipLine(i);
    if (c === 0x2f && i + 1 < n && s.charCodeAt(i + 1) === 0x2a) {
      // `/*! ... */` is executed by MySQL: it is code, not a comment, at statement start
      if (this.d === "mysql" && atStmtStart && i + 2 < n && s.charCodeAt(i + 2) === 0x21) return null;
      return this.skipBlockComment(i);
    }
    return null;
  }

  /** The identifier word at `i` (no `$`), and the index after it. */
  wordAt(i: number): [string, number] {
    const s = this.s;
    let j = i;
    while (j < s.length && isIdent(s.charCodeAt(j)) && s.charCodeAt(j) !== 0x24) j += 1;
    return [s.slice(i, j), j];
  }

  /** Next word after `i`, skipping whitespace, upper-cased. */
  peekWord(i: number): string | null {
    const s = this.s;
    while (i < s.length && isWs(s.charCodeAt(i))) i += 1;
    if (i < s.length && isIdentStart(s.charCodeAt(i))) return this.wordAt(i)[0].toUpperCase();
    return null;
  }
}

function splitRaw(sql: string, d: Dialect): Raw[] {
  const n = sql.length;
  const sc = new Scanner(sql, d);
  const out: Raw[] = [];

  let i = 0;
  let start: number | null = null;
  let firstWords: string[] = [];
  let compound = false; // statement is a CREATE of something with a BEGIN..END body
  let depth = 0;
  let prevWord = "";

  const finish = (end: number, full: number): void => {
    if (start !== null) {
      let e = end;
      while (e > start && isWs(sql.charCodeAt(e - 1))) e -= 1;
      out.push({ start, end: e, fullEnd: full });
      start = null;
    }
    firstWords = [];
    compound = false;
    depth = 0;
    prevWord = "";
  };

  while (i < n) {
    const c = sql.charCodeAt(i);
    if (isWs(c)) {
      i += 1;
      continue;
    }
    const ce = sc.commentEnd(i, start === null);
    if (ce !== null) {
      i = ce;
      continue;
    }
    // statement terminator
    if (sql.startsWith(sc.delimiter, i) && !(depth > 0 && sc.delimiter === ";")) {
      const dl = sc.delimiter.length;
      finish(i, i + dl);
      i += dl;
      continue;
    }
    // MySQL client command: DELIMITER xx
    if (start === null && d === "mysql" && isIdentStart(c)) {
      const [w, e] = sc.wordAt(i);
      if (w.toLowerCase() === "delimiter" && e < n && (sql[e] === " " || sql[e] === "\t")) {
        let j = e;
        while (j < n && (sql[j] === " " || sql[j] === "\t")) j += 1;
        const ds = j;
        while (j < n && !isWs(sql.charCodeAt(j))) j += 1;
        if (j > ds) {
          sc.delimiter = sql.slice(ds, j);
          i = sc.skipLine(j);
          continue;
        }
      }
    }
    if (start === null) start = i;
    if (c === Q_SINGLE) {
      let backslash = false;
      if (d === "mysql") backslash = true;
      else if (d === "postgres") {
        backslash = i > 0 && (sql[i - 1] === "E" || sql[i - 1] === "e") && (i < 2 || !isIdent(sql.charCodeAt(i - 2)));
      }
      i = sc.skipQuoted(i, Q_SINGLE, backslash);
    } else if (c === Q_DOUBLE) {
      i = sc.skipQuoted(i, Q_DOUBLE, d === "mysql");
    } else if (c === Q_BACKTICK && d !== "postgres") {
      i = sc.skipQuoted(i, Q_BACKTICK, false);
    } else if (c === 0x5b && d === "sqlite") {
      while (i < n && sql.charCodeAt(i) !== 0x5d) i += 1;
      i = Math.min(i + 1, n);
    } else if (c === 0x24 && d === "postgres") {
      const prevIdent = i > 0 && isIdent(sql.charCodeAt(i - 1));
      if (prevIdent || i + 1 >= n || isDigit(sql.charCodeAt(i + 1))) {
        i += 1;
        continue;
      }
      // $tag$
      let j = i + 1;
      if (sql.charCodeAt(j) !== 0x24) {
        if (!isIdentStart(sql.charCodeAt(j))) {
          i += 1;
          continue;
        }
        while (j < n && isIdent(sql.charCodeAt(j)) && sql.charCodeAt(j) !== 0x24) j += 1;
      }
      if (j < n && sql.charCodeAt(j) === 0x24) {
        const tag = sql.slice(i, j + 1);
        const k = sql.indexOf(tag, j + 1);
        i = k < 0 ? n : k + tag.length;
      } else {
        i += 1;
      }
    } else if (isIdentStart(c)) {
      const [w, e] = sc.wordAt(i);
      const upper = w.toUpperCase();
      if (firstWords.length < 12) {
        firstWords.push(upper);
        if (!compound && firstWords[0] === "CREATE") {
          const has = (k: string[]): boolean => firstWords.some((x) => k.includes(x));
          compound =
            d === "sqlite"
              ? has(["TRIGGER"])
              : d === "mysql"
                ? has(["PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"])
                : has(["FUNCTION", "PROCEDURE"]);
        }
      }
      if (sc.delimiter === ";" && compound) {
        if (upper === "BEGIN") {
          if (d !== "postgres" || sc.peekWord(e) === "ATOMIC") depth += 1;
        } else if (upper === "CASE") {
          if (depth > 0 && prevWord !== "END") depth += 1;
        } else if (upper === "END") {
          if (depth > 0) {
            const next = sc.peekWord(e);
            const closesOther = next === "IF" || next === "LOOP" || next === "WHILE" || next === "REPEAT";
            if (!closesOther) depth -= 1;
          }
        }
      }
      prevWord = upper;
      i = e;
    } else {
      i += 1;
    }
  }
  finish(n, n);
  return out;
}

function toStatements(sql: string, raws: Raw[]): Statement[] {
  return raws.map((r, index) => ({
    index,
    text: sql.slice(r.start, r.end),
    start: r.start,
    end: r.end,
    fullEnd: r.fullEnd,
  }));
}

export function splitStatements(sql: string, dialect: Dialect): Statement[] {
  return toStatements(sql, splitRaw(sql, dialect));
}

function pick(raws: Raw[], caret: number): number | null {
  if (raws.length === 0) return null;
  let i = raws.findIndex((r) => caret >= r.start && caret < r.fullEnd);
  if (i >= 0) return i;
  i = raws.findIndex((r) => caret === r.fullEnd);
  if (i >= 0) return i;
  for (let k = raws.length - 1; k >= 0; k--) if (raws[k].fullEnd < caret) return k;
  return 0;
}

/**
 * The statement containing `caret` (a UTF-16 offset). When the caret sits in the blank space
 * between statements the preceding statement wins (the following one if there is no preceding
 * statement), matching DataGrip's "execute current statement".
 */
export function statementAt(sql: string, caret: number, dialect: Dialect): Statement | null {
  const raws = splitRaw(sql, dialect);
  const i = pick(raws, caret);
  return i === null ? null : toStatements(sql, raws)[i];
}

/** Same as {@link statementAt} but also returns the full list (for callers that need both). */
export function statementIndexAt(stmts: Statement[], caret: number): number | null {
  return pick(stmts, caret);
}
