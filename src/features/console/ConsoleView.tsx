/** Content of a `console` editor tab (slot `editor.view.console`): toolbar + SQL editor bound to the console file. */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { readConsole, writeConsole } from "../../api/db";
import { SqlEditor, type SqlEditorHandle } from "../../components/editor";
import { setStatus } from "../../state/status";
import type { EditorTab } from "../../state/tabs";
import { connectedDataSourceIds, explorerDataSources, schemaSnapshotFor } from "../explorer";
import { markConsoleActive } from "../output/model";
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
  const flush = () => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    void writeConsole(props.dsId, props.consoleName, text()).catch(() => {});
  };
  onMount(() => {
    readConsole(props.dsId, props.consoleName)
      .then(setText, () => setText(""))
      .finally(() => setLoaded(true));
    window.addEventListener("beforeunload", flush);
    window.addEventListener("blur", flush);
  });
  onCleanup(() => {
    window.removeEventListener("beforeunload", flush);
    window.removeEventListener("blur", flush);
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
    if (props.active) setStatus("txMode", session.txMode() === "manual" ? (session.inTx() ? "Tx: Manual (active)" : "Tx: Manual") : "Tx: Auto");
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
