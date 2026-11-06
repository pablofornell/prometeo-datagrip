/** The Settings dialog: search + page tree on the left, breadcrumb header and page on the right, OK / Cancel / Apply. */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { Dialog, Highlighted, Icon, TextField } from "../../components/ui";
import { DEFAULT_SETTINGS, type Settings, settings, updateSettings } from "../../state/settings";
import { type ThemePref, setThemePref, themePref } from "../../state/theme";
import { KeymapPage } from "./KeymapPage";
import { PAGES, type PageNode, filterTree, findNode, firstLeaf, pathOf, visibleRows } from "./model";
import { AppearancePage, DataEditorPage, EditorAppearancePage, EditorFontPage, GroupPage, QueryExecutionPage } from "./pages";
import type { Draft } from "./widgets";

export interface SettingsDialogProps {
  initialPage: string;
  onPage: (id: string) => void;
  onClose: () => void;
  register: (open: (id: string) => void) => void;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const [values, setValues] = createStore<Settings>({ ...settings });
  const [theme, setTheme] = createSignal<ThemePref>(themePref());
  const [query, setQuery] = createSignal("");
  const [page, setPage] = createSignal(findNode(props.initialPage) ? props.initialPage : "appearance");
  const [hist, setHist] = createSignal<{ stack: string[]; at: number }>({ stack: [page()], at: 0 });
  const [open, setOpen] = createSignal<Set<string>>(new Set(pathOf(page())?.slice(0, -1).map((n) => n.id) ?? []));

  const draft: Draft = {
    values,
    set: (k, v) => setValues(k, v as never),
    theme,
    setTheme,
    query,
  };

