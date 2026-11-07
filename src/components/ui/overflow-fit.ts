/** Pure part of the toolbar overflow (see overflow.ts). */

/**
 * How many leading items fit in `avail` px. `widths` are the item widths, `gap` the space between items, `btn`
 * the width of the "»" button (needed once something is cut). Returns `widths.length` when everything fits.
 */
export function fitCount(widths: number[], gap: number, avail: number, btn: number): number {
  const used = (n: number) => widths.slice(0, n).reduce((s, w) => s + w + gap, 0);
  if (used(widths.length) - gap <= avail) return widths.length;
  let n = widths.length;
  while (n > 0 && used(n) + btn > avail) n--;
  return n;
}

/**
 * The control a toolbar child stands for: itself, or the first button inside a wrapper (`<span class="dgc-run">`
 * holding the run button), whose title / state / click are the ones that count.
 */
export function controlOf(el: HTMLElement): HTMLElement {
  return el.tagName === "BUTTON" ? el : (el.querySelector<HTMLElement>("button") ?? el);
}

/** The label of a hidden item: its text (`Tx: Auto`), else its tooltip. */
export function labelOf(el: HTMLElement): string {
  const c = controlOf(el);
  return ((c.textContent ?? "").replace(/\s+/g, " ").trim() || c.dataset.tip || c.getAttribute("aria-label") || c.getAttribute("title") || "").trim();
}
