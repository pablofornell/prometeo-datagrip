/**
 * Dump to SQL File dialog: the output file (save dialog), the options of `DumpOptions`, and while the dump runs a
 * progress bar (table and rows) with Cancel. The dialog closes when the dump ends; `onDone` reports the outcome.
 */
import { Show, createMemo, createSignal, type JSX } from "solid-js";
import { type DumpOptions, type DumpProgress, type DumpResult, type Driver, chooseExportPath, exportFolder } from "../../api/db";
import { cancelDump, dumpSchema } from "../../api/tauri";
import { Checkbox, Dialog, Icon, TextField, tip } from "../../components/ui";
import { errText } from "../table/ds";
import {
  defaultDumpOptions,
  dumpFileName,
  dumpFraction,
  dumpOptionsProblem,
  dumpProgressText,
  dumpScopeText,
  normalizeDumpOptions,
  parseBatchSize,
  parseCommitEvery,
  routinesLabel,
} from "./model";
import type { DumpTarget } from "./target";
import "./dump.css";

/** How a dump ended: the result (possibly cancelled, then no file is left), or the error message. */
export type DumpOutcome = { kind: "finished"; result: DumpResult; path: string } | { kind: "failed"; message: string };

export interface DumpDialogProps {
  target: DumpTarget;
  /** Name of the data source (the `Source:` field shows `schema [data source]`). */
  dsName: string;
  onClose: () => void;
  onDone: (outcome: DumpOutcome) => void;
}

const newDumpId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

