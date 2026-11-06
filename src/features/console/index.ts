/**
 * Query console: `editor.view.console` slot (SQL editor bound to the console file + toolbar), one DB
 * session per console, execution into the Database Output (src/features/output), transaction mode,
 * schema switcher, query history popup.
 *
 * Actions: sql.execute, sql.executeScript, sql.cancel, sql.commit, sql.rollback, sql.history.
 * `db.newConsole` / `db.jumpToConsole` belong to the explorer.
 */
import { createRoot, createEffect, on } from "solid-js";
import { registerSlot } from "../../state/slots";
import { setStatus } from "../../state/status";
import { activeTab } from "../../state/tabs";
import { registerConsoleActions } from "./actions";
import { ConsoleView } from "./ConsoleView";
import "./console.css";

export { activeSession, sessionOf } from "./registry";
export type { ConsoleSession } from "./session";

registerConsoleActions();
registerSlot("editor.view.console", ConsoleView);

// leaving a console tab hides its caret / transaction widgets
createRoot(() => {
  createEffect(
    on(activeTab, (t, prev) => {
      if (prev?.kind === "console" && t?.kind !== "console") setStatus({ caret: null, txMode: null });
    }),
  );
});
