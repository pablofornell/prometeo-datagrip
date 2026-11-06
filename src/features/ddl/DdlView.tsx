/** DDL view (`editor.view.ddl`): 34px toolbar (reload, open data) over a read-only SQL editor (`73-ddl-view`). */
import { Show, createEffect, createSignal, onMount, type JSX } from "solid-js";
import { getDdl } from "../../api/db";
import { SqlEditor } from "../../components/editor";
import { ActionButton, notify } from "../../components/ui";
import { setStatus } from "../../state/status";
import type { EditorTab } from "../../state/tabs";
import { ensureConnected } from "../explorer";
import { type ObjectTabData, openTableTab } from "../table/commands";
import { dsInfo, errText, loadDataSources } from "../table/ds";
import "./ddl.css";

export function DdlView(props: { tab: EditorTab; active: boolean }): JSX.Element {
  const data = props.tab.data as ObjectTabData | undefined;
  if (!data?.dsId || !data.objectRef) return <div class="dgd-message">This DDL view has no object to show.</div>;
  return <Ddl tab={props.tab} active={props.active} dsId={data.dsId} objectRef={data.objectRef} />;
}

function Ddl(props: { tab: EditorTab; active: boolean; dsId: string; objectRef: NonNullable<ObjectTabData>["objectRef"] }): JSX.Element {
  const ref = props.objectRef;
  const [text, setText] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const ds = () => dsInfo(props.dsId);
  const hasData = ref.kind === "table" || ref.kind === "view" || ref.kind === "materializedView";

  async function load(): Promise<void> {
    try {
      await loadDataSources();
      await ensureConnected(props.dsId);
      setText(await getDdl(props.dsId, ref));
      setError(null);
      setLoaded(true);
    } catch (e) {
      // the first load shows the error inside the tab (restored tabs must not raise a balloon each);
      // a failed Reload of a DDL that is already shown has no other place to report
      setError(errText(e));
      if (loaded()) notify({ kind: "error", title: "Cannot generate the DDL", body: errText(e) });
    }
  }
  onMount(() => void load());

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
      <div class="dgd-body">
        <Show when={loaded()}>
          <SqlEditor
            value={text()}
            dialect={ds()?.driver ?? "postgres"}
            readOnly
            statementFrame={false}
            onCaretChange={onCaret}
            sourceLabel={ds()?.name}
            defaultSchema={ref.schema ?? undefined}
          />
        </Show>
        <Show when={error() && !loaded()}>
          <div class="dgd-message dgd-error">{error()}</div>
        </Show>
      </div>
    </div>
  );
}

