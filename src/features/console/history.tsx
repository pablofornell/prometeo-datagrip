/** Query History popup (Ctrl+Alt+E): search + list of the executed statements of the data source, Enter inserts into the console. */
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { type HistoryEntry, historyList, historySearch } from "../../api/db";
import { Icon } from "../../components/ui";
import { isInternalSql, logTimestamp } from "../output/format";
import type { ConsoleSession } from "./session";

let open = false;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const when = (ms: number): string => logTimestamp(ms).slice(1, 20);

function History(props: { session: ConsoleSession; onClose: () => void }): JSX.Element {
  const [items, setItems] = createSignal<HistoryEntry[]>([]);
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  let seq = 0;

  const load = async () => {
    const my = ++seq;
    const q = query().trim();
    try {
      const r = q ? await historySearch(q, props.session.dsId, 300) : await historyList(props.session.dsId, 0, 300);
      if (my !== seq) return;
      setItems(r.filter((e) => !isInternalSql(e.sql)));
      setSel(0);
    } catch {
      if (my === seq) setItems([]);
    }
  };
  onMount(() => {
    input.focus();
    void load();
  });

  const insert = (e: HistoryEntry | undefined) => {
    if (!e) return;
    props.onClose();
    const v = props.session.editor?.view;
    if (!v) return;
    const doc = v.state.doc;
    const sep = doc.length === 0 ? "" : doc.sliceString(doc.length - 1) === "\n" ? "\n" : "\n\n";
    const text = e.sql.trim().replace(/;?$/, ";");
    v.dispatch({ changes: { from: doc.length, insert: sep + text + "\n" }, selection: { anchor: doc.length + sep.length + text.length } });
    v.focus();
  };

  const move = (d: number) => {
    const n = items().length;
    if (!n) return;
    const i = (sel() + d + n) % n;
    setSel(i);
    list.querySelectorAll<HTMLElement>(".dgc-h-row")[i]?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), props.onClose());
    else if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Enter") (e.preventDefault(), insert(items()[sel()]));
  };

  return (
    <div class="dgc-h-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dgc-h" onKeyDown={onKey}>
        <div class="dgc-h-title">Query History</div>
        <div class="dgc-h-search">
          <Icon name="search" size={16} />
          <input
            ref={input}
            placeholder="Search"
            spellcheck={false}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              void load();
            }}
          />
        </div>
        <div class="dgc-h-list" ref={list}>
          <Show when={items().length} fallback={<div class="dgc-h-empty">{query() ? "Nothing found" : "No query history"}</div>}>
            <For each={items()}>
              {(e, i) => (
                <div class="dgc-h-row" classList={{ sel: i() === sel(), err: !e.ok }} onMouseMove={() => setSel(i())} onDblClick={() => insert(e)} onClick={() => setSel(i())}>
                  <span class="dgc-h-time">{when(e.tsMs)}</span>
                  <span class="dgc-h-sql">{oneLine(e.sql)}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
        <Show when={items()[sel()]}>
          {(e) => (
            <div class="dgc-h-preview">
              <pre>{e().sql.trim()}</pre>
              <div class="dgc-h-meta">
                {e().ok ? "" : "Failed. "}
                {e().durationMs != null ? `${e().durationMs} ms` : ""}
                {e().rows != null ? `, ${e().rows} rows` : ""}
              </div>
            </div>
          )}
        </Show>
        <div class="dgc-h-foot">Press Enter to insert into the console, Esc to close</div>
      </div>
    </div>
  );
}

export function openHistory(session: ConsoleSession): void {
  if (open) return;
  open = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const prev = document.activeElement as HTMLElement | null;
  const dispose = render(
    () => {
      onCleanup(() => prev?.focus?.({ preventScroll: true }));
      return (
        <History
          session={session}
          onClose={() => {
            open = false;
            queueMicrotask(() => {
              dispose();
              host.remove();
            });
          }}
        />
      );
    },
    host,
  );
}
