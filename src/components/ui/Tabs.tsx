import { For, type JSX, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { ActionButton } from "./ActionButton";
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
  /** Data source color: tints the tab (see explorer.css). */
  color?: string;
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
  /** A tab dragged from another strip was dropped here (before `beforeId`, or at the end). */
  onDropTab?: (id: string, beforeId?: string) => void;
  /** Double click on a tab. */
  onDoubleClick?: (id: string) => void;
  /** ⌄ button shown while tabs overflow the strip; receives the ids of the tabs that are not fully visible. */
  onShowHidden?: (hiddenIds: string[], anchor: HTMLElement) => void;
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

/** Id of the tab being dragged (shared by all strips: a tab can be dropped into another strip). */
let draggedTab: string | null = null;

export function Tabs(props: TabsProps): JSX.Element {
  const variant = () => props.variant ?? "editor";
  const [hidden, setHidden] = createSignal<string[]>([]);
  let list!: HTMLDivElement;
  let overflowBtn: HTMLButtonElement | undefined;
  const dragFrom = () => (draggedTab ? props.items.findIndex((t) => t.id === draggedTab) : -1);
  const foreignDrag = () => !!draggedTab && !!props.onDropTab && dragFrom() < 0;

  // tabs that are cut off by the strip edges (for the ⌄ list)
  const measure = () => {
    if (!list || !props.onShowHidden) return;
    const l = list.getBoundingClientRect();
    const out: string[] = [];
    list.querySelectorAll<HTMLElement>(".dg-tab").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.left < l.left - 1 || r.right > l.right + 1) out.push(el.dataset.id ?? "");
    });
    setHidden((prev) => (prev.length === out.length && prev.every((x, i) => x === out[i]) ? prev : out));
  };

  // keep the active tab in view: on selection / new tab, and when the strip is resized
  const reveal = () => {
    const el = list?.querySelector<HTMLElement>(".dg-tab.dg-selected");
    if (el) revealTab(list, el);
    measure();
  };
  createEffect(on(() => [props.active, props.items.length, props.items.map((t) => t.title).join("\0")] as const, () => requestAnimationFrame(reveal)));
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(reveal);
    ro.observe(list);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div
      class={"dg-tabs dg-tabs-" + variant() + (props.class ? " " + props.class : "")}
      role="tablist"
      onDragOver={(e) => {
        if (foreignDrag()) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!foreignDrag()) return;
        e.preventDefault();
        const id = draggedTab!;
        draggedTab = null;
        props.onDropTab?.(id);
      }}
    >
      <div
        class="dg-tabs-list"
        ref={list}
        onScroll={measure}
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
              classList={{ "dg-selected": props.active === t.id, "dg-tab-is-modified": !!t.modified, "dg-tab-tinted": !!t.color }}
              style={t.color ? { "--dg-tab-tint": t.color } : undefined}
              data-id={t.id}
              aria-selected={props.active === t.id}
              draggable={!!props.onReorder && variant() !== "dialog"}
              onDragStart={(e) => {
                draggedTab = t.id;
                e.dataTransfer?.setData("text/plain", t.id);
              }}
              onDragOver={(e) => {
                if (dragFrom() >= 0 || foreignDrag()) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const from = dragFrom();
                if (from >= 0) props.onReorder?.(from, i());
                else if (foreignDrag()) props.onDropTab?.(draggedTab!, t.id);
                draggedTab = null;
              }}
              onDragEnd={() => (draggedTab = null)}
              onDblClick={() => props.onDoubleClick?.(t.id)}
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
      <Show when={props.onShowHidden && hidden().length > 0}>
        <ActionButton
          icon="chevron-down"
          title="Show Hidden Tabs"
          class="dg-tabs-overflow"
          ref={(el) => (overflowBtn = el)}
          onClick={() => overflowBtn && props.onShowHidden?.(hidden(), overflowBtn)}
        />
      </Show>
      {props.trailing}
    </div>
  );
}
