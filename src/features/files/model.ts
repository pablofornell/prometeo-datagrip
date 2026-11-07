/** Pure logic of the Files tool window: the tree of Scratches and Consoles, opened files and attached folders. */
import type { Driver, FileInfo } from "../../api/db";
import type { TreeItem } from "../../components/ui";

export type FileNode =
  | { kind: "group"; id: "root" | "consoles" | "scratches" | "opened" }
  | { kind: "ds"; dsId: string }
  | { kind: "console"; dsId: string; name: string }
  /** A scratch file (lives in the scratches folder). */
  | { kind: "scratch"; file: FileInfo }
  /** A file picked with File > Open. */
  | { kind: "opened"; file: FileInfo }
  /** A folder attached to the window (the root of its subtree). */
  | { kind: "folder"; file: FileInfo }
  | { kind: "dir"; file: FileInfo }
  | { kind: "file"; file: FileInfo };

export type FileItem = TreeItem & { data: FileNode };

export interface FilesInput {
  dataSources: { id: string; name: string; driver: Driver }[];
  /** Console names per data source id. */
  consoles: Record<string, string[]>;
  scratches: FileInfo[];
  openedFiles: FileInfo[];
  folders: FileInfo[];
}

/** `console` -> `console.sql`. */
export const consoleFileName = (name: string): string => `${name}.sql`;

export function dirItem(f: FileInfo, kind: "dir" | "folder"): FileItem {
  return { id: `${kind}:${f.path}`, label: f.name, hint: kind === "folder" ? f.path : undefined, icon: "folder", hasChildren: true, data: { kind, file: f } };
}

export function fileItem(f: FileInfo): FileItem {
  return { id: `file:${f.path}`, label: f.name, icon: "sql-file", data: { kind: "file", file: f } };
}

/** Children of a folder listing: folders first (the backend sorts them so), files after. */
export const listingItems = (l: FileInfo[]): FileItem[] => l.map((f) => (f.isDir ? dirItem(f, "dir") : fileItem(f)));

/** The tree roots. `iconOf` gives the DBMS icon of a driver. */
export function buildFilesRoots(i: FilesInput, iconOf: (d: Driver) => string | undefined): FileItem[] {
  const dsNodes: FileItem[] = i.dataSources.map((d) => ({
    id: `ds:${d.id}`,
    label: d.name,
    icon: iconOf(d.driver),
    hasChildren: (i.consoles[d.id] ?? []).length > 0,
    children: (i.consoles[d.id] ?? []).map<FileItem>((n) => ({
      id: `console:${d.id}:${n}`,
      label: consoleFileName(n),
      hint: `[${d.name}]`,
      icon: "dg/console",
      data: { kind: "console", dsId: d.id, name: n },
    })),
    data: { kind: "ds", dsId: d.id },
  }));
  const root: FileItem = {
    id: "grp:root",
    label: "Scratches and Consoles",
    icon: "folder",
    hasChildren: true,
    data: { kind: "group", id: "root" },
    children: [
      { id: "grp:consoles", label: "Database Consoles", icon: "folder", hasChildren: dsNodes.length > 0, children: dsNodes, data: { kind: "group", id: "consoles" } },
      {
        id: "grp:scratches",
        label: "Scratches",
        icon: "folder",
        hasChildren: i.scratches.length > 0,
        data: { kind: "group", id: "scratches" },
        children: i.scratches.map<FileItem>((f) => ({ id: `scratch:${f.path}`, label: f.name, icon: "sql-file", data: { kind: "scratch", file: f } })),
      },
    ],
  };
  const out: FileItem[] = [root];
  if (i.openedFiles.length) {
    out.push({
      id: "grp:opened",
      label: "Opened Files",
      icon: "folder",
      hasChildren: true,
      data: { kind: "group", id: "opened" },
      children: i.openedFiles.map<FileItem>((f) => ({ id: `opened:${f.path}`, label: f.name, hint: f.path, icon: "sql-file", data: { kind: "opened", file: f } })),
    });
  }
  for (const f of i.folders) out.push(dirItem(f, "folder"));
  return out;
}

/** The file a node stands for (undefined for groups, data sources and consoles). */
export const fileOf = (n: FileNode): FileInfo | undefined => ("file" in n ? n.file : undefined);
