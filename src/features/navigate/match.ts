/**
 * IntelliJ-style name matching for Search Everywhere / Go to Database Object.
 *
 * The query is split into "chunks" of consecutive characters. Every chunk must match contiguous text, and every
 * chunk after the first must start at a word start of the name (after `_`, `-`, `.`, a space, a lower->UPPER
 * camel hump, or the start of an upper-case word like `HTMLParser`). Matching ignores case.
 *
 *   "oi"   -> order_items      (o at the start, i at the word start)
 *   "ordit"-> order_items      (ord + it)
 *   "oi"   -> OrderItem        (camel humps)
 *   "der"  -> order_items      (plain substring, lowest tier)
 *
 * Separators typed in the query (`ord_it`, `new con`) force a chunk break.
 * Ranking is a tier (exact > prefix > word start > in-word substring) then fewer chunks.
 */

export type Range = [number, number];

export interface PreparedQuery {
  /** The query as typed (trimmed). */
  raw: string;
  /** Lower-case, trimmed. */
  rawLower: string;
  /** Lower-case without separators. */
  flat: string;
  /** Indexes into `flat` where a new chunk must start (after a typed separator). */
  breaks: Set<number>;
}

export interface MatchResult {
  /** Higher is better. */
  score: number;
  chunks: number;
  /** Empty unless asked for. */
  ranges: Range[];
}

const SEP = /[\s_\-.$]+/;

export function prepareQuery(query: string): PreparedQuery {
  const raw = query.trim();
  const parts = raw.toLowerCase().split(SEP).filter(Boolean);
  const breaks = new Set<number>();
  let at = 0;
  for (const p of parts) {
    breaks.add(at);
    at += p.length;
  }
  return { raw, rawLower: raw.toLowerCase(), flat: parts.join(""), breaks };
}

const code = (s: string, i: number) => s.charCodeAt(i);
const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isAlnum = (c: number) => isUpper(c) || isLower(c) || isDigit(c) || c > 127;

/** Is `name[i]` the first character of a word (underscore, camel hump, upper-case run end, after a separator)? */
export function isWordStart(name: string, i: number): boolean {
  const c = code(name, i);
  if (!isAlnum(c)) return false;
  if (i === 0) return true;
  const p = code(name, i - 1);
  if (!isAlnum(p)) return true;
  if (isLower(p) && isUpper(c)) return true;
  if (isUpper(p) && isUpper(c) && i + 1 < name.length && isLower(code(name, i + 1))) return true;
  return false;
}

export const TIER_EXACT = 100;
export const TIER_PREFIX = 90;
export const TIER_WORD = 80;
export const TIER_WORDS_FROM_START = 70;
export const TIER_WORDS = 60;
export const TIER_ANYTHING = 50;
export const TIER_INSIDE = 40;
export const TIER_INSIDE_WORDS = 30;

// DP scratch space shared by all calls (matching is synchronous).
let memo = new Int16Array(4096);
let choice = new Int32Array(4096);
const UNKNOWN = -1;
const NONE = 10_000;

/**
 * Matches `name` (`lower` = `name.toLowerCase()`, passed in so callers can cache it). Returns null when the query
 * does not match. `withRanges` also fills the matched character ranges (for highlighting).
 */
export function matchName(name: string, lower: string, q: PreparedQuery, withRanges = false): MatchResult | null {
  const flat = q.flat;
  const m = flat.length;
  if (m === 0) return q.raw === "" ? null : { score: TIER_ANYTHING * 100, chunks: 0, ranges: [] };
  const n = name.length;
  if (m > n) return null;
  // Cheap subsequence rejection: most names fail here.
  let k = 0;
  for (let i = 0; i < n && k < m; i++) if (lower.charCodeAt(i) === flat.charCodeAt(k)) k++;
  if (k < m) return null;

  if (lower === q.rawLower) return { score: TIER_EXACT * 100, chunks: 1, ranges: withRanges ? [[0, n]] : [] };
  if (lower.startsWith(q.rawLower)) return { score: TIER_PREFIX * 100, chunks: 1, ranges: withRanges ? [[0, q.rawLower.length]] : [] };

  const size = (m + 1) * (n + 1);
  if (memo.length < size) {
    memo = new Int16Array(size * 2);
    choice = new Int32Array(size * 2);
  }
  memo.fill(UNKNOWN, 0, size);
  const stride = n + 1;
  const breaks = q.breaks;

  /** Minimum number of chunks to match flat[p:] with chunks starting at word starts >= i (NONE if impossible). */
  const solve = (p: number, i: number): number => {
    if (p === m) return 0;
    const key = p * stride + i;
    const cached = memo[key];
    if (cached !== UNKNOWN) return cached;
    let best = NONE;
    let bestChoice = -1;
    const fc = flat.charCodeAt(p);
    for (let j = i; j < n; j++) {
      if (lower.charCodeAt(j) !== fc || !isWordStart(name, j)) continue;
      let len = 1;
      while (p + len < m && j + len < n && !breaks.has(p + len) && lower.charCodeAt(j + len) === flat.charCodeAt(p + len)) len++;
      for (let l = len; l >= 1; l--) {
        const r = 1 + solve(p + l, j + l);
        if (r < best) {
          best = r;
          bestChoice = j * 4096 + l;
        }
      }
    }
    memo[key] = best;
    choice[key] = bestChoice;
    return best;
  };

  // First chunk: prefer a word start, else anywhere.
  let bestChunks = NONE;
  let bestJ = -1;
  let bestL = 0;
  let firstAtWord = false;
  for (const wordOnly of [true, false]) {
    const fc = flat.charCodeAt(0);
    for (let j = 0; j < n; j++) {
      if (lower.charCodeAt(j) !== fc) continue;
      if (wordOnly !== isWordStart(name, j)) continue;
      let len = 1;
      while (len < m && j + len < n && !breaks.has(len) && lower.charCodeAt(j + len) === flat.charCodeAt(len)) len++;
      for (let l = len; l >= 1; l--) {
        const r = 1 + solve(l, j + l);
        if (r < bestChunks) {
          bestChunks = r;
          bestJ = j;
          bestL = l;
        }
      }
      // A leftmost word-start hit is enough unless a later one needs fewer chunks: keep scanning (cheap, memoized).
    }
    if (bestJ >= 0) {
      firstAtWord = wordOnly;
      break;
    }
  }
  if (bestJ < 0 || bestChunks >= NONE) return null;

  const tier = firstAtWord
    ? bestJ === 0
      ? bestChunks === 1
        ? TIER_PREFIX
        : TIER_WORDS_FROM_START
      : bestChunks === 1
        ? TIER_WORD
        : TIER_WORDS
    : bestChunks === 1
      ? TIER_INSIDE
      : TIER_INSIDE_WORDS;
  const result: MatchResult = { score: tier * 100 - Math.min(bestChunks, 99), chunks: bestChunks, ranges: [] };
  if (withRanges) {
    const ranges: Range[] = [];
    let p = bestL;
    let from = bestJ + bestL;
    ranges.push([bestJ, from]);
    while (p < m) {
      const c = choice[p * stride + from];
      const j = Math.floor(c / 4096);
      const l = c % 4096;
      const last = ranges[ranges.length - 1];
      if (last[1] === j) last[1] = j + l;
      else ranges.push([j, j + l]);
      p += l;
      from = j + l;
    }
    result.ranges = ranges;
  }
  return result;
}

/** Convenience for tests and one-off use. */
export function match(name: string, query: string, withRanges = true): MatchResult | null {
  return matchName(name, name.toLowerCase(), prepareQuery(query), withRanges);
}
