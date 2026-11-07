/**
 * Keymap page: the registered actions in DataGrip's folders with their shortcuts as key caps. Shortcuts are editable
 * (double-click or the row menu: Add Keyboard Shortcut with a conflicts check, Remove, Reset Shortcuts); the edits
 * live in the dialog's draft (`keymapOverrides`) and are applied by OK / Apply. Changed actions are shown in blue.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import { Dialog, Highlighted, Icon, TextField, hasIcon, openMenu } from "../../components/ui";
import type { MenuItem } from "../../components/ui";
import {
  type KeymapAction,
  type KeymapGroup,
  addShortcut,
  chordFromEvent,
  collectKeymap,
  filterByShortcut,
  filterKeymap,
  findConflicts,
  normalizeShortcut,
  removeShortcut,
  resetShortcuts,
} from "./keymap";
import { keyCaps } from "./keymap-util";
import type { Draft } from "./widgets";

type Row = { kind: "group"; g: KeymapGroup; depth: number } | { kind: "action"; a: KeymapAction; depth: number };

const display = (sc: string) => keyCaps(sc).join("+");

function KeyCaps(props: { shortcuts: string[][] }) {
  return (
    <For each={props.shortcuts}>
      {(sc, i) => (
        <>
          <Show when={i() > 0}>
            <span class="st-km-or">or</span>
          </Show>
          <For each={sc}>{(k) => <kbd class="st-key">{k}</kbd>}</For>
        </>
      )}
    </For>
  );
}

/** "Add Keyboard Shortcut": records one key combination, shows who already uses it. */
function AddShortcutDialog(props: { action: KeymapAction; conflicts: (sc: string) => KeymapAction[]; onClose: () => void; onAdd: (sc: string, takeFrom: string[]) => void }) {
  const [sc, setSc] = createSignal<string | null>(null);
  const [asking, setAsking] = createSignal(false);
  const conflicts = () => (sc() ? props.conflicts(sc()!) : []);
  const names = () => conflicts().map((a) => a.title).join(", ");
  const commit = (remove: boolean) => {
    props.onAdd(sc()!, remove ? conflicts().map((a) => a.id) : []);
    props.onClose();
  };
  const ok = () => {
    if (!sc()) return;
    if (conflicts().length) setAsking(true);
    else commit(false);
  };
  return (
    <>
      <Dialog
        title="Add Keyboard Shortcut"
        width={440}
        onClose={props.onClose}
        buttons={[
          { label: "OK", primary: true, disabled: !sc() || asking(), run: ok },
          { label: "Cancel", run: props.onClose },
        ]}
      >
        <div class="st-addsc">
          <div class="st-addsc-for">
            Action: <b>{props.action.title}</b>
          </div>
          <div
            class="st-capture"
            classList={{ "st-capture-empty": !sc() }}
            tabindex={0}
            data-autofocus
            aria-label="Shortcut"
            onKeyDown={(e) => {
              const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
              if (plain && (e.key === "Escape" || e.key === "Enter" || e.key === "Tab")) return; // dialog keys
              e.preventDefault();
              e.stopPropagation();
              const c = chordFromEvent(e);
              if (c) setSc(c);
            }}
          >
            <Show when={sc()} fallback="Press the shortcut keys">
              <For each={keyCaps(sc()!)}>{(k) => <kbd class="st-key">{k}</kbd>}</For>
            </Show>
          </div>
          <div class="st-addsc-conflict" classList={{ "st-addsc-none": conflicts().length === 0 }}>
            <Show when={conflicts().length > 0}>The shortcut is already assigned to: {names()}</Show>
          </div>
        </div>
      </Dialog>
      <Show when={asking()}>
        <Dialog
          title="Conflicts"
          width={460}
          onClose={() => setAsking(false)}
          buttons={[
            { label: "Remove", primary: true, run: () => commit(true) },
            { label: "Leave", run: () => commit(false) },
            { label: "Cancel", run: () => setAsking(false) },
          ]}
        >
          <div class="st-conflict-text">
            The shortcut <b>{sc() ? display(sc()!) : ""}</b> is already assigned to {conflicts().length === 1 ? "the action" : "the actions"}: <b>{names()}</b>.
            <br />
            Do you want to remove the other assignments?
          </div>
        </Dialog>
      </Show>
    </>
  );
}

