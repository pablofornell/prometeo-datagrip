/** Keymap page: a read-only, searchable tree of the registered actions with their shortcuts (DataGrip's look). */
import { For, Show, createMemo, createSignal } from "solid-js";
import { Highlighted, Icon, TextField, hasIcon } from "../../components/ui";
import { collectKeymap, filterKeymap } from "./keymap";

export function KeymapPage() {
  const all = createMemo(collectKeymap);
  const [filter, setFilter] = createSignal("");
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const groups = createMemo(() => filterKeymap(all(), filter()));
  const searching = () => filter().trim().length > 0;
  const isOpen = (name: string) => searching() || !collapsed().has(name);
  const toggle = (name: string) => {
    const s = new Set(collapsed());
    if (s.has(name)) s.delete(name);
    else s.add(name);
    setCollapsed(s);
  };

  return (
    <div class="st-page st-keymap">
      <div class="st-keymap-head">
        <span class="st-keymap-name">Keymap: XWin</span>
        <span class="st-hint-inline">read-only</span>
      </div>
      <div class="st-keymap-toolbar">
        <button type="button" class="st-tool" title="Expand All" onClick={() => setCollapsed(new Set())}>
          <Icon name="expand-all" />
        </button>
        <button type="button" class="st-tool" title="Collapse All" onClick={() => setCollapsed(new Set(all().map((g) => g.name)))}>
          <Icon name="collapse-all" />
        </button>
        <span class="st-fill" />
        <TextField
          frameClass="st-keymap-search"
          value={filter()}
          onInput={setFilter}
          prefix={<Icon name="search" />}
          placeholder=""
          aria-label="Search actions and shortcuts"
          suffix={
            <Show when={filter()}>
              <button type="button" class="st-clear" aria-label="Clear" onClick={() => setFilter("")}>
                <Icon name="close-small" />
              </button>
            </Show>
          }
        />
      </div>
      <div class="st-keymap-tree" role="tree">
        <For each={groups()} fallback={<div class="st-keymap-empty">No actions match “{filter()}”</div>}>
          {(g) => (
            <>
              <div class="st-km-row st-km-group" role="treeitem" aria-expanded={isOpen(g.name)} onClick={() => toggle(g.name)}>
                <span class="st-km-chevron">
                  <Icon name={isOpen(g.name) ? "chevron-down" : "chevron-right"} />
                </span>
                <Icon name="folder" />
                <span class="st-km-title">{g.name}</span>
              </div>
              <Show when={isOpen(g.name)}>
                <For each={g.actions}>
                  {(a) => (
                    <div class="st-km-row st-km-action" role="treeitem" data-action={a.id}>
                      <span class="st-km-icon">{a.icon && hasIcon(a.icon) ? <Icon name={a.icon} /> : null}</span>
                      <span class="st-km-title">
                        <Highlighted text={a.title} query={filter()} />
                      </span>
                      <span class="st-km-keys">
                        <For each={a.shortcuts}>
                          {(sc, i) => (
                            <>
                              <Show when={i() > 0}>
                                <span class="st-km-or">or</span>
                              </Show>
                              <For each={sc}>{(k) => <kbd class="st-key">{k}</kbd>}</For>
                            </>
                          )}
                        </For>
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </>
          )}
        </For>
      </div>
    </div>
  );
}
