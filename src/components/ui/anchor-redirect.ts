/**
 * Popups anchor under the button that opened them. A toolbar item hidden by the overflow (`overflowToolbar`) has no
 * box, so its popup would open at 0,0, and async handlers (the schema list is fetched first) call `openMenu` long
 * after the click, when no temporary rectangle is in place any more. A hidden item is therefore registered here with
 * the "»" button; `openMenu` asks `anchorRect` and gets the "»" rectangle for an element that has no box of its own.
 */
const redirects = new WeakMap<Element, HTMLElement>();

/** `item` (a toolbar child) is hidden behind `more`. */
export function redirectAnchor(item: Element, more: HTMLElement): void {
  redirects.set(item, more);
}

/** `item` is shown again. */
export function clearAnchorRedirect(item: Element): void {
  redirects.delete(item);
}

/** The rectangle to anchor a popup to: the element's own, or the "»" button's when the element is hidden behind it. */
export function anchorRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  if (r.width > 0 || r.height > 0) return r;
  for (let n: Element | null = el; n; n = n.parentElement) {
    const more = redirects.get(n);
    if (more) return more.getBoundingClientRect();
  }
  return r;
}
