/** Content of a `console` editor tab (slot `editor.view.console`): toolbar + SQL editor bound to the console file. */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { type ObjectRef, listDataSources, readConsole, writeConsole } from "../../api/db";
import { type NavHandlers, type NavTarget, SqlEditor, type SqlEditorHandle } from "../../components/editor";
import { showToolWindow } from "../../state/layout";
import { type Crumb, setEditorPath, setStatus } from "../../state/status";
import { type EditorTab, updateTab } from "../../state/tabs";
import { connectedDataSourceIds, explorerDataSources, openDdlRef, refreshNode, revealObject, schemaSnapshotFor, showQuickDocRef, synonymsFor } from "../explorer";
import { Icon, notify } from "../../components/ui";
import { dsIconUrl } from "../output/dsicon";
import { copyText } from "../output/export";
import { markConsoleActive } from "../output/model";
import { txLabel } from "../table/session";
import { ConsoleToolbar } from "./ConsoleToolbar";
import { dsOf, toEditorSchema } from "./ds";
import { registerSession, unregisterSession } from "./registry";
import { ConsoleSession } from "./session";

const SAVE_DELAY = 600;
const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

/** The database object a name in the SQL refers to (for a column: its table). */
const objectRefOf = (t: NavTarget): ObjectRef => ({ schema: t.schema, name: t.name, kind: t.kind === "matview" ? "materializedView" : (t.kind as ObjectRef["kind"]) });

/**
 * Lets another tab kind (a `.sql` file) reuse the console editor: the text comes from `load` and goes to `change`
 * instead of the console file (no autosave here: the owner decides when it reaches the disk).
 */
export interface ConsoleBacking {
  /** Name the per-console preferences (current schema) are saved under. */
  key: string;
  load: () => Promise<string>;
  change: (text: string) => void;
  /** Status bar path while the tab is active. */
  crumbs: () => Crumb[];
  /** Extra toolbar content next to the schema switcher (the data source chooser of a file). */
  toolbarExtra?: () => JSX.Element;
  /** Changes when the text was replaced from outside (reload from disk): the editor loads it again. */
  revision?: () => number;
  /** The editor is mounted: the session can run something (a file that was just given its data source). */
  onReady?: (session: ConsoleSession) => void;
}

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

