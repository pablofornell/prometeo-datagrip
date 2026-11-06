/**
 * Find bar of "Find on Current Page" (Ctrl+F): query field with match-case / regex / whole-word toggles, previous / next,
 * "Filter rows" and close (docs/ux/screens/98-grid-find-dark.png). Presentational; the grid owns state and matching.
 */
import { Show, onMount, type JSX } from "solid-js";
import type { FindOptions } from "./find";
import "./grid.css";

export interface FindBarProps {
  query: string;
  options: FindOptions;
  /** Hide the rows without a match. */
  filterRows: boolean;
  /** Invalid regular expression message. */
  error?: string | null;
  /** Called after mount with a focus function (re-focus on a repeated Ctrl+F). */
  focusRef?: (focus: () => void) => void;
  onQuery: (q: string) => void;
  onOptions: (o: FindOptions) => void;
  onFilterRows: (on: boolean) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function FindBar(props: FindBarProps): JSX.Element {
  let input!: HTMLInputElement;
  onMount(() => {
    props.focusRef?.(() => {
      input.focus();
      input.select();
    });
    input.focus();
    input.select();
  });
  const tog = (k: keyof FindOptions, title: string, shortcut: string, text: string) => (
    <button
      class="dgg-fbtn"
      classList={{ on: props.options[k] }}
      title={`${title}  ${shortcut}`}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => props.onOptions({ ...props.options, [k]: !props.options[k] })}
    >
      {text}
    </button>
  );
  return (
    <div
      class="dgg-find"
      role="search"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <i class="dgg-i i-find dgg-find-ico" />
      <div class="dgg-find-field">
        <input
          ref={input}
          class="dgg-find-input"
          classList={{ err: !!props.error }}
          value={props.query}
          spellcheck={false}
          autocomplete="off"
          title={props.error ?? undefined}
          onInput={(e) => props.onQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) props.onPrevious();
              else props.onNext();
            } else if (e.key === "Escape") {
              e.preventDefault();
              props.onClose();
            } else if (e.altKey && !e.ctrlKey) {
              const k = e.key.toLowerCase();
              const map: Record<string, keyof FindOptions> = { c: "matchCase", w: "words", x: "regex" };
              if (map[k]) {
                e.preventDefault();
                props.onOptions({ ...props.options, [map[k]]: !props.options[map[k]] });
              }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              props.onNext();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              props.onPrevious();
            }
          }}
        />
        <Show when={props.query}>
          <button class="dgg-find-clear" title="Clear" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => (props.onQuery(""), input.focus())} />
        </Show>
      </div>
      {tog("matchCase", "Match Case", "Alt+C", "Cc")}
      {tog("regex", "Regex", "Alt+X", ".*")}
      {tog("words", "Words", "Alt+W", "W")}
      <span class="dgg-find-sep" />
      <button class="dgg-fbtn arr up" title="Previous Occurrence  Shift+Enter" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onPrevious()} />
      <button class="dgg-fbtn arr down" title="Next Occurrence  Enter" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onNext()} />
      <label class="dgg-find-filter">
        <input type="checkbox" class="dgg-find-cb" checked={props.filterRows} onChange={(e) => props.onFilterRows(e.currentTarget.checked)} tabIndex={-1} />
        <span>Filter rows</span>
      </label>
      <span class="dgg-find-spacer" />
      <button class="dgg-find-close" title="Close  Escape" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onClose()} />
    </div>
  );
}