export function KeymapPage(props: { draft: Draft }) {
  const edits = () => props.draft.values.keymapOverrides;
  const all = createMemo(() => collectKeymap(edits()));
  const [filter, setFilter] = createSignal("");
  const [byKey, setByKey] = createSignal<string | null>(null);
  const [recording, setRecording] = createSignal(false);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [selected, setSelected] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal<KeymapAction | null>(null);

  const groups = createMemo(() => (byKey() ? filterByShortcut(all(), byKey()!) : filterKeymap(all(), filter())));
  const searching = () => filter().trim().length > 0 || byKey() !== null;
  const isOpen = (path: string) => searching() || expanded().has(path);
  const toggle = (path: string) => {
    const s = new Set(expanded());
    if (s.has(path)) s.delete(path);
    else s.add(path);
    setExpanded(s);
  };
  const paths = (gs: KeymapGroup[]): string[] => gs.flatMap((g) => [g.path, ...paths(g.children)]);

  const rows = createMemo(() => {
    const out: Row[] = [];
    const walk = (gs: KeymapGroup[], depth: number) => {
      for (const g of gs) {
        out.push({ kind: "group", g, depth });
        if (!isOpen(g.path)) continue;
        walk(g.children, depth + 1);
        for (const a of g.actions) out.push({ kind: "action", a, depth: depth + 1 });
      }
    };
    walk(groups(), 0);
    return out;
  });

  const setEdits = (next: Record<string, string[]>) => props.draft.set("keymapOverrides", next);
  const find = (id: string) => rowAction(id);
  const rowAction = (id: string): KeymapAction | undefined => {
    const w = (gs: KeymapGroup[]): KeymapAction | undefined => {
      for (const g of gs) {
        const a = g.actions.find((x) => x.id === id) ?? w(g.children);
        if (a) return a;
      }
      return undefined;
    };
    return w(all());
  };

  const menuFor = (a: KeymapAction): MenuItem[] => [
    { label: "Add Keyboard Shortcut", run: () => setAdding(a) },
    ...a.raw.map((sc): MenuItem => ({ label: `Remove ${display(sc)}`, run: () => setEdits(removeShortcut(all(), edits(), a.id, sc)) })),
    { type: "separator" },
    { label: "Reset Shortcuts", enabled: a.modified, run: () => setEdits(resetShortcuts(edits(), a.id)) },
  ];
  const openFor = (a: KeymapAction, at: { x: number; y: number } | { anchor: HTMLElement }) => {
    setSelected(a.id);
    openMenu(menuFor(a), { ...at, minWidth: 220 });
  };

  return (
    <div class="st-page st-keymap">
      <div class="st-keymap-head">
        <span class="st-keymap-combo">XWin</span>
        <button
          type="button"
          class="st-tool"
          title="Reset All Shortcuts"
          aria-label="Keymap actions"
          onClick={(e) =>
            openMenu(
              [
                {
                  label: "Reset All Shortcuts",
                  enabled: Object.keys(edits()).length > 0,
                  run: () => setEdits({}),
                },
              ],
              { anchor: e.currentTarget },
            )
          }
        >
          <Icon name="settings" />
        </button>
      </div>
      <div class="st-keymap-toolbar">
        <button type="button" class="st-tool" title="Expand All" onClick={() => setExpanded(new Set(paths(all())))}>
          <Icon name="expand-all" />
        </button>
        <button type="button" class="st-tool" title="Collapse All" onClick={() => setExpanded(new Set())}>
          <Icon name="collapse-all" />
        </button>
        <button
          type="button"
          class="st-tool"
          title="Edit Shortcut"
          disabled={!selected() || !find(selected()!)}
          onClick={(e) => {
            const a = selected() ? find(selected()!) : undefined;
            if (a) openFor(a, { anchor: e.currentTarget });
          }}
        >
          <Icon name="edit" />
        </button>
        <span class="st-fill" />
        <TextField
          frameClass="st-keymap-search"
          value={recording() ? (byKey() ? display(byKey()!) : "") : filter()}
          onInput={(v) => {
            if (!recording()) setFilter(v);
          }}
          prefix={<Icon name="search" />}
          placeholder={recording() ? "Press a shortcut" : ""}
          aria-label="Search actions and shortcuts"
          onKeyDown={(e) => {
            if (!recording()) return;
            if (e.key === "Escape") {
              setRecording(false);
              setByKey(null);
              e.stopPropagation();
              e.preventDefault();
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            const c = chordFromEvent(e);
            if (c) setByKey(normalizeShortcut(c));
          }}
          suffix={
            <Show when={filter() || byKey()}>
              <button
                type="button"
                class="st-clear"
                aria-label="Clear"
                onClick={() => {
                  setFilter("");
                  setByKey(null);
                  setRecording(false);
                }}
              >
                <Icon name="close-small" />
              </button>
            </Show>
          }
        />
        <button
          type="button"
          class="st-tool"
          classList={{ "st-tool-on": recording() }}
          title="Find Actions by Shortcut"
          aria-pressed={recording()}
          onClick={() => {
            setRecording(!recording());
            setByKey(null);
            setFilter("");
            if (!recording()) return;
            queueMicrotask(() => document.querySelector<HTMLInputElement>(".st-keymap-search input")?.focus());
          }}
        >
          <Icon name="search" />
        </button>
      </div>
      <div class="st-keymap-tree" role="tree">
        <For each={rows()} fallback={<div class="st-keymap-empty">No actions match</div>}>
          {(r) =>
            r.kind === "group" ? (
              <div
                class="st-km-row st-km-group"
                style={{ "padding-left": 4 + r.depth * 18 + "px" }}
                role="treeitem"
                aria-expanded={isOpen(r.g.path)}
                onClick={() => toggle(r.g.path)}
              >
                <span class="st-km-chevron">
                  <Icon name={isOpen(r.g.path) ? "chevron-down" : "chevron-right"} />
                </span>
                <Icon name="folder" />
                <span class="st-km-title">{r.g.name}</span>
              </div>
            ) : (
              <div
                class="st-km-row st-km-action"
                classList={{ "st-km-modified": r.a.modified, "st-km-selected": selected() === r.a.id }}
                style={{ "padding-left": 22 + r.depth * 18 + "px" }}
                role="treeitem"
                aria-selected={selected() === r.a.id}
                data-action={r.a.id}
                onClick={() => setSelected(r.a.id)}
                onDblClick={() => setAdding(r.a)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openFor(r.a, { x: e.clientX, y: e.clientY });
                }}
              >
                <span class="st-km-icon">{r.a.icon && hasIcon(r.a.icon) ? <Icon name={r.a.icon} /> : null}</span>
                <span class="st-km-title">
                  <Highlighted text={r.a.title} query={filter()} />
                </span>
                <span class="st-km-keys">
                  <KeyCaps shortcuts={r.a.shortcuts} />
                </span>
              </div>
            )
          }
        </For>
      </div>
      <Show when={adding()}>
        {(a) => (
          <AddShortcutDialog
            action={a()}
            conflicts={(sc) => findConflicts(all(), a().id, sc)}
            onClose={() => setAdding(null)}
            onAdd={(sc, takeFrom) => setEdits(addShortcut(all(), edits(), a().id, sc, takeFrom))}
          />
        )}
      </Show>
    </div>
  );
}
