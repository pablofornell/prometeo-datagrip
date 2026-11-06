import { type JSX, createSignal } from "solid-js";

export interface SplitterProps {
  /** "vertical" = a vertical bar between left/right panes (drag changes a width);
   *  "horizontal" = a horizontal bar between top/bottom panes (drag changes a height). */
  orientation: "vertical" | "horizontal";
  /** Current size in px of the pane being resized. */
  size: number;
  onResize: (size: number) => void;
  /** Called once when the drag ends (persist here). */
  onResizeEnd?: (size: number) => void;
  min?: number;
  /** Maximum size; may be a function for layout-dependent limits. */
  max?: number | (() => number);
  /** Pane is on the right / bottom of the splitter: dragging towards the start grows it. */
  reverse?: boolean;
  /** Double click (DataGrip has none on island splitters; available for dialogs). */
  onDoubleClick?: () => void;
  class?: string;
}

/**
 * Invisible 5px gap between islands that doubles as the drag handle (cursor changes only).
 * Renders as a flex child: place it between the two panes.
 */
export function Splitter(props: SplitterProps): JSX.Element {
  const [dragging, setDragging] = createSignal(false);
  const vertical = () => props.orientation === "vertical";

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = vertical() ? e.clientX : e.clientY;
    const startSize = props.size;
    let last = startSize;
    setDragging(true);
    document.body.classList.add(vertical() ? "dg-resizing-col" : "dg-resizing-row");
    const move = (ev: PointerEvent) => {
      const d = (vertical() ? ev.clientX : ev.clientY) - start;
      let s = startSize + (props.reverse ? -d : d);
      const max = typeof props.max === "function" ? props.max() : props.max;
      if (max !== undefined) s = Math.min(s, max);
      s = Math.max(s, props.min ?? 0);
      last = Math.round(s);
      props.onResize(last);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDragging(false);
      document.body.classList.remove("dg-resizing-col", "dg-resizing-row");
      props.onResizeEnd?.(last);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div
      class={"dg-splitter dg-splitter-" + props.orientation + (props.class ? " " + props.class : "")}
      classList={{ "dg-dragging": dragging() }}
      role="separator"
      aria-orientation={vertical() ? "vertical" : "horizontal"}
      onPointerDown={onDown}
      onDblClick={() => props.onDoubleClick?.()}
    />
  );
}
