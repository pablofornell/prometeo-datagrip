/** Small building blocks of the Settings pages: section titles, rows, number fields, search highlighting. */
import { type JSX, createSignal } from "solid-js";
import { Highlighted, TextField } from "../../components/ui";
import { type ThemePref, theme } from "../../state/theme";
import { type SchemeId, parseColor } from "../../state/colorScheme";
import type { Settings } from "../../state/settings";

/** What the pages edit: a draft copy of the settings (committed by OK / Apply) and the theme choice. */
export interface Draft {
  values: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  theme: () => ThemePref;
  setTheme: (t: ThemePref) => void;
  /** Current tree search text: pages highlight their labels with it. */
  query: () => string;
}

/** Label text with the search matches highlighted. */
export function L(props: { q: string; children: string }): JSX.Element {
  return <Highlighted text={props.children} query={props.q} />;
}

/** `Title ────────` group header; the content is indented 24px below it. */
export function Section(props: { title: string; q: string; children: JSX.Element }): JSX.Element {
  return (
    <section class="st-section">
      <div class="st-section-title">
        <span>
          <L q={props.q}>{props.title}</L>
        </span>
        <hr />
      </div>
      <div class="st-section-body">{props.children}</div>
    </section>
  );
}

export function Row(props: { children: JSX.Element; class?: string; disabled?: boolean; field?: boolean }): JSX.Element {
  return (
    <div class={"st-row" + (props.class ? " " + props.class : "")} classList={{ "st-disabled": props.disabled, "st-row-field": props.field }}>
      {props.children}
    </div>
  );
}

export function Hint(props: { children: JSX.Element }): JSX.Element {
  return <div class="st-hint">{props.children}</div>;
}

const fmt = (n: number, decimals: number) => n.toFixed(decimals);

/** Numeric text field: commits valid values in range while typing, reverts the text on blur, Up/Down step. */
export function NumberField(props: {
  value: number;
  min: number;
  max: number;
  decimals?: number;
  step?: number;
  /** 50px field instead of 66px. */
  narrow?: boolean;
  disabled?: boolean;
  onChange: (n: number) => void;
}): JSX.Element {
  const decimals = () => props.decimals ?? 0;
  const [text, setText] = createSignal(fmt(props.value, decimals()));
  const [bad, setBad] = createSignal(false);
  const parse = (s: string): number | null => {
    const t = s.trim().replace(",", ".");
    if (!/^\d+(\.\d*)?$/.test(t)) return null;
    const n = Number(t);
    return n >= props.min && n <= props.max ? n : null;
  };
  const commit = (n: number) => {
    const r = Number(fmt(n, decimals()));
    props.onChange(r);
    return r;
  };
  return (
    <TextField
      class="st-number"
      frameClass={"st-number-frame" + (props.narrow ? " st-narrow" : "")}
      inputmode="decimal"
      disabled={props.disabled}
      error={bad()}
      value={props.disabled ? fmt(props.value, decimals()) : text()}
      onInput={(v) => {
        setText(v);
        const n = parse(v);
        setBad(n === null);
        if (n !== null) commit(n);
      }}
      onBlur={() => {
        setBad(false);
        setText(fmt(props.value, decimals()));
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const step = props.step ?? 1;
        const base = parse(text()) ?? props.value;
        const n = Math.min(props.max, Math.max(props.min, base + (e.key === "ArrowUp" ? step : -step)));
        setBad(false);
        setText(fmt(commit(n), decimals()));
      }}
    />
  );
}

/** Black or white, whichever reads better on the colour. */
function contrastOn(hex: string): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? "#000000" : "#FFFFFF";
}

/** Colour swatch: the hex text is editable, the box opens the system colour chooser. */
export function ColorField(props: { value: string | undefined; fallback: string; disabled?: boolean; onChange: (hex: string) => void }): JSX.Element {
  const shown = () => props.value ?? props.fallback;
  const [text, setText] = createSignal<string | null>(null);
  const commit = (raw: string) => {
    const c = parseColor(raw);
    setText(null);
    if (c) props.onChange(c);
  };
  return (
    <span class="st-swatch" classList={{ "st-swatch-off": props.disabled }} style={{ background: shown().slice(0, 7), color: contrastOn(shown()) }}>
      <input
        class="st-swatch-input"
        spellcheck={false}
        disabled={props.disabled}
        aria-label="Color"
        value={text() ?? shown().slice(1, 7)}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.stopPropagation();
            e.preventDefault();
            commit(e.currentTarget.value);
          }
        }}
      />
      <input
        class="st-swatch-pick"
        type="color"
        tabindex={-1}
        disabled={props.disabled}
        aria-label="Choose color"
        value={shown().slice(0, 7).toLowerCase()}
        onInput={(e) => props.onChange(e.currentTarget.value.toUpperCase())}
      />
    </span>
  );
}

/** The UI theme the draft will have (Sync with OS: the current system theme). */
export function draftTheme(d: Draft): SchemeId {
  const t = d.theme();
  return t === "system" ? theme() : t;
}

/** The editor color scheme the draft will use: the explicit choice, else the one of the theme. */
export function draftScheme(d: Draft): SchemeId {
  const s = d.values.editorScheme;
  return s === "auto" ? draftTheme(d) : s;
}
