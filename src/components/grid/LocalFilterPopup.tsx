/**
 * "Local Filter For 'col'" popup of a header funnel: searchable list of the column's distinct values with row counts and
 * checkboxes; ticking values hides every row whose value is not ticked
 * (docs/ux/screens/98-grid-local-filter-popup-dark.png). Presentational.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { NULL_KEY, type ValueCount } from "./localFilter";
import "./grid.css";

export interface LocalFilterPopupProps {
  column: string;
  /** Funnel button rectangle (the popup opens just below its centre). */
  anchor: DOMRect;
  values: ValueCount[];
  /** More distinct values exist than listed. */
  truncated?: boolean;
  /** Ticked keys; empty = no filter. */
  selected: ReadonlySet<string>;
  /** Rows left after all filters (shown once something is ticked). */
  matchCount: number;
  nullLabel?: string;
  onToggle: (key: string) => void;
  /** Header checkbox: clears the filter when anything is ticked, else ticks every value. */
  onToggleAll: () => void;
  onClose: () => void;
}

const W = 211;
const H = 502;

export function LocalFilterPopup(props: LocalFilterPopupProps): JSX.Element {
  let el!: HTMLDivElement;
  let search!: HTMLInputElement;
  const [q, setQ] = createSignal("");
  const label = (k: string) => (k === NULL_KEY ? (props.nullLabel ?? "null") : k);
  const rows = createMemo(() => {
    const t = q().trim().toLowerCase();
    return t ? props.values.filter((v) => label(v.key).toLowerCase().includes(t)) : props.values;
  });
  const pos = () => ({
    x: Math.max(4, Math.min(props.anchor.left - 4, window.innerWidth - W - 4)),
    y: Math.max(4, Math.min(props.anchor.bottom - 9, window.innerHeight - H - 4)),
  });

  onMount(() => {
    search.focus();
    const down = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    });
  });

  return (
    <Portal>
      <div ref={el} class="dgg-lf" style={{ left: pos().x + "px", top: pos().y + "px", width: W + "px", height: H + "px" }}>
        <div class="dgg-lf-title">Local Filter For '{props.column}'</div>
        <div class="dgg-lf-search">
          <i class="dgg-i i-find" />
          <input ref={search} value={q()} spellcheck={false} autocomplete="off" onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
        <div class="dgg-lf-head">
          <span class="dgg-mc-cb" classList={{ on: props.selected.size > 0 }} onClick={() => props.onToggleAll()} />
          <span class="dgg-lf-val">Value</span>
          <span class="dgg-lf-cnt">Count</span>
        </div>
        <div class="dgg-lf-list">
          <For each={rows()}>
            {(v) => (
              <div class="dgg-lf-row" onClick={() => props.onToggle(v.key)}>
                <span class="dgg-mc-cb" classList={{ on: props.selected.has(v.key) }} />
                <span class="dgg-lf-val" classList={{ nul: v.key === NULL_KEY }}>
                  {label(v.key)}
                </span>
                <span class="dgg-lf-cnt">{v.count}</span>
              </div>
            )}
          </For>
        </div>
        <div class="dgg-lf-foot">
          <Show when={props.selected.size > 0} fallback={"Select a checkbox to filter rows"}>
            Number of matches {props.matchCount}
          </Show>
          <Show when={props.truncated}>
            <span class="dgg-lf-more"> (first {props.values.length} values)</span>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
