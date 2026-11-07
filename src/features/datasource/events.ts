/** Tiny change notification: the explorer reloads its data sources when the dialog applied something. */
type Listener = () => void;
const listeners = new Set<Listener>();

/** Name of the window event dispatched next to the listeners (for code that prefers DOM events). */
export const DATA_SOURCES_CHANGED_EVENT = "prometeo:datasources-changed";

/** `cb` runs after the dialog saved / deleted data sources. Returns the unsubscribe function. */
export function onDataSourcesChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitDataSourcesChanged(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch (e) {
      console.error(e);
    }
  }
  window.dispatchEvent(new CustomEvent(DATA_SOURCES_CHANGED_EVENT));
}

/** Data sources that were created (not just edited) by the same Apply: the explorer opens a console and introspects them. */
type CreatedListener = (ids: string[]) => void;
const createdListeners = new Set<CreatedListener>();

export function onDataSourcesCreated(cb: CreatedListener): () => void {
  createdListeners.add(cb);
  return () => createdListeners.delete(cb);
}

export function emitDataSourcesCreated(ids: string[]): void {
  for (const l of [...createdListeners]) {
    try {
      l(ids);
    } catch (e) {
      console.error(e);
    }
  }
}
