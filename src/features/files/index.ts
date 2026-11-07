/**
 * Files tool window (Alt+4, docks right): Scratches and Consoles, opened files and attached folders. `.sql` files
 * open as `file` editor tabs (the console editor with a data source chooser). Importing this module registers the
 * slots `files.header|headerActions|body`, `editor.view.file` and the actions file.newScratch, file.open,
 * file.saveAll, file.reload and nav.gotoFile.
 */
import { registerBeforeClose, registerQuitGuard } from "../../state/tabs";
import { registerSlot } from "../../state/slots";
import { askChoice } from "../table/dialogs";
import { registerFileActions } from "./actions";
import { fileTabData, flushScratches, isDirty, revertDoc, saveDoc, syncFromDisk } from "./docs";
import { FileView } from "./FileView";
import { FilesHeader, FilesHeaderActions, FilesToolWindow } from "./FilesTree";
import "./files.css";

export { FilesToolWindow } from "./FilesTree";
export { fileTabData, openFileTab, setFileTarget, fileTarget } from "./docs";
export { newScratchFile, openFromDisk } from "./actions";

registerFileActions();
registerSlot("files.header", FilesHeader);
registerSlot("files.headerActions", FilesHeaderActions);
registerSlot("files.body", FilesToolWindow);
registerSlot("editor.view.file", FileView);

const askSave = (title: string) =>
  askChoice({
    title: "Save Changes",
    message: `Save changes to '${title}' before closing?`,
    choices: [
      { label: "Save", value: "save", primary: true },
      { label: "Don't Save", value: "discard" },
      { label: "Cancel", value: "cancel" },
    ],
    cancel: "cancel",
  });

// closing a file with unsaved changes asks Save / Don't Save / Cancel
registerBeforeClose(async (tab) => {
  if (tab.kind !== "file") return true;
  const d = fileTabData(tab);
  if (!d || !isDirty(d.path)) return true;
  const a = await askSave(tab.title);
  if (a === "save") return saveDoc(d.path);
  if (a === "discard") {
    revertDoc(d.path);
    return true;
  }
  return false;
});

// quitting: the question is the same, but "Save" / "Don't Save" are only carried out once every prompt was answered
registerQuitGuard(async (tab) => {
  if (tab.kind !== "file") return null;
  const d = fileTabData(tab);
  if (!d || !isDirty(d.path)) return null;
  const path = d.path;
  const a = await askSave(tab.title);
  if (a === "save") return () => saveDoc(path);
  if (a === "discard") return () => (revertDoc(path), true);
  return false;
});

// the window loses / gets the focus: scratches are saved, files changed outside are picked up
window.addEventListener("blur", flushScratches);
window.addEventListener("beforeunload", flushScratches);
window.addEventListener("focus", () => void syncFromDisk());
