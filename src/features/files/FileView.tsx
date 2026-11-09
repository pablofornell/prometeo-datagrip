/**
 * Content of a `file` editor tab (slot `editor.view.file`): a `.sql` file in the console editor. With a data source
 * the file is a full console (session, Tx, schema switcher, Database Output); without one it is a plain SQL editor
 * whose Run button asks for the data source first.
 */
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Icon, openMenu } from "../../components/ui";
import type { MenuItem } from "../../components/ui";
import { SqlEditor } from "../../components/editor";
import { setEditorPath, setStatus, type Crumb } from "../../state/status";
import type { EditorTab } from "../../state/tabs";
import { type ConsoleBacking, ConsoleEditor } from "../console";
import { dsOf } from "../console/ds";
import { registerEditor, unregisterEditor } from "../console/registry";
import { explorerDataSources } from "../explorer";
import { dsIconUrl } from "../output/dsicon";
import { ActionButton } from "../../components/ui";
import { acquireDoc, docOf, editDoc, fileTabData, fileTarget, releaseDoc, setFileTarget } from "./docs";

/** `Scratches › scratch.sql`, or `<folder> › file.sql` for a file from disk. */
export function crumbsOf(path: string, scratch: boolean): Crumb[] {
  const parts = path.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? path;
  const dir = scratch ? "Scratches" : (parts[parts.length - 2] ?? "/");
  return [{ label: dir }, { label: name, icon: "sql-file" }];
}

/** `<data source> ⌄` toolbar button: the data source chooser of a file. */
function TargetButton(props: { path: string }): JSX.Element {
  let btn!: HTMLButtonElement;
  const ds = () => {
    const id = fileTarget(props.path);
    return id ? dsOf(id) : undefined;
  };
  const choose = () => {
    const list = explorerDataSources();
    const items: MenuItem[] = list.length
      ? list.map<MenuItem>((d) => ({ label: d.name, icon: dsIconUrl(d.driver), checked: () => ds()?.id === d.id, run: () => setFileTarget(props.path, d.id) }))
      : [{ label: "No data sources", enabled: false }];
    openMenu(items, { anchor: btn, compact: true });
  };
  return (
    <button ref={btn} type="button" class="dgc-text-btn dgf-target" title="Choose the data source of this file" tabindex={-1} onMouseDown={(e) => e.preventDefault()} onClick={choose}>
      <Show when={ds()} fallback={<Icon name="dg/database" size={16} />}>
        {(d) => <Icon src={dsIconUrl(d().driver)} size={16} />}
      </Show>
      <span>{ds()?.name ?? "<data source>"}</span>
      <Icon name="chevron-down" size={16} />
    </button>
  );
}

export function FileView(props: { tab: EditorTab; active: boolean }): JSX.Element {
  const data = fileTabData(props.tab);
  if (!data) return <div class="dg-placeholder-center">This file tab has no path</div>;
  const path = data.path;
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let acquired = false;
  /** Run as soon as the editor of the freshly chosen data source is there (Run clicked before a data source was set). */
  let runWhenReady = false;
  let runBtn: HTMLButtonElement | undefined;

  onMount(() => {
    acquireDoc(path, data.scratch).then(
      () => ((acquired = true), setReady(true)),
      (e) => setError(String((e as Error)?.message ?? e)),
    );
  });
  onCleanup(() => acquired && releaseDoc(path));
  onCleanup(() => unregisterEditor(props.tab.id));

  // a file whose data source was deleted behaves as one without
  const dsId = createMemo(() => {
    const id = fileTarget(path);
    return id && dsOf(id) ? id : undefined;
  });

  // the plain editor reports its own path and encoding (the console editor does it itself)
  createEffect(() => {
    if (!props.active || dsId()) return;
    setEditorPath(crumbsOf(path, data.scratch));
    setStatus({ lineSeparator: "LF", encoding: "UTF-8", readOnly: false, txMode: null });
  });

  const backing: ConsoleBacking = {
    key: `file:${path}`,
    load: () => Promise.resolve(docOf(path)?.text ?? ""),
    change: (t) => editDoc(path, t),
    crumbs: () => crumbsOf(path, data.scratch),
    toolbarExtra: () => <TargetButton path={path} />,
    revision: () => docOf(path)?.rev ?? 0,
    onReady: (s) => {
      if (!runWhenReady) return;
      runWhenReady = false;
      s.executeFromEditor();
    },
  };

  /** Run without a data source: the chooser opens, the choice runs the statement. */
  const runWithoutSource = () => {
    const list = explorerDataSources();
    const items: MenuItem[] = list.length
      ? list.map<MenuItem>((d) => ({
          label: d.name,
          icon: dsIconUrl(d.driver),
          run: () => {
            runWhenReady = true;
            setFileTarget(path, d.id);
          },
        }))
      : [{ label: "No data sources", enabled: false }];
    openMenu(items, runBtn ? { anchor: runBtn, compact: true } : { x: 200, y: 120, compact: true });
  };

  return (
    <Show when={ready()} fallback={<div class="dg-placeholder-center">{error() ?? "Loading…"}</div>}>
      <Show
        when={dsId()}
        keyed
        fallback={
          <div class="dgc-view">
            <div class="dg-toolbar dgc-toolbar">
              <span class="dgc-run">
                <ActionButton icon="run" title="Run" ref={(el) => (runBtn = el)} onClick={runWithoutSource} />
              </span>
              <span class="dgc-spacer" />
              <TargetButton path={path} />
            </div>
            <div class="dgc-editor">
              <SqlEditor
                value={docOf(path)?.text ?? ""}
                onChange={(v) => editDoc(path, v)}
                dialect="postgres"
                onExecute={runWithoutSource}
                onCaretChange={(line, col) => {
                  if (props.active) setStatus("caret", { line, col });
                }}
                ref={(h) => {
                  registerEditor(props.tab.id, h);
                  if (props.active) h.focus();
                }}
                autofocus={props.active}
              />
            </div>
          </div>
        }
      >
        {(id) => <ConsoleEditor tab={props.tab} active={props.active} dsId={id} consoleName={backing.key} backing={backing} />}
      </Show>
    </Show>
  );
}
