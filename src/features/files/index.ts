/**
 * Files tool window (Alt+4, docks right): Scratches and Consoles, opened files and attached folders. `.sql` files
 * open as `file` editor tabs (the console editor with a data source chooser). Importing this module registers the
 * slots `files.header|headerActions|body`, `editor.view.file` and the actions file.newScratch, file.open,
 * file.saveAll, file.reload and nav.gotoFile.
 */
import { registerBeforeClose } from "../../state/tabs";
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

// closing a file with unsaved changes asks Save / Don't Save / Cancel
registerBeforeClose(async (tab) => {
  if (tab.kind !== "file") return true;
  const d = fileTabData(tab);
  if (!d || !isDirty(d.path)) return true;
  const a = await askChoice({
    title: "Save Changes",
    message: `Save changes to '${tab.title}' before closing?`,
    choices: [
      { label: "Save", value: "save", primary: true },
      { label: "Don't Save", value: "discard" },
      { label: "Cancel", value: "cancel" },
    ],
    cancel: "cancel",
  });
  if (a === "save") return saveDoc(d.path);
  if (a === "discard") {
    revertDoc(d.path);
    return true;
  }
  return false;
});

// the window loses / gets the focus: scratches are saved, files changed outside are picked up
window.addEventListener("blur", flushScratches);
window.addEventListener("beforeunload", flushScratches);
window.addEventListener("focus", () => void syncFromDisk());
