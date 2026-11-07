/** The Alt+Enter popup: the intentions of the caret in the shared list-popup menu. */
import type { EditorView } from "@codemirror/view";
import { type MenuItem, openMenu } from "../ui/Menu";
import { type Intention, type IntentionOptions, intentionHostFacet, intentionsAt, runQueryFacet } from "./intentions";

const itemOf = (i: Intention, view: EditorView): MenuItem => ({
  label: i.label,
  icon: i.kind === "fix" ? "error" : undefined,
  run: () => {
    view.focus();
    i.apply(view);
  },
});

const optionsOf = (view: EditorView, extra: IntentionOptions = {}): IntentionOptions => ({
  host: { ...view.state.facet(intentionHostFacet), ...extra.host },
  run: extra.run ?? view.state.facet(runQueryFacet),
});

/** The popup under the caret. Returns false when there is nothing to offer. */
export function showIntentions(view: EditorView, extra: IntentionOptions = {}): boolean {
  const state = view.state;
  const head = state.selection.main.head;
  const list = intentionsAt(state, head, optionsOf(view, extra));
  if (!list.length) return false;
  const fixes = list.filter((i) => i.kind === "fix");
  const actions = list.filter((i) => i.kind === "action");
  const items: MenuItem[] = fixes.map((i) => itemOf(i, view));
  if (fixes.length && actions.length) items.push({ type: "separator" });
  items.push(...actions.map((i) => itemOf(i, view)));
  const c = view.coordsAtPos(head);
  openMenu(items, { x: c?.left ?? 0, y: (c?.bottom ?? 0) + 2, compact: true, minWidth: 328, selected: "first" });
  return true;
}

/** Alt+Enter. */
export const intentionsCommand = (view: EditorView): boolean => {
  showIntentions(view);
  return true;
};

/** Alt+Shift+Enter: applies the first fix (else the first intention) without the popup. */
export const applyFirstIntention = (view: EditorView): boolean => {
  const list = intentionsAt(view.state, view.state.selection.main.head, optionsOf(view));
  const first = list.find((i) => i.kind === "fix") ?? list[0];
  if (first) first.apply(view);
  return true;
};
