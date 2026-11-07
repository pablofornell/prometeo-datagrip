/**
 * IntelliJ's ActionToolbar overflow: a toolbar never grows past its pane. What does not fit (from the right)
 * is hidden and reachable from a "»" button at the right edge, which opens the hidden items as a menu.
 *
 *   <div class="dg-toolbar" ref={overflowToolbar}> ...buttons... </div>
 *
 * The toolbar is clipped (`dg-ovf`); children keep their own click handlers: a menu entry clicks the hidden
 * button, whose `getBoundingClientRect()` answers with the "»" rectangle meanwhile, so popups that anchor under
 * their button open under "»". Handlers that open their popup later (after an await) are covered by
 * `redirectAnchor`: `openMenu` anchors an element without a box to the "»" button.
 */
import { clearAnchorRedirect, redirectAnchor } from "./anchor-redirect";
import { openMenu, type MenuItem } from "./Menu";
import { controlOf, fitCount, labelOf } from "./overflow-fit";

const SEP = /(^|\s)(dg-toolbar-sep|dgg-tsep)(\s|$)/;
const isSep = (el: Element) => SEP.test(el.getAttribute("class") ?? "");

function entryOf(item: HTMLElement, anchor: HTMLElement): MenuItem {
  const el = controlOf(item);
  const off = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.classList.contains("dg-disabled");
  return {
    label: labelOf(item) || "Action",
    shortcut: el.dataset.tipShortcut,
    enabled: !off,
    checked: el.classList.contains("selected") || el.classList.contains("dg-selected") ? true : undefined,
    run: () => {
      // synchronous handlers read the rectangle of the button itself; later ones go through `redirectAnchor`
      const rect = () => anchor.getBoundingClientRect();
      el.getBoundingClientRect = rect;
      try {
        el.click();
      } finally {
        delete (el as { getBoundingClientRect?: unknown }).getBoundingClientRect;
      }
    },
  };
}

/** Ref callback: makes `bar` (a flex row of buttons) collapse what does not fit into a "»" menu. */
export function overflowToolbar(bar: HTMLElement): void {
  bar.classList.add("dg-ovf");
  const more = document.createElement("button");
  more.type = "button";
  more.className = "dg-ovf-more dg-action-button";
  more.tabIndex = -1;
  more.hidden = true;
  more.dataset.tip = "More";
  more.textContent = "»";
  more.addEventListener("mousedown", (e) => e.preventDefault());
  let hiddenItems: HTMLElement[] = [];
  more.addEventListener("click", () => {
    const entries: MenuItem[] = [];
    for (const el of hiddenItems) {
      if (isSep(el)) {
        if (entries.length && entries[entries.length - 1].type !== "separator") entries.push({ type: "separator" });
      } else {
        entries.push(entryOf(el, more));
      }
    }
    while (entries.length && entries[entries.length - 1].type === "separator") entries.pop();
    if (entries.length) openMenu(entries, { anchor: more });
  });
  bar.appendChild(more);

  const layout = () => {
    const kids = [...bar.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c !== more);
    for (const k of kids) {
      k.removeAttribute("data-ovf");
      clearAnchorRedirect(k);
    }
    more.hidden = true;
    if (!bar.clientWidth) return; // not shown
    const cs = getComputedStyle(bar);
    const gap = parseFloat(cs.columnGap) || 0;
    const avail = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    // spacers (flex-grow) take what is left: they count as nothing
    const widths = kids.map((k) => (parseFloat(getComputedStyle(k).flexGrow) > 0 && !k.children.length && !k.textContent ? 0 : k.getBoundingClientRect().width + marginsOf(k)));
    let keep = fitCount(widths, gap, avail, 22 + gap);
    // do not strand a separator at the cut
    while (keep > 0 && isSep(kids[keep - 1])) keep--;
    const cut = kids.slice(keep);
    hiddenItems = cut.filter((_, i) => widths[keep + i] > 0);
    if (!hiddenItems.length) return;
    for (const k of cut) {
      k.setAttribute("data-ovf", "");
      redirectAnchor(k, more);
    }
    more.hidden = false;
  };

  let raf = 0;
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(layout);
  };
  const ro = new ResizeObserver(schedule);
  ro.observe(bar);
  const mo = new MutationObserver(schedule);
  mo.observe(bar, { childList: true, subtree: true, characterData: true });
  schedule();
}

const marginsOf = (el: HTMLElement): number => {
  const s = getComputedStyle(el);
  return (parseFloat(s.marginLeft) || 0) + (parseFloat(s.marginRight) || 0);
};
