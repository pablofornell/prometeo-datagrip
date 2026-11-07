/** Small dialogs of the Files feature that have no view of their own. */
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { Dialog, TextField } from "../../components/ui";

function mount(view: (close: () => void) => JSX.Element): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(() => view(close), host);
  function close() {
    dispose();
    host.remove();
  }
}

/** A one-line name prompt (Rename). Resolves with the text, or null when cancelled. `validate` returns an error text. */
export function promptName(o: { title: string; label: string; value: string; okLabel?: string; validate?: (v: string) => string | null }): Promise<string | null> {
  return new Promise((resolve) => {
    mount((close) => {
      const [v, setV] = createSignal(o.value);
      const err = () => (v().trim() ? (o.validate?.(v().trim()) ?? null) : "The name must not be empty");
      const answer = (r: string | null) => (close(), resolve(r));
      return (
        <Dialog
          title={o.title}
          width={420}
          onClose={() => answer(null)}
          buttons={[
            { label: o.okLabel ?? "OK", primary: true, disabled: !!err(), run: () => answer(v().trim()) },
            { label: "Cancel", run: () => answer(null) },
          ]}
        >
          <div class="dgf-prompt">
            <label>{o.label}</label>
            <TextField
              value={v()}
              error={!!err()}
              data-autofocus
              ref={(el) =>
                queueMicrotask(() => {
                  el.focus();
                  const dot = el.value.lastIndexOf(".");
                  el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
                })
              }
              onInput={setV}
            />
            <div class="dgf-prompt-error">{err() && v().trim() ? err() : ""}</div>
          </div>
        </Dialog>
      );
    });
  });
}
