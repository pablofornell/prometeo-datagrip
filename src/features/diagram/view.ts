/**
 * Fit-to-stage math for the diagram. The bounds passed in are the padded diagram box that `renderDiagramSvg` bakes
 * into the exported SVG's width / height / viewBox, so Fit and the SVG agree: the whole padded box (including the
 * outer margin and the self-loop headroom) ends up inside the stage, centered.
 */
import type { Bounds } from "./svg";

export interface StageSize {
  width: number;
  height: number;
}

export interface View {
  zoom: number;
  tx: number;
  ty: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

/** Fit never zooms in past 2x: a two-table diagram should not fill the screen. */
const FIT_MAX_ZOOM = 2;
/** 5% breathing room around the fitted diagram. */
const FIT_MARGIN = 0.95;

/**
 * The view (zoom + translation) that centers `bounds` in `stage` with a small margin, or null when either box is
 * empty (a 0x0 stage at startup, or no diagram yet).
 */
export function fitView(bounds: Bounds, stage: StageSize, margin = FIT_MARGIN, maxZoom = FIT_MAX_ZOOM): View | null {
  if (!(stage.width > 0) || !(stage.height > 0) || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const zoom = Math.max(MIN_ZOOM, Math.min(stage.width / bounds.width, stage.height / bounds.height, maxZoom) * margin);
  return {
    zoom,
    tx: (stage.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    ty: (stage.height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
}
