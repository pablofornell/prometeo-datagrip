/**
 * DDL view (`editor.view.ddl`): 34px toolbar (reload, open data) over a SQL editor (`73-ddl-view`). The text is
 * editable; once it differs from the generated one a banner offers `Submit` (the text goes to a new query console of
 * the data source, where it is run) and `Revert`. Names of the object's own schema are written unqualified.
 */
import { Show, createEffect, createSignal, on, onMount, type JSX } from "solid-js";
import { createConsole, getDdl, writeConsole } from "../../api/db";
import { SqlEditor, type SqlEditorHandle } from "../../components/editor";
import { ActionButton, notify } from "../../components/ui";
import { setStatus } from "../../state/status";
import type { EditorTab } from "../../state/tabs";
import { ensureConnected, openConsoleTab } from "../explorer";
import { type ObjectTabData, openTableTab } from "../table/commands";
import { dsInfo, errText, loadDataSources } from "../table/ds";
import { ddlLineOf } from "./line";
import "./ddl.css";

export function DdlView(props: { tab: EditorTab; active: boolean }): JSX.Element {
  const data = props.tab.data as ObjectTabData | undefined;
  if (!data?.dsId || !data.objectRef) return <div class="dgd-message">This DDL view has no object to show.</div>;
  return <Ddl tab={props.tab} active={props.active} dsId={data.dsId} objectRef={data.objectRef} />;
}

/** Offset of the definition of `column` in a generated `create table` (first line that starts with its name). */
function columnOffset(text: string, column: string): number | null {
  const esc = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^[ \\t]*["\`\\[]?${esc}["\`\\]]?(?=[\\s,)])`, "im").exec(text);
  if (!m) return null;
  return m.index + m[0].length - m[0].trimStart().length;
}

function Ddl(props: { tab: EditorTab; active: boolean; dsId: string; objectRef: NonNullable<ObjectTabData>["objectRef"] }): JSX.Element {
  const ref = props.objectRef;
  /** What the editor shows (set on load and Revert; typing only changes `current`). */
  const [text, setText] = createSignal("");
  /** The generated DDL the edits are compared with. */
  const [original, setOriginal] = createSignal("");
  const [current, setCurrent] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const ds = () => dsInfo(props.dsId);
  const hasData = ref.kind === "table" || ref.kind === "view" || ref.kind === "materializedView";

  /** A load is under way (the first DBMS_METADATA call of an Oracle session can take many seconds). */
  const [loading, setLoading] = createSignal(true);
  /** Only the latest load may show its result: a slow older one must not overwrite (or blank) a newer one. */
  let seq = 0;

  async function load(): Promise<void> {
    const mine = ++seq;
    setLoading(true);
    try {
      await loadDataSources();
      await ensureConnected(props.dsId);
      const ddl = await getDdl(props.dsId, ref, true);
      if (mine !== seq) return;
      setOriginal(ddl);
      setCurrent(ddl);
      setText(ddl);
      setError(null);
      setLoaded(true);
      setLoading(false);
    } catch (e) {
      if (mine !== seq) return;
      setLoading(false);
      // the first load shows the error inside the tab (restored tabs must not raise a balloon each);
      // a failed Reload of a DDL that is already shown has no other place to report
      setError(errText(e));
      if (loaded()) notify({ kind: "error", title: "Cannot generate the DDL", body: errText(e) });
    }
  }
  onMount(() => void load());

  const modified = () => loaded() && current() !== original();
  const revert = () => {
    setCurrent(original());
    setText(original());
  };
  /** Submit: the modified DDL opens in a new console of the data source, ready to run. */
  const submit = async (): Promise<void> => {
    try {
      const name = await createConsole(props.dsId);
      await writeConsole(props.dsId, name, current());
      openConsoleTab(props.dsId, name);
    } catch (e) {
      notify({ kind: "error", title: "Cannot create a query console", body: errText(e) });
    }
  };

  // Ctrl+B on a column in a console: the caret goes to that column's definition
  let editor: SqlEditorHandle | undefined;
  const revealColumn = (): void => {
    const col = (props.tab.data as { column?: string } | undefined)?.column;
    const at = col && editor ? columnOffset(text(), col) : null;
    if (at !== null && col) editor?.revealRange({ from: at, to: at });
  };
  createEffect(on(() => (props.tab.data as { column?: string } | undefined)?.column, revealColumn, { defer: true }));

  // Find Usages: the line a usage names (`line`, with its text as the hint, see ./line). Keyed on the tab's data, which
  // is replaced each time the DDL is opened, so the same usage opened again goes to its line again.
  const revealUsageLine = (): void => {
    const d = props.tab.data as { line?: number; lineText?: string } | undefined;
    const doc = editor?.view?.state.doc;
    if (!d?.line || !editor || !doc) return;
    const l = doc.line(ddlLineOf(doc.toString(), d.lineText, d.line));
    editor.revealRange({ from: l.from, to: l.to });
  };
  createEffect(on(() => props.tab.data, revealUsageLine, { defer: true }));

  createEffect(() => {
    if (props.active) setStatus({ aggregator: null, caret: null });
  });

  const onCaret = (line: number, col: number) => {
    if (props.active) setStatus({ caret: { line, col }, aggregator: null });
  };

  return (
    <div class="dgd-view">
      <div class="dgd-toolbar" role="toolbar">
        <ActionButton icon="refresh" title="Reload DDL" onClick={() => void load()} />
        <Show when={hasData}>
          <ActionButton icon="dg/table" title="Open Table Data" onClick={() => void openTableTab(props.dsId, ref)} />
        </Show>
      </div>
      <Show when={modified()}>
        <div class="dgd-banner" role="status">
          <span>The DDL was modified.</span>
          <a class="dgd-banner-link" onClick={() => void submit()} title="Open the modified DDL in a query console to run it">
            Submit
          </a>
          <span class="dgd-banner-sep" />
          <a class="dgd-banner-link" onClick={revert}>
            Revert
          </a>
        </div>
      </Show>
      <div class="dgd-body">
        <Show when={loaded()}>
          <SqlEditor
            value={text()}
            dialect={ds()?.driver ?? "postgres"}
            onChange={setCurrent}
            statementFrame={false}
            onCaretChange={onCaret}
            ref={(h) => {
              editor = h;
              revealColumn();
              revealUsageLine();
            }}
            sourceLabel={ds()?.name}
            defaultSchema={ref.schema ?? undefined}
          />
        </Show>
        <Show when={loading() && !loaded()}>
          <div class="dgd-message">Loading DDL...</div>
        </Show>
        <Show when={error() && !loaded() && !loading()}>
          <div class="dgd-message dgd-error">{error()}</div>
        </Show>
      </div>
    </div>
  );
}

