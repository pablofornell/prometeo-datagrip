/**
 * "Manage Columns" popup (Ctrl+F12): column list with show/hide checkboxes, search, drag to reorder, and a
 * `N of M visible` footer with Show all / Hide all (DataGrip 2026.3, docs/ux/screens/98-grid-manage-columns-dark.png).
 * Presentational: the grid owns the order / hidden state and passes it in.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { GridColumn } from "./types";
import "./grid.css";

function iconClass(c: GridColumn): string {
  if (c.isPk && c.isFk) return "k-pkfk";
  if (c.isPk) return "k-pk";
  if (c.isFk) return "k-fk";
  if (c.isIndexed) return "k-idx";
  if (c.nullable === false) return "k-nn";
  return "k-col";
}

export interface ManageColumnsProps {
  columns: GridColumn[];
  /** Visual order of column indexes (hidden ones included). */
  order: number[];
  hidden: ReadonlySet<number>;
  /** Pinned (frozen) columns. */
  pinned?: ReadonlySet<number>;
  /** Toolbar button rectangle to open under (right edges aligned); omitted = centred over `bounds`. */
  anchor?: DOMRect;
  /** Grid rectangle used to centre the popup when there is no anchor. */
  bounds?: DOMRect;
  onToggle: (col: number, visible: boolean) => void;
  /** Pin / unpin a column (the pin icon of a hovered row). */
  onTogglePin?: (col: number) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  /** Move `col` so it lands at index `toIndex` of the (full) order. */
  onMove: (col: number, toIndex: number) => void;
  onClose: () => void;
}

const W = 421;
const H = 521;
const ROW = 26;

export function ManageColumns(props: ManageColumnsProps): JSX.Element {
  let el!: HTMLDivElement;
  let list!: HTMLDivElement;
  let search!: HTMLInputElement;
  const [q, setQ] = createSignal("");
  const [hover, setHover] = createSignal(-1);
  const [drag, setDrag] = createSignal<{ col: number; to: number } | null>(null);

  const pos = () => {
    const a = props.anchor;
    const b = props.bounds;
    let x: number;
    let y: number;
    if (a) {
      x = a.right - W;
      y = a.bottom + 4;
    } else if (b) {
      x = b.left + (b.width - W) / 2;
      y = b.top + 24;
    } else {
      x = (window.innerWidth - W) / 2;
      y = 40;
    }
    x = Math.max(4, Math.min(x, window.innerWidth - W - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - H - 4));
    return { x, y };
  };

  const rows = createMemo(() => {
    const t = q().trim().toLowerCase();
    return props.order.filter((ci) => props.columns[ci] && (!t || props.columns[ci].name.toLowerCase().includes(t)));
  });
  const visibleCount = () => props.order.filter((ci) => !props.hidden.has(ci)).length;

  onMount(() => {
    search.focus();
    const down = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = rows().length;
        if (n) setHover((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
      } else if (e.key === " " && hover() >= 0 && e.target !== search) {
        e.preventDefault();
        toggle(rows()[hover()]);
      }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    });
  });

  const toggle = (ci: number | undefined) => {
    if (ci !== undefined) props.onToggle(ci, props.hidden.has(ci));
  };

  /** Drag a row by its handle; the drop target is the row index under the pointer (within the filtered list). */
  function startDrag(e: MouseEvent, ci: number) {
    e.preventDefault();
    e.stopPropagation();
    const rect = () => list.getBoundingClientRect();
    const target = (ev: MouseEvent) => Math.max(0, Math.min(rows().length, Math.round((ev.clientY - rect().top + list.scrollTop) / ROW)));
    setDrag({ col: ci, to: target(e) });
    const move = (ev: MouseEvent) => setDrag({ col: ci, to: target(ev) });
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      const to = target(ev);
      setDrag(null);
      const list2 = rows();
      const from = list2.indexOf(ci);
      if (to === from || to === from + 1) return;
      // translate the filtered-list boundary into an index of the full order
      const rest = props.order.filter((c) => c !== ci);
      const before = list2[to] === ci ? list2[to + 1] : list2[to];
      const at = before === undefined ? rest.length : rest.indexOf(before);
      props.onMove(ci, at < 0 ? rest.length : at);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  }

  return (
    <Portal>
      <div ref={el} class="dgg-mc" style={{ left: pos().x + "px", top: pos().y + "px", width: W + "px", height: H + "px" }}>
        <div class="dgg-mc-title">Manage Columns</div>
        <div class="dgg-mc-search">
          <i class="dgg-i i-find" />
          <input ref={search} value={q()} placeholder="Search columns" spellcheck={false} autocomplete="off" onInput={(e) => (setQ(e.currentTarget.value), setHover(-1))} />
        </div>
        <div ref={list} class="dgg-mc-list">
          <For each={rows()}>
            {(ci, i) => (
              <div
                class="dgg-mc-row"
                classList={{ hover: hover() === i(), off: props.hidden.has(ci), dragging: drag()?.col === ci }}
                onMouseEnter={() => setHover(i())}
                onClick={() => toggle(ci)}
              >
                <span class="dgg-mc-cb" classList={{ on: !props.hidden.has(ci) }} />
                <i class={"dgg-ico " + iconClass(props.columns[ci])} />
                <span class="dgg-mc-name">{props.columns[ci].name}</span>
                <span class="dgg-mc-type">{props.columns[ci].typeName.toUpperCase()}</span>
                <span class="dgg-mc-spacer" />
                <Show when={props.onTogglePin}>
                  <i
                    class="dgg-mc-pin dgg-i"
                    classList={{ on: !!props.pinned?.has(ci), "i-pin": !props.pinned?.has(ci), "i-pinOn": !!props.pinned?.has(ci) }}
                    title={props.pinned?.has(ci) ? "Unpin column" : "Pin column"}
                    onClick={(e) => (e.stopPropagation(), props.onTogglePin?.(ci))}
                  />
                </Show>
                <i class="dgg-mc-grip" title="Drag to reorder" onMouseDown={(e) => startDrag(e, ci)} onClick={(e) => e.stopPropagation()} />
              </div>
            )}
          </For>
          <Show when={drag()}>{(d) => <div class="dgg-mc-drop" style={{ top: d().to * ROW + "px" }} />}</Show>
        </div>
        <div class="dgg-mc-foot">
          <span class="dgg-mc-count">
            {visibleCount()} of {props.order.length} visible
          </span>
          <span class="dgg-mc-spacer" />
          <Show when={visibleCount() < props.order.length}>
            <a class="dgg-mc-link" onClick={() => props.onShowAll()}>
              Show all
            </a>
          </Show>
          <Show when={visibleCount() > 0}>
            <a class="dgg-mc-link" onClick={() => props.onHideAll()}>
              Hide all
            </a>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
