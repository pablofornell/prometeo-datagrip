import { type Component, type JSX, Show, splitProps } from "solid-js";

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
  return (
    <div class={"dg-textfield" + (own.frameClass ? " " + own.frameClass : "")} classList={{ "dg-error": own.error, "dg-disabled": rest.disabled }}>
      <Show when={own.prefix}>
        <span class="dg-textfield-affix">{own.prefix}</span>
      </Show>
      <input
        ref={own.ref}
        spellcheck={false}
        autocomplete="off"
        {...rest}
        class={own.class}
        value={own.value ?? ""}
        onInput={(e) => own.onInput?.(e.currentTarget.value, e)}
      />
      <Show when={own.suffix}>
        <span class="dg-textfield-affix">{own.suffix}</span>
      </Show>
    </div>
  );
};
