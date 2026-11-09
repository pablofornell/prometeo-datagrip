import { Match, Show, Switch, createMemo, createSignal, onMount, type JSX } from "solid-js";
import "./value/value.css";
import { base64ToBytes, bytesToHex, formatBytes, hexToBytes, utf8Decode, utf8Encode } from "./value/bytes";
import { HexView } from "./value/HexView";
import { IMAGE_EXTENSION, detectImage } from "./value/magic";
import { ImageView } from "./value/ImageView";
import { JsonTree } from "./value/JsonTree";
import { isContainer, parseJsonText } from "./value/json";
import { loadValue, saveValue } from "./value/files";
import { isLargeValue } from "./value/size";
import type { CellFull } from "./value/types";
import { isBinaryCell } from "./format";
import type { Cell, ColumnKind } from "./types";

interface Props {
  title: string;
  typeName: string;
  /** The cell as the grid shows it: the text of a text value, or the `0x…` preview of a binary one. */
  text: string;
  /** The raw cell (a binary preview is `{ $bin, len, truncated }`). */
  cell?: Cell;
  /** Column kind: a `binary` column gets the binary view even when its cell is NULL. */
  kind?: ColumnKind;
  /** json / jsonb column: the text is pretty-printed and the JSON tab is offered. */
  json?: boolean;
  /** Read-only results (or no editing): no Apply, no file load. */
  readOnly?: boolean;
  /** Editable table cell: a file may be loaded into it. */
  canLoad?: boolean;
  /** The whole value of a truncated binary preview (table rows with a primary key). Omitted: the preview only. */
  loadFull?: () => Promise<CellFull>;
  /** Text / JSON value: the text to store (OK / Ctrl+Enter). */
  onApply: (text: string) => void;
  /** Binary value: the `{ $bin, len }` to store (after a file was loaded). */
  onApplyValue?: (value: Cell) => void;
  onCancel: () => void;
}

