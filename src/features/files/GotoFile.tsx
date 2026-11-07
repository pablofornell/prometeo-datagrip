/** Navigate | File… (Ctrl+Shift+N): jump to a scratch, an opened file, a console or a file of an attached folder. */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { type FileInfo, fileRoots, listConsoles, listDir, listScratches } from "../../api/db";
import { Icon } from "../../components/ui";
import { explorerDataSources } from "../explorer";
import { openConsoleTab } from "../explorer/commands";
import { match } from "../navigate/match";
import { dsIconUrl } from "../output/dsicon";
import { openFileTab } from "./docs";

interface Entry {
  name: string;
  /** Where it lives, shown right of the name. */
  where: string;
  icon: string | undefined;
  open: () => void;
}

const MAX_SCAN = 1500;
const MAX_DEPTH = 4;

/** Every file the popup offers. Folders are scanned a few levels deep (capped). */
async function collect(): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const s of await listScratches().catch(() => [] as FileInfo[])) out.push({ name: s.name, where: "Scratches", icon: "sql-file", open: () => openFileTab(s, true) });
  const roots = await fileRoots().catch(() => ({ files: [] as FileInfo[], folders: [] as FileInfo[] }));
  for (const f of roots.files) out.push({ name: f.name, where: f.path, icon: "sql-file", open: () => openFileTab(f, false) });
  for (const d of explorerDataSources()) {
    for (const n of await listConsoles(d.id).catch(() => [] as string[])) out.push({ name: `${n}.sql`, where: `Database Consoles/${d.name}`, icon: dsIconUrl(d.driver) ?? "dg/console", open: () => openConsoleTab(d.id, n) });
  }
  let scanned = 0;
  const walk = async (dir: FileInfo, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || scanned > MAX_SCAN) return;
    for (const e of await listDir(dir.path).catch(() => [] as FileInfo[])) {
      scanned++;
      if (e.isDir) await walk(e, depth + 1);
      else out.push({ name: e.name, where: e.path.slice(0, e.path.lastIndexOf("/")), icon: "sql-file", open: () => openFileTab(e, false) });
    }
  };
  for (const f of roots.folders) await walk(f, 0);
  return out;
}

function GotoFilePopup(props: { close: () => void }): JSX.Element {
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const hits = createMemo(() => {
    const q = query().trim();
    const all = entries();
    if (!q) return all.slice(0, 200);
    return all
      .map((e) => ({ e, m: match(e.name, q, false) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .map((x) => x.e)
      .slice(0, 200);
  });
  onMount(() => {
    input.focus();
    void collect().then(setEntries);
  });
  onCleanup(() => undefined);
  const go = (e: Entry | undefined) => {
    if (!e) return;
    props.close();
    setTimeout(e.open, 0);
  };
  const move = (d: number) => {
    const n = hits().length;
    if (!n) return;
    const i = (sel() + d + n) % n;
    setSel(i);
    list.querySelectorAll<HTMLElement>(".dgn-row")[i]?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    const stop = () => (e.preventDefault(), e.stopPropagation());
    if (e.key === "Escape") return stop(), props.close();
    if (e.key === "ArrowDown") return stop(), move(1);
    if (e.key === "ArrowUp") return stop(), move(-1);
    if (e.key === "Enter") return stop(), go(hits()[sel()]);
  };
  return (
    <div class="dgn-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.close()}>
      <div class="dgn-popup dgf-goto" role="dialog" onKeyDown={onKey}>
        <div class="dgn-header">
          <button type="button" class="dgn-tab dgn-on" tabindex={-1}>
            Files
          </button>
        </div>
        <div class="dgn-field">
          <input
            ref={input}
            spellcheck={false}
            autocomplete="off"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setSel(0);
            }}
          />
        </div>
        <div class="dgn-list" ref={list}>
          <Show when={hits().length === 0 && query().trim()}>
            <div class="dgn-empty">Nothing found</div>
          </Show>
          <For each={hits()}>
            {(e, i) => (
              <div class="dgn-row" classList={{ "dgn-sel": i() === sel() }} onClick={() => go(e)} onMouseMove={() => sel() !== i() && setSel(i())}>
                <span class="dgn-ico">
                  <Show when={e.icon}>{(n) => <Icon name={n()} />}</Show>
                </span>
                <span class="dgn-name">{e.name}</span>
                <span class="dgn-loc">{e.where}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

let open = false;
export function openGotoFile(): void {
  if (open) return;
  open = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <GotoFilePopup
        close={() => {
          dispose();
          host.remove();
          open = false;
        }}
      />
    ),
    host,
  );
}
