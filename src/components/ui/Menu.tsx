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
import { anchorRect } from "./anchor-redirect";
import { mnemonicIndex, pruneItems } from "./menu-util";

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
      /**
       * Mnemonic letter (underlined in the main menu bar's dropdowns; pressing it while that menu is open
       * activates the item).
       */
      mnemonic?: string;
      /** Registry-backed item that is left out entirely while its action is not registered (feature not built yet). */
      optional?: boolean;
      enabled?: boolean | (() => boolean);
      checked?: boolean | (() => boolean);
      run?: () => void;
      children?: MenuItem[];
      /** Small toggle button at the row's end (pin in the "More tool windows" list); clicking it keeps the menu open. */
      trailing?: { icon: string; selectedIcon?: string; selected?: boolean | (() => boolean); title?: string; run: () => void };
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
  /** Underline the `mnemonic` letters and let them activate their item (context menus; the bar variant always does). */
  mnemonics?: boolean;
  /** "bar": dropdown of the main menu bar (narrower insets, full-width separators, like Swing menus). */
  variant?: "bar";
  /** Gap in px between the anchor and the menu (default 2). */
  gap?: number;
  /** Called after the menu closed for any reason. */
  onClose?: () => void;
  /** Left/Right pressed on the top level without a submenu (menu bar navigation). */
  onHorizontal?: (dir: -1 | 1) => void;
  /** Index (into `items`) preselected when opening from the keyboard / combo box; "first" = first enabled item. */
  selected?: number | "first";
  /** List popup with a grey number before every item; the digit keys 1-9 pick the item directly. */
  numbered?: boolean;
  /** Center the menu in the window (quick-switch popups). */
  center?: boolean;
  /** The highlighted row of the top level changed (hover or arrow keys): used for live previews. */
  onHighlight?: (index: number) => void;
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
  clearTimeout(subTimer);
  setState(null);
  restoreFocus?.focus?.({ preventScroll: true });
  restoreFocus = null;
  s.opts.onClose?.();
}

export const isMenuOpen = () => state() !== null;

export function openMenu(rawItems: MenuItem[], opts: OpenMenuOptions = {}): void {
  const items = pruneItems(rawItems);
  const prev = state();
  if (prev) {
    setState(null);
    prev.opts.onClose?.();
  } else {
    restoreFocus = document.activeElement as HTMLElement | null;
  }
  let rect: Level["rect"];
  if (opts.anchor) {
    const r = anchorRect(opts.anchor);
    rect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  } else {
    const x = opts.x ?? 0;
    const y = opts.y ?? 0;
    rect = { left: x, right: x, top: y, bottom: y };
  }
  const idx = opts.selected === "first" ? Math.max(-1, items.findIndex(selectable)) : (opts.selected ?? -1);
  setState({ levels: [{ items, index: idx, rect, anchored: !!opts.anchor, gap: opts.gap ?? 2 }], opts });
}

// ---------------------------------------------------------------- item resolution

interface Resolved {
  kind: "item" | "separator" | "header" | "hint";
  label: string;
  icon?: string;
  shortcut?: string;
  badge?: string;
  mnemonic?: string;
  enabled: boolean;
  checked: boolean;
  hasChildren: boolean;
  children?: MenuItem[];
  run?: () => void;
  trailing?: { icon: string; title?: string; run: () => void };
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
    mnemonic: it.mnemonic,
    enabled,
    checked: it.checked !== undefined ? val(it.checked, false) : (a?.checked?.() ?? false),
    hasChildren,
    children: it.children,
    run: it.run ?? (it.action ? () => void a?.run?.() : undefined),
    trailing: it.trailing && {
      icon: val(it.trailing.selected, false) ? (it.trailing.selectedIcon ?? it.trailing.icon) : it.trailing.icon,
      title: it.trailing.title,
      run: it.trailing.run,
    },
  };
}

const selectable = (it: MenuItem) => {
  const r = resolve(it);
  return r.kind === "item" && r.enabled;
};

// ---------------------------------------------------------------- host

let hoveredBarItem: HTMLElement | null = null;

/** The element under the pointer, ignoring the menu backdrop. */
function elementBelow(e: MouseEvent): HTMLElement | undefined {
  return document.elementsFromPoint(e.clientX, e.clientY).find((el) => !el.classList.contains("dg-menu-backdrop")) as HTMLElement | undefined;
}

/** How long the pointer rests on a row with a submenu before the submenu opens. */
const SUBMENU_DELAY_MS = 200;
let subTimer: ReturnType<typeof setTimeout> | undefined;

