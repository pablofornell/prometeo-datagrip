/**
 * The close-request handler of the main window while a transaction is open. Quitting must always be possible:
 * a second request while the first prompt is still open quits at once (the prompt may be stuck behind a connection
 * that never answers), and so does a request after the guard itself failed.
 */
export interface QuitDeps {
  /** Asks about the open transactions; resolves false when the user cancelled. */
  confirm(): Promise<boolean>;
  /** Removes the guard and closes the window for good. */
  quit(): Promise<void>;
}

export function createQuitHandler(deps: QuitDeps): (e: { preventDefault(): void }) => Promise<void> {
  let prompting = false;
  return async (e) => {
    e.preventDefault();
    if (prompting) return void (await deps.quit()); // the user asked again: quit
    prompting = true;
    try {
      if (!(await deps.confirm())) return; // a deliberate Cancel: the next request asks again
    } catch {
      // the guard failed: do not trap the user in the application
    } finally {
      prompting = false;
    }
    await deps.quit();
  };
}
