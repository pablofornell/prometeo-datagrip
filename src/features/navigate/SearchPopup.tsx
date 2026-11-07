/** Search Everywhere (Shift Shift) and Go to Database Object (Ctrl+N): one popup, tabs All / Database / Files / Actions / Text. */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import type { DataSource } from "../../api/db";
import { Checkbox, Icon, type MenuItem, openMenu, tip } from "../../components/ui";
import { isActionEnabled, getAction } from "../../state/actions";
import { explorerDataSources } from "../explorer";
import { iconOf } from "../explorer/model";
import { providerIcon } from "../explorer/icons";
import { NodeIcon } from "../explorer/NodeIcon";
import { hasDdl, loadRecent, openEntry, pushRecent } from "./open";
import {
  type Entry,
  type EntryKind,
  type Hit,
  collectActions,
  collectSettings,
  consoleEntries,
  databaseColumnEntries,
  databaseEntries,
  ensureIndex,
  footerPath,
  isEntryVisible,
  locationOf,
  parseQuery,
  reloadConsoles,
  reloadTextIndex,
  search,
  searchText,
  signatureText,
  textEntries,
} from "./sources";
import type { Range } from "./match";

export type SearchTab = "all" | "db" | "console" | "action" | "text";

const TABS: { id: SearchTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "db", label: "Database" },
  { id: "console", label: "Files" },
  { id: "action", label: "Actions" },
  { id: "text", label: "Text" },
];

/** `/` commands: switch the tab (DataGrip's "Type / to see commands"). */
const COMMANDS: { name: string; tab: SearchTab; desc: string }[] = [
  { name: "all", tab: "all", desc: "Everywhere" },
  { name: "db", tab: "db", desc: "Database objects" },
  { name: "files", tab: "console", desc: "Consoles" },
  { name: "actions", tab: "action", desc: "Actions and settings" },
  { name: "text", tab: "text", desc: "Text in consoles" },
];

const FILTERS: { label: string; kinds: EntryKind[] }[] = [
  { label: "Tables", kinds: ["table"] },
  { label: "Views", kinds: ["view", "materializedView"] },
  { label: "Routines", kinds: ["routine", "function", "procedure"] },
  { label: "Sequences", kinds: ["sequence"] },
  { label: "Indexes", kinds: ["index"] },
  { label: "Keys", kinds: ["primaryKey", "uniqueKey"] },
  { label: "Foreign Keys", kinds: ["foreignKey"] },
  { label: "Checks", kinds: ["check"] },
  { label: "Triggers", kinds: ["trigger"] },
  { label: "Schemas", kinds: ["schema"] },
  { label: "Columns", kinds: ["column"] },
  { label: "Data Sources", kinds: ["dataSource"] },
];

const MAX_ROWS = 200;
const ALL_LIMITS = { db: 25, console: 6, action: 12, setting: 4, text: 4 };

const [openState, setOpenState] = createSignal<{ tab: SearchTab } | null>(null);
const [requestedTab, setRequestedTab] = createSignal<{ tab: SearchTab; n: number }>({ tab: "all", n: 0 });
let host: HTMLDivElement | undefined;
let dispose: (() => void) | undefined;
let prevFocus: HTMLElement | null = null;

/** Opens the popup on `tab`; when it is already open, switches to that tab and focuses the field. */
export function openSearch(tab: SearchTab): void {
  setRequestedTab((r) => ({ tab, n: r.n + 1 }));
  if (openState()) return;
  prevFocus = document.activeElement as HTMLElement | null;
  setOpenState({ tab });
  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <SearchPopup initialTab={tab} />, host);
}

function close(restoreFocus = true): void {
  if (!openState()) return;
  setOpenState(null);
  const f = prevFocus;
  prevFocus = null;
  queueMicrotask(() => {
    dispose?.();
    host?.remove();
    dispose = undefined;
    host = undefined;
    if (restoreFocus) f?.focus?.({ preventScroll: true });
  });
}

function Hl(props: { text: string; ranges: Range[] }): JSX.Element {
  const parts = () => {
    const out: { t: string; m: boolean }[] = [];
    let p = 0;
    for (const [a, b] of props.ranges) {
      if (a > p) out.push({ t: props.text.slice(p, a), m: false });
      out.push({ t: props.text.slice(a, b), m: true });
      p = b;
    }
    if (p < props.text.length) out.push({ t: props.text.slice(p), m: false });
    return out;
  };
  return <For each={parts()}>{(s) => (s.m ? <mark class="dg-search-match">{s.t}</mark> : <>{s.t}</>)}</For>;
}

function iconFor(e: Entry, ds: DataSource | undefined): string | undefined {
  if (e.group === "console") return "dg/console";
  if (e.group === "action") return undefined;
  if (e.group === "text") return "dg/console";
  if (e.kind === "dataSource") return ds ? providerIcon(ds.driver) : "dg/dbms";
  if (e.kind === "index" && e.unique) return "dg/index-unique";
  return iconOf(e.kind as never);
}

