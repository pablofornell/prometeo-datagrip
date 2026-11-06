/** Dialogs opened from code that has no view of its own (explorer actions, close guards, console). */
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { ChoiceDialog, ProgressDialog } from "./Popups";

/** Mounts `view` in a detached root; the returned function unmounts it. */
function mount(view: (close: () => void) => JSX.Element): () => void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(() => view(() => close()), host);
  const close = () => {
    dispose();
    host.remove();
  };
  return close;
}

/** Choice dialog (`Commit` / `Roll Back` / `Cancel` ...). Resolves with the chosen `value` (`cancel` for Esc). */
export function askChoice(c: {
  title: string;
  message: string;
  choices: { label: string; value: string; primary?: boolean }[];
  cancel: string;
}): Promise<string> {
  return new Promise((resolve) => {
    mount((close) => (
      <ChoiceDialog
        title={c.title}
        message={c.message}
        choices={c.choices}
        cancel={c.cancel}
        onAnswer={(v) => {
          close();
          resolve(v);
        }}
      />
    ));
  });
}

/** Brings the topmost open dialog to the front (focus): the answer to a request that must not open a second one. */
export function focusTopDialog(): void {
  const all = document.querySelectorAll<HTMLElement>(".dg-dialog");
  const top = all[all.length - 1];
  if (!top) return;
  const btn = top.querySelector<HTMLElement>(".dg-dialog-footer button");
  (btn ?? top).focus();
}

/**
 * The wait dialog of a COMMIT / ROLLBACK that the user chose: `Committing…`; `stuck()` adds the warning that the
 * outcome is unknown and the "Quit anyway" button, which resolves `quitAnyway`. `close()` removes it.
 */
export function showProgress(c: { title: string; message: string; warning: string; quitAnywayLabel: string }): {
  stuck(): void;
  close(): void;
  quitAnyway: Promise<void>;
} {
  const [stuck, setStuck] = createSignal(false);
  let quit!: () => void;
  const quitAnyway = new Promise<void>((r) => (quit = r));
  const close = mount(() => (
    <ProgressDialog title={c.title} message={c.message} stuck={stuck()} warning={c.warning} quitAnywayLabel={c.quitAnywayLabel} onQuitAnyway={quit} />
  ));
  return { stuck: () => setStuck(true), close, quitAnyway };
}

export { mount as mountDialog };
