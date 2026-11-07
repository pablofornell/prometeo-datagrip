/**
 * Date / time picker panel under the in-cell editor of a date, timestamp or time column
 * (docs/ux/screens/132-grid-date-cell-editor-dark.png): day and month combos with a year spinner, and
 * `HH : mm : ss` spinners. The cell text stays the source of truth; every change rewrites it.
 */
import { For, Show, createMemo, type JSX } from "solid-js";
import { MONTHS, daysIn, formatDateParts, parseDateParts, wrap, type DateParts } from "./dateparts";
import type { ColumnKind } from "./types";

interface Props {
  kind: ColumnKind;
  text: string;
  onChange: (text: string) => void;
}

function today(kind: ColumnKind): DateParts {
  const n = new Date();
  return { y: n.getFullYear(), mo: n.getMonth() + 1, d: n.getDate(), h: kind === "time" ? n.getHours() : 0, mi: kind === "time" ? n.getMinutes() : 0, s: 0, frac: "", sep: " ", tz: "" };
}

/** Number field with the spinner arrows at its right (the dialogs' 28px field style). */
function Spin(props: { value: number; min: number; max: number; pad?: number; roll?: boolean; width: number; onChange: (n: number) => void }): JSX.Element {
  const set = (n: number) => props.onChange(props.roll ? wrap(n, props.min, props.max) : Math.max(props.min, Math.min(props.max, n)));
  return (
    <div class="dgg-spin" style={{ width: props.width + "px" }}>
      <input
        value={props.pad ? String(props.value).padStart(props.pad, "0") : String(props.value)}
        spellcheck={false}
        inputmode="numeric"
        onChange={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n)) set(Math.trunc(n));
          else e.currentTarget.value = String(props.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            set(props.value + (e.key === "ArrowUp" ? 1 : -1));
          }
        }}
        onWheel={(e) => {
          e.preventDefault();
          set(props.value + (e.deltaY < 0 ? 1 : -1));
        }}
      />
      <span class="dgg-spin-btns">
        <button tabIndex={-1} class="up" onMouseDown={(e) => e.preventDefault()} onClick={() => set(props.value + 1)} />
        <button tabIndex={-1} class="down" onMouseDown={(e) => e.preventDefault()} onClick={() => set(props.value - 1)} />
      </span>
    </div>
  );
}

export function DateEditor(props: Props): JSX.Element {
  const parts = createMemo(() => parseDateParts(props.text, props.kind) ?? today(props.kind));
  const change = (patch: Partial<DateParts>) => props.onChange(formatDateParts({ ...parts(), ...patch }, props.kind));
  const showDate = () => props.kind !== "time";
  const showTime = () => props.kind !== "date";
  return (
    <div class="dgg-dpick" onMouseDown={(e) => !(e.target as HTMLElement).closest("select, input") && e.preventDefault()}>
      <Show when={showDate()}>
        <div class="dgg-dpick-row">
          <select class="dgg-dsel day" value={parts().d} onChange={(e) => change({ d: Number(e.currentTarget.value) })}>
            <For each={Array.from({ length: daysIn(parts().y, parts().mo) }, (_, i) => i + 1)}>{(d) => <option value={d} selected={d === parts().d}>{d}</option>}</For>
          </select>
          <select class="dgg-dsel month" value={parts().mo} onChange={(e) => change({ mo: Number(e.currentTarget.value) })}>
            <For each={MONTHS}>{(m, i) => <option value={i() + 1} selected={i() + 1 === parts().mo}>{m}</option>}</For>
          </select>
          <Spin value={parts().y} min={1} max={9999} width={81} onChange={(y) => change({ y })} />
        </div>
      </Show>
      <Show when={showTime()}>
        <div class="dgg-dpick-row time">
          <Spin value={parts().h} min={0} max={23} roll width={82} onChange={(h) => change({ h })} />
          <span class="dgg-dpick-colon">:</span>
          <Spin value={parts().mi} min={0} max={59} roll width={82} onChange={(mi) => change({ mi })} />
          <span class="dgg-dpick-colon">:</span>
          <Spin value={parts().s} min={0} max={59} roll width={82} onChange={(s) => change({ s })} />
        </div>
      </Show>
    </div>
  );
}
