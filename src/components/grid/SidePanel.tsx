/**
 * Docked side panel of the Record View (Ctrl+Shift+Enter): tabs `Record` (one field per column of the active row),
 * `Value` (text of the active cell) and `Aggregates` (statistics of the selection)
 * (docs/ux/screens/98-grid-record-view-dark.png, 98-grid-value-tab-dark.png, 98-grid-aggregates-tab-dark.png).
 * Presentational: the grid passes accessors for the active row and handles commits.
 */
import { For, Show, createSignal, type JSX } from "solid-js";
import { formatStat, type Aggregates } from "./aggregates";
import { GridMenu, type MenuItem } from "./GridMenu";
import type { GridColumn, SideTab } from "./types";
import "./grid.css";

export type SideDock = "right" | "bottom";

export interface SidePanelProps {
  tab: SideTab;
  onTab: (t: SideTab) => void;
  dock: SideDock;
  onDock: (d: SideDock) => void;
  twoColumns: boolean;
  onTwoColumns: (on: boolean) => void;
  onClose: () => void;
  /** Panel size in px (width when docked right, height at the bottom) and its resize callback. */
  size: number;
  onSize: (px: number) => void;

  /** Record tab: visible column indexes in visual order. */
  columns: GridColumn[];
  fieldCols: number[];
  /** Column of the active cell (its field gets the focus ring). */
  activeCol: () => number | null;
  /** True when a row is selected (otherwise the Record tab is empty). */
  hasRecord: () => boolean;
  fieldText: (ci: number) => string;
  fieldIsNull: (ci: number) => boolean;
  fieldEditable: (ci: number) => boolean;
  nullText: string;
  iconClass: (c: GridColumn) => string;
  onFocusField: (ci: number) => void;
  onCommitField: (ci: number, text: string) => void;
  onExpandField: (ci: number) => void;

  /** Value tab. */
  valueTitle: () => string;
  valueText: () => string;
  valueEditable: () => boolean;
  onCommitValue: (text: string) => void;

  /** Aggregates tab. */
  aggregates: () => Aggregates;
  /** Return focus to the grid (Escape). */
  onFocusGrid: () => void;
}

const TABS: [SideTab, string][] = [
  ["record", "Record"],
  ["value", "Value"],
  ["aggregates", "Aggregates"],
];

