/**
 * The close-request handler of the main window while a transaction is open. One guard at a time (a promise lock): a
 * further close request while the guard is open (the prompt, or the COMMIT / ROLLBACK the user chose) never quits and
 * never opens a second prompt, it only brings the dialog to the front and waits for the first guard to finish. That
 * covers a double click on the window's close button. The guard itself offers the way out of a COMMIT that hangs
 * (`confirmEndTransactions` with `progress`: "Quit anyway" after 10 s); only a guard that failed does not trap the user.
 */
export interface QuitDeps {
  /** Asks about the open transactions and ends them; resolves false when the user cancelled. */
  confirm(): Promise<boolean>;
  /** Removes the guard and closes the window for good. */
  quit(): Promise<void>;
  /** Brings the guard dialog to the front (a further close request). */
  focus?(): void;
}

export function createQuitHandler(deps: QuitDeps): (e: { preventDefault(): void }) => Promise<void> {
  let guard: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    try {
      if (!(await deps.confirm())) return; // a deliberate Cancel: the next request asks again
    } catch {
      // the guard failed: do not trap the user in the application
    }
    await deps.quit();
  };
  return (e) => {
    e.preventDefault();
    if (guard) {
      deps.focus?.();
      return guard;
    }
    const mine = run().finally(() => {
      if (guard === mine) guard = null;
    });
    guard = mine;
    return mine;
  };
}
