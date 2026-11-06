import { type Component, type JSX } from "solid-js";
import { theme } from "../../state/theme";
import { iconUrl } from "./icons";

export interface IconProps {
  /** Icon name from src/assets/icons (see icons.ts), theme-aware. */
  name?: string;
  /** Alternative: any image URL (brand icons, data URIs). Not theme-aware. */
  src?: string;
  /** Box size in px (default 16; use the "@20x20" icons with size 20). */
  size?: number;
  class?: string;
  style?: JSX.CSSProperties;
}

/** Icon image. Also accepts `name` values that are URLs ("/...", "data:", "http"). */
export const Icon: Component<IconProps> = (props) => {
  const size = () => props.size ?? 16;
  const url = () => {
    if (props.src) return props.src;
    const n = props.name;
    if (!n) return undefined;
    if (n.startsWith("/") || n.startsWith("data:") || n.startsWith("http")) return n;
    return iconUrl(n, theme());
  };
  return (
    <img
      class={"dg-icon" + (props.class ? " " + props.class : "")}
      src={url()}
      width={size()}
      height={size()}
      style={{ width: size() + "px", height: size() + "px", ...props.style }}
      alt=""
      draggable={false}
    />
  );
};
