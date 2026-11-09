/** Open console sessions by editor tab id. */
import { createSignal } from "solid-js";
import type { SqlEditorHandle } from "../../components/editor";
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

/** SQL editors of the open console and file tabs, by tab id (set when the editor mounts, dropped when it goes). */
const editors = new Map<string, SqlEditorHandle>();
/** Lines asked for before their editor mounted (Find Usages opens the tab, then moves to the line). */
const pendingLines = new Map<string, number>();

/** Selects line `line` (1-based, kept inside the text) of the editor and scrolls to it. */
function revealLineIn(h: SqlEditorHandle, line: number): void {
  const doc = h.view?.state.doc;
  if (!doc) return;
  const l = doc.line(Math.min(Math.max(1, line), doc.lines));
  h.revealRange({ from: l.from, to: l.to });
}

/** The editor of a tab mounted: a line asked for before is revealed now. */
export function registerEditor(tabId: string, h: SqlEditorHandle): void {
  editors.set(tabId, h);
  const line = pendingLines.get(tabId);
  if (line === undefined) return;
  pendingLines.delete(tabId);
  revealLineIn(h, line);
}

/** The editor of a tab went away (closed, or its file got a data source and another editor). */
export function unregisterEditor(tabId: string): void {
  editors.delete(tabId);
}

/** Moves the caret of an open console or file tab to `line`; the line waits for the editor when it is not mounted yet. */
export function revealLine(tabId: string, line: number): void {
  const h = editors.get(tabId);
  if (h?.view) revealLineIn(h, line);
  else pendingLines.set(tabId, line);
}
