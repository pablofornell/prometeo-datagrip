/**
 * Editor color schemes (Settings > Editor > Color Scheme > SQL). Pure logic, no DOM: the attribute list, the base values
 * of both built-in schemes (read from the theme files, so they cannot drift) and the CSS the user's edits produce.
 *
 * A scheme is "Islands Dark" or "Islands Light". The scheme in use normally follows the UI theme; choosing the other one
 * applies its whole `--dg-editor-*` token family on `<html>`. Edits are kept per scheme, so both keep their own values:
 * the foreground of an attribute is written over the same `--dg-editor-*` token the stylesheet reads, the other
 * properties (bold, italic, background, effect) become rules of a generated stylesheet.
 */
import darkCss from "../theme/dark.css?raw";
import lightCss from "../theme/light.css?raw";

export type SchemeId = "dark" | "light";
export type EffectKind = "box" | "underline" | "wave" | "strike";

/** The user's edit of one attribute. A missing property inherits the scheme's value. */
export interface AttrOverride {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  effect?: EffectKind;
  effectColor?: string;
}

export type SchemeOverrides = Record<SchemeId, Record<string, AttrOverride>>;

export interface SchemeAttr {
  id: string;
  label: string;
  /** CSS class the highlighter puts on the tokens (components/editor/highlight.ts). */
  cls: string;
  /** Tokens that hold the foreground. */
  tokens: string[];
  /** The scheme attribute the value comes from ("Inherit values from: Keyword (Language Defaults)"). */
  inherits: string;
  /** Italic in the stock scheme. */
  italic?: (scheme: SchemeId) => boolean;
}

/** The SQL attributes the editor really renders, in DataGrip's alphabetical order. */
export const SCHEME_ATTRS: SchemeAttr[] = [
  { id: "bad", label: "Bad token", cls: "cm-sql-bad", tokens: ["--dg-editor-wrong-ref"], inherits: "Wrong reference" },
  { id: "col", label: "Column", cls: "cm-sql-col", tokens: ["--dg-editor-field"], inherits: "Instance field" },
  { id: "cmt", label: "Comment", cls: "cm-sql-cmt", tokens: ["--dg-editor-line-comment", "--dg-editor-block-comment"], inherits: "Line comment", italic: (s) => s === "light" },
  { id: "fn", label: "Function call", cls: "cm-sql-fn", tokens: ["--dg-editor-static-method"], inherits: "Static method", italic: () => true },
  { id: "kw", label: "Keyword", cls: "cm-sql-kw", tokens: ["--dg-editor-keyword"], inherits: "Keyword" },
  { id: "num", label: "Number token", cls: "cm-sql-num", tokens: ["--dg-editor-number"], inherits: "Number" },
  { id: "param", label: "Parameter", cls: "cm-sql-param", tokens: ["--dg-editor-parameter"], inherits: "Parameter" },
  { id: "str", label: "String", cls: "cm-sql-str", tokens: ["--dg-editor-string"], inherits: "String" },
];

export const EFFECTS: { value: EffectKind; label: string }[] = [
  { value: "box", label: "Bordered" },
  { value: "underline", label: "Underscored" },
  { value: "wave", label: "Wave underscored" },
  { value: "strike", label: "Strikeout" },
];

export const SCHEME_LABEL: Record<SchemeId, string> = { dark: "Islands Dark", light: "Islands Light" };

export const EMPTY_OVERRIDES: SchemeOverrides = { dark: {}, light: {} };

const TOKEN_RE = /(--dg-editor-[a-z0-9-]+)\s*:\s*([^;]+);/g;

/** Every `--dg-editor-*` declaration of a theme file. */
export function editorTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(TOKEN_RE)) out[m[1]] = m[2].trim();
  return out;
}

const BASE: Record<SchemeId, Record<string, string>> = { dark: editorTokens(darkCss), light: editorTokens(lightCss) };

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const isHex = (s: unknown): s is string => typeof s === "string" && HEX.test(s);

/** `"cf8e6d"` / `"#CF8E6D"` -> `"#CF8E6D"`; `null` when it is not a colour. */
export function parseColor(text: string): string | null {
  const t = text.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(t)) return "#" + [...t].map((c) => c + c).join("").toUpperCase();
  return /^(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(t) ? "#" + t.toUpperCase() : null;
}

