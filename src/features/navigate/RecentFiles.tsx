/**
 * Recent Files (Ctrl+E) and the Switcher (Ctrl+Tab): one popup listing the tool windows (left) and the recently used
 * editor tabs in most-recently-activated order, including recently closed ones (right). The second entry is preselected,
 * so Ctrl+E, Enter jumps back to the previous tab. In Switcher mode the popup lives while Ctrl is held: Tab / Shift+Tab move,
 * releasing Ctrl opens the selection.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { referenceOf } from "../../components/shell/tabMenu";
import { Checkbox, Icon } from "../../components/ui";
import { Highlighted, matchRanges } from "../../components/ui/SpeedSearch";
import { runAction } from "../../state/actions";
import { TOOL_WINDOWS } from "../../state/layout";
import { type EditorTab, activateTab, closedTabList, recentTabs, reopenClosedById, splitTab } from "../../state/tabs";

export type RecentMode = "recent" | "switch";

interface Entry {
  tab: EditorTab;
  closed: boolean;
}

/** Open tabs by recent use, then the recently closed ones. */
export function recentEntries(): Entry[] {
  const open = recentTabs();
  const ids = new Set(open.map((t) => t.id));
  return [...open.map((tab) => ({ tab, closed: false })), ...closedTabList().filter((t) => !ids.has(t.id)).map((tab) => ({ tab, closed: true }))];
}

const [openMode, setOpenMode] = createSignal<RecentMode | null>(null);
let host: HTMLDivElement | undefined;
let dispose: (() => void) | undefined;
let prevFocus: HTMLElement | null = null;

export function openRecentFiles(mode: RecentMode = "recent", reverse = false): void {
  if (openMode()) return; // repeated shortcuts are handled by the open popup itself (capturing key listener)
  prevFocus = document.activeElement as HTMLElement | null;
  setOpenMode(mode);
  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <RecentFiles mode={mode} reverse={reverse} />, host);
}

function close(restoreFocus: boolean): void {
  if (!openMode()) return;
  setOpenMode(null);
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

function RecentFiles(props: { mode: RecentMode; reverse: boolean }): JSX.Element {
  const [edited, setEdited] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [col, setCol] = createSignal<"files" | "tools">("files");
  const entries = recentEntries();
  const files = createMemo(() =>
    entries.filter((e) => (!edited() || (!e.closed && e.tab.modified)) && (!query() || matchRanges(e.tab.title, query()))),
  );
  const tools = createMemo(() => TOOL_WINDOWS.filter((t) => !query() || matchRanges(t.title, query())));
  const [fi, setFi] = createSignal(props.reverse ? entries.length - 1 : Math.min(1, entries.length - 1));
  const [ti, setTi] = createSignal(0);
  let listEl!: HTMLDivElement;

  const selected = () => (col() === "files" ? files()[fi()] : undefined);
  const move = (d: number) => {
    const n = col() === "files" ? files().length : tools().length;
    if (!n) return;
    const set = col() === "files" ? setFi : setTi;
    set((i) => (Math.max(0, Math.min(i, n - 1)) + d + n) % n);
    queueMicrotask(() => listEl?.querySelector(".dgrf-sel")?.scrollIntoView({ block: "nearest" }));
  };
  const clampSel = () => {
    setFi((i) => Math.max(0, Math.min(i, files().length - 1)));
    setTi((i) => Math.max(0, Math.min(i, tools().length - 1)));
  };

  const open = (split = false) => {
    if (col() === "tools") {
      const t = tools()[ti()];
      close(false);
      if (t) void runAction("toolwindow." + t.id);
      return;
    }
    const e = files()[fi()];
    close(false);
    if (!e) return;
    if (e.closed) reopenClosedById(e.tab.id);
    else activateTab(e.tab.id);
    if (split) splitTab(e.tab.id, "right");
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const handled = () => (e.preventDefault(), e.stopPropagation(), true);
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return;
      if (e.key === "Escape") return void (handled(), close(true));
      if (e.key === "Enter") return void (handled(), open(e.shiftKey));
      if (e.key === "ArrowDown") return void (handled(), move(1));
      if (e.key === "ArrowUp") return void (handled(), move(-1));
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") return void (handled(), setCol((c) => (c === "files" ? "tools" : "files")));
      if (e.key === "Tab") return void (handled(), move(e.shiftKey ? -1 : 1));
      if (e.ctrlKey && !e.altKey && e.code === "KeyE") return void (handled(), setEdited((v) => !v), clampSel());
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Backspace") return void (handled(), setQuery((q) => q.slice(0, -1)), clampSel());
      if (e.key.length === 1) return void (handled(), setQuery((q) => q + e.key), setFi(0), setTi(0), clampSel());
    };
    const onUp = (e: KeyboardEvent) => {
      if (props.mode === "switch" && e.key === "Control") open();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
    });
  });

  return (
    <div
      class="dgrf-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(true);
      }}
    >
      <div class="dgrf-popup" role="dialog" aria-label={props.mode === "switch" ? "Switcher" : "Recent Files"}>
        <div class="dgrf-header">
          <span class="dgrf-title">{props.mode === "switch" ? "Switcher" : "Recent Files"}</span>
          <Show when={query()}>
            <span class="dgrf-query">{query()}</span>
          </Show>
          <span class="dgrf-edited">
            <Checkbox checked={edited()} onChange={(v) => (setEdited(v), clampSel())} label="Show edited only" />
            <span class="dgrf-key">Ctrl+E</span>
          </span>
        </div>
        <div class="dgrf-cols" ref={listEl}>
          <div class="dgrf-tools" classList={{ "dgrf-colactive": col() === "tools" }}>
            <For each={tools()}>
              {(t, i) => (
                <div
                  class="dgrf-row"
                  classList={{ "dgrf-sel": col() === "tools" && i() === ti() }}
                  onMouseMove={() => (setCol("tools"), setTi(i()))}
                  onClick={() => open()}
                >
                  <Icon name={t.menuIcon ?? t.icon.replace("@20x20", "")} class="dgrf-ico" />
                  <span class="dgrf-name">
                    <Highlighted text={t.title} query={query()} />
                  </span>
                  <Show when={t.shortcut}>
                    <span class="dgrf-key">{t.shortcut}</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <div class="dgrf-files" classList={{ "dgrf-colactive": col() === "files" }}>
            <For each={files()} fallback={<div class="dgrf-empty">{edited() ? "No edited files" : "No recent files"}</div>}>
              {(e, i) => (
                <div
                  class="dgrf-row"
                  classList={{ "dgrf-sel": col() === "files" && i() === fi(), "dgrf-closed": e.closed }}
                  onMouseMove={() => (setCol("files"), setFi(i()))}
                  onClick={() => open()}
                >
                  <Icon name={e.tab.icon ?? "dg/console"} class="dgrf-ico" />
                  <span class="dgrf-name">
                    <Highlighted text={e.tab.title} query={query()} />
                  </span>
                  <span class="dgrf-loc">{referenceOf(e.tab)}</span>
                  <Show when={col() === "files" && i() === fi()}>
                    <span
                      class="dgrf-split"
                      title="Open in Right Split (Shift+Enter)"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        open(true);
                      }}
                    >
                      <Icon name="split-vertically" />
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="dgrf-footer">{selected() ? referenceOf(selected()!.tab) : ""}</div>
      </div>
    </div>
  );
}
