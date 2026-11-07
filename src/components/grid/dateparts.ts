/**
 * Date / time text <-> parts, for the picker under a date cell editor. Pure functions, no DOM.
 * The text keeps what the picker does not show (fractional seconds, `T` separator, time zone suffix).
 */
import type { ColumnKind } from "./types";

export interface DateParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** `.316831` (with the dot) or empty. */
  frac: string;
  /** ` ` or `T` between date and time. */
  sep: string;
  /** `+02`, `Z`, ` UTC`... whatever follows the seconds. */
  tz: string;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const pad2 = (n: number) => String(Math.trunc(n)).padStart(2, "0");

export function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const DATE_RE = /^(\d{4,6})-(\d{1,2})-(\d{1,2})/;
const TIME_RE = /(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(.*)$/;

/** Parts of a cell text; null when it does not look like a date / time of that kind. */
export function parseDateParts(text: string, kind: ColumnKind): DateParts | null {
  const t = text.trim();
  const out: DateParts = { y: 1970, mo: 1, d: 1, h: 0, mi: 0, s: 0, frac: "", sep: " ", tz: "" };
  let rest = t;
  if (kind !== "time") {
    const m = DATE_RE.exec(t);
    if (!m) return null;
    out.y = Number(m[1]);
    out.mo = Number(m[2]);
    out.d = Number(m[3]);
    if (out.mo < 1 || out.mo > 12 || out.d < 1 || out.d > 31) return null;
    rest = t.slice(m[0].length);
    if (kind === "date") return rest.trim() === "" ? out : null;
    if (rest === "") return out;
    out.sep = rest[0] === "T" ? "T" : " ";
    rest = rest.replace(/^[T\s]+/, "");
  }
  const m = TIME_RE.exec(rest);
  if (!m) return rest === "" && kind === "datetime" ? out : null;
  out.h = Number(m[1]);
  out.mi = Number(m[2]);
  out.s = m[3] ? Number(m[3]) : 0;
  out.frac = m[4] ?? "";
  out.tz = m[5] ? (/^[+-Z]/.test(m[5]) ? m[5] : " " + m[5]) : "";
  if (out.h > 23 || out.mi > 59 || out.s > 59) return null;
  return out;
}

/** Text of the parts (the day is clamped to the month). */
export function formatDateParts(p: DateParts, kind: ColumnKind): string {
  const day = Math.min(p.d, daysIn(p.y, p.mo));
  const date = `${String(p.y).padStart(4, "0")}-${pad2(p.mo)}-${pad2(day)}`;
  const time = `${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}${p.frac}${p.tz}`;
  if (kind === "date") return date;
  if (kind === "time") return time;
  return `${date}${p.sep}${time}`;
}

/** Wraps a number into [lo, hi] (spinners roll over). */
export function wrap(n: number, lo: number, hi: number): number {
  const span = hi - lo + 1;
  return ((((n - lo) % span) + span) % span) + lo;
}