export function DumpDialog(props: DumpDialogProps): JSX.Element {
  const driver: Driver = props.target.driver;
  const [opts, setOpts] = createSignal<DumpOptions>(defaultDumpOptions());
  const [batchText, setBatchText] = createSignal(String(defaultDumpOptions().batchSize));
  const [commitText, setCommitText] = createSignal(String(defaultDumpOptions().commitEvery));
  const [path, setPath] = createSignal("");
  const [running, setRunning] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [progress, setProgress] = createSignal<DumpProgress | undefined>();
  const [error, setError] = createSignal("");
  let dumpId = "";

  const patch = (p: Partial<DumpOptions>) => setOpts((o) => ({ ...o, ...p }));
  // unreadable numbers become 0 / -1, which the check reports (when rows are written at all)
  const current = (): DumpOptions => ({
    ...opts(),
    batchSize: parseBatchSize(batchText()) ?? 0,
    commitEvery: parseCommitEvery(commitText()) ?? -1,
  });
  const problem = createMemo(() => (path() ? (dumpOptionsProblem(current()) ?? "") : "Choose the output file."));
  // a table subset has no views, sequences or routines (the backend skips them), so their options do nothing
  const subset = () => !!props.target.tables;

  const browse = async () => {
    try {
      // the save dialog is the only way to pick the file: the backend writes nowhere else
      const p = await chooseExportPath(dumpFileName(props.target.schema), "sqlInsert", exportFolder(path()) ?? undefined);
      if (p) setPath(p);
    } catch (e) {
      setError(errText(e));
    }
  };

  const start = async () => {
    if (running() || problem()) return;
    dumpId = newDumpId();
    const file = path();
    setRunning(true);
    setCancelling(false);
    setProgress(undefined);
    setError("");
    try {
      const result = await dumpSchema(
        props.target.dsId,
        props.target.schema,
        normalizeDumpOptions(current(), props.target.tables),
        file,
        dumpId,
        (p) => setProgress(p),
      );
      props.onDone({ kind: "finished", result, path: file });
    } catch (e) {
      props.onDone({ kind: "failed", message: errText(e) });
    }
  };

  const cancel = () => {
    if (!running()) return props.onClose();
    setCancelling(true);
    void cancelDump(dumpId).catch(() => setCancelling(false));
  };

  // Esc and the close button do not abandon a running dump: Cancel does
  const close = () => {
    if (!running()) props.onClose();
  };

  const bar = () => {
    const p = progress();
    return p ? dumpFraction(p) : 0.3;
  };

  return (
    <Dialog
      title="Dump to SQL File"
      width={580}
      onClose={close}
      footerLeft={
        <Show when={problem() || error()}>
          <span class="dgd-problem" role="alert">
            {error() || problem()}
          </span>
        </Show>
      }
      buttons={[
        { label: "Dump", primary: true, disabled: running() || !!problem(), run: () => void start() },
        { label: "Cancel", disabled: cancelling(), run: cancel },
      ]}
    >
      <div class="dgd-root">
        <div class="dgt-export-opts">
          <label>Source:</label>
          <div class="dgd-source">
            {dumpScopeText(props.target.schema, props.target.tables)} [{props.dsName}]
          </div>
          <label>Output file:</label>
          <TextField
            value={path()}
            readOnly
            placeholder="Choose the output file"
            disabled={running()}
            suffix={
              <button type="button" class="dgt-export-browse" {...tip("Choose the output file")} tabindex={-1} disabled={running()} onClick={() => void browse()}>
                <Icon name="folder" size={16} />
              </button>
            }
          />
          <label>{driver === "mysql" ? "Target database:" : "Target schema:"}</label>
          <TextField
            value={opts().targetSchema ?? ""}
            placeholder={props.target.schema}
            disabled={running()}
            onInput={(v) => patch({ targetSchema: v })}
            {...tip("Restore into this schema instead of the dumped one (empty: the same)")}
          />
          <label>Rows per INSERT:</label>
          <TextField
            value={batchText()}
            disabled={running() || !opts().data}
            error={opts().data && parseBatchSize(batchText()) === null}
            onInput={(v) => setBatchText(v)}
          />
          <label>Commit every N rows:</label>
          <TextField
            value={commitText()}
            disabled={running() || !opts().data}
            error={opts().data && parseCommitEvery(commitText()) === null}
            onInput={(v) => setCommitText(v)}
            {...tip("0: commit only at the end")}
          />
        </div>
        <div class="dgt-export-checks">
          {/* without the structure the data is the whole dump: Data stays on */}
          <Checkbox
            checked={opts().includeDdl}
            disabled={running()}
            onChange={(v) => patch(v ? { includeDdl: true } : { includeDdl: false, data: true })}
            label="Structure (DDL)"
          />
          <Checkbox checked={opts().data} disabled={running() || !opts().includeDdl} onChange={(v) => patch({ data: v })} label="Data (INSERT statements)" />
          <Checkbox
            checked={opts().dropIfExists}
            disabled={running() || !opts().includeDdl}
            onChange={(v) => patch({ dropIfExists: v })}
            label="Drop statements before each create"
          />
          <Checkbox
            checked={opts().includeViews}
            disabled={running() || !opts().includeDdl || subset()}
            onChange={(v) => patch({ includeViews: v })}
            label="Views"
          />
          <Show when={driver === "postgres"}>
            <Checkbox
              checked={opts().includeSequences}
              disabled={running() || !opts().includeDdl || subset()}
              onChange={(v) => patch({ includeSequences: v })}
              label="Sequences"
            />
          </Show>
          <Checkbox
            checked={opts().includeRoutines}
            disabled={running() || !opts().includeDdl || subset()}
            onChange={(v) => patch({ includeRoutines: v })}
            label={routinesLabel(driver)}
          />
        </div>
        <Show when={running()}>
          <div class="dgd-progress">
            <div class="dg-progress">
              <span class="dg-progress-bar" classList={{ "dg-indeterminate": !progress()?.tablesTotal }} style={{ width: bar() * 100 + "%" }} />
            </div>
            <div class="dgd-progress-text">{progress() ? dumpProgressText(progress()!) : "Starting…"}</div>
          </div>
        </Show>
      </div>
    </Dialog>
  );
}
