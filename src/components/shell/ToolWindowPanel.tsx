import { Show, createEffect, createSignal, type JSX } from "solid-js";
import {
  type StretchDir,
  type ToolWindowAnchor,
  activeToolWindow,
  anchorOf,
  hideToolWindow,
  isMaximized,
  layout,
  markActiveToolWindow,
  moveToolWindow,
  stretchDirsOf,
  stretchToolWindow,
  toggleMaximizeToolWindow,
  toolWindowDef,
} from "../../state/layout";
import { Slot } from "../../state/slots";
import { ActionButton } from "../ui/ActionButton";
import { type MenuItem, openMenu } from "../ui/Menu";

const ANCHORS: [ToolWindowAnchor, string][] = [
  ["left", "Left"],
  ["right", "Right"],
  ["bottom", "Bottom"],
];
const STRETCH: [StretchDir, string, string][] = [
  ["left", "Stretch to Left", "Ctrl+Shift+Left"],
  ["right", "Stretch to Right", "Ctrl+Shift+Right"],
  ["top", "Stretch to Top", "Ctrl+Shift+Up"],
  ["bottom", "Stretch to Bottom", "Ctrl+Shift+Down"],
];

/** The ⋮ menu of a tool window header: window specific items, Move To, Resize, Maximize, Hide. */
export function toolWindowOptions(id: string): MenuItem[] {
  const def = toolWindowDef(id);
  const extra = def?.options?.() ?? [];
  const dirs = stretchDirsOf(id);
  return [
    ...extra,
    ...(extra.length ? [{ type: "separator" } as MenuItem] : []),
    {
      label: "Move To",
      children: ANCHORS.map<MenuItem>(([a, label]) => ({ label, enabled: anchorOf(id) !== a, run: () => moveToolWindow(id, a) })),
    },
    {
      label: "Resize",
      children: STRETCH.map<MenuItem>(([d, label, shortcut]) => ({
        label,
        shortcut,
        enabled: dirs.includes(d),
        run: () => stretchToolWindow(id, d),
      })),
    },
    {
      label: isMaximized(id) ? "Restore Tool Window Size" : "Maximize Tool Window",
      shortcut: "Ctrl+Shift+'",
      run: () => toggleMaximizeToolWindow(id),
    },
    { type: "separator" },
    { label: "Hide", shortcut: "Shift+Escape", icon: "hide", run: () => hideToolWindow(id) },
  ];
}

/**
 * A tool window island: 40px header (title, slot content, hover actions ⋮ and —), optional toolbar slot,
 * body slot. Slot ids: `<id>.header`, `<id>.headerActions`, `<id>.toolbar`, `<id>.body`.
 * The body is mounted lazily the first time the window is shown and then kept alive (hidden with CSS).
 * Where it sits (left / right / bottom grid area) follows the window's anchor, see `Shell`.
 */
export function ToolWindowPanel(props: {
  id: string;
  style?: JSX.CSSProperties;
  fallbackBody?: () => JSX.Element;
  fallbackToolbar?: () => JSX.Element;
  fallbackHeader?: () => JSX.Element;
}): JSX.Element {
  const def = toolWindowDef(props.id)!;
  const visible = () => !!layout.visible[props.id];
  const [mounted, setMounted] = createSignal(visible());
  createEffect(() => visible() && setMounted(true));
  let optionsBtn!: HTMLButtonElement;

  return (
    <Show when={mounted()}>
      <section
        class={"dg-island dg-toolwindow dg-toolwindow-" + props.id}
        classList={{ "dg-hidden": !visible(), "dg-active": activeToolWindow() === props.id, "dg-maximized": isMaximized(props.id) }}
        data-toolwindow={props.id}
        data-anchor={anchorOf(props.id)}
        tabindex={-1}
        style={props.style}
        onFocusIn={() => markActiveToolWindow(props.id)}
      >
        <header
          class="dg-tw-header"
          onDblClick={(e) => {
            // double click on the bare header (not on its buttons / tabs) maximizes or restores the window
            const t = e.target as HTMLElement;
            if (t === e.currentTarget || t.classList.contains("dg-tw-title") || t.classList.contains("dg-tw-header-slot")) toggleMaximizeToolWindow(props.id);
          }}
        >
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
              onClick={() => openMenu(toolWindowOptions(props.id), { anchor: optionsBtn })}
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
