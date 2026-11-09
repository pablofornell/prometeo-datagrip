/**
 * The Hex tab of the value viewer: `offset | hex | ASCII` rows, drawn only for the part that is in view.
 */
import { For, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { HEX_ROW_BYTES, hexRow, hexRowCount } from "./hexdump";
import { VALUE_ROW_PX, rowWindow } from "./window";

function HexLine(props: { bytes: () => Uint8Array; index: number; top: number }): JSX.Element {
  const row = () => hexRow(props.bytes(), props.index, HEX_ROW_BYTES);
  return (
    <div class="dgg-vx-row dgg-vx-hex" style={{ top: `${props.top}px` }}>
      <span class="dgg-vx-hex-off">{row().offset}</span>
      <span class="dgg-vx-hex-bytes">{row().hex}</span>
      <span class="dgg-vx-hex-asc">{row().ascii}</span>
    </div>
  );
}

export function HexView(props: { bytes: () => Uint8Array }): JSX.Element {
  let scroller!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [view, setView] = createSignal(240);
  onMount(() => {
    setView(scroller.clientHeight || 240);
    const ro = new ResizeObserver(() => setView(scroller.clientHeight || 240));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });
  // the bytes are taken once per change (a text value is encoded here, not once per row)
  const data = createMemo(() => props.bytes());
  const win = createMemo(() => rowWindow(top(), view(), VALUE_ROW_PX, hexRowCount(data().length)));
  const indices = createMemo(() => {
    const w = win();
    return Array.from({ length: w.end - w.first }, (_, k) => w.first + k);
  });
  return (
    <div class="dgg-vx-scroll dgg-vx-hex-scroll" ref={scroller} onScroll={(e) => setTop(e.currentTarget.scrollTop)} tabIndex={-1}>
      <div class="dgg-vx-spacer" style={{ height: `${win().height}px` }}>
        <For each={indices()}>{(i) => <HexLine bytes={data} index={i} top={i * VALUE_ROW_PX - win().shift} />}</For>
      </div>
    </div>
  );
}
