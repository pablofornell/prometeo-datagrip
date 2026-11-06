/**
 * Speed search helpers shared by trees and lists: matching (substring, then word-start initials),
 * the orange match highlight, the key handling and the search field.
 */
import { For, type JSX, Show, createSignal } from "solid-js";
import { Icon } from "./Icon";

export type Range = [number, number];

const isWordStart = (s: string, i: number) =>
  i === 0 || !/[A-Za-z0-9]/.test(s[i - 1]) || (/[a-z]/.test(s[i - 1]) && /[A-Z]/.test(s[i]));

/**
 * Case-insensitive match. First a plain substring (preferring word starts), then the query as a
 * sequence of word initials ("oi" matches "order_items"). Returns the matched ranges or null.
 */
export function matchRanges(text: string, query: string): Range[] | null {
  if (!query) return null;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let idx = -1;
  for (let from = 0; ; ) {
    const i = t.indexOf(q, from);
    if (i < 0) break;
    if (idx < 0) idx = i;
    if (isWordStart(text, i)) {
      idx = i;
      break;
    }
    from = i + 1;
  }
  if (idx >= 0) return [[idx, idx + q.length]];
  // Word-initials fallback.
  const ranges: Range[] = [];
  let pos = 0;
  for (const ch of q) {
    let found = -1;
    for (let i = pos; i < t.length; i++) {
      if (t[i] === ch && (isWordStart(text, i) || (ranges.length && ranges[ranges.length - 1][1] === i))) {
        found = i;
        break;
      }
    }
    if (found < 0) return null;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else ranges.push([found, found + 1]);
    pos = found + 1;
  }
  return ranges;
}

/** Text with the speed-search matches highlighted. */
export function Highlighted(props: { text: string; query?: string }): JSX.Element {
  const parts = () => {
    const r = props.query ? matchRanges(props.text, props.query) : null;
    if (!r) return null;
    const out: { t: string; m: boolean }[] = [];
    let p = 0;
    for (const [a, b] of r) {
      if (a > p) out.push({ t: props.text.slice(p, a), m: false });
      out.push({ t: props.text.slice(a, b), m: true });
      p = b;
    }
    if (p < props.text.length) out.push({ t: props.text.slice(p), m: false });
    return out;
  };
  return (
    <Show when={parts()} fallback={<>{props.text}</>}>
      {(ps) => <For each={ps()}>{(s) => (s.m ? <mark class="dg-search-match">{s.t}</mark> : <>{s.t}</>)}</For>}
    </Show>
  );
}

export interface SpeedSearch {
  query: () => string;
  active: () => boolean;
  setQuery: (q: string) => void;
  clear: () => void;
  /** Feed a keydown; returns true if it was consumed (typing, Backspace, Escape while active). */
  handleKey: (e: KeyboardEvent) => boolean;
}

export function createSpeedSearch(onChange?: (q: string) => void): SpeedSearch {
  const [query, setQ] = createSignal("");
  const set = (q: string) => {
    setQ(q);
    onChange?.(q);
  };
  return {
    query,
    active: () => query().length > 0,
    setQuery: set,
    clear: () => set(""),
    handleKey(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (e.key === "Escape" && query()) {
        set("");
        return true;
      }
      if (e.key === "Backspace" && query()) {
        set(query().slice(0, -1));
        return true;
      }
      if (e.key.length === 1 && (e.key !== " " || query())) {
        set(query() + e.key);
        return true;
      }
      return false;
    },
  };
}

/** The search field DataGrip shows over a tree/list while typing (🔍 text, funnel filter toggle). */
export function SpeedSearchField(props: {
  query: string;
  /** No match: text turns red. */
  noMatch?: boolean;
  filterMode?: boolean;
  onToggleFilter?: () => void;
  class?: string;
}): JSX.Element {
  return (
    <div class={"dg-speedsearch" + (props.class ? " " + props.class : "")} classList={{ "dg-nomatch": props.noMatch }}>
      <Icon name="search" />
      <span class="dg-speedsearch-text">{props.query}</span>
      <Show when={props.onToggleFilter}>
        <span class="dg-speedsearch-filter" classList={{ "dg-on": props.filterMode }} onClick={props.onToggleFilter}>
          <Icon name="filter" />
        </span>
      </Show>
    </div>
  );
}
