/**
 * The run configuration editor (name, target data sources / schemas, script text or files, launch options) and the two
 * dialogs around it: the single-configuration dialog that opens when a file runs without a known target, and the
 * Run/Debug Configurations dialog (Run > Edit Configurations…).
 */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { chooseOpenFiles } from "../../api/db";
import { SqlEditor } from "../../components/editor";
import { ActionButton, Checkbox, Dialog, Icon, TextField, Tree, type MenuItem, type TreeItem, ToolbarSeparator, openMenu } from "../../components/ui";
import { dsOf } from "../console/ds";
import { connectedDataSourceIds, explorerDataSources, loadSchemaSnapshot } from "../explorer";
import { dsIconUrl } from "../output/dsicon";
import { type RunConfig, type RunTarget, baseName, newConfig, sameConfig, targetParts, uniqueName, validate } from "./model";
import { configs, removeConfig, saveConfig } from "./store";
import { startRun } from "./run";

function mount(view: (close: () => void) => JSX.Element): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(() => view(close), host);
  function close() {
    dispose();
    host.remove();
  }
}

const knownDs = (): Set<string> => new Set(explorerDataSources().map((d) => d.id));

// ---------------------------------------------------------------- the editor

function Radio(props: { checked: boolean; label: string; onSelect: () => void }): JSX.Element {
  return (
    <span class="dgr-radio" classList={{ "dgr-on": props.checked }} role="radio" aria-checked={props.checked} tabindex={0} onClick={props.onSelect} onKeyDown={(e) => (e.key === " " ? (e.preventDefault(), props.onSelect()) : undefined)}>
      <i class="dgr-radio-dot" />
      <span>{props.label}</span>
    </span>
  );
}

/** Up / down / remove of a list with a selected row. */
function moved<T>(list: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const c = list.slice();
  [c[i], c[j]] = [c[j], c[i]];
  return c;
}

/** The `+` popup of the targets list: data sources of the same DBMS as the targets already there, with their schemas. */
async function pickTarget(anchor: HTMLElement, cfg: RunConfig, add: (t: RunTarget) => void): Promise<void> {
  const driver = dsOf(cfg.targets[0]?.dsId ?? "")?.driver;
  const sources = explorerDataSources().filter((d) => !driver || d.driver === driver);
  const items: MenuItem[] = await Promise.all(
    sources.map(async (d): Promise<MenuItem> => {
      const base = { label: d.name, icon: dsIconUrl(d.driver) };
      const schemas = connectedDataSourceIds().has(d.id) && d.driver !== "sqlite" ? [...new Set((await loadSchemaSnapshot(d.id).catch(() => [])).map((o) => o.schema))].sort() : [];
      if (!schemas.length) return { ...base, run: () => add({ dsId: d.id }) };
      return { ...base, children: [{ label: "<default schema>", run: () => add({ dsId: d.id }) }, { type: "separator" }, ...schemas.map<MenuItem>((s) => ({ label: s, icon: "dg/schema", run: () => add({ dsId: d.id, schema: s }) }))] };
    }),
  );
  openMenu(items.length ? items : [{ label: "No compatible data sources", enabled: false }], { anchor, compact: true, minWidth: 260 });
}

