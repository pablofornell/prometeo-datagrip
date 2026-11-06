import { type Component, type JSX, Show, createEffect, splitProps, untrack } from "solid-js";

export interface TextFieldProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "onChange" | "onInput" | "prefix" | "value" | "ref"> {
  value?: string;
  onInput?: (value: string, e: InputEvent) => void;
  /** Error state: red border. */
  error?: boolean;
  /** Content before the input inside the frame (e.g. a search icon). */
  prefix?: JSX.Element;
  /** Content after the input inside the frame (e.g. a clear button). */
  suffix?: JSX.Element;
  /** Class for the wrapping frame. */
  frameClass?: string;
  ref?: (el: HTMLInputElement) => void;
}

/** Single-line text field, 28px high, 4px radius, 2px accent ring when focused. */
export const TextField: Component<TextFieldProps> = (props) => {
  const [own, rest] = splitProps(props, ["value", "onInput", "error", "prefix", "suffix", "frameClass", "class", "ref"]);
  let input: HTMLInputElement | undefined;
  // Controlled, but the DOM value is only written when it really differs: re-assigning the text the user has just
  // typed makes WebKit reset the caret / selection, and fast typing (xdotool, paste + keys) then loses characters.
  createEffect(() => {
    const v = own.value ?? "";
    if (input && input.value !== v) input.value = v;
  });
  return (
    <div class={"dg-textfield" + (own.frameClass ? " " + own.frameClass : "")} classList={{ "dg-error": own.error, "dg-disabled": rest.disabled }}>
      <Show when={own.prefix}>
        <span class="dg-textfield-affix">{own.prefix}</span>
      </Show>
      <input
        ref={(el) => {
          input = el;
          own.ref?.(el);
        }}
        spellcheck={false}
        autocomplete="off"
        {...rest}
        class={own.class}
        value={untrack(() => own.value ?? "")}
        onInput={(e) => own.onInput?.(e.currentTarget.value, e)}
      />
      <Show when={own.suffix}>
        <span class="dg-textfield-affix">{own.suffix}</span>
      </Show>
    </div>
  );
};
