/**
 * Palette resolution for the diagram renderer. Colours come from the theme CSS variables; the font stacks are
 * resolved to concrete family lists here because the exported SVG / PNG is rendered outside the app, where
 * `var(--dg-font-mono, monospace)` does not resolve.
 */
import type { DiagramPalette } from "./svg";

export const FALLBACK_FONT_MONO = '"JetBrains Mono", ui-monospace, "DejaVu Sans Mono", monospace';
export const FALLBACK_FONT_UI = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif';

/** Reads a custom property of `<html>`; empty outside the DOM (unit tests). */
const cssVar = (name: string): string => (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim());

/** Concrete colours / fonts read from the theme CSS variables at render time (the export string is self-contained). */
export function resolvePalette(read: (name: string) => string = cssVar): DiagramPalette {
  const pick = (name: string, fallback: string): string => read(name) || fallback;
  return {
    background: pick("--dg-editor-bg", "#191a1c"),
    nodeBg: pick("--dg-island-bg", "#1f2024"),
    nodeBorder: pick("--dg-separator", "#33353b"),
    headerBg: pick("--dg-layer-1-bg", "#26282c"),
    headerFg: pick("--dg-text", "#d1d3d9"),
    viewHeaderBg: pick("--dg-banner-info-bg", "#233558"),
    viewFg: pick("--dg-text", "#d1d3d9"),
    text: pick("--dg-grid-fg", "#bcbec4"),
    typeText: pick("--dg-text-secondary", "#73767c"),
    pk: pick("--dg-editor-sql-synthetic", "#e0bb65"),
    fk: pick("--dg-editor-function-declaration", "#56a8f5"),
    edge: pick("--dg-text-secondary", "#73767c"),
    edgeLabel: pick("--dg-text-muted", "#9fa2a8"),
    selection: pick("--dg-accent", "#3871e1"),
    rowLine: pick("--dg-editor-indent-guide", "#323438"),
    fontMono: pick("--dg-font-mono", FALLBACK_FONT_MONO),
    fontUi: pick("--dg-font-ui", FALLBACK_FONT_UI),
  };
}