export function SidePanel(props: SidePanelProps): JSX.Element {
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [wrap, setWrap] = createSignal(true);

  const openGear = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.right,
      y: r.bottom + 2,
      items: [
        { label: props.dock === "right" ? "Move to Bottom" : "Move to Right", onSelect: () => props.onDock(props.dock === "right" ? "bottom" : "right") },
        { label: props.twoColumns ? "Change to One Column Layout" : "Change to Two Column Layout", onSelect: () => props.onTwoColumns(!props.twoColumns) },
      ],
    });
  };

  /** Splitter between the grid and the panel. */
  function startResize(e: MouseEvent) {
    e.preventDefault();
    const right = props.dock === "right";
    const start = right ? e.clientX : e.clientY;
    const s0 = props.size;
    const move = (ev: MouseEvent) => props.onSize(Math.max(180, s0 - ((right ? ev.clientX : ev.clientY) - start)));
    const up = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  }

  const style = (): JSX.CSSProperties => (props.dock === "right" ? { width: props.size + "px" } : { height: props.size + "px" });

  return (
    <div class="dgg-side" classList={{ bottom: props.dock === "bottom" }} style={style()} onMouseDown={(e) => e.stopPropagation()}>
      <div class="dgg-side-split" onMouseDown={startResize} />
      <div class="dgg-side-head">
        <For each={TABS}>
          {([id, label]) => (
            <button class="dgg-side-tab" classList={{ on: props.tab === id }} tabIndex={-1} onClick={() => props.onTab(id)}>
              {label}
            </button>
          )}
        </For>
        <span class="dgg-side-spacer" />
        <Show when={props.tab === "value"}>
          <button class="dgg-side-btn" classList={{ on: wrap() }} title="Soft-Wrap" tabIndex={-1} onClick={() => setWrap(!wrap())}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2.5 4.5h11M2.5 8h9a2 2 0 0 1 0 4H9M10.5 10.5 9 12l1.5 1.5M2.5 11.5H6" />
            </svg>
          </button>
          <span class="dgg-side-sep" />
        </Show>
        <button class="dgg-side-btn" title="Options" tabIndex={-1} onClick={openGear}>
          <i class="dgg-i i-gear" />
        </button>
        <button class="dgg-side-btn close" title="Close" tabIndex={-1} onClick={props.onClose} />
      </div>

      <Show when={props.tab === "record"}>
        <div class="dgg-rec" classList={{ two: props.twoColumns }}>
          <Show when={props.hasRecord()}>
            <For each={props.fieldCols}>
              {(ci) => {
                let input!: HTMLInputElement;
                const col = () => props.columns[ci];
                const text = () => props.fieldText(ci);
                const commit = () => {
                  if (!props.fieldEditable(ci)) return;
                  if (input.value !== text()) props.onCommitField(ci, input.value);
                };
                return (
                  <div class="dgg-rec-f" title={`${col().name}  ${col().typeName}`}>
                    <div class="dgg-rec-l">
                      <i class={"dgg-ico " + props.iconClass(col())} />
                      <span>{col().name}</span>
                    </div>
                    <div class="dgg-rec-i" classList={{ act: props.activeCol() === ci, nul: props.fieldIsNull(ci) }}>
                      <input
                        ref={input}
                        value={text()}
                        placeholder={props.fieldIsNull(ci) ? props.nullText : ""}
                        readOnly={!props.fieldEditable(ci)}
                        spellcheck={false}
                        autocomplete="off"
                        onFocus={() => props.onFocusField(ci)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter" && e.shiftKey) {
                            e.preventDefault();
                            props.onExpandField(ci);
                          } else if (e.key === "Enter") {
                            e.preventDefault();
                            commit();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            input.value = text();
                            props.onFocusGrid();
                          }
                        }}
                      />
                      <button class="dgg-rec-x" title="Open Value Editor  Shift+Enter" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onExpandField(ci)} />
                    </div>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={props.tab === "value"}>
        <div class="dgg-val">
          <div class="dgg-val-gutter" />
          <textarea
            class="dgg-val-text"
            classList={{ nowrap: !wrap() }}
            value={props.valueText()}
            readOnly={!props.valueEditable()}
            spellcheck={false}
            wrap={wrap() ? "soft" : "off"}
            title={props.valueTitle()}
            onBlur={(e) => {
              if (props.valueEditable() && e.currentTarget.value !== props.valueText()) props.onCommitValue(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.currentTarget.value = props.valueText();
                props.onFocusGrid();
              }
            }}
          />
        </div>
      </Show>

      <Show when={props.tab === "aggregates"}>
        <div class="dgg-agg">
          <div class="dgg-agg-box">
            <For
              each={
                [
                  ["AVG", (a: Aggregates) => formatStat(a.avg)],
                  ["COEFFICIENT_OF_VARIATION", (a: Aggregates) => formatStat(a.coefficientOfVariation)],
                  ["COLS", (a: Aggregates) => String(a.cols)],
                  ["COUNT", (a: Aggregates) => String(a.count)],
                  ["COUNT_NUMS", (a: Aggregates) => String(a.countNums)],
                  ["MAX", (a: Aggregates) => formatStat(a.max)],
                  ["MEDIAN", (a: Aggregates) => formatStat(a.median)],
                  ["MIN", (a: Aggregates) => formatStat(a.min)],
                  ["ROWS", (a: Aggregates) => String(a.rows)],
                  ["SUM", (a: Aggregates) => formatStat(a.sum)],
                ] as [string, (a: Aggregates) => string][]
              }
            >
              {([name, fmt]) => (
                <div class="dgg-agg-r">
                  <span class="dgg-agg-n" title={name}>
                    {name}
                  </span>
                  <span class="dgg-agg-v">{fmt(props.aggregates())}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={menu()}>{(m) => <GridMenu x={m().x} y={m().y} items={m().items} alignRight onClose={() => setMenu(null)} />}</Show>
    </div>
  );
}
