/** "View as > Text": the result as an aligned plain-text table (psql style), virtualized by lines. */
import { For, createMemo, createSignal, onMount, type JSX } from "solid-js";
import { classifyType, displayCell, displayLength } from "./format";
import type { Cell, GridColumn } from "./types";

const touch = (_: unknown) => {};
const LINE_H = 21;
const CHAR_W = 8;
const OVERSCAN = 8;
const MAX_COL_CHARS = 80;

interface Props {
  columns: GridColumn[];
  rowCount: number;
  getRow: (i: number) => Cell[] | undefined;
  version?: number;
}

export function TextView(props: Props): JSX.Element {
  let sc!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [h, setH] = createSignal(400);
  onMount(() => {
    const ro = new ResizeObserver(() => setH(sc.clientHeight));
    ro.observe(sc);
    setH(sc.clientHeight);
    return () => ro.disconnect();
  });

  const kinds = createMemo(() => props.columns.map((c) => classifyType(c.typeName)));
  const widths = createMemo(() => {
    touch(props.version);
    const n = Math.min(props.rowCount, 500);
    return props.columns.map((c, ci) => {
      let w = c.name.length;
      for (let i = 0; i < n; i++) {
        const row = props.getRow(i);
        if (row) w = Math.max(w, displayLength(row[ci], kinds()[ci]));
      }
      return Math.min(w, MAX_COL_CHARS);
    });
  });
  const fit = (s: string, w: number, right: boolean) => {
    const t = s.length > w ? s.slice(0, w - 1) + "…" : s;
    return right ? t.padStart(w) : t.padEnd(w);
  };
  const header = createMemo(() => props.columns.map((c, i) => fit(c.name, widths()[i], kinds()[i] === "number")).join(" | "));
  const rule = createMemo(() => widths().map((w) => "-".repeat(w)).join("-+-"));
  const lineChars = () => widths().reduce((a, w) => a + w, 0) + 3 * Math.max(0, widths().length - 1);
  const line = (r: number): string => {
    touch(props.version);
    const row = props.getRow(r);
    if (!row) return "";
    return props.columns
      .map((_, ci) => {
        const d = displayCell(row[ci] ?? null, kinds()[ci]);
        return fit(d.text, widths()[ci], kinds()[ci] === "number");
      })
      .join(" | ");
  };
  const range = createMemo<[number, number]>(
    () => [Math.max(0, Math.floor(top() / LINE_H) - OVERSCAN), Math.min(props.rowCount - 1, Math.ceil((top() + h()) / LINE_H) + OVERSCAN)],
    [0, -1],
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  const rows = createMemo(() => {
    const [a, b] = range();
    const out: number[] = [];
    for (let r = a; r <= b; r++) out.push(r);
    return out;
  });

  return (
    <div ref={sc} class="dgg-text" onScroll={() => setTop(sc.scrollTop)}>
      <div style={{ width: Math.ceil(lineChars() * CHAR_W) + 24 + "px", height: (props.rowCount + 2) * LINE_H + "px", position: "relative" }}>
        <div class="dgg-tl-sticky" style={{ height: 2 * LINE_H + "px", width: Math.ceil(lineChars() * CHAR_W) + 24 + "px" }}>
          <div class="dgg-tl head" style={{ top: "0px" }}>{header()}</div>
          <div class="dgg-tl rule" style={{ top: LINE_H + "px" }}>{rule()}</div>
        </div>
        <For each={rows()}>{(r) => <div class="dgg-tl" style={{ top: (r + 2) * LINE_H + "px" }}>{line(r)}</div>}</For>
      </div>
    </div>
  );
}
