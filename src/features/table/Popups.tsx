/** Popups of the table editor: SQL preview (pending changes / query), column filter, export dialog, confirmations. */
import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { ColumnMeta, Driver, ExportFormat, ExportOptions } from "../../api/types";
import { SqlEditor } from "../../components/editor";
import { Button, Checkbox, ComboBox, Dialog, TextField } from "../../components/ui";
import { FILTER_OPS, type FilterOp } from "./sql";

// ---------------------------------------------------------------- SQL popup (`60-grid-preview-pending-changes-popup`)

export interface SqlPopupProps {
  sql: string;
  dialect: Driver;
  /** Blue default button (Submit); omitted for a plain viewer. */
  primary?: { label: string; run: () => void };
  secondaryLabel?: string;
  onClose: () => void;
}

export function SqlPopup(props: SqlPopupProps): JSX.Element {
  let box!: HTMLDivElement;
  onMount(() => {
    box.focus();
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      }
    };
    box.addEventListener("keydown", down);
  });
  return (
    <Portal>
      <div class="dgt-sqlpop-overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        <div ref={box} class="dgt-sqlpop" tabindex={-1} role="dialog">
          <div class="dgt-sqlpop-editor" classList={{ compact: !props.primary }}>
            <SqlEditor value={props.sql} dialect={props.dialect} readOnly gutter={false} stripe={false} statementFrame={false} />
          </div>
          <div class="dgt-sqlpop-footer">
            <Show when={props.primary}>
              {(p) => (
                <Button primary onClick={p().run}>
                  {p().label}
                </Button>
              )}
            </Show>
            <Button onClick={props.onClose}>{props.secondaryLabel ?? "Cancel"}</Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------- column filter (funnel in a header)

export interface ColumnFilterProps {
  column: ColumnMeta;
  anchor: DOMRect;
  onApply: (op: FilterOp, value: string) => void;
  onClose: () => void;
}

export function ColumnFilterPopup(props: ColumnFilterProps): JSX.Element {
  const [op, setOp] = createSignal<FilterOp>("=");
  const [value, setValue] = createSignal("");
  const noValue = () => op() === "is null" || op() === "is not null";
  const apply = () => props.onApply(op(), value());
  let box!: HTMLDivElement;
  onMount(() => {
    const away = (e: MouseEvent) => {
      if (!box.contains(e.target as Node) && !(e.target as Element).closest(".dg-menu")) props.onClose();
    };
    window.addEventListener("mousedown", away, true);
    onCleanup(() => window.removeEventListener("mousedown", away, true));
  });
  const left = () => Math.max(4, Math.min(props.anchor.left, window.innerWidth - 300));
  return (
    <Portal>
      <div
        ref={box}
        class="dgt-colfilter"
        style={{ left: left() + "px", top: props.anchor.bottom + 4 + "px" }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
        }}
      >
        <div class="dgt-colfilter-title">Filter by {props.column.name}</div>
        <div class="dgt-colfilter-row">
          <ComboBox width={110} options={FILTER_OPS} value={op()} onChange={setOp} />
          <TextField
            value={value()}
            disabled={noValue()}
            placeholder={noValue() ? "" : "Value"}
            onInput={setValue}
            ref={(el) => queueMicrotask(() => el.focus())}
            frameClass="dgt-colfilter-field"
          />
        </div>
        <div class="dgt-colfilter-footer">
          <Button primary onClick={apply}>
            Apply
          </Button>
          <Button onClick={props.onClose}>Cancel</Button>
        </div>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------- export dialog

export const EXPORT_FORMATS: { value: ExportFormat; label: string; ext: string; mime: string }[] = [
  { value: "csv", label: "CSV", ext: "csv", mime: "text/csv" },
  { value: "tsv", label: "TSV", ext: "tsv", mime: "text/tab-separated-values" },
  { value: "json", label: "JSON", ext: "json", mime: "application/json" },
  { value: "sqlInsert", label: "SQL Inserts", ext: "sql", mime: "application/sql" },
  { value: "markdown", label: "Markdown", ext: "md", mime: "text/markdown" },
];

export type ExportTarget = "file" | "clipboard";

export interface ExportDialogProps {
  options: ExportOptions;
  target: ExportTarget;
  onClose: () => void;
  onExport: (options: ExportOptions, target: ExportTarget) => void;
}

export function ExportDialog(props: ExportDialogProps): JSX.Element {
  const [opts, setOpts] = createSignal<ExportOptions>(props.options);
  const [target, setTarget] = createSignal<ExportTarget>(props.target);
  const patch = (p: Partial<ExportOptions>) => setOpts((o) => ({ ...o, ...p }));
  const textual = () => ["csv", "tsv", "markdown"].includes(opts().format);
  const run = () => props.onExport(opts(), target());
  return (
    <Dialog
      title="Export Data"
      width={420}
      onClose={props.onClose}
      buttons={[
        { label: "Export", primary: true, run },
        { label: "Cancel", run: props.onClose },
      ]}
    >
      <div class="dgt-export">
        <label>Extractor</label>
        <ComboBox options={EXPORT_FORMATS} value={opts().format} onChange={(f) => patch({ format: f })} />
        <label>Output</label>
        <ComboBox
          options={[
            { value: "file", label: "File" },
            { value: "clipboard", label: "Clipboard" },
          ]}
          value={target()}
          onChange={setTarget}
        />
        <Show when={textual()}>
          <label>NULL text</label>
          <TextField value={opts().nullText} onInput={(v) => patch({ nullText: v })} />
        </Show>
        <Show when={textual()}>
          <span />
          <Checkbox checked={opts().header} onChange={(v) => patch({ header: v })} label="Write column names" />
        </Show>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- confirmation with several answers

export interface ChoiceDialogProps {
  title: string;
  message: JSX.Element;
  choices: { label: string; value: string; primary?: boolean }[];
  /** Answer for Esc / the close button. */
  cancel: string;
  onAnswer: (value: string) => void;
}

export function ChoiceDialog(props: ChoiceDialogProps): JSX.Element {
  return (
    <Dialog
      title={props.title}
      width={440}
      onClose={() => props.onAnswer(props.cancel)}
      buttons={props.choices.map((c) => ({ label: c.label, primary: c.primary, run: () => props.onAnswer(c.value) }))}
    >
      <div class="dgt-choice">{props.message}</div>
    </Dialog>
  );
}
