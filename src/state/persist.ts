/**
 * Small persistence adapter for UI state (layout sizes, open tabs, theme).
 *
 * localStorage is the synchronous copy used at startup (so the first paint already has the right sizes);
 * every save is also sent to the backend with `setUiState` (src/api/db.ts, debounced there; served by the
 * browser mock outside Tauri). `loadBackendState` reads the backend copy asynchronously.
 */
import { getUiState, setUiState } from "../api/db";

const PREFIX = "prometeo.ui.";

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Saves to localStorage immediately and to the backend (fire and forget). */
export function saveUiState(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota / private mode: ignore */
  }
  setUiState("shell." + key, value).catch(() => {});
}

/** Reads the backend copy; resolves to `undefined` when unavailable or never saved. */
export async function loadBackendState<T>(key: string): Promise<T | undefined> {
  try {
    return (await getUiState<T>("shell." + key)) ?? undefined;
  } catch {
    return undefined;
  }
}
