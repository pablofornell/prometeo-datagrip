/** Pure helpers of the menu component (kept free of DOM / Solid imports so they are unit-testable). */
import { getAction } from "../../state/actions";
import type { MenuItem } from "./Menu";

/**
 * Drops `optional` items whose action is not registered (and submenus left empty by that), then collapses
 * leading / trailing / doubled separators.
 */
export function pruneItems(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.type === "separator" || it.type === "header" || it.type === "hint") {
      out.push(it);
      continue;
    }
    if (it.optional && it.action && !getAction(it.action)) continue;
    if (it.children?.length) {
      const children = pruneItems(it.children);
      if (!children.some((c) => c.type !== "separator" && c.type !== "header" && c.type !== "hint")) continue;
      out.push({ ...it, children });
      continue;
    }
    out.push(it);
  }
  const clean: MenuItem[] = [];
  for (const it of out) {
    if (it.type === "separator" && (!clean.length || clean[clean.length - 1].type === "separator")) continue;
    clean.push(it);
  }
  while (clean.length && clean[clean.length - 1].type === "separator") clean.pop();
  return clean;
}

/** Index of the mnemonic letter in a label: the first word that starts with it, else its first occurrence. */
export function mnemonicIndex(label: string, letter: string): number {
  const l = label.toLowerCase();
  const c = letter.toLowerCase();
  for (let i = 0; i < l.length; i++) if (l[i] === c && (i === 0 || l[i - 1] === " ")) return i;
  return l.indexOf(c);
}
