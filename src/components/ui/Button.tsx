import { type Component, type JSX, splitProps } from "solid-js";

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Default (blue) button: activated by Enter in dialogs. */
  primary?: boolean;
}

/** Dialog / form button: 28px high, 72px min width, 4px radius. */
export const Button: Component<ButtonProps> = (props) => {
  const [own, rest] = splitProps(props, ["primary", "class", "children"]);
  return (
    <button type="button" {...rest} class={"dg-button" + (own.primary ? " dg-button-primary" : "") + (own.class ? " " + own.class : "")}>
      {own.children}
    </button>
  );
};
