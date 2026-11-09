/** Popups of the table editor: SQL preview (pending changes / query), column filter, export dialog, confirmations. */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { ColumnMeta, Driver, ExportFormat, ExportOptions } from "../../api/types";
import { SqlEditor } from "../../components/editor";
import { approveExportPath, chooseExportPath, defaultExportPath, exportFolder, isTauri } from "../../api/db";
import { Button, Checkbox, ComboBox, Dialog, Icon, TextField, tip } from "../../components/ui";
import { EXPORT_CHARSETS, EXTRACTORS } from "../output/extractors";
import { FILTER_OPS, type FilterOp } from "./sql";

// ---------------------------------------------------------------- SQL popup (`60-grid-preview-pending-changes-popup`)

export interface SqlPopupProps {
  /** Heading above the statement (`Query`). */
  title?: string;
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
        <div ref={box} class="dgt-sqlpop" tabindex={-1} role="dialog" aria-label={props.title}>
          <Show when={props.title}>
            <div class="dgt-sqlpop-title">{props.title}</div>
          </Show>
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

export const EXPORT_FORMATS: { value: ExportFormat; label: string; ext: string; mime: string }[] = EXTRACTORS.map((x) => ({ value: x.id, label: x.label, ext: x.ext, mime: x.mime }));

export type ExportTarget = "file" | "clipboard";

/** The dialog's "Output file": the path, and whether the save dialog (folder button) already picked it. */
export interface ExportPath {
  path: string;
  chosen: boolean;
}

export interface ExportDialogProps {
  options: ExportOptions;
  /** Text of the read-only `Source:` field (`main.orders`). */
  source: string;
  /** Name of the default output file, without extension (`main_orders`). */
  fileBase: string;
  /** The text of the first rows in the given options (`Export preview`). */
  preview: (options: ExportOptions) => Promise<string>;
  onClose: () => void;
  onExport: (options: ExportOptions, target: ExportTarget, out: ExportPath) => void;
}

const PREVIEW_ROWS = 10;

/** `main.orders` -> `main_orders`: the default file name of a source. */
export const exportFileBase = (source: string): string => source.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "export";

/**
 * Export Data dialog (`106-export-data-dialog-dark.png`): extractor and options on the left, the live preview of
 * the first rows on the right. Used by the grid's Export Data button, the explorer and the table editor.
 */
export function ExportDialog(props: ExportDialogProps): JSX.Element {
  const [opts, setOpts] = createSignal<ExportOptions>(props.options);
  const patch = (p: Partial<ExportOptions>) => setOpts((o) => ({ ...o, ...p }));
  const ext = (f: ExportFormat) => EXPORT_FORMATS.find((x) => x.value === f)?.ext ?? "csv";
  const [path, setPath] = createSignal(`${props.fileBase}.${ext(props.options.format)}`);
  const [chosen, setChosen] = createSignal(false);
  const [preview, setPreview] = createSignal("");
  const [error, setError] = createSignal("");
  /** Why the backend refused the typed output file (the save dialog is then offered). */
  const [pathError, setPathError] = createSignal("");
  const fmt = () => opts().format;
  const textual = () => ["csv", "tsv", "markdown", "csvPipe", "csvSemicolon"].includes(fmt());
  const nullable = () => textual() || ["html", "pretty"].includes(fmt());
  const sqlTable = () => ["sqlInsert", "sqlUpdate"].includes(fmt());
  const out = (): ExportPath => ({ path: path().trim(), chosen: chosen() });
  const canExport = () => path().trim().length > 0;

  // the default folder is the user's home (decided by the backend); a typed path is checked on export
  void defaultExportPath(`${props.fileBase}.${ext(props.options.format)}`).then((p) => p && !chosen() && path().startsWith(props.fileBase) && setPath(p));

  // the extension follows the extractor as long as the name still ends with the previous one
  const changeFormat = (f: ExportFormat) => {
    setPathError("");
    const old = `.${ext(fmt())}`;
    if (path().endsWith(old)) setPath(path().slice(0, -old.length) + `.${ext(f)}`);
    patch({ format: f });
  };

  // the preview follows every option (the last request wins)
  let seq = 0;
  createEffect(() => {
    const o = opts();
    const n = ++seq;
    props.preview(o).then(
      (t) => n === seq && (setPreview(t), setError("")),
      (e) => n === seq && (setPreview(""), setError(String((e as Error)?.message ?? e).replace(/^Error:\s*/, ""))),
    );
  });
  const lines = () => {
    const l = preview().replace(/\n$/, "").split("\n");
    return preview() ? l : [];
  };

  const browse = async () => {
    try {
      // opens in the folder that was typed (when it exists)
      const p = await chooseExportPath(path().split("/").pop() || undefined, fmt(), exportFolder(path()) ?? undefined);
      if (p) (setPath(p), setChosen(true), setPathError(""));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const run = async (target: ExportTarget) => {
    if (target === "file" && isTauri() && !chosen()) {
      // a typed path: the backend approves it or says why not; only then the save dialog is offered
      try {
        const why = await approveExportPath(path().trim(), fmt());
        if (why) return setPathError(why);
      } catch (e) {
        return setPathError(String((e as Error)?.message ?? e));
      }
      return props.onExport(opts(), target, { path: path().trim(), chosen: true });
    }
    props.onExport(opts(), target, out());
  };
  return (
    <Dialog
      title="Export Data"
      width={820}
      onClose={props.onClose}
      buttons={[
        { label: "Export to File", primary: true, disabled: !canExport(), run: () => run("file") },
        { label: "Cancel", run: props.onClose },
        { label: "Copy to Clipboard", run: () => run("clipboard") },
      ]}
    >
      <div class="dgt-export">
        <div class="dgt-export-left">
          <label>Source:</label>
          <div class="dgt-export-source">{props.source}</div>
          <label>Extractor:</label>
          <ComboBox options={EXPORT_FORMATS} value={fmt()} onChange={changeFormat} />
          <label>Charset:</label>
          <ComboBox options={EXPORT_CHARSETS} value={opts().encoding ?? "utf8"} onChange={(v) => patch({ encoding: v })} />
          <div class="dgt-export-checks">
            <Checkbox checked={!!opts().transpose} onChange={(v) => patch({ transpose: v })} label="Transpose" />
            <Checkbox checked={opts().header} disabled={!textual()} onChange={(v) => patch({ header: v })} label="Add column header" />
            <Checkbox checked={!!opts().rowHeader} disabled={!textual()} onChange={(v) => patch({ rowHeader: v })} label="Add row header" />
          </div>
          <Show when={nullable()}>
            <div class="dgt-export-opts">
              <label>NULL text:</label>
              <TextField value={opts().nullText} onInput={(v) => patch({ nullText: v })} />
              <Show when={fmt() === "csv"}>
                <label>Delimiter:</label>
                <TextField value={opts().delimiter ?? ","} maxLength={1} onInput={(v) => patch({ delimiter: v || null })} />
                <label>Quote:</label>
                <TextField value={opts().quote} maxLength={1} onInput={(v) => patch({ quote: v || '"' })} />
              </Show>
            </div>
          </Show>
          <Show when={sqlTable()}>
            <div class="dgt-export-opts">
              <label>Table name:</label>
              <TextField value={opts().tableName ?? ""} onInput={(v) => patch({ tableName: v || null })} />
              <Show when={fmt() === "sqlInsert"}>
                <label>Rows per INSERT:</label>
                <TextField value={String(opts().rowsPerInsert)} onInput={(v) => patch({ rowsPerInsert: Math.max(1, parseInt(v, 10) || 1) })} />
              </Show>
            </div>
          </Show>
          <label>Output file:</label>
          <TextField
            value={path()}
            onInput={(v) => (setPath(v), setChosen(false), setPathError(""))}
            suffix={
              <button type="button" class="dgt-export-browse" {...tip("Choose the output file")} tabindex={-1} onClick={() => void browse()}>
                <Icon name="folder" size={16} />
              </button>
            }
          />
          <Show when={pathError()}>
            <div class="dgt-export-patherr" role="alert">
              {pathError()}{" "}
              <button type="button" class="dgt-export-link" onClick={() => void browse()}>
                Choose location...
              </button>
            </div>
          </Show>
        </div>
        <div class="dgt-export-right">
          <label>Export preview (first {PREVIEW_ROWS} rows are shown):</label>
          <div class="dgt-export-preview">
            <Show when={!error()} fallback={<div class="dgt-export-error">{error()}</div>}>
              <div class="dgt-export-gutter">
                <For each={[...lines(), ""]}>{(_, i) => <div>{i() + 1}</div>}</For>
              </div>
              <pre class="dgt-export-text">{preview()}</pre>
            </Show>
          </div>
        </div>
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

/**
 * A wait that cannot be cancelled (the COMMIT / ROLLBACK of the quit guard). `stuck` adds the warning and the
 * "Quit anyway" button; Esc and the close button do nothing meanwhile.
 */
export interface ProgressDialogProps {
  title: string;
  message: string;
  stuck: boolean;
  warning: string;
  quitAnywayLabel: string;
  onQuitAnyway: () => void;
}

export function ProgressDialog(props: ProgressDialogProps): JSX.Element {
  return (
    <Dialog
      title={props.title}
      width={440}
      onClose={() => {}}
      buttons={props.stuck ? [{ label: props.quitAnywayLabel, run: () => props.onQuitAnyway() }] : []}
    >
      <div class="dgt-choice">
        {props.message}
        <Show when={props.stuck}>{"\n\n" + props.warning}</Show>
      </div>
    </Dialog>
  );
}