function SearchPopup(props: { initialTab: SearchTab }): JSX.Element {
  ensureIndex();
  void reloadConsoles();
  void reloadTextIndex();
  const actions = collectActions();
  const settings = collectSettings();
  const [includeHidden, setIncludeHidden] = createSignal(false);
  const [tab, setTab] = createSignal<SearchTab>(props.initialTab);
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const [scope, setScope] = createSignal<string | null>(null);
  const [hidden, setHidden] = createSignal<ReadonlySet<EntryKind>>(new Set());
  const recent = loadRecent();
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;

  const dsById = (id: string) => explorerDataSources().find((d) => d.id === id);
  // Only what the explorer shows, unless "Include non-project items" is on (schemas hidden by the schema selector).
  const allDb = createMemo(() => {
    const all = [...databaseEntries(), ...databaseColumnEntries()];
    if (includeHidden()) return all;
    const byId = new Map(explorerDataSources().map((d) => [d.id, d]));
    return all.filter((e) => isEntryVisible(e, e.dsId ? byId.get(e.dsId) : undefined));
  });

  const hits = createMemo<Hit[]>(() => {
    const text = query();
    const t = tab();
    const q = parseQuery(text);
    const base = { dsById, hideKinds: hidden(), dsId: scope() };
    if (text.startsWith("/")) {
      const c = text.slice(1).trim().toLowerCase();
      return COMMANDS.filter((x) => x.name.startsWith(c)).map<Hit>((x) => ({
        entry: { group: "action", kind: "action", name: "/" + x.name, lower: "/" + x.name, goTab: x.tab, right: x.desc },
        ranges: [],
        score: 0,
      }));
    }
    if (!text.trim() && t === "console") return consoleEntries().slice(0, MAX_ROWS).map((entry) => ({ entry, ranges: [], score: 0 }));
    if (!text.trim()) {
      // Nothing typed: the objects / consoles opened recently from this popup.
      const known = new Set(explorerDataSources().map((d) => d.id));
      const rs = recent.filter((r) => known.has(r.dsId ?? "") && (t === "all" || (t === "db" && r.group === "db") || (t === "console" && r.group === "console")));
      return rs.map((entry) => ({ entry, ranges: [], score: 0 }));
    }
    if (t === "db") return search(allDb(), q, { ...base, limit: MAX_ROWS });
    if (t === "console") return search(consoleEntries(), q, { ...base, limit: MAX_ROWS, dsId: null });
    if (t === "action") return search([...actions, ...settings], q, { ...base, limit: MAX_ROWS, dsId: null });
    if (t === "text") return searchText(textEntries(), text, MAX_ROWS);
    return [
      ...search(allDb(), q, { ...base, limit: ALL_LIMITS.db }),
      ...search(consoleEntries(), q, { ...base, limit: ALL_LIMITS.console }),
      ...search(actions, q, { ...base, limit: ALL_LIMITS.action, dsId: null }),
      ...search(settings, q, { ...base, limit: ALL_LIMITS.setting, dsId: null }),
      ...searchText(textEntries(), text, ALL_LIMITS.text, scope()),
    ];
  });

  createEffect(() => {
    hits();
    setSel(0);
    if (list) list.scrollTop = 0;
  });
  createEffect(() => {
    const r = requestedTab();
    if (r.n > 0) {
      setTab(r.tab);
      input?.focus();
      input?.select();
    }
  });
  onMount(() => input.focus());
  onCleanup(() => setOpenState(null));

  const current = () => hits()[sel()]?.entry;
  const move = (d: number) => {
    const n = hits().length;
    if (!n) return;
    const i = Math.min(n - 1, Math.max(0, d === 1 || d === -1 ? (sel() + d + n) % n : sel() + d));
    setSel(i);
    list.querySelectorAll<HTMLElement>(".dgn-row")[i]?.scrollIntoView({ block: "nearest" });
  };
  const activate = (e: Entry | undefined, mode: "default" | "ddl" = "default") => {
    if (!e) return;
    if (e.goTab) {
      setTab(e.goTab as SearchTab);
      setQuery("");
      input.focus();
      return;
    }
    if (e.group === "action" && e.actionId && !isActionEnabled(getAction(e.actionId))) return;
    pushRecent(e);
    close(e.group !== "action");
    // Let the previous focus come back first: actions look at the focused component.
    setTimeout(() => void openEntry(e, mode), 0);
  };
  const cycleTab = (d: number) => {
    const i = TABS.findIndex((x) => x.id === tab());
    setTab(TABS[(i + d + TABS.length) % TABS.length].id);
  };

  const onKey = (e: KeyboardEvent) => {
    const stop = () => (e.preventDefault(), e.stopPropagation());
    switch (e.key) {
      case "Escape":
        return stop(), close();
      case "ArrowDown":
        return stop(), move(1);
      case "ArrowUp":
        return stop(), move(-1);
      case "PageDown":
        return stop(), move(10);
      case "PageUp":
        return stop(), move(-10);
      case "Enter":
        return stop(), activate(current(), e.shiftKey ? "ddl" : "default");
      case "Tab":
        return stop(), cycleTab(e.shiftKey ? -1 : 1);
    }
    if (e.ctrlKey && e.key.toLowerCase() === "n") return;
  };

  const scopeName = () => (scope() ? (dsById(scope()!)?.name ?? "All Data Sources") : "All Data Sources");
  let scopeBtn!: HTMLButtonElement;
  let filterBtn!: HTMLButtonElement;
  const openScope = () => {
    const items: MenuItem[] = [
      { label: "All Data Sources", icon: "dg/database", checked: () => scope() === null, run: () => setScope(null) },
      { type: "separator" },
      ...explorerDataSources().map<MenuItem>((d) => ({ label: d.name, icon: providerIcon(d.driver), checked: () => scope() === d.id, run: () => setScope(d.id) })),
    ];
    openMenu(items, { anchor: scopeBtn, compact: true });
  };
  const isShown = (kinds: EntryKind[]) => !kinds.some((k) => hidden().has(k));
  const openFilter = () => {
    const items: MenuItem[] = FILTERS.map<MenuItem>((f) => ({
      label: f.label,
      checked: () => isShown(f.kinds),
      run: () =>
        setHidden((h) => {
          const n = new Set(h);
          for (const k of f.kinds) (isShown(f.kinds) ? n.add(k) : n.delete(k));
          return n;
        }),
    }));
    openMenu(items, { anchor: filterBtn, compact: true });
  };

  const selDs = () => (current()?.dsId ? dsById(current()!.dsId!) : undefined);
  const footer = () => (current() ? footerPath(current()!, selDs()) : "");

  return (
    <div class="dgn-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dgn-popup" role="dialog" onKeyDown={onKey}>
        <div class="dgn-header">
          <For each={TABS}>
            {(t) => (
              <button type="button" class="dgn-tab" classList={{ "dgn-on": tab() === t.id }} tabindex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            )}
          </For>
          <div class="dgn-header-right">
            <Show when={tab() === "db"}>
              <button ref={scopeBtn} type="button" class="dgn-scope" tabindex={-1} onMouseDown={(e) => e.preventDefault()} onClick={openScope}>
                <Icon name="dg/database" />
                <span>{scopeName()}</span>
                <Icon name="chevron-down" size={12} />
              </button>
            </Show>
            <Show when={tab() === "all" || tab() === "db"}>
              <span class="dgn-include" onMouseDown={(e) => e.preventDefault()}>
                <Checkbox checked={includeHidden()} onChange={setIncludeHidden} label="Include non-project items" />
              </span>
              <button ref={filterBtn} type="button" class="dgn-iconbtn" tabindex={-1} {...tip("Filter")} onMouseDown={(e) => e.preventDefault()} onClick={openFilter}>
                <Icon name="filter" />
                <Show when={hidden().size > 0}>
                  <span class="dgn-dot" />
                </Show>
              </button>
            </Show>
          </div>
        </div>
        <div class="dgn-field">
          <svg class="dgn-search-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.5 2a4.5 4.5 0 1 0 2.6 8.2l2.9 2.9.7-.7-2.9-2.9A4.5 4.5 0 0 0 6.5 2Zm0 1a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z" fill="currentColor" />
            <path d="M13 6.5h3l-1.5 1.7z" fill="currentColor" transform="translate(-1 .5)" />
          </svg>
          <input ref={input} spellcheck={false} autocomplete="off" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          <Show when={query().length < 40}>
            <span class="dgn-hint">Type / to see commands</span>
          </Show>
        </div>
        <div class="dgn-list" ref={list}>
          <Show when={hits().length === 0 && query().trim()}>
            <div class="dgn-empty">Nothing found</div>
          </Show>
          <For each={hits()}>
            {(h, i) => {
              const e = h.entry;
              const ds = () => (e.dsId ? dsById(e.dsId) : undefined);
              const dis = () => e.group === "action" && !!e.actionId && !isActionEnabled(getAction(e.actionId));
              return (
                <div class="dgn-row" classList={{ "dgn-sel": i() === sel(), "dgn-dis": dis() }} onClick={() => activate(e)} onMouseMove={() => sel() !== i() && setSel(i())}>
                  <span class="dgn-ico">
                    <Show when={iconFor(e, ds())}>{(n) => <NodeIcon name={n()} />}</Show>
                  </span>
                  <span class="dgn-name">
                    <Hl text={e.name} ranges={h.ranges} />
                    <Show when={e.signature != null}>{signatureText(e.signature)}</Show>
                  </span>
                  <span class="dgn-loc">{locationOf(e, ds())}</span>
                  <Show when={e.right}>
                    <span class="dgn-right">{e.right}</span>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
        <div class="dgn-footer">
          <span class="dgn-path">{footer()}</span>
          <Show when={hasDdl(current())}>
            <a class="dgn-link" {...tip("Open the DDL", "Shift+Enter")} onMouseDown={(ev) => ev.preventDefault()} onClick={() => activate(current(), "ddl")}>
              Open DDL
            </a>
          </Show>
        </div>
      </div>
    </div>
  );
}
