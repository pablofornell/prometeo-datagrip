/** Content of a `console` editor tab (slot `editor.view.console`): toolbar + SQL editor bound to the console file. */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { listDataSources, readConsole, writeConsole } from "../../api/db";
import { SqlEditor, type SqlEditorHandle } from "../../components/editor";
import { setStatus } from "../../state/status";
import { type EditorTab, updateTab } from "../../state/tabs";
import { connectedDataSourceIds, explorerDataSources, schemaSnapshotFor } from "../explorer";
import { dsIconUrl } from "../output/dsicon";
import { markConsoleActive } from "../output/model";
import { txLabel } from "../table/session";
import { ConsoleToolbar } from "./ConsoleToolbar";
import { dsOf, toEditorSchema } from "./ds";
import { registerSession, unregisterSession } from "./registry";
import { ConsoleSession } from "./session";

const SAVE_DELAY = 600;

export function ConsoleView(props: { tab: EditorTab; active: boolean }): JSX.Element {
  const data = () => props.tab.data as { dsId?: string; consoleName?: string } | undefined;
  const ds = createMemo(
    () => (data()?.dsId ? dsOf(data()!.dsId!) : undefined),
    undefined,
    { equals: (a, b) => a?.id === b?.id },
  );
  return (
    <Show
      when={ds()}
      fallback={
        <div class="dg-placeholder-center">
          {!data()?.dsId ? "This console has no data source" : explorerDataSources().length ? "The data source of this console no longer exists" : "Loading data sources..."}
        </div>
      }
    >
      {(d) => <ConsoleInner tab={props.tab} active={props.active} dsId={d().id} consoleName={data()?.consoleName ?? "console"} />}
    </Show>
  );
}

function ConsoleInner(props: { tab: EditorTab; active: boolean; dsId: string; consoleName: string }): JSX.Element {
  const ds = dsOf(props.dsId)!;
  const session = new ConsoleSession(props.tab.id, ds, props.consoleName, () => props.tab.title);
  registerSession(session);

  const [text, setText] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [everActive, setEverActive] = createSignal(props.active);
  let caret = { line: 1, col: 1 };
  let editor: SqlEditorHandle | undefined;

  // ---- autosave (like DataGrip: no explicit save)
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const write = () => void writeConsole(props.dsId, props.consoleName, text()).catch(() => {});
  /**
   * Saves the script. A console of a data source that was deleted meanwhile is NOT written back (that would resurrect
   * its folder): the backend's list decides, since the explorer's own list is refreshed after the tabs are closed.
   */
  const flush = (checkDataSource = true) => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    if (!checkDataSource) return write();
    const body = text();
    void listDataSources().then(
      (l) => l.some((d) => d.id === props.dsId) && void writeConsole(props.dsId, props.consoleName, body).catch(() => {}),
      write,
    );
  };
  const flushNow = () => flush(false); // the page is going away: no time for a round trip
  onMount(() => {
    readConsole(props.dsId, props.consoleName)
      .then(setText, () => setText(""))
      .finally(() => setLoaded(true));
    window.addEventListener("beforeunload", flushNow);
    window.addEventListener("blur", flushNow);
  });
  onCleanup(() => {
    window.removeEventListener("beforeunload", flushNow);
    window.removeEventListener("blur", flushNow);
    flush();
    session.dispose();
    unregisterSession(props.tab.id);
  });

  // ---- completion data: loaded lazily, the first time the tab is shown
  const schema = createMemo(() => (everActive() ? toEditorSchema(schemaSnapshotFor(props.dsId), ds.database || undefined) : undefined));

  // ---- status bar, focus, eager session
  const pushStatus = () =>
    setStatus({
      path: [{ label: "Database Consoles" }, { label: ds.name }, { label: props.tab.title, icon: "dg/console" }],
      caret,
      lineSeparator: "LF",
      encoding: "UTF-8",
      readOnly: false,
    });
  createEffect(
    on(
      () => props.active,
      (a) => {
        if (!a) return;
        setEverActive(true);
        markConsoleActive(props.tab.id);
        pushStatus();
        requestAnimationFrame(() => editor?.focus());
      },
    ),
  );
  createEffect(() => {
    if (props.active) setStatus("txMode", txLabel(session.txMode(), session.txStatus()));
  });
  // the console's tab shows the DBMS icon of its data source, like DataGrip
  createEffect(() => {
    const icon = dsIconUrl(ds.driver);
    if (icon && props.tab.icon !== icon) updateTab(props.tab.id, { icon });
  });
  // the data source was disconnected / deactivated: the server rolled the open transaction back with the connection
  createEffect(() => {
    if (!connectedDataSourceIds().has(props.dsId) && session.sessionId) session.connectionClosed();
  });
  // open the DB session as soon as the data source is connected, so the schema switcher shows the real schema
  createEffect(() => {
    if (props.active && connectedDataSourceIds().has(props.dsId) && !session.sessionId) void session.ensureSession().catch(() => {});
  });

  return (
    <div class="dgc-view">
      <ConsoleToolbar session={session} />
      <div class="dgc-editor">
        <Show when={loaded()}>
          <SqlEditor
            value={text()}
            onChange={(v) => {
              setText(v);
              dirty = true;
              clearTimeout(timer);
              timer = setTimeout(flush, SAVE_DELAY);
            }}
            dialect={ds.driver}
            schema={schema()}
            defaultSchema={session.schema() ?? undefined}
            sourceLabel={ds.name}
            errors={session.errors()}
            execMarks={session.marks()}
            onExecute={(req) => void session.run(req)}
            onCaretChange={(line, col) => {
              caret = { line, col };
              if (props.active) setStatus("caret", { line, col });
            }}
            ref={(h) => {
              editor = h;
              session.editor = h;
            }}
            autofocus={props.active}
          />
        </Show>
      </div>
    </div>
  );
}
