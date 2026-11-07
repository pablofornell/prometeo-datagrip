import type { BinaryCell, Cell, ColumnKind, DefaultCell, GridColumn, SqlExprCell } from "./types";

/** Shared sentinel for "set DEFAULT" (serialises to `{"$default": true}` as dbcore expects). */
export const DEFAULT_VALUE: DefaultCell = Object.freeze({ $default: true }) as DefaultCell;

export function isDefaultCell(v: Cell): v is DefaultCell {
  return v === DEFAULT_VALUE || (typeof v === "object" && v !== null && (v as DefaultCell).$default === true);
}

export function isExprCell(v: Cell): v is SqlExprCell {
  return typeof v === "object" && v !== null && typeof (v as SqlExprCell).$expr === "string";
}

export function isBinaryCell(v: Cell): v is BinaryCell {
  return typeof v === "object" && v !== null && typeof (v as BinaryCell).$bin === "string";
}

const NUMBER_RE = /^(u?(tiny|small|medium|big)?int(eger)?[0-9]*|(big|small)?serial[0-9]*|numeric|decimal|dec|float[0-9]*|double|real|money|smallmoney|number|oid|year)\b/;

/** Classifies a database type name into the rendering kind. */
export function classifyType(typeName: string): ColumnKind {
  const t = typeName.trim().toLowerCase();
  if (!t) return "other";
  if (t === "bool" || t === "boolean") return "bool";
  if (t === "json" || t === "jsonb") return "json";
  if (t === "uuid") return "uuid";
  if (t.startsWith("timestamp") || t.startsWith("datetime")) return "datetime";
  if (t === "date") return "date";
  if (t.startsWith("time")) return "time";
  if (t.startsWith("interval")) return "other";
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|image|raw)\b/.test(t)) return "binary";
  if (NUMBER_RE.test(t)) return "number";
  if (/^(char|varchar|nvarchar|nchar|text|tinytext|mediumtext|longtext|string|citext|name|clob|character|bpchar|enum)/.test(t)) return "text";
  return "other";
}

const MAX_DISPLAY = 400;
const WS_RE = /[\r\n\t\u2028\u2029]+/g;
const WS_TEST = /[\r\n\t\u2028\u2029]/;

export interface CellDisplay {
  text: string;
  /** Extra CSS classes: `nul` (placeholder), `bin`, `b` (boolean). */
  cls: string;
}

/**
 * Display text of a value, always single-line and cut to `maxChars` (callers pass what fits the column + a few,
 * so shaping cost does not depend on the value length; CSS adds the ellipsis).
 */
export function displayCell(v: Cell, kind: ColumnKind, maxChars = MAX_DISPLAY, nullText = "<null>"): CellDisplay {
  if (v === null || v === undefined) return { text: nullText, cls: " nul" };
  if (typeof v === "string") {
    const s = v.length > maxChars ? v.slice(0, maxChars) : v;
    return { text: WS_TEST.test(s) ? s.replace(WS_RE, " ") : s, cls: "" };
  }
  if (typeof v === "boolean") return { text: v ? "• true" : "  false", cls: " b" };
  if (typeof v === "number") return { text: String(v), cls: "" };
  if (isDefaultCell(v)) return { text: "<default>", cls: " nul" };
  if (isExprCell(v)) return { text: v.$expr, cls: " expr" };
  if (isBinaryCell(v)) {
    const more = v.truncated || (v.len !== undefined && v.len * 2 > v.$bin.length);
    return { text: "0x" + v.$bin.toUpperCase() + (more ? "…" : ""), cls: " bin" };
  }
  void kind;
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return { text: s.length > maxChars ? s.slice(0, maxChars) : s, cls: "" };
}

/** Right-aligned (numbers). A NULL in a number column is right-aligned too. */
export function isRightAligned(kind: ColumnKind, v: Cell): boolean {
  return kind === "number" || typeof v === "number";
}

/** Full text of a value as shown in the editors (no truncation, newlines kept). */
export function editText(v: Cell): string {
  if (v === null || v === undefined || isDefaultCell(v)) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isExprCell(v)) return v.$expr;
  if (isBinaryCell(v)) return "0x" + v.$bin;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const NUM_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parses text typed in an editor into a cell value for the given column kind. */
export function parseEdit(text: string, kind: ColumnKind): Cell {
  if (kind === "text" || kind === "other") return text;
  const t = text.trim();
  if (t === "") return null;
  switch (kind) {
    case "number": {
      if (!NUM_LITERAL.test(t)) return text;
      const n = Number(t);
      // keep precision for big/decimal literals as strings (dbcore sends those as strings)
      return Number.isSafeInteger(n) || (/[.eE]/.test(t) && String(n) === t) ? n : t;
    }
    case "bool": {
      const l = t.toLowerCase();
      if (l === "true" || l === "t" || l === "1" || l === "yes") return true;
      if (l === "false" || l === "f" || l === "0" || l === "no") return false;
      return text;
    }
    case "json": {
      try {
        return JSON.parse(t);
      } catch {
        return text;
      }
    }
    default:
      return text;
  }
}

export function isEditableKind(kind: ColumnKind, col: GridColumn): boolean {
  return kind !== "binary" && !col.readOnly;
}

/** Comparable key for local sorting: numbers numerically, booleans 0/1, everything else as string. */
export function sortKey(v: Cell, kind: ColumnKind): number | string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (kind === "number") {
      const n = Number(v);
      return Number.isNaN(n) ? v : n;
    }
    return v;
  }
  if (isBinaryCell(v)) return v.$bin;
  if (isExprCell(v)) return v.$expr;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function compareKeys(a: number | string | null, b: number | string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : 1;
}

/** Number of characters a cell occupies when drawn (for auto-fit). */
export function displayLength(v: Cell, kind: ColumnKind, nullText = "<null>"): number {
  if (typeof v === "string") return Math.min(v.length, MAX_DISPLAY);
  return displayCell(v, kind, MAX_DISPLAY, nullText).text.length;
}