export function MenuHost(): JSX.Element {
  const setLevelIndex = (l: number, i: number) => {
    const s = state();
    if (!s) return;
    const levels = s.levels.slice(0, l + 1);
    levels[l] = { ...levels[l], index: i };
    setState({ ...s, levels });
    if (l === 0 && s.levels[0].index !== i) s.opts.onHighlight?.(i);
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
      const sub = pruneItems(r.children!);
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
        const plain = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
        // Numbered list popups: 1-9 pick the item directly.
        if (plain && s.opts.numbered && l === 0 && /^[1-9]$/.test(e.key)) {
          const real = items.map((it, i) => ({ it, i })).filter((x) => resolve(x.it).kind === "item");
          const hit = real[Number(e.key) - 1];
          if (hit && resolve(hit.it).enabled) {
            setLevelIndex(l, hit.i);
            activate(l, hit.i);
          }
          break;
        }
        // Main menu bar dropdowns: the mnemonic letter activates its item.
        if (plain && (s.opts.variant === "bar" || s.opts.mnemonics)) {
          const ch = e.key.toLowerCase();
          const i = items.findIndex((it) => {
            const r = resolve(it);
            return r.kind === "item" && r.enabled && r.mnemonic?.toLowerCase() === ch;
          });
          if (i >= 0) {
            setLevelIndex(l, i);
            activate(l, i);
            break;
          }
        }
        // Type-to-jump to the next item starting with the typed letter.
        if (plain) {
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
            onMouseMove={(e) => {
              // The main menu bar stays live under the backdrop: hovering another title switches the menu.
              if (s().opts.variant !== "bar") return;
              const item = elementBelow(e)?.closest<HTMLElement>(".dg-menubar-item");
              if (item && item !== hoveredBarItem) item.dispatchEvent(new MouseEvent("mouseenter"));
              hoveredBarItem = item ?? null;
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              if (s().opts.variant === "bar") {
                const item = elementBelow(e)?.closest<HTMLElement>(".dg-menubar-item");
                if (item) {
                  // a click on a title: the bar toggles / switches menus itself
                  item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
                  return;
                }
              }
              closeMenu();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const { clientX, clientY } = e;
              const below = elementBelow(e);
              closeMenu();
              // Like DataGrip: a right click elsewhere closes the menu and opens the context menu of what is under the pointer.
              if (below && !below.closest(".dg-menubar"))
                queueMicrotask(() =>
                  (document.elementFromPoint(clientX, clientY) ?? below).dispatchEvent(
                    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY, button: 2 }),
                  ),
                );
            }}
          />
          <Index each={s().levels}>
            {(lv, l) => (
              <MenuPanel
                level={lv}
                depth={l}
                opts={s().opts}
                subOpen={() => (state()?.levels.length ?? 0) > l + 1}
                onHover={(i, rowEl) => {
                  const cur = state();
                  if (!cur) return;
                  const it = cur.levels[l].items[i];
                  const r = resolve(it);
                  clearTimeout(subTimer);
                  if (r.hasChildren && r.enabled) {
                    if (cur.levels[l].index !== i || cur.levels.length > l + 1) setLevelIndex(l, i); // highlight now, open after the delay
                    // like DataGrip: a submenu opens when the pointer rests on its row, not when it passes over it
                    subTimer = setTimeout(() => {
                      const s2 = state();
                      if (s2 && s2.levels[l]?.index === i && s2.levels.length === l + 1 && rowEl.isConnected) openSub(l, i, rowEl.getBoundingClientRect(), false);
                    }, SUBMENU_DELAY_MS);
                  } else setLevelIndex(l, i);
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
  /** Is a submenu of this panel open? */
  subOpen: () => boolean;
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
    if (props.depth === 0 && props.opts.center) {
      left = Math.round((vw - w) / 2);
      top = Math.round((vh - h) / 2);
    } else if (props.depth > 0) {
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
      onMouseDown={(e) => {
        // Menus never take the keyboard focus: focus-dependent actions (Edit > Copy) must still see the component the user was in.
        e.preventDefault();
        e.stopPropagation();
      }}
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
                  // a highlighted row (the keyboard / the first item of a bar menu) still has to open its submenu on hover
                  if (props.level().index !== i || (r().hasChildren && !props.subOpen())) props.onHover(i, e.currentTarget);
                }}
                onClick={(e) => props.onActivate(i, e.currentTarget)}
              >
                <Show
                  when={props.opts.numbered && props.depth === 0}
                  fallback={
                    <span class="dg-menu-icon">
                      <Show when={r().icon} fallback={<Show when={r().checked}><Icon name="checkmark" /></Show>}>
                        <Icon name={r().icon} />
                      </Show>
                    </span>
                  }
                >
                  <span class="dg-menu-number">{numberOf(props.level().items, i)}</span>
                </Show>
                <span class="dg-menu-label">
                  <Show when={(props.opts.variant === "bar" || props.opts.mnemonics) && r().mnemonic} fallback={r().label}>
                    <Mnemonic label={r().label} letter={r().mnemonic!} />
                  </Show>
                </span>
                <Show when={r().badge}>
                  <span class="dg-menu-badge">{r().badge}</span>
                </Show>
                <Show when={r().shortcut}>
                  <span class="dg-menu-shortcut">{r().shortcut}</span>
                </Show>
                <Show when={r().trailing}>
                  {(t) => (
                    <span
                      class="dg-menu-trailing"
                      title={t().title}
                      onClick={(e) => {
                        e.stopPropagation();
                        t().run();
                      }}
                    >
                      <Icon name={t().icon} />
                    </span>
                  )}
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

/** 1-based position of `items[i]` among the real (non-separator) rows of a numbered popup. */
function numberOf(items: MenuItem[], i: number): number {
  let n = 0;
  for (let k = 0; k <= i; k++) if (resolve(items[k]).kind === "item") n++;
  return n;
}

/** Label with the mnemonic letter underlined. */
export function Mnemonic(props: { label: string; letter: string }): JSX.Element {
  const at = () => mnemonicIndex(props.label, props.letter);
  return (
    <Show when={at() >= 0} fallback={props.label}>
      {props.label.slice(0, at())}
      <u>{props.label[at()]}</u>
      {props.label.slice(at() + 1)}
    </Show>
  );
}
