/**
 * Query History (Ctrl+Alt+E): the executed statements of the data source in a two-pane dialog, the list (oldest on
 * top, the latest preselected) and a read-only preview of the selected statement. Typing filters the list (speed
 * search), Paste inserts the statement at the caret of the console.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { type HistoryEntry, historyList } from "../../api/db";
import { SqlEditor } from "../../components/editor";
import { Button, Highlighted, SpeedSearchField, createSpeedSearch, matchRanges } from "../../components/ui";
import { isInternalSql, logTimestamp } from "../output/format";
import type { ConsoleSession } from "./session";

let open = false;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const when = (ms: number): string => logTimestamp(ms).slice(1, 20);
const LIST_MIN = 90;

function History(props: { session: ConsoleSession; onClose: () => void }): JSX.Element {
  const [all, setAll] = createSignal<HistoryEntry[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [sel, setSel] = createSignal(0);
  const [listWidth, setListWidth] = createSignal(145);
  const search = createSpeedSearch(() => setSel(items().length - 1));
  let root!: HTMLDivElement;
  let list!: HTMLDivElement;

  const items = createMemo(() => {
    const q = search.query();
    return q ? all().filter((e) => !!matchRanges(oneLine(e.sql), q)) : all();
  });
  const current = (): HistoryEntry | undefined => items()[Math.min(sel(), items().length - 1)];

  onMount(() => {
    root.focus();
    void historyList(props.session.dsId, 0, 300)
      .then((r) => {
        // the backend answers newest first; the dialog lists the latest at the bottom
        const rows = r.filter((e) => !isInternalSql(e.sql)).reverse();
        setAll(rows);
        setSel(rows.length - 1);
        reveal();
      })
      .catch(() => setAll([]))
      .finally(() => setLoaded(true));
  });

  const reveal = () => queueMicrotask(() => list?.querySelector<HTMLElement>(".dgc-h-row.sel")?.scrollIntoView({ block: "nearest" }));

  const paste = (e: HistoryEntry | undefined) => {
    if (!e) return;
    props.onClose();
    props.session.insertSql(e.sql.trim().replace(/;?$/, ";"));
  };

  const move = (d: number) => {
    const n = items().length;
    if (!n) return;
    setSel(Math.min(n - 1, Math.max(0, Math.min(sel(), n - 1) + d)));
    reveal();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (search.active()) search.clear();
      else props.onClose();
    } else if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Home") (e.preventDefault(), setSel(0), reveal());
    else if (e.key === "End") (e.preventDefault(), setSel(items().length - 1), reveal());
    else if (e.key === "Enter") (e.preventDefault(), paste(current()));
    else if (e.key === "Tab") return;
    else if (search.handleKey(e)) e.preventDefault();
  };

  const startResize = (ev: PointerEvent) => {
    ev.preventDefault();
    const el = ev.currentTarget as HTMLElement;
    el.setPointerCapture(ev.pointerId);
    const x0 = ev.clientX;
    const w0 = listWidth();
    const move = (m: PointerEvent) => setListWidth(Math.max(LIST_MIN, Math.min(root.clientWidth - 160, w0 + m.clientX - x0)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const meta = (e: HistoryEntry): string =>
    [when(e.tsMs), e.ok ? "" : "Failed", e.durationMs != null ? `${e.durationMs} ms` : "", e.rows != null && e.ok ? `${e.rows} rows` : ""].filter(Boolean).join("  ·  ");

  return (
    <div class="dgc-h-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dgc-h" ref={root} tabindex={-1} role="dialog" aria-label="Query History" onKeyDown={onKey}>
        <div class="dgc-h-body">
          <div class="dgc-h-left" style={{ width: `${listWidth()}px` }}>
            <Show when={search.active()}>
              <SpeedSearchField query={search.query()} noMatch={!items().length} class="dgc-h-search" />
            </Show>
            <div class="dgc-h-list" ref={list}>
              <Show when={items().length} fallback={<div class="dgc-h-empty">{!loaded() ? "" : search.active() ? "Nothing found" : "No query history"}</div>}>
                <For each={items()}>
                  {(e, i) => (
                    <div class="dgc-h-row" classList={{ sel: i() === Math.min(sel(), items().length - 1), err: !e.ok }} onClick={() => setSel(i())} onDblClick={() => paste(e)}>
                      <span class="dgc-h-sql">
                        <Highlighted text={oneLine(e.sql)} query={search.query()} />
                      </span>
                      <span class="dgc-h-time">{when(e.tsMs)}</span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
          <div class="dgc-h-split" onPointerDown={startResize} />
          <div class="dgc-h-right">
            <div class="dgc-h-preview">
              <Show when={current()}>{(e) => <SqlEditor value={e().sql.trim()} dialect={props.session.driver} readOnly stripe={false} statementFrame={false} />}</Show>
            </div>
            <Show when={current()}>{(e) => <div class="dgc-h-meta" classList={{ err: !e().ok }} title={e().error ?? undefined}>{meta(e())}</div>}</Show>
          </div>
        </div>
        <div class="dgc-h-buttons">
          <Button primary disabled={!current()} onClick={() => paste(current())}>
            Paste
          </Button>
          <Button onClick={props.onClose}>Close</Button>
        </div>
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
