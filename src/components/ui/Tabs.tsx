import { For, type JSX, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icon";
import { tip } from "./Tooltip";

export interface TabItem {
  id: string;
  title: string;
  /** Icon name or URL. */
  icon?: string;
  closeable?: boolean;
  pinned?: boolean;
  /** Unsaved changes: a dot replaces the × until the pointer is over the tab button. */
  modified?: boolean;
  tooltip?: string;
}

export interface TabsProps {
  items: TabItem[];
  active?: string | null;
  onSelect?: (id: string) => void;
  /** May return a promise (the store asks the `beforeClose` hooks); the strip ignores the result. */
  onClose?: (id: string) => unknown;
  /** Click on the pin icon of a pinned tab. */
  onUnpin?: (id: string) => void;
  onContextMenu?: (id: string, e: MouseEvent) => void;
  /** Drag & drop reordering (indexes in `items`). */
  onReorder?: (from: number, to: number) => void;
  /**
   * "editor": Islands pill tabs, 28px pills in a 40px strip (editor tabs).
   * "result": 28px pills without the strip border (Database Output header).
   * "dialog": text pills for dialog pages (General | Options | ...).
   */
  variant?: "editor" | "result" | "dialog";
  class?: string;
  /** Rendered after the tabs, right-aligned inside the strip (e.g. the ⋮ button). */
  trailing?: JSX.Element;
}

/** Scrolls the strip horizontally so that `tab` is fully visible (no-op when it already is). */
export function revealTab(list: HTMLElement, tab: HTMLElement): void {
  const l = list.getBoundingClientRect();
  const t = tab.getBoundingClientRect();
  if (t.left < l.left) list.scrollLeft -= l.left - t.left;
  else if (t.right > l.right) list.scrollLeft += t.right - l.right;
}

export function Tabs(props: TabsProps): JSX.Element {
  const variant = () => props.variant ?? "editor";
  const [dragFrom, setDragFrom] = createSignal(-1);
  let list!: HTMLDivElement;

  // keep the active tab in view: on selection / new tab, and when the strip is resized
  const reveal = () => {
    const el = list?.querySelector<HTMLElement>(".dg-tab.dg-selected");
    if (el) revealTab(list, el);
  };
  createEffect(on(() => [props.active, props.items.length] as const, () => requestAnimationFrame(reveal)));
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(reveal);
    ro.observe(list);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div class={"dg-tabs dg-tabs-" + variant() + (props.class ? " " + props.class : "")} role="tablist">
      <div
        class="dg-tabs-list"
        ref={list}
        onWheel={(e) => {
          // a vertical wheel scrolls the (scrollbar-less) strip sideways
          if (list.scrollWidth > list.clientWidth) list.scrollLeft += e.deltaX || e.deltaY;
        }}
      >
        <For each={props.items}>
          {(t, i) => (
            <div
              role="tab"
              class="dg-tab"
              classList={{ "dg-selected": props.active === t.id, "dg-tab-is-modified": !!t.modified }}
              aria-selected={props.active === t.id}
              draggable={!!props.onReorder && variant() !== "dialog"}
              onDragStart={(e) => {
                setDragFrom(i());
                e.dataTransfer?.setData("text/plain", t.id);
              }}
              onDragOver={(e) => {
                if (dragFrom() >= 0) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom() >= 0) props.onReorder?.(dragFrom(), i());
                setDragFrom(-1);
              }}
              onDragEnd={() => setDragFrom(-1)}
              onMouseDown={(e) => {
                if (e.button === 0) props.onSelect?.(t.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && t.closeable !== false) props.onClose?.(t.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                props.onContextMenu?.(t.id, e);
              }}
              {...tip(t.tooltip)}
            >
              <Show when={t.icon && variant() !== "dialog"}>
                <Icon name={t.icon} class="dg-tab-icon" />
              </Show>
              <span class="dg-tab-title">{t.title}</span>
              <Show when={variant() !== "dialog"}>
                <Show
                  when={t.pinned}
                  fallback={
                    <Show when={t.closeable !== false}>
                      <span
                        class="dg-tab-close"
                        classList={{ "dg-tab-modified": !!t.modified }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onClose?.(t.id);
                        }}
                      >
                        <Show when={t.modified}>
                          <span class="dg-tab-dot" />
                        </Show>
                        <Icon name="close-small" class="dg-tab-x" />
                      </span>
                    </Show>
                  }
                >
                  <span
                    class="dg-tab-close dg-tab-pin"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onUnpin?.(t.id);
                    }}
                  >
                    <Icon name="pin-selected" />
                  </span>
                </Show>
              </Show>
            </div>
          )}
        </For>
      </div>
      {props.trailing}
    </div>
  );
}