export function ConfigEditor(props: { cfg: RunConfig; onChange: (c: RunConfig) => void }): JSX.Element {
  const c = () => props.cfg;
  const set = (p: Partial<RunConfig>) => props.onChange({ ...c(), ...p, temporary: false });
  const [selTarget, setSelTarget] = createSignal(-1);
  const [selFile, setSelFile] = createSignal(-1);
  const [beforeOpen, setBeforeOpen] = createSignal(true);
  let addTarget!: HTMLButtonElement;
  const dialect = () => dsOf(c().targets[0]?.dsId ?? "")?.driver ?? "postgres";

  return (
    <div class="dgr-editor">
      <div class="dgr-row dgr-name-row">
        <label for="dgr-name">
          <u>N</u>ame:
        </label>
        <TextField
          id="dgr-name"
          frameClass="dgr-name"
          value={c().name}
          ref={(el) =>
            queueMicrotask(() => {
              el.focus();
              el.select();
            })
          }
          onInput={(v) => set({ name: v })}
        />
        <Checkbox checked={c().allowMultiple} label="Allow multiple instances" onChange={(v) => set({ allowMultiple: v })} />
      </div>

      <div class="dgr-label">Target data source / schema:</div>
      <div class="dgr-box dgr-targets">
        <div class="dg-toolbar dgr-tb">
          <ActionButton icon="add" title="Add" ref={(el) => (addTarget = el)} onClick={() => void pickTarget(addTarget, c(), (t) => set({ targets: [...c().targets.filter((x) => x.dsId !== t.dsId || x.schema !== t.schema), t] }))} />
          <ActionButton icon="remove" title="Remove" disabled={selTarget() < 0} onClick={() => (set({ targets: c().targets.filter((_, i) => i !== selTarget()) }), setSelTarget(-1))} />
          <ActionButton icon="sort-ascending" title="Move Up" disabled={selTarget() < 1} onClick={() => (set({ targets: moved(c().targets, selTarget(), -1) }), setSelTarget(selTarget() - 1))} />
          <ActionButton icon="sort-descending" title="Move Down" disabled={selTarget() < 0 || selTarget() >= c().targets.length - 1} onClick={() => (set({ targets: moved(c().targets, selTarget(), 1) }), setSelTarget(selTarget() + 1))} />
        </div>
        <div class="dgr-list">
          <Show when={c().targets.length} fallback={<div class="dgr-empty">Target data sources</div>}>
            <For each={c().targets}>
              {(t, i) => {
                const ds = () => dsOf(t.dsId);
                return (
                  <div class="dgr-item" classList={{ "dgr-sel": selTarget() === i() }} onClick={() => setSelTarget(i())}>
                    <Show when={ds()} fallback={<Icon name="dg/database" />}>
                      {(d) => <Icon src={dsIconUrl(d().driver)} />}
                    </Show>
                    <span>{ds()?.name ?? "<deleted data source>"}</span>
                    <Show when={ds() && targetParts(ds()!, t).schema}>
                      <span class="dgr-schema">/ {targetParts(ds()!, t).schema}</span>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </div>

      <div class="dgr-row dgr-execute">
        <span>Execute:</span>
        <Radio checked={c().mode === "text"} label="Script text" onSelect={() => set({ mode: "text" })} />
        <Radio checked={c().mode === "files"} label="Script files" onSelect={() => set({ mode: "files" })} />
      </div>

      <Show
        when={c().mode === "files"}
        fallback={
          <div class="dgr-box dgr-text">
            <SqlEditor value={c().text} onChange={(v) => set({ text: v })} dialect={dialect()} />
          </div>
        }
      >
        <div class="dgr-box dgr-files">
          <div class="dg-toolbar dgr-tb">
            <ActionButton
              icon="add"
              title="Add"
              onClick={() =>
                void chooseOpenFiles().then((fs) => set({ files: [...c().files, ...fs.map((f) => f.path).filter((p) => !c().files.includes(p))] }))
              }
            />
            <ActionButton icon="remove" title="Remove" disabled={selFile() < 0} onClick={() => (set({ files: c().files.filter((_, i) => i !== selFile()) }), setSelFile(-1))} />
            <ActionButton icon="sort-ascending" title="Move Up" disabled={selFile() < 1} onClick={() => (set({ files: moved(c().files, selFile(), -1) }), setSelFile(selFile() - 1))} />
            <ActionButton icon="sort-descending" title="Move Down" disabled={selFile() < 0 || selFile() >= c().files.length - 1} onClick={() => (set({ files: moved(c().files, selFile(), 1) }), setSelFile(selFile() + 1))} />
          </div>
          <div class="dgr-list">
            <For each={c().files}>
              {(p, i) => (
                <div class="dgr-item" classList={{ "dgr-sel": selFile() === i() }} onClick={() => setSelFile(i())}>
                  <Icon name="sql-file" />
                  <span class="dgr-path">
                    {p.slice(0, p.length - baseName(p).length)}
                    <b>{baseName(p)}</b>
                  </span>
                  <Icon name="green-checkmark" class="dgr-ok" />
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="dgr-row dgr-options">
          <Checkbox checked={c().stopOnError} label="Stop on error" onChange={(v) => set({ stopOnError: v })} />
          <Checkbox checked={c().singleTransaction} label="Single transaction" onChange={(v) => set({ singleTransaction: v })} />
        </div>
      </Show>

      <div class="dgr-before">
        <button type="button" class="dgr-before-head" tabindex={-1} onClick={() => setBeforeOpen(!beforeOpen())}>
          <Icon name={beforeOpen() ? "chevron-down" : "chevron-right"} />
          <span>
            <u>B</u>efore launch
          </span>
          <hr />
        </button>
        <Show when={beforeOpen()}>
          <div class="dgr-box dgr-before-body">
            <div class="dgr-empty">There are no tasks to run before launch</div>
          </div>
        </Show>
      </div>

      <div class="dgr-row dgr-options">
        <Checkbox checked={c().showPage} label="Show this page" onChange={(v) => set({ showPage: v })} />
        <Checkbox checked={c().activateTool} label="Activate tool window" onChange={(v) => set({ activateTool: v })} />
        <Checkbox checked={c().focusTool} label="Focus tool window" onChange={(v) => set({ focusTool: v })} />
      </div>
    </div>
  );
}

const ErrorLine = (props: { error: string | null }): JSX.Element => (
  <Show when={props.error}>
    <span class="dgr-error">
      <Icon name="error" />
      <b>Error:</b> {props.error}
    </span>
  </Show>
);

// ---------------------------------------------------------------- single configuration (Run '<file>' without a target)

/** The editor for one configuration with Run / Cancel / Apply. Run saves and starts it. */
export function openRunDialog(initial: RunConfig): void {
  mount((close) => {
    const [cfg, setCfg] = createSignal<RunConfig>(initial);
    const error = createMemo(() => validate(cfg(), knownDs()));
    const changed = () => !sameConfig(cfg(), initial);
    const apply = () => saveConfig({ ...cfg(), temporary: false });
    return (
      <Dialog
        title="Run/Debug Configurations"
        width={640}
        onClose={close}
        footerLeft={<ErrorLine error={error()} />}
        buttons={[
          { label: "Run", primary: true, disabled: !!error(), run: () => (apply(), close(), startRun(cfg())) },
          { label: "Cancel", run: close },
          { label: "Apply", disabled: !changed() || !!error(), run: () => (apply(), close()) },
        ]}
      >
        <ConfigEditor cfg={cfg()} onChange={setCfg} />
      </Dialog>
    );
  });
}

// ---------------------------------------------------------------- Run/Debug Configurations

let editOpen = false;

/** Run > Edit Configurations…: the tree of configurations on the left, the editor on the right. */
export function openConfigurationsDialog(selectId?: string, create?: RunConfig): void {
  if (editOpen) return;
  editOpen = true;
  mount((close0) => {
    const close = () => (editOpen = false, close0());
    const [drafts, setDrafts] = createSignal<RunConfig[]>([...configs(), ...(create ? [create] : [])]);
    const [sel, setSel] = createSignal<string | null>(create?.id ?? selectId ?? drafts()[0]?.id ?? null);
    const current = () => drafts().find((d) => d.id === sel());
    const error = createMemo(() => (current() ? validate(current()!, knownDs()) : null));
    const changed = () => {
      const saved = configs();
      const d = drafts();
      return d.length !== saved.length || d.some((x) => !saved.some((s) => sameConfig(s, x)));
    };
    const apply = () => {
      const d = drafts();
      for (const s of configs()) if (!d.some((x) => x.id === s.id)) removeConfig(s.id);
      for (const x of d) if (!configs().some((s) => sameConfig(s, x))) saveConfig(x);
    };
    const items = (): TreeItem[] => [
      {
        id: "type",
        label: "Database Script",
        icon: "dg/sql-script",
        hasChildren: true,
        children: drafts().map<TreeItem>((d) => ({ id: d.id, label: d.name, icon: "dg/sql-script", labelClass: d.temporary ? "dgr-temp" : undefined })),
      },
    ];
    let addBtn!: HTMLButtonElement;
    const add = (base?: RunConfig) => {
      const c = newConfig({ ...(base ? { ...base, id: undefined } : {}), name: uniqueName(base?.name ?? "Unnamed", drafts().map((d) => d.name)), temporary: false } as Partial<RunConfig>);
      setDrafts([...drafts(), c]);
      setSel(c.id);
    };
    return (
      <Dialog
        title="Run/Debug Configurations"
        width={860}
        height={600}
        flush
        onClose={close}
        footerLeft={<ErrorLine error={error()} />}
        buttons={[
          { label: "Run", disabled: !current() || !!error(), run: () => (apply(), close(), startRun(current()!)) },
          { label: "OK", primary: true, run: () => (apply(), close()) },
          { label: "Cancel", run: close },
          { label: "Apply", disabled: !changed(), run: apply },
        ]}
      >
        <div class="dgr-split">
          <div class="dgr-left">
            <div class="dg-toolbar dgr-tb">
              <ActionButton
                icon="add"
                title="Add New Configuration"
                ref={(el) => (addBtn = el)}
                onClick={() => openMenu([{ label: "Database Script", icon: "dg/sql-script", run: () => add() }], { anchor: addBtn, title: "Add New Configuration", compact: true, minWidth: 260 })}
              />
              <ActionButton icon="remove" title="Remove Configuration" disabled={!current()} onClick={() => (setDrafts(drafts().filter((d) => d.id !== sel())), setSel(drafts()[0]?.id ?? null))} />
              <ActionButton icon="copy" title="Copy Configuration" disabled={!current()} onClick={() => current() && add(current()!)} />
              <ToolbarSeparator />
            </div>
            <Tree roots={items()} initialExpanded={["type"]} selectedId={sel()} onSelect={(it) => it && it.id !== "type" && setSel(it.id)} class="dgr-tree" />
          </div>
          <div class="dgr-right">
            <Show when={current()} fallback={<div class="dgr-empty dgr-none">Press the + button to create a new configuration</div>}>
              {(c) => <ConfigEditor cfg={c()} onChange={(n) => setDrafts(drafts().map((d) => (d.id === n.id ? n : d)))} />}
            </Show>
          </div>
        </div>
      </Dialog>
    );
  });
}
