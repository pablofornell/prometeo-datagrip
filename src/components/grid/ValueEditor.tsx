import { Show, createSignal, onMount, type JSX } from "solid-js";

interface Props {
  title: string;
  typeName: string;
  text: string;
  /** Read-only results (or binary values): no Apply button. */
  readOnly?: boolean;
  /** Preformat as JSON when it parses. */
  json?: boolean;
  onApply: (text: string) => void;
  onCancel: () => void;
}

/** Popup editor for long / multi-line values (Shift+Enter in DataGrip). */
export function ValueEditor(props: Props): JSX.Element {
  let ta!: HTMLTextAreaElement;
  const initial = (() => {
    if (props.json) {
      try {
        return JSON.stringify(JSON.parse(props.text), null, 2);
      } catch {
        /* not JSON: show as is */
      }
    }
    return props.text;
  })();
  const [value, setValue] = createSignal(initial);

  onMount(() => {
    ta.focus();
    ta.setSelectionRange(initial.length, initial.length);
  });

  const apply = () => {
    if (!props.readOnly) props.onApply(value());
    else props.onCancel();
  };

  return (
    <div class="dgg-ve" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div class="dgg-ve-head">
        <span class="dgg-ve-title">{props.title}</span>
        <span class="dgg-ve-type">{props.typeName}</span>
      </div>
      <textarea
        ref={ta}
        class="dgg-ve-text"
        spellcheck={false}
        readOnly={props.readOnly}
        value={initial}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.onCancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            apply();
          }
        }}
      />
      <div class="dgg-ve-foot">
        <span class="dgg-ve-hint">
          <Show when={!props.readOnly} fallback="Read-only">
            Ctrl+Enter to apply, Esc to cancel
          </Show>
        </span>
        <span class="dgg-ve-spacer" />
        <button class="dgg-btn" onClick={() => props.onCancel()}>
          {props.readOnly ? "Close" : "Cancel"}
        </button>
        <Show when={!props.readOnly}>
          <button class="dgg-btn primary" onClick={apply}>
            OK
          </button>
        </Show>
      </div>
    </div>
  );
}
