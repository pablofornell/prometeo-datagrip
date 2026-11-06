import { type Component, type JSX, Show } from "solid-js";
import { actionShortcut, getAction, isActionEnabled, runAction } from "../../state/actions";
import { Icon } from "./Icon";
import { tip } from "./Tooltip";

export interface ActionButtonProps {
  /** Icon name (see Icon). */
  icon?: string;
  iconSize?: number;
  /** Registry action id: supplies tooltip, shortcut, enabled state and the click handler. */
  action?: string;
  /** Tooltip text (defaults to the action title). */
  title?: string;
  /** Shortcut shown in the tooltip (defaults to the action's). */
  shortcut?: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  /** Toggled-on look (e.g. "Switch to Table"). */
  selected?: boolean;
  /** Button size in px: 22 (default, toolbars and panel headers), 26 or 30 (main toolbar). */
  size?: number;
  /** Small dropdown triangle in the bottom-right corner (the "+" New button). */
  dropdown?: boolean;
  class?: string;
  children?: JSX.Element;
  ref?: (el: HTMLButtonElement) => void;
}

/** Toolbar icon button: transparent, rounded hover/pressed background exactly like DataGrip. */
export const ActionButton: Component<ActionButtonProps> = (props) => {
  const a = () => (props.action ? getAction(props.action) : undefined);
  const disabled = () => props.disabled || (props.action ? !isActionEnabled(a()) : false);
  const title = () => props.title ?? a()?.title;
  const shortcut = () => props.shortcut ?? actionShortcut(a());
  const size = () => props.size ?? 22;
  return (
    <button
      type="button"
      ref={props.ref}
      class={"dg-action-button" + (props.class ? " " + props.class : "")}
      classList={{ "dg-disabled": disabled(), "dg-selected": props.selected }}
      style={{ width: size() + "px", height: size() + "px" }}
      aria-disabled={disabled()}
      tabindex={-1}
      {...tip(title(), shortcut())}
      onMouseDown={(e) => e.preventDefault() /* keep focus where it is (tree / editor) */}
      onClick={(e) => {
        if (disabled()) return;
        if (props.action) void runAction(props.action);
        props.onClick?.(e);
      }}
    >
      <Show when={props.icon}>
        <Icon name={props.icon} size={props.iconSize ?? 16} />
      </Show>
      {props.children}
      <Show when={props.dropdown}>
        <span class="dg-action-button-arrow" />
      </Show>
    </button>
  );
};

/** 1px vertical separator between toolbar groups. */
export const ToolbarSeparator: Component = () => <span class="dg-toolbar-sep" />;
