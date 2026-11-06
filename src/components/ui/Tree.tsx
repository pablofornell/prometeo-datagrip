/**
 * Generic virtualized tree (DataGrip look): 24px rows, 19px indent, chevrons, icon, name + gray hint,
 * focused / unfocused selection, keyboard navigation and speed search. Children can be loaded lazily
 * with an async `loadChildren`.
 *
 *   <Tree roots={[{ id: "ds1", label: "postgres@localhost", hasChildren: true }]}
 *         loadChildren={async (n) => await introspect(n)}
 *         onActivate={(n, via) => via === "f4" || via === "dblclick" ? openTable(n) : false}
 *         onContextMenu={(n, e) => openMenu(items, { x: e.clientX, y: e.clientY })}
 *         ref={(c) => (controller = c)} />
 *
 * Keys: Up/Down, Left (collapse / go to parent), Right (expand / first child), Home/End, PageUp/PageDown,
 * Enter and F4 (`onActivate`; return true when handled, otherwise Enter/double-click toggle folders),
 * typing = speed search (orange highlight, Up/Down jump between matches, Esc clears).
 */
import {
  Index,
  type JSX,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { Icon } from "./Icon";
import { Highlighted, SpeedSearchField, createSpeedSearch, matchRanges } from "./SpeedSearch";

export interface TreeItem {
  id: string;
  label: string;
  /** Icon name from src/assets/icons, or a URL. */
  icon?: string;
  /** Gray text after the label (type, count, signature). */
  hint?: string;
  /** Boxed badge after the label ("1", "3 of 5"). */
  badge?: string;
  /** Shows a chevron even if the children are not loaded yet. */
  hasChildren?: boolean;
  /** Preloaded children (otherwise `loadChildren` is called on first expand). */
  children?: TreeItem[];
  labelClass?: string;
  tooltip?: string;
  /** Free payload for the owner. */
  data?: unknown;
}

export interface TreeController<T extends TreeItem = TreeItem> {
  expand: (id: string) => void;
  collapse: (id: string) => void;
  toggle: (id: string) => void;
  /** Expands all already known nodes (lazy nodes are loaded one level at a time, depth-limited). */
  expandAll: (maxDepth?: number) => Promise<void>;
  collapseAll: () => void;
  select: (id: string | null, opts?: { reveal?: boolean }) => void;
  selected: () => T | undefined;
  /** Drops the cached children of `id` (or of everything) and reloads the ones that are expanded. */
  refresh: (id?: string) => void;
  getExpanded: () => string[];
  focus: () => void;
  /** Current speed-search text. */
  searchQuery: () => string;
  /** Speed-search filter mode (funnel toggle): only matching nodes and their parents are listed. */
  filterMode: () => boolean;
  setFilterMode: (on: boolean) => void;
}

export interface TreeProps<T extends TreeItem = TreeItem> {
  roots: T[];
  loadChildren?: (item: T) => Promise<T[]> | T[];
  selectedId?: string | null;
  onSelect?: (item: T | undefined) => void;
  /** Enter / F4 / double click. Return true if handled; otherwise Enter and double click toggle. */
  onActivate?: (item: T, via: "enter" | "f4" | "dblclick") => boolean | void;
  onContextMenu?: (item: T | undefined, e: MouseEvent) => void;
  /** Called before default key handling; return true to consume the key. */
  onKey?: (e: KeyboardEvent, item: T | undefined) => boolean | void;
  initialExpanded?: string[];
  onExpandedChange?: (ids: string[]) => void;
  onSpeedSearchChange?: (query: string) => void;
  /** Show the floating speed-search field over the tree (default true). */
  speedSearchField?: boolean;
  /** Custom label content (default: highlighted label + hint + badge). */
  renderLabel?: (item: T, query: string) => JSX.Element;
  emptyText?: JSX.Element;
  ref?: (c: TreeController<T>) => void;
  class?: string;
}

const ROW_H = 24;
const OVERSCAN = 8;

interface Row<T> {
  item: T;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  loading: boolean;
  error?: string;
}

export function Tree<T extends TreeItem = TreeItem>(props: TreeProps<T>): JSX.Element {
  let scroller!: HTMLDivElement;
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(props.initialExpanded ?? []));
  const [rev, bump] = createSignal(0);
  const [loadingIds, setLoadingIds] = createSignal<Set<string>>(new Set());
  const [errors, setErrors] = createSignal<Map<string, string>>(new Map());
  const [selId, setSelId] = createSignal<string | null>(props.selectedId ?? null);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);
  const cache = new Map<string, T[]>();
  const byId = new Map<string, T>();
  const parentOf = new Map<string, string | undefined>();

  const search = createSpeedSearch((q) => props.onSpeedSearchChange?.(q));
  const [filterMode, setFilterMode] = createSignal(false);

  createEffect(() => {
    if (props.selectedId !== undefined) setSelId(props.selectedId);
  });

  const childrenOf = (it: T): T[] | undefined => (it.children as T[] | undefined) ?? cache.get(it.id);
  const hasKids = (it: T) => it.hasChildren ?? !!(it.children && it.children.length);

  const rows = createMemo<Row<T>[]>(() => {
    rev();
    const exp = expanded();
    const loading = loadingIds();
    const errs = errors();
    const out: Row<T>[] = [];
    // Filter mode: keep the nodes that match and the ones with a matching descendant (loaded nodes only).
    const fq = filterMode() ? search.query() : "";
    const keep = new Map<string, boolean>();
    const kidMatch = (it: T): boolean => (childrenOf(it) ?? []).some(keeps);
    const keeps = (it: T): boolean => {
      let k = keep.get(it.id);
      if (k === undefined) {
        k = !!matchRanges(it.label, fq) || kidMatch(it);
        keep.set(it.id, k);
      }
      return k;
    };
    const walk = (list: T[], depth: number, parent: string | undefined) => {
      for (const item of list) {
        byId.set(item.id, item);
        parentOf.set(item.id, parent);
        if (fq && !keeps(item)) continue;
        const hk = hasKids(item);
        const isExp = hk && (exp.has(item.id) || (!!fq && kidMatch(item)));
        out.push({ item, depth, expanded: isExp, hasChildren: hk, loading: loading.has(item.id), error: errs.get(item.id) });
        if (isExp) {
          const kids = childrenOf(item);
          if (kids) walk(kids, depth + 1, item.id);
        }
      }
    };
    walk(props.roots, 0, undefined);
    return out;
  });

  const indexOfId = (id: string | null) => (id === null ? -1 : rows().findIndex((r) => r.item.id === id));
  const selectedItem = () => (selId() === null ? undefined : byId.get(selId()!));

  // ---- loading
  const load = async (item: T, force = false) => {
    if (!force && (childrenOf(item) || loadingIds().has(item.id))) return;
    if (!props.loadChildren) {
      cache.set(item.id, []);
      bump((v) => v + 1);
      return;
    }
    setLoadingIds((s) => new Set(s).add(item.id));
    setErrors((m) => {
      const n = new Map(m);
      n.delete(item.id);
      return n;
    });
    try {
      const kids = await props.loadChildren(item);
      cache.set(item.id, kids);
      kids.forEach((k) => {
        byId.set(k.id, k);
        parentOf.set(k.id, item.id);
      });
    } catch (e) {
      setErrors((m) => new Map(m).set(item.id, String((e as Error)?.message ?? e)));
    } finally {
      setLoadingIds((s) => {
        const n = new Set(s);
        n.delete(item.id);
        return n;
      });
      bump((v) => v + 1);
    }
  };

  // Auto-load children of expanded nodes whose children are unknown (initial state, refresh).
  createEffect(
    on(rows, (rs) => {
      for (const r of rs) if (r.expanded && !childrenOf(r.item) && !r.loading && !r.error) void load(r.item);
    }),
  );

  const emitExpanded = () => props.onExpandedChange?.([...expanded()]);

  const expand = (id: string) => {
    const it = byId.get(id);
    if (!it || !hasKids(it) || expanded().has(id)) return;
    setExpanded((s) => new Set(s).add(id));
    void load(it);
    emitExpanded();
  };
  const collapse = (id: string) => {
    if (!expanded().has(id)) return;
    setExpanded((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    // Keep the selection visible: if it was inside the collapsed subtree, select the collapsed node.
    let p = parentOf.get(selId() ?? "");
    while (p !== undefined) {
      if (p === id) {
        select(id);
        break;
      }
      p = parentOf.get(p);
    }
    emitExpanded();
  };
  const toggle = (id: string) => (expanded().has(id) ? collapse(id) : expand(id));

  const select = (id: string | null, opts?: { reveal?: boolean }) => {
    if (opts?.reveal && id) {
      let p = parentOf.get(id);
      const add: string[] = [];
      while (p !== undefined) {
        add.push(p);
        p = parentOf.get(p);
      }
      if (add.length) setExpanded((s) => new Set([...s, ...add]));
    }
    setSelId(id);
    props.onSelect?.(id ? byId.get(id) : undefined);
    queueMicrotask(() => scrollToId(id));
  };

  const scrollToId = (id: string | null) => {
    const i = indexOfId(id);
    if (i < 0 || !scroller) return;
    const top = i * ROW_H;
    const pad = 4;
    if (top < scroller.scrollTop) scroller.scrollTop = Math.max(0, top - pad);
    else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight - pad)
      scroller.scrollTop = top + ROW_H - scroller.clientHeight + pad;
  };

  const collapseAll = () => {
    setExpanded(new Set<string>());
    emitExpanded();
    if (selId() && indexOfId(selId()) < 0) {
      let p = parentOf.get(selId()!);
      while (p !== undefined && indexOfId(p) < 0) p = parentOf.get(p);
      select(p ?? null);
    }
  };

  const expandAll = async (maxDepth = 4) => {
    for (let pass = 0; pass < maxDepth; pass++) {
      const pending: Promise<void>[] = [];
      const add = new Set(expanded());
      let changed = false;
      for (const r of rows()) {
        if (r.hasChildren && !add.has(r.item.id)) {
          add.add(r.item.id);
          changed = true;
          pending.push(load(r.item));
        }
      }
      if (!changed) break;
      setExpanded(add);
      await Promise.all(pending);
    }
    emitExpanded();
  };

  const refresh = (id?: string) => {
    if (id === undefined) cache.clear();
    else cache.delete(id);
    bump((v) => v + 1);
  };

  props.ref?.({
    expand,
    collapse,
    toggle,
    expandAll,
    collapseAll,
    select,
    selected: selectedItem,
    refresh,
    getExpanded: () => [...expanded()],
    focus: () => scroller?.focus(),
    searchQuery: search.query,
    filterMode,
    setFilterMode,
  });

  // ---- speed search
  const matchIndexes = createMemo(() => {
    const q = search.query();
    if (!q) return [] as number[];
    const out: number[] = [];
    rows().forEach((r, i) => {
      if (matchRanges(r.item.label, q)) out.push(i);
    });
    return out;
  });
  const noMatch = () => search.active() && matchIndexes().length === 0;

  createEffect(
    on(search.query, (q) => {
      if (!q) return;
      const m = matchIndexes();
      if (!m.length) return;
      const cur = Math.max(0, indexOfId(selId()));
      const next = m.find((i) => i >= cur) ?? m[0];
      select(rows()[next].item.id);
    }),
  );

  // ---- keyboard
  const onKeyDown = (e: KeyboardEvent) => {
    const rs = rows();
    const item = selectedItem();
    if (props.onKey?.(e, item)) {
      e.preventDefault();
      return;
    }
    // Ctrl / Alt / Meta combinations (Ctrl+F4, Ctrl+Enter, ...) belong to the global keymap, not to the tree.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const cur = indexOfId(selId());
    const go = (i: number) => {
      if (!rs.length) return;
      select(rs[Math.max(0, Math.min(rs.length - 1, i))].item.id);
    };
    const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1);
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (search.active() && matchIndexes().length) {
          const m = matchIndexes();
          const t = dir === 1 ? m.find((i) => i > cur) ?? m[0] : [...m].reverse().find((i) => i < cur) ?? m[m.length - 1];
          go(t);
        } else go(cur < 0 ? 0 : cur + dir);
        break;
      }
      case "Home":
        go(0);
        break;
      case "End":
        go(rs.length - 1);
        break;
      case "PageDown":
        go(cur + page);
        break;
      case "PageUp":
        go(cur - page);
        break;
      case "ArrowRight":
        if (cur < 0) go(0);
        else if (rs[cur].hasChildren && !rs[cur].expanded) expand(rs[cur].item.id);
        else if (rs[cur].expanded && rs[cur + 1]?.depth > rs[cur].depth) go(cur + 1);
        break;
      case "ArrowLeft":
        if (cur < 0) break;
        if (rs[cur].expanded) collapse(rs[cur].item.id);
        else {
          const p = parentOf.get(rs[cur].item.id);
          if (p !== undefined) select(p);
        }
        break;
      case "Enter":
      case "F4":
        if (item) {
          const via = e.key === "F4" ? "f4" : "enter";
          const done = props.onActivate?.(item, via);
          if (!done && via === "enter" && hasKids(item)) toggle(item.id);
        }
        break;
      default:
        handled = search.handleKey(e);
        if (!handled) return;
    }
    if (handled) e.preventDefault();
  };

  // ---- virtualization
  onMount(() => {
    const ro = new ResizeObserver(() => setViewH(scroller.clientHeight));
    ro.observe(scroller);
    setViewH(scroller.clientHeight);
    onCleanup(() => ro.disconnect());
  });

  const range = createMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN);
    const last = Math.min(rows().length, Math.ceil((scrollTop() + viewH()) / ROW_H) + OVERSCAN);
    return [first, last] as const;
  });
  const visible = createMemo(() => {
    const [a, b] = range();
    return rows()
      .slice(a, b)
      .map((r, k) => ({ r, i: a + k }));
  });

  const rowFromEvent = (e: Event): Row<T> | undefined => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
    const i = id ? indexOfId(id) : -1;
    return i >= 0 ? rows()[i] : undefined;
  };

  return (
    <div
      class={"dg-tree" + (props.class ? " " + props.class : "")}
      ref={scroller}
      tabindex={0}
      data-focus-target
      role="tree"
      onScroll={() => setScrollTop(scroller.scrollTop)}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (e.button === 2 || e.button === 0) {
          const row = rowFromEvent(e);
          if (row && (e.target as HTMLElement).closest(".dg-tree-chevron") === null) select(row.item.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const row = rowFromEvent(e);
        props.onContextMenu?.(row?.item, e);
      }}
    >
      <Show when={props.speedSearchField !== false && search.active()}>
        <div class="dg-tree-search">
          <SpeedSearchField
            query={search.query()}
            noMatch={noMatch()}
            filterMode={filterMode()}
            onToggleFilter={() => setFilterMode(!filterMode())}
          />
        </div>
      </Show>
      <div class="dg-tree-inner" style={{ height: rows().length * ROW_H + "px" }}>
        <Index each={visible()}>
          {(v) => {
            const r = () => v().r;
            return (
            <div
              class="dg-tree-row"
              classList={{ "dg-selected": r().item.id === selId() }}
              data-row-id={r().item.id}
              role="treeitem"
              aria-expanded={r().hasChildren ? r().expanded : undefined}
              aria-selected={r().item.id === selId()}
              style={{ top: v().i * ROW_H + "px", "padding-left": r().depth * 19 + "px" }}
              title={r().item.tooltip}
              onDblClick={() => {
                const done = props.onActivate?.(r().item, "dblclick");
                if (!done && r().hasChildren) toggle(r().item.id);
              }}
            >
              <span
                class="dg-tree-chevron"
                onMouseDown={(e) => {
                  if (r().hasChildren) {
                    e.preventDefault();
                    e.stopPropagation();
                    batch(() => {
                      select(r().item.id);
                      toggle(r().item.id);
                    });
                    scroller.focus();
                  }
                }}
              >
                <Show when={r().loading} fallback={<Show when={r().hasChildren}><Icon name={r().expanded ? "chevron-down" : "chevron-right"} /></Show>}>
                  <span class="dg-spinner" />
                </Show>
              </span>
              <Show when={r().item.icon}>
                <Icon name={r().item.icon} class="dg-tree-icon" />
              </Show>
              <Show when={props.renderLabel} fallback={<DefaultLabel item={r().item} query={search.query()} error={r().error} />}>
                {props.renderLabel!(r().item, search.query())}
              </Show>
            </div>
            );
          }}
        </Index>
      </div>
      <Show when={rows().length === 0 && props.emptyText}>
        <div class="dg-tree-empty">{props.emptyText}</div>
      </Show>
    </div>
  );
}

function DefaultLabel(p: { item: TreeItem; query: string; error?: string }): JSX.Element {
  return (
    <>
      <span class={"dg-tree-label" + (p.item.labelClass ? " " + p.item.labelClass : "")}>
        <Highlighted text={p.item.label} query={p.query} />
      </span>
      <Show when={p.item.badge}>
        <span class="dg-tree-badge">{p.item.badge}</span>
      </Show>
      <Show when={p.item.hint}>
        <span class="dg-tree-hint">{p.item.hint}</span>
      </Show>
      <Show when={p.error}>
        <span class="dg-tree-error" title={p.error}>
          {p.error}
        </span>
      </Show>
    </>
  );
}
