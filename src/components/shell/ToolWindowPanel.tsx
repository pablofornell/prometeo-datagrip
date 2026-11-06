import { Show, createEffect, createSignal, type JSX } from "solid-js";
import {
  TOOL_WINDOWS,
  activeToolWindow,
  hideToolWindow,
  layout,
  markActiveToolWindow,
} from "../../state/layout";
import { Slot } from "../../state/slots";
import { ActionButton } from "../ui/ActionButton";
import { type MenuItem, openMenu } from "../ui/Menu";

/**
 * A tool window island: 40px header (title, slot content, hover actions ⋮ and —), optional toolbar slot,
 * body slot. Slot ids: `<id>.header`, `<id>.headerActions`, `<id>.toolbar`, `<id>.body`.
 * The body is mounted lazily the first time the window is shown and then kept alive (hidden with CSS).
 */
export function ToolWindowPanel(props: {
  id: string;
  style?: JSX.CSSProperties;
  fallbackBody?: () => JSX.Element;
  fallbackToolbar?: () => JSX.Element;
  fallbackHeader?: () => JSX.Element;
}): JSX.Element {
  const def = TOOL_WINDOWS.find((t) => t.id === props.id)!;
  const visible = () => !!layout.visible[props.id];
  const [mounted, setMounted] = createSignal(visible());
  createEffect(() => visible() && setMounted(true));
  let optionsBtn!: HTMLButtonElement;

  const options = (): MenuItem[] => [
    ...(def.options?.() ?? []),
    ...(def.options ? [{ type: "separator" } as MenuItem] : []),
    { label: "Hide", shortcut: "Shift+Escape", icon: "hide", run: () => hideToolWindow(props.id) },
  ];

  return (
    <Show when={mounted()}>
      <section
        class={"dg-island dg-toolwindow dg-toolwindow-" + props.id}
        classList={{ "dg-hidden": !visible(), "dg-active": activeToolWindow() === props.id }}
        data-toolwindow={props.id}
        tabindex={-1}
        style={props.style}
        onFocusIn={() => markActiveToolWindow(props.id)}
      >
        <header class="dg-tw-header">
          <span class="dg-tw-title">{def.title}</span>
          <div class="dg-tw-header-slot">
            <Slot id={props.id + ".header"} fallback={props.fallbackHeader} />
          </div>
          <div class="dg-tw-actions">
            <Slot id={props.id + ".headerActions"} />
            <ActionButton
              icon="more-vertical"
              title="Options"
              ref={(el) => (optionsBtn = el)}
              onClick={() => openMenu(options(), { anchor: optionsBtn })}
            />
            <ActionButton icon="hide" title="Hide" shortcut="Shift+Escape" onClick={() => hideToolWindow(props.id)} />
          </div>
        </header>
        <Slot id={props.id + ".toolbar"} fallback={props.fallbackToolbar} />
        <div class="dg-tw-body">
          <Slot id={props.id + ".body"} fallback={props.fallbackBody} />
        </div>
      </section>
    </Show>
  );
}
