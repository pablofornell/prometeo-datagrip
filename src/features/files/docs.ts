/**
 * Open `.sql` files (scratches, files opened from disk, files of attached folders): one shared document per path
 * (text, last saved text, disk mtime), the dirty marker of the tab, save / save all / reload from disk, and the data
 * source a file runs against. Scratch files autosave (like consoles); the others save with Ctrl+S.
 */
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { type FileInfo, readFile, writeFile } from "../../api/db";
import { notify } from "../../components/ui";
import { saveUiState, loadLocal } from "../../state/persist";
import { activateTab, openTab, tabs, updateTab } from "../../state/tabs";
import { askChoice } from "../table/dialogs";

/** Payload of a `file` editor tab (persisted with the tab). */
export interface FileTabData {
  path: string;
  /** The file lives in the scratches folder: autosave, shown under Scratches. */
  scratch: boolean;
  /** The data source the file runs against (mirror of `fileTarget`, so the explorer tints the tab). */
  dsId?: string;
}

export interface FileDoc {
  path: string;
  name: string;
  text: string;
  /** The text on disk as far as this app knows. */
  saved: string;
  mtimeMs: number;
  scratch: boolean;
  /** Views showing the document (two panes may show the same file). */
  refs: number;
  /** Bumped when the text was replaced from outside the editor (reload from disk, revert): the editor reloads it. */
  rev: number;
}

const SAVE_DELAY = 600;
const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

export const fileTabId = (path: string): string => `file:${path}`;
export const fileTabData = (t: { data?: unknown }): FileTabData | undefined => {
  const d = t.data as Partial<FileTabData> | undefined;
  return d && typeof d.path === "string" ? (d as FileTabData) : undefined;
};

// ---------------------------------------------------------------- target data source per file

type Targets = Record<string, string>;
const [targets, setTargets] = createSignal<Targets>(loadLocal<Targets>("fileTargets", {}));

export const fileTarget = (path: string): string | undefined => targets()[path];

/** Chooses (or clears) the data source a file runs against. The tab follows, so its tint and session change. */
export function setFileTarget(path: string, dsId: string | null): void {
  const next = { ...targets() };
  if (dsId) next[path] = dsId;
  else delete next[path];
  setTargets(next);
  saveUiState("fileTargets", next);
  const tab = tabs().find((t) => t.id === fileTabId(path));
  const d = tab && fileTabData(tab);
  if (tab && d) updateTab(tab.id, { data: { ...d, dsId: dsId ?? undefined } satisfies FileTabData });
}

// ---------------------------------------------------------------- documents

const [docs, setDocs] = createStore<Record<string, FileDoc>>({});
const loading = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const docOf = (path: string): FileDoc | undefined => docs[path];
export const isDirty = (path: string): boolean => !!docs[path] && docs[path].text !== docs[path].saved;
export const dirtyPaths = (): string[] => Object.keys(docs).filter(isDirty);
export const openPaths = (): string[] => Object.keys(docs);

function syncMarker(path: string): void {
  const id = fileTabId(path);
  const t = tabs().find((x) => x.id === id);
  if (t && !!t.modified !== isDirty(path)) updateTab(id, { modified: isDirty(path) });
}

/** A view starts showing the file: loads it on first use. Rejects with the reason when it cannot be read. */
export async function acquireDoc(path: string, scratch: boolean): Promise<FileDoc> {
  if (!docs[path]) {
    let p = loading.get(path);
    if (!p) {
      p = readFile(path).then((c) => {
        setDocs(path, {
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          text: c.text,
          saved: c.text,
          mtimeMs: c.mtimeMs,
          scratch,
          refs: 0,
          rev: 0,
        });
      });
      loading.set(path, p);
      p.then(
        () => loading.delete(path),
        () => loading.delete(path),
      );
    }
    await p;
  }
  setDocs(path, "refs", (n) => n + 1);
  return docs[path];
}

/** A view stopped showing the file; the last one frees the document (a scratch is flushed first). */
export function releaseDoc(path: string): void {
  if (!docs[path]) return;
  const refs = docs[path].refs - 1;
  if (refs > 0) return setDocs(path, "refs", refs);
  clearTimeout(timers.get(path));
  timers.delete(path);
  if (docs[path].scratch && isDirty(path)) void writeFile(path, docs[path].text).catch(() => {});
  setDocs(
    produce((d) => {
      delete d[path];
    }),
  );
}

/** The editor changed the text. */
export function editDoc(path: string, text: string): void {
  if (!docs[path] || docs[path].text === text) return;
  setDocs(path, "text", text);
  syncMarker(path);
  if (docs[path].scratch) {
    clearTimeout(timers.get(path));
    timers.set(path, setTimeout(() => void saveDoc(path, { quiet: true }), SAVE_DELAY));
  }
}

