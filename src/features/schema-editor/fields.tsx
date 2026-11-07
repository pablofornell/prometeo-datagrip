/** Form controls of the property sheet: labelled row, data type combo, multi-select column list, FK target pickers. */
import { For, type JSX, Show, createSignal } from "solid-js";
import { Checkbox, ComboBox, Icon, type ComboOption, TextField, openMenu, type MenuItem } from "../../components/ui";

export function Field(props: { label: string; children: JSX.Element; top?: boolean; class?: string }): JSX.Element {
  return (
    <div class={"dgse-row" + (props.class ? " " + props.class : "")} classList={{ "dgse-row-top": props.top }}>
      <span class="dgse-label">{props.label}</span>
      <div class="dgse-control">{props.children}</div>
    </div>
  );
}

/** One-line text input (28px). `name` marks the field that gets the focus when the dialog or the node opens. */
export function Text(props: { value: string; onInput: (v: string) => void; disabled?: boolean; mono?: boolean; placeholder?: string; name?: boolean; error?: boolean }): JSX.Element {
  return (
    <TextField
      value={props.value}
      onInput={props.onInput}
      disabled={props.disabled}
      placeholder={props.placeholder}
      error={props.error}
      class={props.mono ? "dgse-mono" : undefined}
      data-name={props.name ? "1" : undefined}
    />
  );
}

/** Editable combo: type anything or pick from the dialect's list. */
export function TypeCombo(props: { value: string; options: string[]; onInput: (v: string) => void; disabled?: boolean }): JSX.Element {
  let box!: HTMLDivElement;
  const open = () => {
    if (props.disabled) return;
    const items: MenuItem[] = props.options.map((o) => ({ label: o, run: () => props.onInput(o) }));
    openMenu(items, { anchor: box, compact: true, minWidth: box.offsetWidth, selected: props.options.indexOf(props.value) });
  };
  return (
    <div ref={box} class="dgse-typecombo">
      <TextField
        value={props.value}
        onInput={props.onInput}
        disabled={props.disabled}
        class="dgse-mono"
        suffix={
          <span class="dgse-chevron" onMouseDown={(e) => e.preventDefault()} onClick={open}>
            <Icon name="chevron-down" />
          </span>
        }
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !props.disabled) {
            e.preventDefault();
            open();
          }
        }}
      />
    </div>
  );
}

/** Multi-select list of the columns of a table; the selection order is the order of the key / index columns. */
export function ColumnList(props: { all: string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }): JSX.Element {
  const extras = () => props.value.filter((v) => !props.all.includes(v));
  const toggle = (name: string, on: boolean) => props.onChange(on ? [...props.value, name] : props.value.filter((v) => v !== name));
  return (
    <div class="dgse-collist" classList={{ "dgse-disabled": props.disabled }}>
      <For each={props.all}>
        {(c) => (
          <div class="dgse-colrow">
            <Checkbox checked={props.value.includes(c)} disabled={props.disabled} onChange={(on) => toggle(c, on)} label={c} />
            <Show when={props.value.includes(c)}>
              <span class="dgse-colorder">{props.value.indexOf(c) + 1}</span>
            </Show>
          </div>
        )}
      </For>
      <For each={extras()}>
        {(c) => (
          <div class="dgse-colrow">
            <Checkbox checked disabled={props.disabled} onChange={() => toggle(c, false)} label={<i>{c}</i>} />
          </div>
        )}
      </For>
    </div>
  );
}

/** Plain combo for a short list of strings. */
export function Choice(props: { value: string; options: string[]; onChange: (v: string) => void; disabled?: boolean; width?: number; allowEmpty?: boolean }): JSX.Element {
  const opts = (): ComboOption[] => [...(props.allowEmpty ? [{ value: "", label: "" }] : []), ...props.options.map((o) => ({ value: o, label: o }))];
  return <ComboBox options={opts()} value={props.value} onChange={props.onChange} disabled={props.disabled} width={props.width} />;
}

export function useToggle(initial: boolean): [() => boolean, () => void] {
  const [v, set] = createSignal(initial);
  return [v, () => set(!v())];
}
