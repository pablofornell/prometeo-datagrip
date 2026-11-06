/**
 * Slot registry: how other modules plug their components into the shell.
 *
 * Slot ids used by the shell (`<tw>` = explorer | output):
 *   <tw>.header         content next to the tool window title (e.g. the Output | result tabs)
 *   <tw>.headerActions  header buttons left of ⋮ and — (locate, expand all, collapse all, ...)
 *   <tw>.toolbar        34px toolbar under the header
 *   <tw>.body           the tool window body (tree, results grid, log)
 *   editor.view.<kind>  editor tab content; props { tab: EditorTab, active: boolean }; kind = console | table | ddl
 *   editor.empty        shown when no editor tab is open
 */
import { createStore } from "solid-js/store";
import { type Component, type JSX, createMemo, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";

type AnyComponent = Component<any>;
const [slots, setSlots] = createStore<Record<string, AnyComponent | undefined>>({});

/** Registers (or replaces) the component rendered by a slot. Returns a disposer that clears it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerSlot<P extends Record<string, any> = Record<string, never>>(id: string, component: Component<P>): () => void {
  setSlots(id, () => component as AnyComponent);
  return () => {
    if (slots[id] === (component as AnyComponent)) setSlots(id, undefined);
  };
}

export function getSlot(id: string): AnyComponent | undefined {
  return slots[id];
}

/** Renders the component registered for `id` (or `fallback`). Extra props are forwarded. */
export function Slot(props: { id: string; fallback?: AnyComponent; [k: string]: unknown }): JSX.Element {
  const [own, rest] = splitProps(props, ["id", "fallback"]);
  const comp = createMemo(() => slots[own.id] ?? own.fallback);
  return <Dynamic component={comp()} {...rest} />;
}
