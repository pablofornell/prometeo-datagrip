import { type Component, type JSX, Show } from "solid-js";

export interface CheckboxProps {
  checked?: boolean;
  /** Partial state (dash). */
  indeterminate?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  label?: JSX.Element;
  class?: string;
}

/** 16px checkbox, 3px radius; checked = accent fill + white check, dash for partial. */
export const Checkbox: Component<CheckboxProps> = (props) => {
  const on = () => props.checked || props.indeterminate;
  const toggle = () => !props.disabled && props.onChange?.(props.indeterminate ? true : !props.checked);
  return (
    <span
      class={"dg-checkbox" + (props.class ? " " + props.class : "")}
      classList={{ "dg-checked": on(), "dg-disabled": props.disabled }}
      role="checkbox"
      aria-checked={props.indeterminate ? "mixed" : !!props.checked}
      tabindex={props.disabled ? -1 : 0}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <span class="dg-checkbox-box">
        <Show when={on()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <Show when={props.indeterminate} fallback={<path d="M4 8.5L7 11.5L12.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />}>
              <path d="M4.5 8H11.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </Show>
          </svg>
        </Show>
      </span>
      <Show when={props.label}>
        <span class="dg-checkbox-label">{props.label}</span>
      </Show>
    </span>
  );
};
