/** Dialogs opened from code that has no view of its own (explorer actions, close guards, console). */
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { ChoiceDialog } from "./Popups";

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

export { mount as mountDialog };
