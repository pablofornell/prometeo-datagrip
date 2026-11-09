/**
 * Find Usages popup (Alt+F7): the objects that refer to a table, view, routine, column or synonym, grouped by kind,
 * then the lines of the SQL texts (consoles, scratch and opened files) that name it. Enter or a double click opens the
 * DDL of a usage, or the console / file of a line. Escape closes it.
 */
import { For, Show, createMemo, createResource, createSignal, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { findUsages, type Usage } from "../../api/db";
import { Icon } from "../../components/ui";
import { ensureConnected } from "../explorer";
import { NodeIcon } from "../explorer/NodeIcon";
import { type ExplorerKind, iconOf } from "../explorer/model";
import { groupUsages, searchSqlText, type TextHit } from "./model";
import { gatherSqlTexts } from "./sqlTexts";
import { type UsageRequest, openHit, openUsage } from "./find";
import "./usages.css";

type Row = { type: "group"; label: string; count: number } | { type: "usage"; usage: Usage } | { type: "hit"; hit: TextHit };

let host: HTMLDivElement | undefined;
let dispose: (() => void) | undefined;
let prevFocus: HTMLElement | null = null;

/** Opens the popup for `req`; one popup at a time (a new request replaces the open one). */
export function openFindPopup(req: UsageRequest): void {
  if (dispose) {
    // replacing: the focus that came before the first popup is still the one to give back
    const d = dispose;
    const h = host;
    dispose = undefined;
    host = undefined;
    queueMicrotask(() => {
      d();
      h?.remove();
    });
  } else prevFocus = document.activeElement as HTMLElement | null;
  host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <FindPopup req={req} onClose={() => closeFindPopup()} />, host);
}

function closeFindPopup(restoreFocus = true): void {
  const d = dispose;
  const h = host;
  const f = prevFocus;
  dispose = undefined;
  host = undefined;
  prevFocus = null;
  queueMicrotask(() => {
    d?.();
    h?.remove();
    if (restoreFocus) f?.focus?.({ preventScroll: true });
  });
}

const iconKind = (k: Usage["kind"]): ExplorerKind => (k === "packageBody" ? "package" : (k as ExplorerKind));

function FindPopup(props: { req: UsageRequest; onClose: () => void }): JSX.Element {
  const object = props.req.object;
  const label = object.schema ? `${object.schema}.${object.name}` : object.name;
  const [found] = createResource(() => props.req, async (r) => {
    await ensureConnected(r.dsId);
    return findUsages(r.dsId, r.object);
  });
  const [texts] = createResource(() => props.req, () => gatherSqlTexts());
  const [sel, setSel] = createSignal(0);
  let list!: HTMLDivElement;

  const groups = createMemo(() => groupUsages(found() ?? []));
  const hits = createMemo(() => (texts() ? searchSqlText(texts()!, object.name) : []));
  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groups()) {
      out.push({ type: "group", label: g.label, count: g.items.length });
      for (const usage of g.items) out.push({ type: "usage", usage });
    }
    if (hits().length) {
      out.push({ type: "group", label: "In SQL files", count: hits().length });
      for (const hit of hits()) out.push({ type: "hit", hit });
    }
    return out;
  });
  const selectable = createMemo<Row[]>(() => rows().filter((r) => r.type !== "group"));
  const current = () => selectable()[sel()];

  const move = (d: number) => {
    const n = selectable().length;
    if (!n) return;
    const i = Math.min(n - 1, Math.max(0, sel() + d));
    setSel(i);
    list.querySelectorAll<HTMLElement>(".dgn-row")[i]?.scrollIntoView({ block: "nearest" });
  };

  const activate = (r: Row | undefined) => {
    if (!r || r.type === "group") return;
    props.onClose();
    // the popup gives the focus back first: the DDL / editor tab takes it afterwards
    setTimeout(() => {
      if (r.type === "usage") void openUsage(props.req.dsId, r.usage);
      else openHit(r.hit);
    }, 0);
  };

  const onKey = (e: KeyboardEvent) => {
    const stop = () => (e.preventDefault(), e.stopPropagation());
    switch (e.key) {
      case "Escape":
        return stop(), props.onClose();
      case "ArrowDown":
        return stop(), move(1);
      case "ArrowUp":
        return stop(), move(-1);
      case "PageDown":
        return stop(), move(10);
      case "PageUp":
        return stop(), move(-10);
      case "Enter":
        return stop(), activate(current());
    }
  };

  onMount(() => list.focus());

  const footer = () => {
    const r = current();
    if (!r || r.type === "group") return "";
    return r.type === "usage" ? r.usage.detail : (r.hit.path ?? r.hit.name);
  };

  return (
    <div class="dgn-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dgn-popup dgu-popup" role="dialog" aria-label="Find Usages" onKeyDown={onKey}>
        <div class="dgn-header dgu-header">
          <Icon name="search" />
          <span class="dgu-title">Usages of {label}</span>
        </div>
        <div class="dgn-list dgu-list" ref={list} tabindex={-1}>
          <Show when={found.error}>
            <div class="dgn-empty dgu-error">{String((found.error as Error)?.message ?? found.error)}</div>
          </Show>
          <Show when={!found.loading && !found.error && rows().length === 0}>
            <div class="dgn-empty">No usages found</div>
          </Show>
          <Show when={found.loading}>
            <div class="dgn-empty">Searching…</div>
          </Show>
          <For each={rows()}>
            {(r) => {
              if (r.type === "group") {
                return (
                  <div class="dgu-group">
                    {r.label} <span class="dgu-count">{r.count}</span>
                  </div>
                );
              }
              const i = () => selectable().indexOf(r);
              return r.type === "usage" ? (
                <div class="dgn-row" classList={{ "dgn-sel": i() === sel() }} onClick={() => setSel(i())} onDblClick={() => activate(r)} onMouseMove={() => i() !== sel() && setSel(i())}>
                  <span class="dgn-ico">
                    <NodeIcon name={iconOf(iconKind(r.usage.kind))} />
                  </span>
                  <span class="dgn-name">{r.usage.schema ? `${r.usage.schema}.${r.usage.name}` : r.usage.name}</span>
                  <span class="dgn-loc">{r.usage.detail}</span>
                  <Show when={r.usage.line !== null}>
                    <span class="dgn-right">:{r.usage.line}</span>
                  </Show>
                </div>
              ) : (
                <div class="dgn-row dgu-hit" classList={{ "dgn-sel": i() === sel() }} onClick={() => setSel(i())} onDblClick={() => activate(r)} onMouseMove={() => i() !== sel() && setSel(i())}>
                  <span class="dgn-ico">
                    <NodeIcon name={r.hit.console ? "dg/console" : "sql-file"} />
                  </span>
                  <span class="dgn-name">{r.hit.name}</span>
                  <span class="dgn-loc">{r.hit.text}</span>
                  <span class="dgn-right">:{r.hit.line}</span>
                </div>
              );
            }}
          </For>
        </div>
        <div class="dgn-footer">
          <span class="dgn-path">{footer()}</span>
          <a class="dgn-link" onMouseDown={(ev) => ev.preventDefault()} onClick={() => activate(current())}>
            Open
          </a>
        </div>
      </div>
    </div>
  );
}
