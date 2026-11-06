/** Registry actions of the console: execute, cancel, commit / rollback, history. */
import { type Action, registerActions } from "../../state/actions";
import { activeSession } from "./registry";
import { openHistory } from "./history";

/** Keyboard focus is inside a console (editor) or the Database Output of one. */
const inConsoleArea = (): boolean => !!(document.activeElement as HTMLElement | null)?.closest?.(".dgc-view, .dg-toolwindow-output");

export function registerConsoleActions(): () => void {
  const list: Action[] = [
    {
      id: "sql.execute",
      title: "Execute",
      shortcut: "Ctrl+Enter",
      icon: "run",
      enabled: () => !!activeSession() && !activeSession()!.out.running(),
      when: () => !!activeSession() && !!(document.activeElement as HTMLElement | null)?.closest?.(".dgc-view"),
      run: () => activeSession()?.executeFromEditor(),
    },
    {
      id: "sql.executeScript",
      title: "Execute Script",
      icon: "run",
      enabled: () => !!activeSession() && !activeSession()!.out.running(),
      run: () => activeSession()?.executeScript(),
    },
    {
      id: "sql.cancel",
      title: "Cancel Running Statements",
      shortcut: "Ctrl+F2",
      icon: "stop",
      enabled: () => !!activeSession()?.out.running(),
      when: inConsoleArea,
      run: () => activeSession()?.cancel(),
    },
    {
      id: "sql.commit",
      title: "Commit",
      shortcut: "Ctrl+Alt+Shift+Enter",
      icon: "dg/commit",
      enabled: () => {
        const s = activeSession();
        return !!s && s.inTx() && !s.out.running();
      },
      run: () => void activeSession()?.endTx("commit"),
    },
    {
      id: "sql.rollback",
      title: "Roll back",
      icon: "dg/rollback",
      enabled: () => {
        const s = activeSession();
        return !!s && s.inTx() && !s.out.running();
      },
      run: () => void activeSession()?.endTx("rollback"),
    },
    {
      id: "sql.history",
      title: "Browse Query History",
      shortcut: "Ctrl+Alt+E",
      icon: "history",
      enabled: () => !!activeSession(),
      run: () => {
        const s = activeSession();
        if (s) openHistory(s);
      },
    },
  ];
  return registerActions(list);
}