export function ConsoleInner(props: { tab: EditorTab; active: boolean; dsId: string; consoleName: string; backing?: ConsoleBacking }): JSX.Element {
  const ds = dsOf(props.dsId)!;
  const session = new ConsoleSession(props.tab.id, ds, props.consoleName, () => props.tab.title);
  registerSession(session);

  const [text, setText] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [everActive, setEverActive] = createSignal(props.active);
  let caret: { line: number; col: number; chars?: number; breaks?: number } = { line: 1, col: 1 };
  let editor: SqlEditorHandle | undefined;

  createEffect(on(() => props.backing?.revision?.(), () => void props.backing?.load().then(setText), { defer: true }));

  // ---- autosave (like DataGrip: no explicit save)
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  /** The autosave of this console failed: one balloon, until a later save succeeds (the next change retries). */
  let saveErrorShown = false;
  const saved = () => {
    saveErrorShown = false;
  };
  const saveFailed = (e: unknown) => {
    if (saveErrorShown) return;
    saveErrorShown = true;
    notify({ kind: "error", title: `Cannot save ${props.consoleName}`, body: errText(e) });
  };
  const write = () => void writeConsole(props.dsId, props.consoleName, text()).then(saved, saveFailed);
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
      (l) => l.some((d) => d.id === props.dsId) && void writeConsole(props.dsId, props.consoleName, body).then(saved, saveFailed),
      write,
    );
  };
  const flushNow = () => flush(false); // the page is going away: no time for a round trip
  onMount(() => {
    (props.backing ? props.backing.load() : readConsole(props.dsId, props.consoleName))
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

  // ---- Ctrl+B / Ctrl+Click, Ctrl+Q, Alt+Shift+B on a table / column named in the SQL
  const navigate: NavHandlers = {
    goTo: (t) => void openDdlRef(props.dsId, objectRefOf(t), t.column?.name),
    quickDoc: (t, anchor) => showQuickDocRef({ dsId: props.dsId, ref: objectRefOf(t), column: t.column }, anchor),
    selectInExplorer: (t) => {
      showToolWindow("explorer", false);
      void revealObject(props.dsId, t.column ? { schema: t.schema, name: t.column.name, kind: "column", table: t.name } : objectRefOf(t));
    },
  };

  // ---- completion data: loaded lazily, the first time the tab is shown
  const schema = createMemo(() => (everActive() ? toEditorSchema(schemaSnapshotFor(props.dsId), ds.database || undefined, synonymsFor(props.dsId)) : undefined));

  // ---- status bar, focus, eager session
  const pushStatus = () => {
    setEditorPath(
      props.backing?.crumbs() ?? [
        { label: "Database Consoles" },
        { label: dsOf(props.dsId)?.name ?? ds.name, onClick: () => void revealObject(props.dsId, null) },
        { label: props.tab.title, icon: dsIconUrl(ds.driver) ?? "dg/console" },
      ],
    );
    setStatus({ caret, lineSeparator: "LF", encoding: "UTF-8", readOnly: false });
  };
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
  // the data source was renamed: the breadcrumb at the bottom follows
  createEffect(
    on(
      () => dsOf(props.dsId)?.name,
      () => {
        if (props.active) pushStatus();
      },
      { defer: true },
    ),
  );
  createEffect(() => {
    if (props.active) setStatus("txMode", txLabel(session.txMode(), session.txStatus()));
  });
  // the console's tab shows the DBMS icon of its data source, like DataGrip
  createEffect(() => {
    const icon = props.backing ? undefined : dsIconUrl(ds.driver);
    if (icon && props.tab.icon !== icon) updateTab(props.tab.id, { icon });
  });
  // the data source was disconnected / deactivated: the server rolled the open transaction back with the connection
  createEffect(() => {
    if (!connectedDataSourceIds().has(props.dsId) && session.sessionId) session.connectionClosed();
  });
  // a SET search_path that ran while a result was paging: the server is asked which schema it is once nothing pages
  createEffect(() => {
    if (session.schemaReadable()) void session.settleSchema();
  });
  // open the DB session as soon as the data source is connected, so the schema switcher shows the real schema
  createEffect(() => {
    if (props.active && connectedDataSourceIds().has(props.dsId) && !session.sessionId) void session.ensureSession().catch(() => {});
  });

  return (
    <div class="dgc-view">
      <ConsoleToolbar session={session} trailing={props.backing?.toolbarExtra?.()} />
      <div
        class="dgc-editor"
        classList={{ "dg-ds-tinted": !!dsOf(props.dsId)?.color }}
        style={dsOf(props.dsId)?.color ? { "--dg-ds-tint": dsOf(props.dsId)!.color! } : undefined}
      >
        <Show when={loaded()}>
          <SqlEditor
            value={text()}
            onChange={(v) => {
              setText(v);
              if (props.backing) return props.backing.change(v);
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
            navigate={navigate}
            intentions={{ refreshSchema: () => refreshNode([props.dsId]), chooseSchema: (at) => void session.openSchemaMenu(at) }}
            onExecute={(req) => void session.run(req)}
            onCaretChange={(line, col, chars, breaks) => {
              caret = { line, col, chars, breaks };
              if (props.active) setStatus("caret", { line, col, chars, breaks });
            }}
            ref={(h) => {
              editor = h;
              session.editor = h;
              props.backing?.onReady?.(session);
            }}
            autofocus={props.active}
          />
        </Show>
      </div>
      <ExecErrorBanner session={session} />
    </div>
  );
}

/** The error of the last run: red banner docked at the bottom of the editor (first line, `Copy`, close). */
function ExecErrorBanner(props: { session: ConsoleSession }): JSX.Element {
  return (
    <Show when={props.session.execError()}>
      {(m) => (
        <div class="dgc-banner" role="alert">
          <span class="dgc-banner-text">{m().split("\n")[0]}</span>
          <a class="dgc-banner-link" onClick={() => void copyText(m())}>
            Copy
          </a>
          <button type="button" class="dgc-banner-close" tabindex={-1} aria-label="Close" onClick={() => props.session.setExecError(null)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </Show>
  );
}
