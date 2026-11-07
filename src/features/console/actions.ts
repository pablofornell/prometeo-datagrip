/** Registry actions of the console: execute, explain, cancel, commit / rollback, history. */
import { notify } from "../../components/ui";
import { type Action, registerActions } from "../../state/actions";
import { currentOutput, type ResultTab } from "../output";
import { activeSession } from "./registry";
import { openHistory } from "./history";

/** Keyboard focus is inside a console (editor) or the Database Output of one. */
const inConsoleArea = (): boolean => !!(document.activeElement as HTMLElement | null)?.closest?.(".dgc-view, .dg-toolwindow-output");

/** Keyboard focus is inside the result grid of the Database Output. */
const inResultGrid = (): boolean => !!(document.activeElement as HTMLElement | null)?.closest?.(".dg-toolwindow-output .dgg");
const resultTab = () => currentOutput()?.current();
/** Page actions of the grid: pending edits belong to the page, so they block the change. */
function pageResult(go: (t: ResultTab) => unknown): void {
  const t = resultTab();
  if (!t) return;
  if (t.pending() > 0) {
    notify({ kind: "warning", title: "Pending changes", body: "Submit or revert the pending changes before changing the page." });
    return;
  }
  void go(t);
}

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
      id: "sql.explainPlan",
      title: "Explain Plan",
      icon: "explain-plan",
      enabled: () => !!activeSession() && !activeSession()!.out.running(),
      run: () => void activeSession()?.explain(false),
    },
    {
      id: "sql.explainAnalyse",
      title: "Explain Analyse",
      icon: "explain-plan",
      enabled: () => !!activeSession() && !activeSession()!.out.running() && activeSession()!.driver !== "sqlite",
      run: () => void activeSession()?.explain(true),
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
    {
      id: "output.nextPage",
      title: "Next Page",
      shortcut: "Ctrl+Alt+Down",
      when: inResultGrid,
      enabled: () => !!resultTab()?.canNextPage(),
      run: () => pageResult((t) => t.nextPage()),
    },
    {
      id: "output.prevPage",
      title: "Previous Page",
      shortcut: "Ctrl+Alt+Up",
      when: inResultGrid,
      enabled: () => !!resultTab()?.canPrevPage(),
      run: () => pageResult((t) => t.prevPage()),
    },
  ];
  return registerActions(list);
}
