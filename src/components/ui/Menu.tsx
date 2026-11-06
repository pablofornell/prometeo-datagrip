/**
 * Popup menu / context menu / list popup (DataGrip look): keyboard navigation, submenus, separators,
 * right-aligned shortcuts, check marks. One menu can be open at a time, rendered by <MenuHost/>.
 *
 *   openMenu([{ action: "db.refresh" }, { type: "separator" }, { label: "New", children: [...] }],
 *            { x, y })                         // context menu at the pointer
 *   openMenu(items, { anchor: buttonEl })      // dropdown under an element
 *
 * Items with `action` take label / shortcut / icon / enabled / checked from the action registry and run it.
 */
import { Index, Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { actionShortcut, getAction, isActionEnabled } from "../../state/actions";
import { Icon } from "./Icon";

export type MenuItem =
  | {
      type?: "item";
      label?: string;
      /** Registry action id: provides label, shortcut, icon, enabled and the run handler. */
      action?: string;
      icon?: string;
      shortcut?: string;
      /** Small pill after the label, e.g. "New". */
      badge?: string;
      enabled?: boolean | (() => boolean);
      checked?: boolean | (() => boolean);
      run?: () => void;
      children?: MenuItem[];
    }
  | { type: "separator" }
  /** Gray section header ("Transaction Mode"). */
  | { type: "header"; label: string }
  /** Gray wrapped hint at the bottom ("Changes submitted ... are auto-committed"). */
  | { type: "hint"; label: string };

export interface OpenMenuOptions {
  /** Pointer position (context menu). */
  x?: number;
  y?: number;
  /** Anchor element: the menu opens below it (above if there is no room). */
  anchor?: HTMLElement;
  /** Centered bold title row on top ("New"); implies the list-popup look. */
  title?: string;
  /** List-popup look: 24px rows (combo boxes, "New" popup). Default: 26px menu rows. */
  compact?: boolean;
  minWidth?: number;
  /** "bar": dropdown of the main menu bar (narrower insets, full-width separators, like Swing menus). */
  variant?: "bar";
  /** Gap in px between the anchor and the menu (default 2). */
  gap?: number;
  /** Called after the menu closed for any reason. */
  onClose?: () => void;
  /** Left/Right pressed on the top level without a submenu (menu bar navigation). */
  onHorizontal?: (dir: -1 | 1) => void;
  /** Index (into `items`) preselected when opening from the keyboard / combo box. */
  selected?: number;
}

interface Level {
  items: MenuItem[];
  index: number;
  /** For level > 0: rect of the parent row. For level 0: anchor rect or pointer point. */
  rect: { left: number; right: number; top: number; bottom: number };
  anchored: boolean;
  gap: number;
}

const [state, setState] = createSignal<{ levels: Level[]; opts: OpenMenuOptions } | null>(null);
let restoreFocus: HTMLElement | null = null;

export function closeMenu(): void {
  const s = state();
  if (!s) return;
  setState(null);
  restoreFocus?.focus?.({ preventScroll: true });
  restoreFocus = null;
  s.opts.onClose?.();
}

export const isMenuOpen = () => state() !== null;

export function openMenu(items: MenuItem[], opts: OpenMenuOptions = {}): void {
  const prev = state();
  if (prev) {
    setState(null);
    prev.opts.onClose?.();
  } else {
    restoreFocus = document.activeElement as HTMLElement | null;
  }
  let rect: Level["rect"];
  if (opts.anchor) {
    const r = opts.anchor.getBoundingClientRect();
    rect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  } else {
    const x = opts.x ?? 0;
    const y = opts.y ?? 0;
    rect = { left: x, right: x, top: y, bottom: y };
  }
  const idx = opts.selected ?? -1;
  setState({ levels: [{ items, index: idx, rect, anchored: !!opts.anchor, gap: opts.gap ?? 2 }], opts });
}

// ---------------------------------------------------------------- item resolution

interface Resolved {
  kind: "item" | "separator" | "header" | "hint";
  label: string;
  icon?: string;
  shortcut?: string;
  badge?: string;
  enabled: boolean;
  checked: boolean;
  hasChildren: boolean;
  children?: MenuItem[];
  run?: () => void;
}

function val(v: boolean | (() => boolean) | undefined, dflt: boolean): boolean {
  return typeof v === "function" ? v() : (v ?? dflt);
}

function resolve(it: MenuItem): Resolved {
  if (it.type === "separator") return { kind: "separator", label: "", enabled: false, checked: false, hasChildren: false };
  if (it.type === "header") return { kind: "header", label: it.label, enabled: false, checked: false, hasChildren: false };
  if (it.type === "hint") return { kind: "hint", label: it.label, enabled: false, checked: false, hasChildren: false };
  const a = it.action ? getAction(it.action) : undefined;
  const hasChildren = !!it.children && it.children.length > 0;
  let enabled = val(it.enabled, true);
  if (it.action) enabled = enabled && isActionEnabled(a);
  if (!hasChildren && !it.action && !it.run) enabled = false;
  return {
    kind: "item",
    label: it.label ?? a?.title ?? it.action ?? "",
    icon: it.icon ?? a?.icon,
    shortcut: it.shortcut ?? actionShortcut(a),
    badge: it.badge,
    enabled,
    checked: it.checked !== undefined ? val(it.checked, false) : (a?.checked?.() ?? false),
    hasChildren,
    children: it.children,
    run: it.run ?? (it.action ? () => void a?.run?.() : undefined),
  };
}

const selectable = (it: MenuItem) => {
  const r = resolve(it);
  return r.kind === "item" && r.enabled;
};

// ---------------------------------------------------------------- host

export function MenuHost(): JSX.Element {
  const setLevelIndex = (l: number, i: number) => {
    const s = state();
    if (!s) return;
    const levels = s.levels.slice(0, l + 1);
    levels[l] = { ...levels[l], index: i };
    setState({ ...s, levels });
  };

  const openSub = (l: number, i: number, rowRect: DOMRect, selectFirst: boolean) => {
    const s = state();
    if (!s) return;
    const parent = s.levels[l];
    const it = parent.items[i];
    const r = it && resolve(it);
    const levels = s.levels.slice(0, l + 1);
    levels[l] = { ...levels[l], index: i };
    if (r && r.hasChildren && r.enabled) {
      const sub = r.children!;
      // Anchor to the parent *menu* edges (submenus overlap the parent's border by 1px), the row's top.
      const pr = document.querySelectorAll(".dg-menu")[l]?.getBoundingClientRect() ?? rowRect;
      rowRect = new DOMRect(pr.left, rowRect.top, pr.width, rowRect.height);
      levels.push({
        items: sub,
        index: selectFirst ? Math.max(0, sub.findIndex(selectable)) : -1,
        rect: { left: rowRect.left, right: rowRect.right, top: rowRect.top, bottom: rowRect.bottom },
        anchored: false,
        gap: 0,
      });
    }
    setState({ ...s, levels });
  };

  const activate = (l: number, i: number, rowEl?: HTMLElement) => {
    const s = state();
    if (!s) return;
    const it = s.levels[l].items[i];
    const r = it && resolve(it);
    if (!r || r.kind !== "item" || !r.enabled) return;
    if (r.hasChildren) {
      const rect = rowEl?.getBoundingClientRect() ?? panelRowRect(l, i);
      if (rect) openSub(l, i, rect, true);
      return;
    }
    closeMenu();
    // Run after the menu is gone so focus-dependent actions see the restored focus.
    queueMicrotask(() => r.run?.());
  };

  const panelRowRect = (l: number, i: number): DOMRect | undefined => {
    const panel = document.querySelectorAll(".dg-menu")[l];
    return panel?.querySelectorAll<HTMLElement>(".dg-menu-row")[i]?.getBoundingClientRect();
  };

  const onKey = (e: KeyboardEvent) => {
    const s = state();
    if (!s) return;
    const l = s.levels.length - 1;
    const lv = s.levels[l];
    const items = lv.items;
    const move = (dir: 1 | -1, from = lv.index) => {
      const n = items.length;
      let i = from;
      for (let k = 0; k < n; k++) {
        i = (i + dir + n) % n;
        if (from === -1 && dir === -1 && k === 0) i = n - 1;
        if (selectable(items[i])) return setLevelIndex(l, i);
      }
    };
    switch (e.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Home": {
        const i = items.findIndex(selectable);
        if (i >= 0) setLevelIndex(l, i);
        break;
      }
      case "End": {
        for (let i = items.length - 1; i >= 0; i--)
          if (selectable(items[i])) {
            setLevelIndex(l, i);
            break;
          }
        break;
      }
      case "ArrowRight": {
        const it = items[lv.index];
        const r = it && resolve(it);
        if (r?.hasChildren) activate(l, lv.index);
        else if (l === 0) s.opts.onHorizontal?.(1);
        break;
      }
      case "ArrowLeft":
        if (l > 0) setState({ ...s, levels: s.levels.slice(0, l) });
        else s.opts.onHorizontal?.(-1);
        break;
      case "Enter":
      case " ":
        if (lv.index >= 0) activate(l, lv.index);
        break;
      case "Escape":
      case "Tab":
        if (l > 0 && e.key === "Escape") setState({ ...s, levels: s.levels.slice(0, l) });
        else closeMenu();
        break;
      default: {
        // Type-to-jump to the next item starting with the typed letter.
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const ch = e.key.toLowerCase();
          const n = items.length;
          for (let k = 1; k <= n; k++) {
            const i = (Math.max(lv.index, -1) + k) % n;
            const r = resolve(items[i]);
            if (r.kind === "item" && r.enabled && r.label.toLowerCase().startsWith(ch)) {
              setLevelIndex(l, i);
              break;
            }
          }
          break;
        }
        return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  createEffect(() => {
    if (state()) {
      window.addEventListener("keydown", onKey, true);
      onCleanup(() => window.removeEventListener("keydown", onKey, true));
    }
  });

  return (
    <Show when={state()}>
      {(s) => (
        <Portal>
          <div
            class="dg-menu-backdrop"
            onMouseDown={(e) => {
              e.preventDefault();
              closeMenu();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
          />
          <Index each={s().levels}>
            {(lv, l) => (
              <MenuPanel
                level={lv}
                depth={l}
                opts={s().opts}
                onHover={(i, rowEl) => {
                  const cur = state();
                  if (!cur) return;
                  const it = cur.levels[l].items[i];
                  const r = resolve(it);
                  if (r.hasChildren) openSub(l, i, rowEl.getBoundingClientRect(), false);
                  else setLevelIndex(l, i);
                }}
                onActivate={(i, rowEl) => activate(l, i, rowEl)}
              />
            )}
          </Index>
        </Portal>
      )}
    </Show>
  );
}

function MenuPanel(props: {
  level: () => Level;
  depth: number;
  opts: OpenMenuOptions;
  onHover: (i: number, row: HTMLElement) => void;
  onActivate: (i: number, row: HTMLElement) => void;
}): JSX.Element {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  const compact = () => !!(props.opts.compact || props.opts.title);

  const place = () => {
    const lv = props.level();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (props.depth > 0) {
      left = lv.rect.right - 1;
      if (left + w > vw - 4) left = Math.max(4, lv.rect.left - w + 1);
      top = lv.rect.top - 7;
    } else if (lv.anchored) {
      left = lv.rect.left;
      top = lv.rect.bottom + lv.gap;
      if (top + h > vh - 4 && lv.rect.top - h - lv.gap > 4) top = lv.rect.top - h - lv.gap;
    } else {
      left = lv.rect.left;
      top = lv.rect.top;
    }
    if (left + w > vw - 4) left = Math.max(4, vw - w - 4);
    if (top + h > vh - 4) top = Math.max(4, vh - h - 4);
    setPos({ left, top });
  };
  // Re-place whenever the panel is (re)anchored: first render, or another parent row for a submenu.
  createEffect(on(() => props.level().rect, place));

  // Keep the keyboard-selected row visible in tall menus.
  createEffect(() => {
    const i = props.level().index;
    el?.querySelectorAll<HTMLElement>(".dg-menu-row")[i]?.scrollIntoView?.({ block: "nearest" });
  });

  return (
    <div
      ref={el}
      class="dg-menu"
      classList={{ "dg-menu-compact": compact(), "dg-menu-bar-menu": props.opts.variant === "bar" }}
      style={{
        left: (pos()?.left ?? 0) + "px",
        top: (pos()?.top ?? 0) + "px",
        visibility: pos() ? "visible" : "hidden",
        "min-width": (props.opts.minWidth ?? 0) + "px",
      }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Show when={props.opts.title && props.depth === 0}>
        <div class="dg-menu-title">{props.opts.title}</div>
      </Show>
      <Index each={props.level().items}>
        {(it, i) => {
          const r = () => resolve(it());
          return (
            <Show
              when={r().kind === "item"}
              fallback={
                <>
                  <Show when={r().kind === "separator"}>
                    <div class="dg-menu-sep" />
                  </Show>
                  <Show when={r().kind === "header"}>
                    <div class="dg-menu-header">{r().label}</div>
                  </Show>
                  <Show when={r().kind === "hint"}>
                    <div class="dg-menu-hint">{r().label}</div>
                  </Show>
                </>
              }
            >
              <div
                class="dg-menu-row"
                classList={{
                  "dg-active": props.level().index === i,
                  "dg-disabled": !r().enabled,
                }}
                onMouseMove={(e) => {
                  if (props.level().index !== i) props.onHover(i, e.currentTarget);
                }}
                onClick={(e) => props.onActivate(i, e.currentTarget)}
              >
                <span class="dg-menu-icon">
                  <Show when={r().icon} fallback={<Show when={r().checked}><Icon name="checkmark" /></Show>}>
                    <Icon name={r().icon} />
                  </Show>
                </span>
                <span class="dg-menu-label">{r().label}</span>
                <Show when={r().badge}>
                  <span class="dg-menu-badge">{r().badge}</span>
                </Show>
                <Show when={r().shortcut}>
                  <span class="dg-menu-shortcut">{r().shortcut}</span>
                </Show>
                <Show when={r().hasChildren}>
                  <span class="dg-menu-arrow">
                    <Icon name="chevron-right" />
                  </span>
                </Show>
              </div>
            </Show>
          );
        }}
      </Index>
    </div>
  );
}
