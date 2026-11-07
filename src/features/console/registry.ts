/** Open console sessions by editor tab id. */
import { createSignal } from "solid-js";
import { activeTab } from "../../state/tabs";
import type { ConsoleSession } from "./session";

const [sessions, setSessions] = createSignal<ReadonlyMap<string, ConsoleSession>>(new Map());

export function registerSession(s: ConsoleSession): void {
  setSessions((m) => new Map(m).set(s.tabId, s));
}
export function unregisterSession(tabId: string): void {
  setSessions((m) => {
    const n = new Map(m);
    n.delete(tabId);
    return n;
  });
}
export const sessionOf = (tabId: string): ConsoleSession | undefined => sessions().get(tabId);

/** Session of the active editor tab (a console, or a file with a data source; undefined for table / DDL tabs). */
export function activeSession(): ConsoleSession | undefined {
  const t = activeTab();
  return t?.kind === "console" || t?.kind === "file" ? sessions().get(t.id) : undefined;
}

/** Every open console session. */
export const allSessions = (): ConsoleSession[] => [...sessions().values()];
