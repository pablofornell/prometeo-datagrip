/** Small form widgets the UI kit does not have (segmented control, editable combo, file field, color field). */
import { For, type JSX, Show, createSignal, splitProps } from "solid-js";
import { Icon, TextField, openMenu } from "../../components/ui";
import type { MenuItem } from "../../components/ui";

/** `Label:` + control row of the General / SSH tabs. */
export function Row(props: { label: JSX.Element; children: JSX.Element; class?: string; disabled?: boolean; labelWidth?: number }) {
  return (
    <div class={"ds-row" + (props.class ? " " + props.class : "")} classList={{ "ds-disabled": props.disabled }}>
      <span class="ds-label" style={props.labelWidth ? { width: props.labelWidth + "px" } : undefined}>
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

/** Segmented button group: `default | In-memory | URL only`. */
export function Segmented<T extends string>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div class="ds-segmented" role="radiogroup">
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === o.value}
            class="ds-segment"
            classList={{ "ds-selected": props.value === o.value }}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** Editable combo: text input + chevron that lists suggestions (looks like the Database combo of DataGrip). */
export function EditableCombo(props: {
  value: string;
  onInput: (v: string) => void;
  /** Called when the chevron is pressed; resolves with the suggestions to list. */
  suggestions: () => Promise<string[]> | string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  let wrap!: HTMLDivElement;
  const open = async () => {
    if (props.disabled) return;
    let list: string[] = [];
    try {
      list = await props.suggestions();
    } catch {
      /* no suggestions */
    }
    if (!list.length) return;
    const items: MenuItem[] = list.map((s) => ({ label: s, checked: s === props.value, run: () => props.onInput(s) }));
    openMenu(items, { anchor: wrap, compact: true, minWidth: wrap.offsetWidth, selected: list.indexOf(props.value) });
  };
  return (
    <div ref={wrap} class="ds-editable-combo" classList={{ "dg-disabled": props.disabled }}>
      <input
        spellcheck={false}
        autocomplete="off"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      <span class="ds-editable-combo-arrow" onMouseDown={(e) => e.preventDefault()} onClick={() => void open()}>
        <Icon name="chevron-down" />
      </span>
    </div>
  );
}

/** Text field with a folder button at the right (file chooser through the Tauri dialog plugin). */
export function FileField(props: {
  value: string;
  onInput: (v: string) => void;
  onBrowse: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <TextField
      value={props.value}
      onInput={props.onInput}
      disabled={props.disabled}
      placeholder={props.placeholder}
      frameClass="ds-fill"
      suffix={
        <span class="ds-browse" onMouseDown={(e) => e.preventDefault()} onClick={() => !props.disabled && props.onBrowse()}>
          <Icon name="folder" />
        </span>
      }
    />
  );
}

// ---------------------------------------------------------------- color picker

export interface ColorOption {
  name: string;
  value: string;
}

/** Palette of the data source color (DataGrip's "Color" popup). */
export const COLORS: ColorOption[] = [
  { name: "Blue", value: "#3574F0" },
  { name: "Green", value: "#5FB865" },
  { name: "Yellow", value: "#E5C07B" },
  { name: "Orange", value: "#E08855" },
  { name: "Red", value: "#DB5C5C" },
  { name: "Purple", value: "#9C6FD6" },
  { name: "Gray", value: "#8B8E94" },
];

export const swatch = (color: string) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="3" fill="${color}"/></svg>`,
  );

export const colorLabel = (c: string | null): string | null => (c ? (COLORS.find((x) => x.value.toLowerCase() === c.toLowerCase())?.name ?? c) : null);

/** "Color ⌄" selector that lives inside the Name field. */
export function ColorSelect(props: { value: string | null; onChange: (c: string | null) => void }) {
  let btn!: HTMLButtonElement;
  let picker!: HTMLInputElement;
  const open = () => {
    const items: MenuItem[] = [
      { label: "No color", checked: !props.value, run: () => props.onChange(null) },
      { type: "separator" },
      ...COLORS.map<MenuItem>((c) => ({
        label: c.name,
        icon: swatch(c.value),
        checked: props.value?.toLowerCase() === c.value.toLowerCase(),
        run: () => props.onChange(c.value),
      })),
      { type: "separator" },
      { label: "Custom…", run: () => picker.click() },
    ];
    openMenu(items, { anchor: btn, compact: true, minWidth: 140, onClose: () => btn.focus({ preventScroll: true }) });
  };
  return (
    <>
      <button type="button" ref={btn} class="ds-color-select" onMouseDown={(e) => e.preventDefault()} onClick={open}>
        <Show when={props.value}>
          <Icon src={swatch(props.value!)} />
        </Show>
        <span>{colorLabel(props.value) ?? "Color"}</span>
        <Icon name="chevron-down" />
      </button>
      <input
        ref={picker}
        type="color"
        class="ds-color-input"
        tabindex={-1}
        value={/^#[0-9a-f]{6}$/i.test(props.value ?? "") ? props.value! : "#3574f0"}
        onInput={(e) => props.onChange(e.currentTarget.value)}
      />
    </>
  );
}

/** Link-style text button ("Test Connection", "Add comment"). */
export function LinkButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [own, rest] = splitProps(props, ["class"]);
  return <button type="button" {...rest} class={"ds-link" + (own.class ? " " + own.class : "")} />;
}

/** Small controlled toggle used by tabs that keep a "section open" flag. */
export const createToggle = (initial = false) => {
  const [v, set] = createSignal(initial);
  return [v, () => set(!v())] as const;
};
