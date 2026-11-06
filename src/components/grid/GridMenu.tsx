/**
 * Minimal popup menu used by the grid (context menu, page size, view-as...).
 * TODO: swap for the shared ContextMenu of src/components/ui once it exists.
 */
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

export interface MenuItem {
  label?: string;
  /** Right-aligned gray hint, e.g. `Ctrl+C`. */
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  /** Small gray section title (e.g. "Page Size"). */
  header?: boolean;
  /** Highlighted "primary" first row (like "Count Rows" in the paging menu). */
  primary?: boolean;
  submenu?: MenuItem[];
  onSelect?: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** Open to the left of x (for right-aligned anchors). */
  alignRight?: boolean;
}

export function GridMenu(props: Props): JSX.Element {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: props.x, y: props.y });
  const [hover, setHover] = createSignal(-1);
  const [subFor, setSubFor] = createSignal(-1);

  const isSelectable = (it: MenuItem) => !it.separator && !it.header && !it.disabled;

  onMount(() => {
    const r = el.getBoundingClientRect();
    let x = props.alignRight ? props.x - r.width : props.x;
    let y = props.y;
    if (x + r.width > window.innerWidth - 4) x = Math.max(4, window.innerWidth - r.width - 4);
    if (y + r.height > window.innerHeight - 4) y = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: Math.max(4, x), y });
    const down = (e: MouseEvent) => {
      if (!el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".dgg-menu")) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const n = props.items.length;
        let i = hover();
        for (let k = 0; k < n; k++) {
          i = (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
          if (isSelectable(props.items[i])) break;
        }
        setHover(i);
      } else if (e.key === "Enter") {
        const it = props.items[hover()];
        if (it && isSelectable(it)) {
          e.preventDefault();
          e.stopPropagation();
          choose(it);
        }
      } else if (e.key === "ArrowRight" && props.items[hover()]?.submenu) {
        e.preventDefault();
        e.stopPropagation();
        setSubFor(hover());
      }
    };
    const blur = () => props.onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    onCleanup(() => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
    });
  });

  const choose = (it: MenuItem) => {
    if (!isSelectable(it) || it.submenu) return;
    props.onClose();
    it.onSelect?.();
  };

  return (
    <Portal>
      <div ref={el} class="dgg-menu" style={{ left: pos().x + "px", top: pos().y + "px" }} onContextMenu={(e) => e.preventDefault()}>
        <For each={props.items}>
          {(it, i) => (
            <Show
              when={!it.separator}
              fallback={<div class="dgg-menu-sep" />}
            >
              <Show
                when={!it.header}
                fallback={<div class="dgg-menu-header">{it.label}</div>}
              >
                <div
                  class="dgg-menu-item"
                  classList={{
                    hover: hover() === i() && !it.disabled,
                    disabled: it.disabled,
                    primary: it.primary,
                  }}
                  onMouseEnter={() => {
                    setHover(i());
                    setSubFor(it.submenu && !it.disabled ? i() : -1);
                  }}
                  onClick={() => choose(it)}
                >
                  <span class="dgg-menu-check">{it.checked ? "✓" : ""}</span>
                  <span class="dgg-menu-label">{it.label}</span>
                  <Show when={it.shortcut}>
                    <span class="dgg-menu-shortcut">{it.shortcut}</span>
                  </Show>
                  <Show when={it.submenu}>
                    <span class="dgg-menu-arrow">{"›"}</span>
                    <Show when={subFor() === i()}>
                      <SubMenu items={it.submenu!} parent={el} onClose={props.onClose} />
                    </Show>
                  </Show>
                </div>
              </Show>
            </Show>
          )}
        </For>
      </div>
    </Portal>
  );
}

function SubMenu(props: { items: MenuItem[]; parent: HTMLElement; onClose: () => void }): JSX.Element {
  let el!: HTMLDivElement;
  const [flip, setFlip] = createSignal(false);
  onMount(() => {
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) setFlip(true);
  });
  return (
    <div ref={el} class="dgg-menu dgg-submenu" classList={{ flip: flip() }}>
      <For each={props.items}>
        {(it) => (
          <Show when={!it.separator} fallback={<div class="dgg-menu-sep" />}>
            <div
              class="dgg-menu-item"
              classList={{ disabled: it.disabled }}
              onClick={(e) => {
                e.stopPropagation();
                if (it.disabled) return;
                props.onClose();
                it.onSelect?.();
              }}
            >
              <span class="dgg-menu-check">{it.checked ? "✓" : ""}</span>
              <span class="dgg-menu-label">{it.label}</span>
              <Show when={it.shortcut}>
                <span class="dgg-menu-shortcut">{it.shortcut}</span>
              </Show>
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}
