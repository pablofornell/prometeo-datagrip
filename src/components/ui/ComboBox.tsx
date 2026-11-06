import { Show } from "solid-js";
import { Icon } from "./Icon";
import { type MenuItem, openMenu } from "./Menu";

export interface ComboOption<T extends string | number = string> {
  value: T;
  label: string;
  icon?: string;
}

export interface ComboBoxProps<T extends string | number = string> {
  options: ComboOption<T>[];
  value?: T;
  onChange?: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Fixed width in px (default: fill the parent). */
  width?: number;
  class?: string;
}

/** Non-editable DataGrip combo box: raised background, chevron on the right, list popup below. */
export function ComboBox<T extends string | number = string>(props: ComboBoxProps<T>) {
  let btn!: HTMLButtonElement;
  const current = () => props.options.find((o) => o.value === props.value);
  const open = () => {
    if (props.disabled) return;
    const items: MenuItem[] = props.options.map((o) => ({
      label: o.label,
      icon: o.icon,
      checked: o.value === props.value,
      run: () => props.onChange?.(o.value),
    }));
    openMenu(items, {
      anchor: btn,
      compact: true,
      minWidth: btn.offsetWidth,
      selected: props.options.findIndex((o) => o.value === props.value),
      onClose: () => btn.focus({ preventScroll: true }),
    });
  };
  return (
    <button
      type="button"
      ref={btn}
      class={"dg-combo" + (props.class ? " " + props.class : "")}
      classList={{ "dg-disabled": props.disabled }}
      style={props.width ? { width: props.width + "px" } : undefined}
      disabled={props.disabled}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          open();
        }
      }}
    >
      <Show when={current()?.icon}>
        <Icon name={current()!.icon} />
      </Show>
      <span class="dg-combo-text" classList={{ "dg-placeholder": !current() }}>
        {current()?.label ?? props.placeholder ?? ""}
      </span>
      <span class="dg-combo-arrow">
        <Icon name="chevron-down" />
      </span>
    </button>
  );
}

// Re-exported helper for plain lists of strings.
export const stringOptions = (xs: string[]): ComboOption[] => xs.map((x) => ({ value: x, label: x }));
