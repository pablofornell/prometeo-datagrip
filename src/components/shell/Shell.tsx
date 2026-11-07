import { Show, onCleanup, onMount, type JSX } from "solid-js";
import { FilesToolWindow } from "../../features/files";
import {
  type ToolWindowAnchor,
  anchorOf,
  commitLayout,
  effectiveSize,
  maxSizeOf,
  maximizedToolWindow,
  MIN_BOTTOM,
  MIN_LEFT,
  MIN_RIGHT,
  GAP,
  setBodyBox,
  setToolWindowSize,
  visibleAt,
} from "../../state/layout";
import { Splitter } from "../ui/Splitter";
import { EditorArea } from "./EditorArea";
import { ExplorerBodyPlaceholder, ExplorerToolbarPlaceholder, OutputBodyPlaceholder } from "./Placeholders";
import { ToolWindowPanel } from "./ToolWindowPanel";

/**
 * The island layout: a grid with a left, a right and a bottom dock around the editor. Every tool window panel
 * stays at the same place in the DOM (its body keeps its state when it is moved to another anchor); its anchor
 * only picks the grid area (shell.css). Sizes are persisted per window.
 */
export function Shell(): JSX.Element {
  let body!: HTMLDivElement;

  onMount(() => {
    const ro = new ResizeObserver(() => setBodyBox(body.clientWidth, body.clientHeight));
    ro.observe(body);
    setBodyBox(body.clientWidth, body.clientHeight);
    onCleanup(() => ro.disconnect());
  });

  /** Anchor of the maximized window (it spans the editor area). */
  const maxAnchor = (): ToolWindowAnchor | null => {
    const id = maximizedToolWindow();
    return id ? anchorOf(id) : null;
  };
  const shown = (a: ToolWindowAnchor) => !!visibleAt(a);
  const splitter = (a: ToolWindowAnchor) => shown(a) && maxAnchor() !== a && !(a !== "bottom" && maxAnchor() === "bottom");

  const columns = () => {
    const l = effectiveSize("left");
    const r = effectiveSize("right");
    return `${l}px ${l ? GAP : 0}px minmax(0, 1fr) ${r ? GAP : 0}px ${r}px`;
  };
  const rows = () => {
    const b = effectiveSize("bottom");
    return maxAnchor() === "bottom" ? "0px 0px minmax(0, 1fr)" : `minmax(0, 1fr) ${b ? GAP : 0}px ${b}px`;
  };

  const sizeOf = (a: ToolWindowAnchor) => ({
    size: effectiveSize(a),
    onResize: (px: number) => {
      const id = visibleAt(a);
      if (id) setToolWindowSize(id, px);
    },
  });

  return (
    <div
      class="dg-body"
      ref={body}
      data-max={maxAnchor() ?? undefined}
      style={{ "grid-template-columns": columns(), "grid-template-rows": rows() }}
    >
      <ToolWindowPanel
        id="explorer"
        fallbackToolbar={ExplorerToolbarPlaceholder}
        fallbackBody={ExplorerBodyPlaceholder}
      />
      <ToolWindowPanel id="files" fallbackBody={FilesToolWindow} />
      <ToolWindowPanel id="output" fallbackBody={OutputBodyPlaceholder} />
      <ToolWindowPanel id="services" />
      <Show when={splitter("left")}>
        <Splitter
          class="dg-split-left"
          orientation="vertical"
          {...sizeOf("left")}
          min={MIN_LEFT}
          max={() => maxSizeOf("left")}
          onResizeEnd={commitLayout}
        />
      </Show>
      <EditorArea />
      <Show when={splitter("right")}>
        <Splitter
          class="dg-split-right"
          orientation="vertical"
          {...sizeOf("right")}
          min={MIN_RIGHT}
          max={() => maxSizeOf("right")}
          reverse
          onResizeEnd={commitLayout}
        />
      </Show>
      <Show when={splitter("bottom")}>
        <Splitter
          class="dg-split-bottom"
          orientation="horizontal"
          {...sizeOf("bottom")}
          min={MIN_BOTTOM}
          max={() => maxSizeOf("bottom")}
          reverse
          onResizeEnd={commitLayout}
        />
      </Show>
    </div>
  );
}