  const dirty = createMemo(() => {
    if (theme() !== themePref()) return true;
    const cur = settings as Settings;
    return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).some((k) => values[k] !== cur[k]);
  });

  const apply = () => {
    const patch: Partial<Settings> = {};
    const v = unwrap(values);
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) if (v[k] !== settings[k]) (patch as Record<string, unknown>)[k] = v[k];
    if (Object.keys(patch).length) updateSettings(patch);
    if (theme() !== themePref()) setThemePref(theme());
  };
  const ok = () => {
    apply();
    props.onClose();
  };

  // ---- navigation (page, history, tree expansion)
  const searching = () => query().trim().length > 0;
  const tree = createMemo(() => filterTree(query()));
  const rows = createMemo(() => visibleRows(tree(), (id) => searching() || open().has(id)));

  const reveal = (id: string) => {
    const anc = pathOf(id)?.slice(0, -1).map((n) => n.id) ?? [];
    if (anc.length) setOpen(new Set([...open(), ...anc]));
  };
  const select = (id: string, push = true) => {
    if (!findNode(id)) return;
    setPage(id);
    reveal(id);
    props.onPage(id);
    if (push && hist().stack[hist().at] !== id) {
      const h = hist();
      setHist({ stack: [...h.stack.slice(0, h.at + 1), id], at: h.at + 1 });
    }
    queueMicrotask(() => document.querySelector(".st-tree-row.st-selected")?.scrollIntoView({ block: "nearest" }));
  };
  const go = (delta: number) => {
    const h = hist();
    const at = h.at + delta;
    if (at < 0 || at >= h.stack.length) return;
    setHist({ ...h, at });
    select(h.stack[at], false);
  };

  // searching selects the first matching page, like DataGrip
  createEffect(
    on(query, (q) => {
      if (!q.trim()) return;
      const t = tree();
      const ids = new Set(visibleRows(t, () => true).map((r) => r.node.id));
      if (!ids.has(page())) {
        const f = firstLeaf(t);
        if (f) select(f.id);
      }
    }),
  );

  props.register((id) => select(id));

  const toggle = (id: string) => {
    if (searching()) return;
    const s = new Set(open());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setOpen(s);
  };

  const onTreeKey = (e: KeyboardEvent) => {
    const list = rows();
    const i = list.findIndex((r) => r.node.id === page());
    const cur = list[i];
    if (e.key === "ArrowDown" && i < list.length - 1) select(list[i + 1].node.id);
    else if (e.key === "ArrowUp" && i > 0) select(list[i - 1].node.id);
    else if (e.key === "Home") select(list[0].node.id);
    else if (e.key === "End") select(list[list.length - 1].node.id);
    else if (e.key === "ArrowRight" && cur?.hasChildren) {
      if (!cur.expanded) toggle(cur.node.id);
      else select(list[i + 1].node.id);
    } else if (e.key === "ArrowLeft" && cur) {
      if (cur.hasChildren && cur.expanded && !searching()) toggle(cur.node.id);
      else {
        const parent = pathOf(cur.node.id)?.slice(-2, -1)[0];
        if (parent) select(parent.id);
      }
    } else return;
    e.preventDefault();
  };

  const crumbs = () => pathOf(page()) ?? [];
  const node = () => findNode(page());

  return (
    <Dialog
      title="Settings"
      width={900}
      height={740}
      flush
      onClose={props.onClose}
      buttons={[
        { label: "OK", primary: true, run: ok },
        { label: "Cancel", run: props.onClose },
        { label: "Apply", disabled: !dirty(), run: apply },
      ]}
    >
      <div class="st-dialog">
        <div class="st-left">
          <div class="st-search">
            <TextField
              value={query()}
              onInput={setQuery}
              prefix={<Icon name="search" />}
              aria-label="Search settings"
              data-autofocus
              suffix={
                <Show when={query()}>
                  <button type="button" class="st-clear" aria-label="Clear" onClick={() => setQuery("")}>
                    <Icon name="close-small" />
                  </button>
                </Show>
              }
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  document.querySelector<HTMLElement>(".st-tree")?.focus();
                }
              }}
            />
          </div>
          <div class="st-tree" role="tree" tabindex={0} onKeyDown={onTreeKey}>
            <For each={rows()} fallback={<div class="st-tree-empty">Nothing found</div>}>
              {(r) => (
                <div
                  class="st-tree-row"
                  classList={{ "st-selected": r.node.id === page(), "st-top": r.depth === 0 }}
                  style={{ "padding-left": 12 + r.depth * 16 + "px" }}
                  role="treeitem"
                  aria-selected={r.node.id === page()}
                  aria-expanded={r.hasChildren ? r.expanded : undefined}
                  data-page={r.node.id}
                  onClick={() => select(r.node.id)}
                >
                  <span
                    class="st-tree-chevron"
                    onClick={(e) => {
                      if (!r.hasChildren) return;
                      e.stopPropagation();
                      toggle(r.node.id);
                    }}
                  >
                    <Show when={r.hasChildren}>
                      <Icon name={r.expanded ? "chevron-down" : "chevron-right"} />
                    </Show>
                  </span>
                  <span class="st-tree-title">
                    <Highlighted text={r.node.title} query={query()} />
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="st-right">
          <div class="st-header">
            <div class="st-crumbs">
              <For each={crumbs()}>
                {(c, i) => (
                  <>
                    <Show when={i() > 0}>
                      <span class="st-crumb-sep">
                        <Icon name="chevron-right" />
                      </span>
                    </Show>
                    <span class="st-crumb">{c.title}</span>
                  </>
                )}
              </For>
            </div>
            <button type="button" class="st-nav" aria-label="Back" disabled={hist().at === 0} onClick={() => go(-1)}>
              <Icon name="chevron-left" />
            </button>
            <button type="button" class="st-nav" aria-label="Forward" disabled={hist().at >= hist().stack.length - 1} onClick={() => go(1)}>
              <Icon name="chevron-right" />
            </button>
          </div>
          <div class="st-content" classList={{ "st-content-fixed": page() === "keymap" || page() === "editor.font" }}>
            <Switch fallback={<Show when={node()}>{(n) => <GroupPage node={n() as PageNode} open={(id) => select(id)} />}</Show>}>
              <Match when={page() === "appearance"}>
                <AppearancePage draft={draft} />
              </Match>
              <Match when={page() === "editor.font"}>
                <EditorFontPage draft={draft} />
              </Match>
              <Match when={page() === "editor.general.appearance"}>
                <EditorAppearancePage draft={draft} />
              </Match>
              <Match when={page() === "database.query-execution"}>
                <QueryExecutionPage draft={draft} />
              </Match>
              <Match when={page() === "database.data-editor"}>
                <DataEditorPage draft={draft} />
              </Match>
              <Match when={page() === "keymap"}>
                <KeymapPage />
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export { PAGES };
