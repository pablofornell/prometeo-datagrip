import { type Component } from "solid-js";
import { Icon } from "../../components/ui";
import { theme } from "../../state/theme";
import { LOCAL, localIconUrl } from "./icons";

/** Icon by key: explorer-local (`x:` prefix, theme-aware) or a name of the shared icon kit. */
export const NodeIcon: Component<{ name?: string; class?: string }> = (props) => {
  const local = () => !!props.name?.startsWith(LOCAL);
  const src = () => (local() ? localIconUrl(props.name!.slice(LOCAL.length), theme()) : undefined);
  return <Icon name={local() ? undefined : props.name} src={src()} class={props.class} />;
};
