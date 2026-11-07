/** Context menu of an editor tab (right click on a tab). */
import { dsOf } from "../../features/console/ds";
import { copyText } from "../../features/output/export";
import {
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  closeTabsSide,
  isSplit,
  moveToOppositePane,
  paneOf,
  paneTabs,
  setPinned,
  splitTab,
  tabs,
  type EditorTab,
} from "../../state/tabs";
import { notify } from "../ui/Notification";
import type { MenuItem } from "../ui/Menu";

/** Text "Copy Path/Reference" puts on the clipboard: the qualified object name, or the console's location. */
export function referenceOf(t: EditorTab): string {
  const d = t.data as { dsId?: string; consoleName?: string; objectRef?: { schema?: string; name: string } } | undefined;
  if (d?.objectRef) return [d.objectRef.schema, d.objectRef.name].filter(Boolean).join(".");
  if (typeof (d as { path?: unknown } | undefined)?.path === "string") return (d as { path: string }).path;
  if (d?.consoleName) return ["Database Consoles", d.dsId ? (dsOf(d.dsId)?.name ?? d.dsId) : "", d.consoleName].filter(Boolean).join("/");
  return t.title;
}

export function tabMenu(id: string): MenuItem[] {
  const t = tabs().find((x) => x.id === id);
  if (!t) return [];
  const mates = paneTabs(paneOf(id) ?? "");
  const at = mates.findIndex((x) => x.id === id);
  const closable = (l: EditorTab[]) => l.some((x) => x.closeable && !x.pinned);
  return [
    { label: "Close", shortcut: "Ctrl+F4", enabled: t.closeable, run: () => void closeTab(id) },
    { label: "Close Other Tabs", enabled: closable(mates.filter((x) => x.id !== id)), run: () => void closeOtherTabs(id) },
    { label: "Close All Tabs", run: () => void closeAllTabs() },
    { label: "Close Tabs to the Left", enabled: closable(mates.slice(0, at)), run: () => void closeTabsSide(id, "left") },
    { label: "Close Tabs to the Right", enabled: closable(mates.slice(at + 1)), run: () => void closeTabsSide(id, "right") },
    { type: "separator" },
    {
      label: "Copy Path/Reference…",
      run: () => {
        const text = referenceOf(t);
        void copyText(text).then(() => notify({ kind: "info", title: "Copied to clipboard", body: text, timeout: 3000 }));
      },
    },
    { type: "separator" },
    { label: "Split Right", icon: "split-vertically", run: () => splitTab(id, "right") },
    { label: "Split Down", icon: "split-horizontally", run: () => splitTab(id, "down") },
    ...(isSplit()
      ? ([
          { label: "Move to Opposite Group", run: () => moveToOppositePane(id) },
          { label: "Unsplit", action: "editor.unsplit" },
        ] as MenuItem[])
      : []),
    { type: "separator" },
    { label: t.pinned ? "Unpin Tab" : "Pin Tab", run: () => setPinned(id, !t.pinned) },
    { type: "separator" },
    { action: "tab.reopen" },
  ];
}
