import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AppInfo } from "./types";

export type { AppInfo } from "./types";

/** True when running inside the Tauri webview (false in a plain browser). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Browser-only mock handlers, keyed by command name. */
export type MockHandler = (args?: Record<string, unknown>) => unknown | Promise<unknown>;

/** Handlers registered at runtime; they win over the built-in mock in `./mock.ts`. */
const mocks: Record<string, MockHandler> = {};

let builtin: Promise<Record<string, MockHandler>> | undefined;
/** The built-in mock (fake "shop@localhost" data source, ...) is only loaded outside Tauri. */
const loadBuiltin = () => (builtin ??= import("./mock").then((m) => m.mockHandlers));

/** Register or override a mock handler used when running outside Tauri. */
export function registerMock(cmd: string, handler: MockHandler): void {
  mocks[cmd] = handler;
}

/**
 * Typed `invoke` that falls back to the mock in a plain browser. Rejections carry the
 * server message as a plain string, like Tauri does for `Result<_, String>` commands.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    return tauriInvoke<T>(cmd, args);
  }
  const mock = mocks[cmd] ?? (await loadBuiltin())[cmd];
  if (!mock) {
    throw new Error(`No browser mock registered for command "${cmd}"`);
  }
  return (await mock(args)) as T;
}

export const appInfo = (): Promise<AppInfo> => invoke<AppInfo>("app_info");
