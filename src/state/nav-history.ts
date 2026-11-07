/**
 * Navigation history (Navigate > Back / Forward, Ctrl+Alt+Left / Right): the places the user visited, i.e. the
 * editor tabs in activation order. Every tab switch pushes a place (opening an object from the explorer, F4,
 * Ctrl+B and Search Everywhere all end in one), Back / Forward re-activate them. Closed tabs are skipped.
 */
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { activateTab, activeTabId, tabs } from "./tabs";

const MAX = 50;
let places: string[] = [];
const [pos, setPos] = createSignal(-1);
const [len, setLen] = createSignal(0);
/** Tab id being activated by Back / Forward itself (must not be pushed as a new place). */
let expected: string | null = null;

const exists = (id: string): boolean => tabs().some((t) => t.id === id);

/** Records a visit to `id`: drops the forward part of the history, ignores repeats of the current place. */
export function pushPlace(id: string | null | undefined): void {
  if (!id) return;
  if (expected === id) {
    expected = null;
    return;
  }
  const i = pos();
  if (places[i] === id) return;
  places = places.slice(0, i + 1);
  places.push(id);
  if (places.length > MAX) places.shift();
  setLen(places.length);
  setPos(places.length - 1);
}

/** Index of the nearest still-open place in direction `dir` from the current one (-1: none). */
function target(dir: -1 | 1): number {
  for (let i = pos() + dir; i >= 0 && i < places.length; i += dir) if (exists(places[i])) return i;
  return -1;
}

export const canGoBack = (): boolean => (len(), target(-1) >= 0);
export const canGoForward = (): boolean => (len(), target(1) >= 0);

function go(dir: -1 | 1): void {
  const i = target(dir);
  if (i < 0) return;
  setPos(i);
  const id = places[i];
  if (id === activeTabId()) return;
  expected = id;
  activateTab(id);
  // an unchanged active tab never re-runs the tracking effect: do not leave a stale marker
  queueMicrotask(() => (expected = null));
}

export const goBack = (): void => go(-1);
export const goForward = (): void => go(1);

/** Starts tracking tab activations; returns the disposer. */
export function initNavHistory(): () => void {
  return createRoot((dispose) => {
    createEffect(on(activeTabId, (id) => pushPlace(id)));
    return dispose;
  });
}

/** Test hook. */
export function resetNavHistory(): void {
  places = [];
  expected = null;
  setPos(-1);
  setLen(0);
}
