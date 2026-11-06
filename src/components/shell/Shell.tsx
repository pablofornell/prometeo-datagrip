import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import {
  MIN_BOTTOM,
  MIN_EDITOR_H,
  MIN_EDITOR_W,
  MIN_LEFT,
  commitLayout,
  layout,
  setBottomHeight,
  setLeftWidth,
} from "../../state/layout";
import { Splitter } from "../ui/Splitter";
import { EditorArea } from "./EditorArea";
import { ExplorerBodyPlaceholder, ExplorerToolbarPlaceholder, OutputBodyPlaceholder } from "./Placeholders";
import { ToolWindowPanel } from "./ToolWindowPanel";

const GAP = 5;

/** The island layout: [explorer | editor] over [output], resizable with sizes persisted. */
export function Shell(): JSX.Element {
  let body!: HTMLDivElement;
  const [bodyW, setBodyW] = createSignal(1600);
  const [bodyH, setBodyH] = createSignal(900);

  onMount(() => {
    const ro = new ResizeObserver(() => {
      setBodyW(body.clientWidth);
      setBodyH(body.clientHeight);
    });
    ro.observe(body);
    onCleanup(() => ro.disconnect());
  });

  const leftVisible = () => !!layout.visible.explorer;
  const bottomVisible = () => !!layout.visible.output;
  // Effective sizes: persisted size clamped to what fits the current window.
  const maxLeft = () => Math.max(MIN_LEFT, bodyW() - 13 - MIN_EDITOR_W - GAP);
  const maxBottom = () => Math.max(MIN_BOTTOM, bodyH() - MIN_EDITOR_H - 41 - GAP);
  const leftW = () => Math.min(Math.max(layout.leftWidth, MIN_LEFT), maxLeft());
  const bottomH = () => Math.min(Math.max(layout.bottomHeight, MIN_BOTTOM), maxBottom());

  return (
    <div class="dg-body" ref={body}>
      <div class="dg-top">
        <ToolWindowPanel
          id="explorer"
          style={{ width: leftW() + "px" }}
          fallbackToolbar={ExplorerToolbarPlaceholder}
          fallbackBody={ExplorerBodyPlaceholder}
        />
        <Show when={leftVisible()}>
          <Splitter
            orientation="vertical"
            size={leftW()}
            min={MIN_LEFT}
            max={maxLeft}
            onResize={setLeftWidth}
            onResizeEnd={commitLayout}
          />
        </Show>
        <EditorArea />
      </div>
      <Show when={bottomVisible()}>
        <Splitter
          orientation="horizontal"
          size={bottomH()}
          min={MIN_BOTTOM}
          max={maxBottom}
          reverse
          onResize={setBottomHeight}
          onResizeEnd={commitLayout}
        />
      </Show>
      <ToolWindowPanel id="output" style={{ height: bottomH() + "px" }} fallbackBody={OutputBodyPlaceholder} />
    </div>
  );
}