/**
 * Writes the document to disk. Resolves false when it was not saved (error shown, or the user declined to overwrite
 * a file that changed on disk). `quiet`: autosave, no dialogs (a conflict simply waits for the next explicit save).
 */
export async function saveDoc(path: string, o: { quiet?: boolean } = {}): Promise<boolean> {
  const d = docs[path];
  if (!d) return true;
  clearTimeout(timers.get(path));
  timers.delete(path);
  if (!isDirty(path)) return true;
  const text = d.text;
  try {
    const mtime = await writeFile(path, text, d.mtimeMs).catch(async (e) => {
      if (!/was changed on disk/.test(errText(e))) throw e;
      if (o.quiet) throw e;
      const a = await askChoice({
        title: "File Cache Conflict",
        message: `'${d.name}' was changed on disk. Overwrite the file with the text of the editor, or load the version from disk?`,
        choices: [
          { label: "Overwrite", value: "overwrite", primary: true },
          { label: "Load from Disk", value: "reload" },
          { label: "Cancel", value: "cancel" },
        ],
        cancel: "cancel",
      });
      if (a === "reload") {
        await reloadDoc(path, true);
        throw "reloaded";
      }
      if (a !== "overwrite") throw "cancelled";
      return writeFile(path, text, null);
    });
    if (docs[path]) setDocs(path, { saved: text, mtimeMs: mtime });
    syncMarker(path);
    return true;
  } catch (e) {
    if (e !== "reloaded" && e !== "cancelled" && !o.quiet) notify({ kind: "error", title: `Cannot save ${d.name}`, body: errText(e) });
    return false;
  }
}

/** File | Save All. */
export async function saveAll(): Promise<void> {
  for (const p of dirtyPaths()) await saveDoc(p);
}

/**
 * Replaces the text with the one on disk. A document with unsaved changes asks first, unless `force`.
 * Resolves false when the user kept their text or the file could not be read.
 */
export async function reloadDoc(path: string, force = false): Promise<boolean> {
  const d = docs[path];
  if (!d) return true;
  if (isDirty(path) && !force) {
    const a = await askChoice({
      title: "Reload from Disk",
      message: `'${d.name}' has unsaved changes. Reloading discards them.`,
      choices: [
        { label: "Reload", value: "reload", primary: true },
        { label: "Cancel", value: "cancel" },
      ],
      cancel: "cancel",
    });
    if (a !== "reload") return false;
  }
  try {
    const c = await readFile(path);
    if (docs[path]) setDocs(path, (x) => ({ text: c.text, saved: c.text, mtimeMs: c.mtimeMs, rev: x.rev + 1 }));
    syncMarker(path);
    return true;
  } catch (e) {
    notify({ kind: "error", title: `Cannot reload ${d.name}`, body: errText(e) });
    return false;
  }
}

/** File | Reload All from Disk. */
export async function reloadAll(): Promise<void> {
  for (const p of openPaths()) await reloadDoc(p);
}

/** Drops the unsaved changes (Close > Don't Save). */
export function revertDoc(path: string): void {
  const d = docs[path];
  if (!d) return;
  setDocs(path, (x) => ({ text: x.saved, rev: x.rev + 1 }));
  syncMarker(path);
}

/** The window got the focus: files that changed on disk and have no unsaved changes are reloaded silently. */
export async function syncFromDisk(): Promise<void> {
  for (const path of openPaths()) {
    if (isDirty(path)) continue;
    const before = docs[path].mtimeMs;
    try {
      const c = await readFile(path);
      const d = docs[path];
      // nothing was typed or saved while the file was read (a save in between makes this read stale)
      if (d && !isDirty(path) && d.mtimeMs === before && c.mtimeMs !== before) setDocs(path, (x) => ({ text: c.text, saved: c.text, mtimeMs: c.mtimeMs, rev: x.rev + 1 }));
    } catch {
      /* deleted or unreadable: the next explicit save says so */
    }
  }
}

/** Autosave of scratches when the window loses the focus or closes. */
export function flushScratches(): void {
  for (const p of openPaths()) if (docs[p].scratch && isDirty(p)) void saveDoc(p, { quiet: true });
}

// ---------------------------------------------------------------- tabs

/** Opens (or activates) the editor tab of a file. */
export function openFileTab(f: Pick<FileInfo, "path" | "name">, scratch: boolean): void {
  const id = fileTabId(f.path);
  if (tabs().some((t) => t.id === id)) return activateTab(id);
  const dsId = fileTarget(f.path);
  openTab({ id, kind: "file", title: f.name, icon: "sql-file", data: { path: f.path, scratch, dsId } satisfies FileTabData });
}
