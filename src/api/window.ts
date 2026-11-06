import { isTauri } from "./tauri";

/** Window controls; no-ops in a plain browser. */
async function withWindow(fn: (w: import("@tauri-apps/api/window").Window) => Promise<void>) {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await fn(getCurrentWindow());
}

export const minimizeWindow = () => withWindow((w) => w.minimize());
export const toggleMaximizeWindow = () => withWindow((w) => w.toggleMaximize());
export const closeWindow = () => withWindow((w) => w.close());