type Tab = "text" | "json" | "image" | "hex";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Popup editor for a cell (Shift+Enter in DataGrip). Text and JSON are edited as before; binary values are viewed in tabs, saved to a file, and in an editable table replaced by a file. */
export function ValueEditor(props: Props): JSX.Element {
  let root!: HTMLDivElement;
  let ta: HTMLTextAreaElement | undefined;

  const bin0 = isBinaryCell(props.cell) ? props.cell : null;
  const binary = props.kind === "binary" || bin0 !== null;
  const isNull = props.cell === null || props.cell === undefined;

  // binary: the bytes shown: the preview of a binary cell, the text of a text cell in a binary column, or the whole
  // value once loaded or read from a file
  const preview = bin0 ? (hexToBytes(bin0.$bin) ?? new Uint8Array()) : isNull ? new Uint8Array() : utf8Encode(props.text);
  const [bytes, setBytes] = createSignal<Uint8Array>(preview);
  const [len, setLen] = createSignal(bin0?.len ?? preview.length);
  const [truncated, setTruncated] = createSignal(bin0 ? bin0.truncated === true || (bin0.len ?? 0) > preview.length : false);
  const [dirty, setDirty] = createSignal(false);
  const decoded = createMemo(() => (binary ? utf8Decode(bytes()) : null));
  const image = createMemo(() => (binary ? detectImage(bytes()) : null));

  // text: pretty-printed JSON when the column is json
  const initial = (() => {
    if (props.json) {
      try {
        return JSON.stringify(JSON.parse(props.text), null, 2);
      } catch {
        /* not JSON: show as is */
      }
    }
    return props.text;
  })();
  const [value, setValue] = createSignal(initial);

  const jsonOffered = createMemo(() => {
    if (props.json) return true;
    const t = binary ? decoded() : initial;
    return t !== null && isContainer(parseJsonText(t)?.value);
  });
  // the large dialog for binary, JSON and long values; short plain text keeps the compact one (decided when it opens)
  const large = isLargeValue(initial, { binary, json: jsonOffered() });
  const imageOffered = () => image() !== null;
  const [tab, setTab] = createSignal<Tab>(imageOffered() ? "image" : "text");
  const parsed = createMemo(() => (tab() === "json" ? parseJsonText(binary ? (decoded() ?? "") : value()) : null));

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    if (ta) {
      ta.focus();
      ta.setSelectionRange(initial.length, initial.length);
    } else root.focus();
  });

  /** The text / JSON tab stores text; a binary column stores bytes, and only once a file was loaded into it. */
  const primary = (): "text" | "binary" | null => {
    if (binary) return dirty() && props.canLoad && props.onApplyValue ? "binary" : null;
    return props.readOnly ? null : "text";
  };

  const applyPrimary = () => {
    if (primary() === "text") props.onApply(value());
    else if (primary() === "binary") {
      const b = bytes();
      props.onApplyValue?.({ $bin: bytesToHex(b), len: b.length });
    } else props.onCancel();
  };

  async function loadWhole() {
    if (!props.loadFull) return;
    setBusy(true);
    setError(null);
    try {
      const c = await props.loadFull();
      if (c.base64 === undefined) throw new Error("The value is not binary");
      setBytes(base64ToBytes(c.base64));
      setLen(c.len);
      setTruncated(c.truncated);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError(null);
    try {
      const img = image();
      const ext = binary ? (img ? IMAGE_EXTENSION[img] : "bin") : props.json ? "json" : "txt";
      await saveValue(props.title, ext, binary ? bytes() : utf8Encode(value()));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function loadFile() {
    setError(null);
    setBusy(true);
    try {
      const f = await loadValue();
      if (!f) return;
      if (binary) {
        setBytes(f.bytes);
        setLen(f.bytes.length);
        setTruncated(false);
        setDirty(true);
        setTab(imageOffered() ? "image" : utf8Decode(f.bytes) !== null ? "text" : "hex");
      } else {
        const t = utf8Decode(f.bytes);
        if (t === null) throw new Error(`${f.name} is not UTF-8 text: a text column takes text`);
        setValue(t);
        setTab("text");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const hint = (): string => {
    if (!binary) return props.readOnly ? "Read-only" : "Ctrl+Enter to apply, Esc to cancel";
    if (isNull && !dirty()) return "NULL";
    if (truncated()) {
      return props.loadFull
        ? `Showing the first ${formatBytes(bytes().length)} of ${formatBytes(len())}`
        : `Preview only: the first ${formatBytes(bytes().length)} of ${formatBytes(len())}`;
    }
    return `${formatBytes(len())}${props.readOnly ? " · read-only" : ""}`;
  };

  /** Why Save is off, or `null`. */
  const saveBlocked = (): string | null => {
    if (!binary) return null;
    if (truncated()) return props.loadFull ? "Load the full value first" : "Only the preview is available for this result";
    if (isNull && !dirty()) return "The value is NULL";
    return null;
  };

  const tabs = (): [Tab, string][] => {
    const out: [Tab, string][] = [["text", "Text"]];
    if (jsonOffered()) out.push(["json", "JSON"]);
    if (imageOffered()) out.push(["image", "Image"]);
    out.push(["hex", "Hex"]);
    return out;
  };

  return (
    <div
      ref={root}
      class="dgg-ve dgg-vx-dialog"
      classList={{ "dgg-vx-large": large }}
      tabIndex={-1}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          props.onCancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          applyPrimary();
        }
      }}
    >
      <div class="dgg-ve-head">
        <span class="dgg-ve-title">{props.title}</span>
        <span class="dgg-ve-type">{props.typeName}</span>
      </div>
      <div class="dgg-vx-tabs" role="tablist">
        {tabs().map(([id, label]) => (
          <button class="dgg-vx-tab" classList={{ on: tab() === id }} tabIndex={-1} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div class="dgg-vx-body">
        <Switch>
          <Match when={tab() === "text" && !binary}>
            <textarea
              ref={(el) => (ta = el)}
              class="dgg-ve-text"
              spellcheck={false}
              readOnly={props.readOnly}
              value={initial}
              onInput={(e) => setValue(e.currentTarget.value)}
            />
          </Match>
          <Match when={tab() === "text" && binary}>
            <Show
              when={decoded() !== null}
              fallback={
                <div class="dgg-vx-note dgg-vx-pad">
                  {truncated() ? "Load the full value to read it as text." : `Not UTF-8 text (${formatBytes(bytes().length)}). See the Hex or Image tab.`}
                </div>
              }
            >
              <textarea class="dgg-ve-text" spellcheck={false} readOnly value={decoded() ?? ""} />
            </Show>
          </Match>
          <Match when={tab() === "json"}>
            <Show
              when={parsed() !== null && isContainer(parsed()?.value)}
              fallback={<div class="dgg-vx-note dgg-vx-pad">{parsed() === null ? "Not valid JSON: see the Text tab." : "A JSON number, string, boolean or null: see the Text tab."}</div>}
            >
              <JsonTree value={parsed()?.value} />
            </Show>
          </Match>
          <Match when={tab() === "image" && image()}>
            {(kind) => <ImageView bytes={bytes()} kind={kind()} truncated={truncated()} />}
          </Match>
          <Match when={tab() === "hex"}>
            <HexView bytes={() => (binary ? bytes() : utf8Encode(value()))} />
          </Match>
        </Switch>
      </div>
      <Show when={error()}>
        <div class="dgg-vx-err">{error()}</div>
      </Show>
      <div class="dgg-ve-foot">
        <span class="dgg-ve-hint">{hint()}</span>
        <span class="dgg-ve-spacer" />
        <Show when={props.loadFull && truncated() && !dirty()}>
          <button class="dgg-btn" disabled={busy()} onClick={() => void loadWhole()}>
            Load full value
          </button>
        </Show>
        <button class="dgg-btn" disabled={busy() || saveBlocked() !== null} title={saveBlocked() ?? "Save the value to a file"} onClick={() => void save()}>
          Save to file…
        </button>
        <Show when={props.canLoad}>
          <button class="dgg-btn" disabled={busy()} title="Replace the value with the contents of a file" onClick={() => void loadFile()}>
            Load from file…
          </button>
        </Show>
        <button class="dgg-btn" onClick={() => props.onCancel()}>
          {props.readOnly || (binary && primary() === null) ? "Close" : "Cancel"}
        </button>
        <Show when={primary() !== null}>
          <button class="dgg-btn primary" disabled={busy()} onClick={applyPrimary}>
            {primary() === "binary" ? "Set value" : "OK"}
          </button>
        </Show>
      </div>
    </div>
  );
}
