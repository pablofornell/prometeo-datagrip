/**
 * Query parameters of a script: `?`, `:name`, `$1`, `${name}` and `#name#`. They are found with the SQL lexer, so
 * the ones inside strings, comments and quoted identifiers, PostgreSQL `::` casts and `@user_variable`s are left
 * alone. The values are substituted textually (DataGrip's default "inline" mode).
 */
import { lex } from "../../components/editor/lexer";
import { keywordsFor } from "../../components/editor/keywords";
import type { Dialect } from "../../components/editor/types";

export interface ParamRef {
  /** Identity of the parameter: `?1` (the first `?`), `:name`, `$1`, `${name}`, `#name#`. */
  key: string;
  from: number;
  to: number;
}

export type ParamType = "sql" | "string" | "number";

export interface ParamValue {
  value: string;
  type: ParamType;
}

/** The distinct parameters of `sql`, in order of first occurrence. */
export function paramList(refs: ParamRef[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refs) {
    if (!seen.has(r.key)) {
      seen.add(r.key);
      out.push(r.key);
    }
  }
  return out;
}

/** Every parameter occurrence of `sql`. */
export function findParams(sql: string, dialect: Dialect): ParamRef[] {
  if (!/[?:$#]/.test(sql)) return [];
  const toks = lex(sql, dialect);
  const kws = keywordsFor(dialect);
  const out: ParamRef[] = [];
  let ordinal = 0;
  const text = (i: number): string => sql.slice(toks[i].from, toks[i].to);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === "param") {
      const s = text(i);
      if (s === "?") {
        if (dialect === "postgres") {
          // `data ? 'key'` is the jsonb operator: it follows an operand
          const p = i > 0 ? toks[i - 1] : undefined;
          const pt = p ? sql.slice(p.from, p.to) : "";
          const operand = !!p && (p.kind === "qident" || p.kind === "string" || p.kind === "number" || pt === ")" || pt === "]" || (p.kind === "word" && !kws.has(pt.toLowerCase())));
          const next = sql[t.to];
          if (operand || next === "|" || next === "&") continue;
        }
        out.push({ key: `?${++ordinal}`, from: t.from, to: t.to });
      } else if (s[0] === "$") out.push({ key: s, from: t.from, to: t.to });
      else if (dialect === "oracle" && /^:(new|old|parent)$/i.test(s)) continue; // trigger row correlation names
      else if (s[0] === ":" && /^:[A-Za-z_]/.test(s)) out.push({ key: s, from: t.from, to: t.to });
      // `@name` / `@@var` are session variables, `:1` is an array slice
      continue;
    }
    if (t.kind !== "punct") continue;
    const s = text(i);
    // `${name}`
    if (s === "$" && i + 3 < toks.length && text(i + 1) === "{" && toks[i + 1].from === t.to && toks[i + 2].kind === "word" && toks[i + 2].from === toks[i + 1].to && text(i + 3) === "}" && toks[i + 3].from === toks[i + 2].to) {
      out.push({ key: "${" + text(i + 2) + "}", from: t.from, to: toks[i + 3].to });
      i += 3;
    }
    // `#name#` (a `#` starts a comment in MySQL)
    else if (s === "#" && i + 2 < toks.length && toks[i + 1].kind === "word" && toks[i + 1].from === t.to && text(i + 2) === "#" && toks[i + 2].from === toks[i + 1].to) {
      out.push({ key: `#${text(i + 1)}#`, from: t.from, to: toks[i + 2].to });
      i += 2;
    }
  }
  return out;
}

/** The SQL text a value stands for. Null: the value is not valid for its type. */
export function literalOf(v: ParamValue): string | null {
  const s = v.value.trim();
  if (v.type === "string") return `'${v.value.replace(/'/g, "''")}'`;
  if (v.type === "number") return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? s : null;
  return s === "" ? null : s;
}

export interface Substituted {
  sql: string;
  /** Offset in the original text of an offset of the substituted text (statement positions of the server events). */
  unmap: (p: number) => number;
}

/** Replaces every occurrence by its value's literal. Missing / invalid values stay as they are. */
export function substitute(sql: string, refs: ParamRef[], values: Record<string, ParamValue>): Substituted {
  const parts: string[] = [];
  const marks: { newFrom: number; newLen: number; from: number; to: number }[] = [];
  let at = 0;
  let len = 0;
  for (const r of [...refs].sort((a, b) => a.from - b.from)) {
    const v = values[r.key];
    const lit = v ? literalOf(v) : null;
    if (lit === null) continue;
    const gap = sql.slice(at, r.from);
    parts.push(gap, lit);
    len += gap.length;
    marks.push({ newFrom: len, newLen: lit.length, from: r.from, to: r.to });
    len += lit.length;
    at = r.to;
  }
  parts.push(sql.slice(at));
  const unmap = (p: number): number => {
    let delta = 0;
    for (const m of marks) {
      if (p < m.newFrom) break;
      if (p < m.newFrom + m.newLen) return m.from;
      delta += m.newLen - (m.to - m.from);
    }
    return p - delta;
  };
  return { sql: parts.join(""), unmap };
}

// ---------------------------------------------------------------- remembered values

const storeKey = (dsId: string, consoleName: string): string => `prometeo.params.${dsId}.${consoleName}`;

/** The values entered earlier in this console, by parameter key. */
export function loadValues(dsId: string, consoleName: string): Record<string, ParamValue> {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(dsId, consoleName)) ?? "{}") as Record<string, ParamValue>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function saveValues(dsId: string, consoleName: string, values: Record<string, ParamValue>): void {
  try {
    localStorage.setItem(storeKey(dsId, consoleName), JSON.stringify(values));
  } catch {
    /* no storage: the values are only kept for this run */
  }
}
