import { Match, Switch, type JSX } from "solid-js";
import { Dialog } from "../../components/ui";
import { confirmDrop, confirmRemoveDs, dialog, setDialog } from "./commands";

/** Confirmation dialogs (Drop, Remove Data Source). Mounted once by the explorer body. */
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
    </Switch>
  );
}
