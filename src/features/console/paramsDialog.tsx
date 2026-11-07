/** The `Parameters` dialog: the values of the `?`, `:name`, `$1` ... of a script, asked before it runs. */
import { For, createSignal, type JSX } from "solid-js";
import { ComboBox, Dialog, TextField } from "../../components/ui";
import { mountDialog } from "../table/dialogs";
import { type ParamType, type ParamValue, literalOf } from "./params";

const TYPES: { value: ParamType; label: string }[] = [
  { value: "sql", label: "SQL" },
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
];

function ParamsDialog(props: {
  keys: string[];
  initial: Record<string, ParamValue>;
  /** `Execute` runs the script; without it the dialog is the `View Parameters` editor (`OK`). */
  execute: boolean;
  onDone: (v: Record<string, ParamValue> | null) => void;
}): JSX.Element {
  const [values, setValues] = createSignal<Record<string, ParamValue>>(Object.fromEntries(props.keys.map((k) => [k, props.initial[k] ?? { value: "", type: "sql" as ParamType }])));
  const set = (k: string, patch: Partial<ParamValue>) => setValues({ ...values(), [k]: { ...values()[k], ...patch } });
  const valid = (k: string): boolean => literalOf(values()[k]) !== null;
  // an empty `sql` / `number` value cannot be run; `String` may be empty (`''`)
  const ok = () => props.keys.every(valid);
  const done = () => ok() && props.onDone(values());
  return (
    <Dialog
      title="Parameters"
      width={520}
      onClose={() => props.onDone(null)}
      buttons={[
        { label: props.execute ? "Execute" : "OK", primary: true, disabled: !ok(), run: done },
        { label: "Cancel", run: () => props.onDone(null) },
      ]}
    >
      <div class="dgc-params">
        <div class="dgc-params-row dgc-params-head">
          <span>Name</span>
          <span>Value</span>
          <span>Type</span>
        </div>
        <For each={props.keys}>
          {(k, i) => (
            <div class="dgc-params-row">
              <span class="dgc-params-name" title={k}>
                {k}
              </span>
              <TextField
                value={values()[k].value}
                error={values()[k].value !== "" && !valid(k)}
                placeholder={values()[k].type === "string" ? "text" : values()[k].type === "number" ? "42" : "'abc', 42, null"}
                data-autofocus={i() === 0 ? "" : undefined}
                onInput={(v) => set(k, { value: v })}
              />
              <ComboBox options={TYPES} value={values()[k].type} onChange={(t) => set(k, { type: t })} />
            </div>
          )}
        </For>
        <div class="dgc-params-hint">The value is SQL text: 'abc', 42, null. It replaces the parameter in the statement.</div>
      </div>
    </Dialog>
  );
}

/** Asks for the values; resolves null when the dialog was cancelled. */
export function askParams(keys: string[], initial: Record<string, ParamValue>, execute: boolean): Promise<Record<string, ParamValue> | null> {
  return new Promise((resolve) => {
    mountDialog((close) => (
      <ParamsDialog
        keys={keys}
        initial={initial}
        execute={execute}
        onDone={(v) => {
          close();
          resolve(v);
        }}
      />
    ));
  });
}
