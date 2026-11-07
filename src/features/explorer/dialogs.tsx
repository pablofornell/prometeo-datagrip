import { Match, Show, Switch, createSignal, type JSX } from "solid-js";
import { Dialog, TextField } from "../../components/ui";
import { confirmDrop, confirmRemoveDs, confirmRename, dialog, setDialog } from "./commands";

/** One-field dialog (New Folder, Rename Folder). */
function Prompt(props: { state: Extract<NonNullable<ReturnType<typeof dialog>>, { kind: "prompt" }>; close: () => void }): JSX.Element {
  const [value, setValue] = createSignal(props.state.value);
  const [error, setError] = createSignal<string | null>(null);
  const ok = () => {
    const err = props.state.accept(value());
    if (err) setError(err);
    else props.close();
  };
  return (
    <Dialog
      title={props.state.title}
      width={props.state.width ?? 360}
      onClose={props.close}
      buttons={[
        { label: "OK", primary: true, run: ok },
        { label: "Cancel", run: props.close },
      ]}
    >
      <div class="dg-explorer-prompt">
        <span>{props.state.label}</span>
        <TextField value={value()} onInput={(v) => (setValue(v), setError(null))} error={!!error()} frameClass="dg-explorer-prompt-field" data-autofocus />
      </div>
      <Show when={error()}>
        <div class="dg-explorer-prompt-error">{error()}</div>
      </Show>
    </Dialog>
  );
}

/** Confirmation dialogs (Drop, Remove Data Source) and prompts. Mounted once by the explorer body. */
export function DialogHost(): JSX.Element {
  const close = () => setDialog(null);
  return (
    <Switch>
      <Match when={dialog()?.kind === "drop" && (dialog() as Extract<ReturnType<typeof dialog>, { kind: "drop" }>)}>
        {(s) => (
          <Dialog
            title="Drop"
            width={460}
            onClose={close}
            buttons={[
              { label: "Drop", primary: true, run: () => void confirmDrop(s()) },
              { label: "Cancel", run: close },
            ]}
          >
            <div>Drop {s().what}?</div>
            <pre class="dg-explorer-sql">{s().sql}</pre>
          </Dialog>
        )}
      </Match>
      <Match when={dialog()?.kind === "rename" && (dialog() as Extract<ReturnType<typeof dialog>, { kind: "rename" }>)}>
        {(s) => (
          <Dialog
            title="Rename"
            width={460}
            onClose={close}
            buttons={[
              { label: "Rename", primary: true, run: () => void confirmRename(s()) },
              { label: "Cancel", run: close },
            ]}
          >
            <div>Rename {s().what} to '{s().newName}'?</div>
            <pre class="dg-explorer-sql">{s().sql}</pre>
          </Dialog>
        )}
      </Match>
      <Match when={dialog()?.kind === "removeDs" && (dialog() as Extract<ReturnType<typeof dialog>, { kind: "removeDs" }>)}>
        {(s) => (
          <Dialog
            title="Remove Data Source"
            width={420}
            onClose={close}
            buttons={[
              { label: "Remove", primary: true, run: () => void confirmRemoveDs(s().ds) },
              { label: "Cancel", run: close },
            ]}
          >
            <div>Remove data source '{s().ds.name}'?</div>
          </Dialog>
        )}
      </Match>
      <Match when={dialog()?.kind === "prompt" && (dialog() as Extract<ReturnType<typeof dialog>, { kind: "prompt" }>)}>
        {(s) => <Prompt state={s()} close={close} />}
      </Match>
    </Switch>
  );
}
