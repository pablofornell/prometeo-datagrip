/** Registry actions of the Files feature: new scratch, open, save all, reload, go to file. */
import { chooseOpenFiles, createScratch } from "../../api/db";
import { notify } from "../../components/ui";
import { type Action, registerActions } from "../../state/actions";
import { dirtyPaths, openFileTab, openPaths, reloadAll, saveAll } from "./docs";
import { openGotoFile } from "./GotoFile";
import { reloadFiles, revealFile } from "./FilesTree";

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

export async function newScratchFile(): Promise<void> {
  try {
    const f = await createScratch();
    openFileTab(f, true);
    await reloadFiles();
    revealFile(f.path);
  } catch (e) {
    notify({ kind: "error", title: "Cannot create the scratch file", body: errText(e) });
  }
}

export async function openFromDisk(): Promise<void> {
  try {
    const files = await chooseOpenFiles();
    for (const f of files) openFileTab(f, false);
    if (files.length) await reloadFiles();
  } catch (e) {
    notify({ kind: "error", title: "Cannot open the file", body: errText(e) });
  }
}

export function registerFileActions(): () => void {
  const list: Action[] = [
    { id: "file.newScratch", title: "Scratch File", shortcut: "Ctrl+Alt+Shift+Insert", icon: "sql-file", run: () => void newScratchFile() },
    { id: "file.open", title: "Open…", icon: "folder", run: () => void openFromDisk() },
    { id: "file.saveAll", title: "Save All", shortcut: "Ctrl+S", enabled: () => dirtyPaths().length > 0, run: () => void saveAll() },
    { id: "file.reload", title: "Reload All from Disk", shortcut: "Ctrl+Alt+Y", enabled: () => openPaths().length > 0, run: () => void reloadAll() },
    { id: "nav.gotoFile", title: "Go to File…", shortcut: "Ctrl+Shift+N", run: () => openGotoFile() },
  ];
  return registerActions(list);
}