/** The scheme's own colour of a token (one level of `var()` is followed); `undefined` when it has none (`inherit`...). */
export function baseColor(scheme: SchemeId, token: string): string | undefined {
  let v = BASE[scheme][token];
  const ref = v?.match(/^var\((--dg-editor-[a-z0-9-]+)\)$/);
  if (ref) v = BASE[scheme][ref[1]];
  return v && isHex(v) ? v.toUpperCase() : undefined;
}

export function attrBaseFg(attr: SchemeAttr, scheme: SchemeId): string {
  return baseColor(scheme, attr.tokens[0]) ?? (scheme === "dark" ? "#BCBEC4" : "#080808");
}

/**
 * Custom properties to put on `<html>`: the whole editor token family of `scheme` when it is not the UI theme's own,
 * then the foreground edits.
 */
export function schemeVars(scheme: SchemeId, uiTheme: SchemeId, edits: Record<string, AttrOverride> | undefined): Record<string, string> {
  const vars: Record<string, string> = scheme === uiTheme ? {} : { ...BASE[scheme] };
  for (const a of SCHEME_ATTRS) {
    const fg = edits?.[a.id]?.fg;
    if (isHex(fg)) for (const t of a.tokens) vars[t] = fg;
  }
  return vars;
}

/** Rules for bold / italic / background / effect edits; `prefixes` are the selectors the token classes live under. */
export function schemeRules(edits: Record<string, AttrOverride> | undefined, prefixes: string[]): string {
  if (!edits) return "";
  const out: string[] = [];
  for (const a of SCHEME_ATTRS) {
    const o = edits[a.id];
    if (!o) continue;
    const decl: string[] = [];
    if (isHex(o.bg)) decl.push(`background-color:${o.bg}`);
    if (o.bold !== undefined) decl.push(`font-weight:${o.bold ? 700 : 400}`);
    if (o.italic !== undefined) decl.push(`font-style:${o.italic ? "italic" : "normal"}`);
    if (o.effect) {
      const c = isHex(o.effectColor) ? o.effectColor : isHex(o.fg) ? o.fg : "currentColor";
      if (o.effect === "box") decl.push(`outline:1px solid ${c}`, "outline-offset:-1px");
      else if (o.effect === "underline") decl.push(`text-decoration:underline ${c}`, "text-underline-offset:3px");
      else if (o.effect === "wave") decl.push(`text-decoration:underline wavy ${c}`, "text-underline-offset:3px", "text-decoration-thickness:1px");
      else decl.push(`text-decoration:line-through ${c}`);
    }
    if (decl.length) out.push(`${prefixes.map((p) => `${p} .${a.cls}`).join(",")}{${decl.join(";")}}`);
  }
  return out.join("\n");
}

/** True when the edit changes nothing (all properties missing). */
export function isEmptyOverride(o: AttrOverride | undefined): boolean {
  return !o || Object.values(o).every((v) => v === undefined);
}

/** `edits` with `patch` merged into attribute `id`; an attribute left without properties is dropped. */
export function patchOverride(edits: Record<string, AttrOverride>, id: string, patch: Partial<AttrOverride>): Record<string, AttrOverride> {
  const next = { ...edits, [id]: { ...edits[id], ...patch } };
  for (const k of Object.keys(next[id]) as (keyof AttrOverride)[]) if (next[id][k] === undefined) delete next[id][k];
  if (isEmptyOverride(next[id])) delete next[id];
  return next;
}

/** Settings loaded from storage may be anything: keep only well-formed colour attributes. */
export function sanitizeOverrides(raw: unknown): SchemeOverrides {
  const out: SchemeOverrides = { dark: {}, light: {} };
  if (!raw || typeof raw !== "object") return out;
  for (const sc of ["dark", "light"] as const) {
    const src = (raw as Record<string, unknown>)[sc];
    if (!src || typeof src !== "object") continue;
    for (const a of SCHEME_ATTRS) {
      const o = (src as Record<string, Record<string, unknown>>)[a.id];
      if (!o || typeof o !== "object") continue;
      const clean: AttrOverride = {};
      if (isHex(o.fg)) clean.fg = o.fg;
      if (isHex(o.bg)) clean.bg = o.bg;
      if (typeof o.bold === "boolean") clean.bold = o.bold;
      if (typeof o.italic === "boolean") clean.italic = o.italic;
      if (EFFECTS.some((e) => e.value === o.effect)) clean.effect = o.effect as EffectKind;
      if (isHex(o.effectColor)) clean.effectColor = o.effectColor;
      if (!isEmptyOverride(clean)) out[sc][a.id] = clean;
    }
  }
  return out;
}
