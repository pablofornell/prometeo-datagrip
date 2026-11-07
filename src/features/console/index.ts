/**
 * Query console: `editor.view.console` slot (SQL editor bound to the console file + toolbar), one DB
 * session per console, execution into the Database Output (src/features/output), transaction mode,
 * schema switcher, query history popup.
 *
 * Actions: sql.execute, sql.executeScript, sql.cancel, sql.commit, sql.rollback, sql.history.
 * `db.newConsole` / `db.jumpToConsole` belong to the explorer.
 */
import { createRoot, createEffect, on } from "solid-js";
import { appInfo, isTauri } from "../../api/db";
import { notify } from "../../components/ui";
import { registerSlot } from "../../state/slots";
import { setStatus } from "../../state/status";
import { activeTab, confirmCloseAll, registerBeforeClose } from "../../state/tabs";
import { registerConsoleActions } from "./actions";
import { ConsoleView } from "./ConsoleView";
import { createQuitHandler } from "./quit";
import { focusTopDialog, showProgress } from "../table/dialogs";
import { type TxProgress, confirmEndTransactions } from "./txguard";
import "./console.css";

export { activeSession, sessionOf } from "./registry";
export type { ConsoleSession } from "./session";
export { confirmEndTransactions } from "./txguard";
export { ConsoleInner as ConsoleEditor, type ConsoleBacking } from "./ConsoleView";

registerConsoleActions();
registerSlot("editor.view.console", ConsoleView);

// closing a console tab (x, middle click, Ctrl+F4, close others / all) with an open transaction asks Commit / Roll Back
registerBeforeClose((tab) => (tab.kind === "console" || tab.kind === "file" ? confirmEndTransactions({ tabId: tab.id, reason: "closing the console" }) : true));

/**
 * Quitting the app (window close button, Alt+F4, File > Exit) ends every session and drops unsaved work: ask first.
 * Open transactions (Commit / Roll Back / Cancel), then every tab's own close hook (pending table changes: Submit /
 * Discard / Cancel; unsaved files: Save / Don't Save / Cancel).
 *
 * Tauri destroys the window itself unless a JS close handler exists, and a handler makes the JS side responsible for
 * closing. So the handler is installed once at start; after the user's answer it is removed and the window is closed
 * natively (a request while the prompt is open never quits, see ./quit).
 */
/** The wait dialog of the COMMIT / ROLLBACK the user chose while quitting (Quit anyway after `STUCK_AFTER_MS`). */
const quitProgress: TxProgress = {
  begin: (verb, title) =>
    showProgress({
      title: `${verb}…`,
      message: `${verb} the transaction of '${title}'…`,
      warning: "The server has not answered yet. Quitting now leaves the outcome unknown: the transaction may or may not have been committed.",
      quitAnywayLabel: "Quit anyway",
    }),
};

function guardQuit(): void {
  if (!isTauri()) return;
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const un: () => void = await win.onCloseRequested(
        createQuitHandler({
          confirm: async () => (await confirmEndTransactions({ reason: "quitting the application", progress: quitProgress })) && (await confirmCloseAll()),
          focus: focusTopDialog,
          quit: async () => {
            un();
            await win.close();
          },
        }),
      );
    } catch {
      /* no window API: quitting is not guarded */
    }
  })();
}
guardQuit();

/** Config files that were corrupt at startup were set aside by the backend: tell the user once. */
void appInfo()
  .then((info) => {
    for (const w of info.startupWarnings ?? []) notify({ kind: "warning", title: "Configuration file could not be read", body: w.message, timeout: 0 });
  })
  .catch(() => {});

// leaving a console tab hides its caret / transaction widgets
createRoot(() => {
  createEffect(
    on(activeTab, (t, prev) => {
      if ((prev?.kind === "console" || prev?.kind === "file") && t?.kind !== "console" && t?.kind !== "file") setStatus({ caret: null, txMode: null });
    }),
  );
});
