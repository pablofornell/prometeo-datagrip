/**
 * The JSON tab of the value viewer: a collapsible tree (Expand All / Collapse All, copy the path or the value of a
 * node). Read-only; the rows that are not in view are not drawn.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { writeText } from "../../editor/contextMenu";
import { containerPaths, flattenJson, valueText, type JsonRow } from "./json";
import { VALUE_ROW_PX, rowWindow } from "./window";

function Row(props: {
  row: () => JsonRow;
  top: () => number;
  open: () => boolean;
  onToggle: (path: string) => void;
}): JSX.Element {
  const r = () => props.row();
  return (
    <div
      class="dgg-vx-row dgg-vx-jrow"
      classList={{ expandable: r().expandable }}
      style={{ top: `${props.top()}px`, "padding-left": `${8 + r().depth * 14}px` }}
      onClick={() => r().expandable && props.onToggle(r().path)}
    >
      <span class="dgg-vx-jtog">{r().expandable ? (props.open() ? "▾" : "▸") : ""}</span>
      <Show when={r().label !== null}>
        <span class="dgg-vx-jkey">{r().label}</span>
        <span class="dgg-vx-jsep">: </span>
      </Show>
      <span class={`dgg-vx-jval k-${r().kind}`}>{r().summary}</span>
      <span class="dgg-vx-jacts" onClick={(e) => e.stopPropagation()}>
        <button class="dgg-vx-link" tabIndex={-1} title="Copy the path of this node" onClick={() => void writeText(r().path)}>
          Path
        </button>
        <button class="dgg-vx-link" tabIndex={-1} title="Copy the value of this node" onClick={() => void writeText(valueText(r().value))}>
          Value
        </button>
      </span>
    </div>
  );
}

export function JsonTree(props: { value: unknown }): JSX.Element {
  let scroller!: HTMLDivElement;
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(["$"]));
  const [top, setTop] = createSignal(0);
  const [view, setView] = createSignal(240);
  onMount(() => {
    setView(scroller.clientHeight || 240);
    const ro = new ResizeObserver(() => setView(scroller.clientHeight || 240));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });
  const rows = createMemo(() => flattenJson(props.value, expanded()));
  const win = createMemo(() => rowWindow(top(), view(), VALUE_ROW_PX, rows().length));
  const indices = createMemo(() => {
    const w = win();
    return Array.from({ length: w.end - w.first }, (_, k) => w.first + k);
  });

  const toggle = (path: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div class="dgg-vx-jtree">
      <div class="dgg-vx-toolbar">
        <button class="dgg-vx-link" tabIndex={-1} onClick={() => setExpanded(new Set(containerPaths(props.value)))}>
          Expand All
        </button>
        <button class="dgg-vx-link" tabIndex={-1} onClick={() => setExpanded(new Set())}>
          Collapse All
        </button>
        <span class="dgg-vx-note">{rows().length} visible</span>
      </div>
      <div class="dgg-vx-scroll" ref={scroller} onScroll={(e) => setTop(e.currentTarget.scrollTop)} tabIndex={-1}>
        <div class="dgg-vx-spacer" style={{ height: `${win().height}px` }}>
          <For each={indices()}>
            {(i) => (
              <Row
                row={() => rows()[i]}
                top={() => i * VALUE_ROW_PX - win().shift}
                open={() => expanded().has(rows()[i].path)}
                onToggle={toggle}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
