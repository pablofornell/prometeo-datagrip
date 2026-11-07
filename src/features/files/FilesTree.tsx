/** Files tool window: Scratches and Consoles, opened files and attached folders. */
import { createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { chooseAttachFolder, deleteScratch, detachFileRoot, fileRoots, listConsoles, listDir, listScratches, renameScratch } from "../../api/db";
import { ActionButton, Icon, Tree, type MenuItem, type TreeController, notify, openMenu } from "../../components/ui";
import { runAction } from "../../state/actions";
import { activeTab, closeTab, tabs } from "../../state/tabs";
import { dsIconUrl } from "../output/dsicon";
import { explorerDataSources } from "../explorer";
import { openConsoleTab } from "../explorer/commands";
import { askChoice } from "../table/dialogs";
import { promptName } from "./dialogs";
import { fileTabId, openFileTab } from "./docs";
import { type FileItem, type FileNode, type FilesInput, buildFilesRoots, fileOf, listingItems } from "./model";

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");
const fail = (title: string, e: unknown): void => void notify({ kind: "error", title, body: errText(e) });

const [input, setInput] = createSignal<FilesInput>({ dataSources: [], consoles: {}, scratches: [], openedFiles: [], folders: [] });
const [controller, setController] = createSignal<TreeController<FileItem> | undefined>();

/** Reads everything the tree shows. Called on start, after a file operation and when the window gets the focus. */
export async function reloadFiles(): Promise<void> {
  const sources = explorerDataSources();
  const [scratches, roots, consoleLists] = await Promise.all([
    listScratches().catch(() => []),
    fileRoots().catch(() => ({ files: [], folders: [] })),
    Promise.all(sources.map(async (d) => [d.id, await listConsoles(d.id).catch(() => [] as string[])] as const)),
  ]);
  setInput({
    dataSources: sources.map((d) => ({ id: d.id, name: d.name, driver: d.driver })),
    consoles: Object.fromEntries(consoleLists),
    scratches,
    openedFiles: roots.files,
    folders: roots.folders,
  });
  controller()?.refresh();
}

/** The Files tree is showing a newly created file: select it. */
export function revealFile(path: string): void {
  controller()?.select(`scratch:${path}`, { reveal: true });
}

export async function attachFolder(): Promise<void> {
  try {
    const f = await chooseAttachFolder();
    if (!f) return;
    await reloadFiles();
    controller()?.expand(`folder:${f.path}`);
  } catch (e) {
    fail("Cannot attach the folder", e);
  }
}

// ---------------------------------------------------------------- node operations

function open(n: FileNode): void {
  if (n.kind === "console") return openConsoleTab(n.dsId, n.name);
  if (n.kind === "scratch") return openFileTab(n.file, true);
  if (n.kind === "opened" || n.kind === "file") return openFileTab(n.file, false);
}

async function renameFile(n: Extract<FileNode, { kind: "scratch" }>): Promise<void> {
  const name = await promptName({
    title: "Rename",
    label: "New name:",
    value: n.file.name,
    validate: (v) => (/[/\\]/.test(v) || v.startsWith(".") ? "Invalid file name" : input().scratches.some((s) => s.name === v && s.path !== n.file.path) ? `'${v}' already exists` : null),
  });
  if (!name || name === n.file.name) return;
  const tabId = fileTabId(n.file.path);
  const wasOpen = tabs().some((t) => t.id === tabId);
  if (wasOpen && !(await closeTab(tabId))) return;
  try {
    const f = await renameScratch(n.file.path, /\.[^./]+$/.test(name) ? name : name + ".sql");
    if (wasOpen) openFileTab(f, true);
  } catch (e) {
    fail("Cannot rename the file", e);
  }
  await reloadFiles();
}

async function deleteFile(n: Extract<FileNode, { kind: "scratch" }>): Promise<void> {
  const a = await askChoice({
    title: "Delete",
    message: `Delete '${n.file.name}'? This cannot be undone.`,
    choices: [
      { label: "Delete", value: "delete", primary: true },
      { label: "Cancel", value: "cancel" },
    ],
    cancel: "cancel",
  });
  if (a !== "delete") return;
  const tabId = fileTabId(n.file.path);
  if (tabs().some((t) => t.id === tabId) && !(await closeTab(tabId))) return;
  try {
    await deleteScratch(n.file.path);
  } catch (e) {
    fail("Cannot delete the file", e);
  }
  await reloadFiles();
}

async function detach(path: string): Promise<void> {
  try {
    await detachFileRoot(path);
  } catch (e) {
    fail("Cannot remove the entry", e);
  }
  await reloadFiles();
}

function contextItems(it: FileItem | undefined): MenuItem[] {
  const newScratch: MenuItem = { action: "file.newScratch" };
  if (!it) return [newScratch, { action: "file.open" }, { label: "Attach Folder…", run: () => void attachFolder() }];
  const n = it.data;
  const f = fileOf(n);
  const run: MenuItem[] = f ? [{ label: `Run '${f.name}'`, icon: "run", shortcut: "Ctrl+Shift+F10", run: () => void runAction("run.file", { path: f.path }) }] : [];
  switch (n.kind) {
    case "console":
      return [{ label: "Open", run: () => open(n) }];
    case "scratch":
      return [
        { label: "Open", run: () => open(n) },
        ...run,
        { type: "separator" },
        { label: "Rename…", shortcut: "Shift+F6", run: () => void renameFile(n) },
        { label: "Delete…", shortcut: "Delete", run: () => void deleteFile(n) },
      ];
    case "opened":
      return [{ label: "Open", run: () => open(n) }, ...run, { type: "separator" }, { label: "Remove from Files Window", run: () => void detach(n.file.path) }];
    case "file":
      return [{ label: "Open", run: () => open(n) }, ...run];
    case "folder":
      return [{ label: "Reload from Disk", run: () => void reloadFiles() }, { type: "separator" }, { label: "Remove from Files Window", run: () => void detach(n.file.path) }];
    case "group":
      return n.id === "scratches" ? [newScratch] : [];
    default:
      return [];
  }
}

/** The tree id of the file / console of the active editor tab. */
function idOfActiveTab(): string | undefined {
  const t = activeTab();
  if (!t) return undefined;
  const d = t.data as { path?: string; scratch?: boolean; dsId?: string; consoleName?: string } | undefined;
  if (t.kind === "file" && d?.path) {
    const inFolder = input().folders.some((f) => d.path!.startsWith(f.path + "/"));
    return d.scratch ? `scratch:${d.path}` : inFolder ? `file:${d.path}` : `opened:${d.path}`;
  }
  if (t.kind === "console" && d?.dsId && d.consoleName) return `console:${d.dsId}:${d.consoleName}`;
  return undefined;
}

export function selectOpenedFile(): void {
  const id = idOfActiveTab();
  if (id) controller()?.select(id, { reveal: true });
}

// ---------------------------------------------------------------- views

export function FilesToolWindow(): JSX.Element {
  const roots = () => buildFilesRoots(input(), dsIconUrl);
  onMount(() => {
    void reloadFiles();
    const onFocus = () => void reloadFiles();
    window.addEventListener("focus", onFocus);
    onCleanup(() => window.removeEventListener("focus", onFocus));
  });
  // data sources appear / go away / get renamed
  createEffect(on(() => explorerDataSources().map((d) => d.id + d.name).join("\n"), () => void reloadFiles(), { defer: true }));
  // consoles and scratches created elsewhere
  createEffect(on(() => tabs().length, () => void reloadFiles(), { defer: true }));
  return (
    <Tree<FileItem>
      class="dgf-tree"
      roots={roots()}
      initialExpanded={["grp:root", "grp:consoles", "grp:scratches"]}
      loadChildren={async (it) => {
        const f = fileOf(it.data);
        return f ? (listingItems(await listDir(f.path)) as FileItem[]) : [];
      }}
      onActivate={(it, via) => {
        const n = it.data;
        if (n.kind === "console" || n.kind === "scratch" || n.kind === "opened" || n.kind === "file") {
          open(n);
          return true;
        }
        return via === "f4";
      }}
      onContextMenu={(it, e) => {
        e.preventDefault();
        openMenu(contextItems(it), { x: e.clientX, y: e.clientY });
      }}
      onKey={(e, it) => {
        if (!it) return false;
        if (e.key === "F6" && e.shiftKey && it.data.kind === "scratch") return void renameFile(it.data), true;
        if (e.key === "Delete" && it.data.kind === "scratch") return void deleteFile(it.data), true;
        return false;
      }}
      ref={setController}
      emptyText="No files to show"
    />
  );
}

/** "Files ⌄" next to the title. */
export function FilesHeader(): JSX.Element {
  return <Icon name="chevron-down" size={16} class="dgf-title-chevron" />;
}

export function FilesHeaderActions(): JSX.Element {
  return (
    <>
      <ActionButton icon="folder" title="Attach Folder…" onClick={() => void attachFolder()} />
      <ActionButton icon="locate" title="Select Opened File" onClick={selectOpenedFile} disabled={!idOfActiveTab()} />
      <ActionButton icon="expand-all" title="Expand All" onClick={() => void controller()?.expandAll()} />
      <ActionButton icon="collapse-all" title="Collapse All" onClick={() => controller()?.collapseAll()} />
    </>
  );
}
