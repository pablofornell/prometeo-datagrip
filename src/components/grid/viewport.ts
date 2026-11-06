/**
 * Viewport measurement of the grid scroller. Pure functions, no DOM.
 *
 * The visible window (rows and columns that get cells) is derived from the viewport size. A pane that is not displayed
 * (inactive editor tab, collapsed tool window, `display: none`) measures 0 x 0; windowing on that draws only the first
 * columns (id + email in the table editor, nothing from the third column on) and the first rows, and any row built in
 * that state stays like that until the next measurement. A hidden pane therefore keeps the last real size.
 */
export interface ViewSize {
  w: number;
  h: number;
}

/** Size to window on: the new measurement, or `prev` when the scroller is not displayed (a zero side). */
export function measuredViewport(w: number, h: number, prev: ViewSize): ViewSize {
  return w > 0 && h > 0 ? { w, h } : prev;
}
