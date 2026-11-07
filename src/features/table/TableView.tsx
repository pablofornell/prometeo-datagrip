/**
 * Table data editor (`editor.view.table`): toolbar, WHERE | ORDER BY bar, the grid on a paged row source,
 * the rows pill, pending-changes preview, export, and the close guard hooks.
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import {
  type ExportOptions,
  type ObjectRef,
  type TxStatus,
  applyChanges,
  closeSession,
  defaultExportOptions,
  exportQueryToString,
  exportToString,
  openSession,
  sessionTxStatus,
} from "../../api/db";
import {
  DataGrid,
  GridPagingPill,
  GridToolbar,
  type DataGridApi,
  type GridChange,
  type GridColumn,
  type GridViewState,
  type SelectionInfo,
  type SortSpec,
} from "../../components/grid";
import { notify, openMenu } from "../../components/ui";
import { settings } from "../../state/settings";
import { setGridSelection, setStatus } from "../../state/status";
import { type EditorTab, activateTab, updateTab } from "../../state/tabs";
import { type ObjectTabData, openDdlTab } from "./commands";
import { registerController } from "./controller";
import { confirmEndTransactions } from "../console/txguard";
import { connectedDataSourceIds, ensureConnected } from "../explorer";
import { rowsRetrieved } from "../output/format";
import { CONNECTION_LOST_LOG, CONNECTION_LOST_TX_LOG } from "../../state/connection-errors";
import { type ConsoleOutput, createOutput, removeOutput } from "../output/model";
import { dsInfo, errText, loadDataSources, writeClipboard } from "./ds";
import { type ExportSource, exportPreview, exportTableQuery } from "./exportData";
import {
  SERVER_ROLLBACK_BODY,
  SERVER_ROLLBACK_LOG,
  SERVER_ROLLBACK_TITLE,
  applyChangesInSession,
  classifyTxEnd,
  endTransaction,
  ensureTransaction,
  isSessionLost,
  txLabel,
} from "./session";
import { FilterBar } from "./FilterBar";
import { createFkNavigation } from "./fkNav";
import { logSubmitted } from "../output/edit";
import { extractorMenuItems } from "../output/extractors";
import { ChoiceDialog, ColumnFilterPopup, EXPORT_FORMATS, ExportDialog, SqlPopup, exportFileBase, type ExportPath, type ExportTarget } from "./Popups";
import { type PageSize, type Query, type QueryReport, createTableSource } from "./source";
import { appendCondition, buildCondition, changeStatements, orderByToSort, previewSql, qualifiedName, selectSql, sortToOrderBy, tableQuerySql, toRowChanges } from "./sql";
import "./table.css";

interface Choice {
  title: string;
  message: string;
  choices: { label: string; value: string; primary?: boolean }[];
  cancel: string;
  resolve: (v: string) => void;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function TableView(props: { tab: EditorTab; active: boolean }): JSX.Element {
  const data = props.tab.data as ObjectTabData | undefined;
  if (!data?.dsId || !data.objectRef) return <div class="dgt-message">This table editor has no object to show.</div>;
  return <TableEditor tab={props.tab} active={props.active} dsId={data.dsId} objectRef={data.objectRef} where={data.where} />;
}

function TableEditor(props: { tab: EditorTab; active: boolean; dsId: string; objectRef: ObjectRef; where?: string }): JSX.Element {
  const { dsId } = props;
  const ref = props.objectRef;
  // Tx: Manual works on a session of its own; its id makes the source read through it (it sees the open transaction)
  const [txMode, setTxModeSignal] = createSignal<"auto" | "manual">("auto");
  const [sid, setSid] = createSignal<string | undefined>();
  // the server's state of that session (`idle` / `active` / `failed`), never guessed from what was typed
  const [txStatus, setTxStatus] = createSignal<TxStatus>("idle");
  const inTx = () => txStatus() !== "idle";
  const [applying, setApplying] = createSignal(false);
  const ds = () => dsInfo(dsId);
  const driver = () => ds()?.driver ?? "postgres";

  // ---- Output: the queries of this editor, like DataGrip logs them
  let out: ConsoleOutput | undefined;
  const prompt = () => (driver() === "postgres" ? `${ds()?.database ?? ""}.${ref.schema ?? "public"}` : (ref.schema ?? ds()?.database ?? ""));
  const onQuery = (r: QueryReport) => {
    const q = r.query;
    out?.log("sql", tableQuerySql(driver(), ref, q.where, q.orderBy, q.pageSize, q.page), prompt());
    if (r.error) out?.log("error", r.error);
    else out?.log("text", rowsRetrieved(r.rows, r.ms, undefined, undefined, q.pageSize === "all" ? 1 : q.page * q.pageSize + 1));
    out?.setLastMs(r.ms);
  };
  const src = createTableSource(dsId, ref, props.where ? { where: props.where } : {}, sid, {
    onQuery,
    onSessionLost: () => recoverSession(),
    // Tx: Manual reads go through the transaction session, reopened here when it was lost
    ensureSession: async () => (txMode() === "manual" ? (sid() ?? (await openTxSession())) : undefined),
  });
  let root!: HTMLDivElement;
  let api: DataGridApi | undefined;

  const [whereText, setWhereText] = createSignal(props.where ?? "");
  const [orderText, setOrderText] = createSignal("");
  const [pending, setPending] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [choice, setChoice] = createSignal<Choice | null>(null);
  const [sqlPopup, setSqlPopup] = createSignal<{ sql: string; submit: boolean } | null>(null);
  const [exportDlg, setExportDlg] = createSignal(false);
  const [extractor, setExtractor] = createSignal<ExportOptions["format"]>("csv");
  const [colFilter, setColFilter] = createSignal<{ col: number; anchor: DOMRect } | null>(null);
  // transpose / record view / find / local filter state of the grid, for the toolbar toggles
  const [view, setView] = createSignal<GridViewState | null>(null);

  const cols = () => src.columns();
  const gridCols = createMemo<GridColumn[] | null>(() => cols()?.map((c) => ({ name: c.name, typeName: c.typeName, nullable: c.nullable, isPk: c.isPk })) ?? null);
  const editable = () => ref.kind === "table" && !ds()?.readOnly;
  const sortSpecs = createMemo<SortSpec[]>(() => orderByToSort(src.applied().orderBy, cols() ?? []));
  const sourceLabel = () => ds()?.name ?? dsId;
  const tableName = () => qualifiedName(driver(), ref);

  const ask = (c: Omit<Choice, "resolve">) => new Promise<string>((resolve) => setChoice({ ...c, resolve }));
  const answer = (v: string) => {
    const c = choice();
    setChoice(null);
    c?.resolve(v);
    api?.focus();
  };
  const fail = (title: string, e: unknown) => notify({ kind: "error", title, body: errText(e) });

  // ---------------------------------------------------------------- loading

  /** Loads another page / query. Pending edits are discarded after a confirmation. Returns whether it loaded. */
  async function reloadPage(next: Partial<Query> = {}, opts: { keepTotal?: boolean } = {}): Promise<boolean> {
    if (pending() > 0) {
      const a = await ask({
        title: "Discard Changes",
        message: `This will discard ${plural(pending(), "uncommitted change")}.`,
        choices: [
          { label: "Discard", value: "discard", primary: true },
          { label: "Cancel", value: "cancel" },
        ],
        cancel: "cancel",
      });
      if (a !== "discard") return false;
    }
    try {
      if (!(await src.load(next, opts))) return false;
      api?.clearChanges();
      setError(null);
      return true;
    } catch (e) {
      fail("Cannot load the data", e);
      if (!src.columns()) setError(errText(e));
      return false;
    }
  }

  const reload = () => void reloadPage();

  async function applyFilter(): Promise<void> {
    const ok = await reloadPage({ where: whereText().trim(), orderBy: orderText().trim(), page: 0 });
    if (ok) api?.focus();
  }

  const goPage = (page: number) => void reloadPage({ page: Math.max(0, page) }, { keepTotal: true });
  const page = () => src.applied().page;
  const nextPage = () => src.hasMore() && goPage(page() + 1);
  const prevPage = () => page() > 0 && goPage(page() - 1);
  async function lastPage(): Promise<void> {
    const size = pageSize();
    if (size === "all") return;
    try {
      const n = src.total() ?? (await src.countRows());
      goPage(Math.max(0, Math.ceil(n / size) - 1));
    } catch (e) {
      fail("Cannot count the rows", e);
    }
  }
  const pageSize = () => src.applied().pageSize;
  const setPageSize = (s: PageSize) => void reloadPage({ pageSize: s, page: 0 }, { keepTotal: true });
  async function countRows(): Promise<void> {
    try {
      await src.countRows();
    } catch (e) {
      fail("Cannot count the rows", e);
    }
  }

  onMount(() => {
    void (async () => {
      try {
        await loadDataSources();
        if (!ds()) throw new Error("The data source of this tab no longer exists.");
        out = createOutput(props.tab.id, driver());
        await ensureConnected(dsId);
        out.log("text", "Connected");
        await src.load();
      } catch (e) {
        // shown inside the tab: restoring many tabs must not raise a balloon each (the explorer closes tabs of
        // deleted data sources at startup, see features/explorer/restore.ts)
        setError(errText(e));
      }
    })();
  });
  onCleanup(() => {
    src.dispose();
    removeOutput(props.tab.id);
  });

  // ---------------------------------------------------------------- editing

  /**
   * Applies the pending changes in one transaction; false keeps them pending (error shown). Tx: Manual applies them
   * inside the session's transaction, which stays open until Commit / Roll Back.
   */
  async function onSubmit(changes: GridChange[]): Promise<boolean> {
    const cs = cols();
    if (!cs) return false;
    setApplying(true);
    try {
      const rowChanges = toRowChanges(changes, cs, src.locatorOf);
      const id = txMode() === "manual" ? (sid() ?? (await openTxSession())) : undefined;
      if (id) {
        const st = await ensureTransaction(id, driver());
        setTxStatus(st);
        if (st === "failed") {
          notify({ kind: "error", title: "Cannot submit the changes", body: "The transaction has failed (an earlier statement raised an error). Roll it back, then submit the changes again." });
          return false;
        }
      }
      const t0 = performance.now();
      const res = id ? await applyChangesInSession(dsId, id, ref, rowChanges) : await applyChanges(dsId, ref, rowChanges);
      if (id) await syncTxStatus(id);
      const bad = res.results.find((r) => r.error);
      if (out) {
        const statements = changeStatements(driver(), ref, cs, changes);
        const affected = res.results.reduce((n, r) => n + (r.rowsAffected || 0), 0);
        logSubmitted((k, t, p) => out?.log(k, t, p), prompt(), statements, !res.committed ? { error: bad?.error ?? "The transaction was rolled back." } : { rowsAffected: affected, ms: Math.round(performance.now() - t0) });
      }
      if (!res.committed) {
        notify({ kind: "error", title: "Cannot submit the changes", body: bad?.error ?? "The transaction was rolled back." });
        return false;
      }
    } catch (e) {
      if (isSessionLost(e)) {
        sessionLost();
        notify({ kind: "error", title: "Cannot submit the changes", body: "The connection was closed and its transaction rolled back, so nothing was applied. Submit the changes again." });
        return false;
      }
      fail("Cannot submit the changes", e);
      return false;
    } finally {
      setApplying(false);
    }
    api?.clearChanges();
    try {
      await src.load({}, { keepTotal: false });
      // an emptied last page: step back
      if (src.rowCount() === 0 && page() > 0) await src.load({ page: page() - 1 });
    } catch (e) {
      fail("The changes were submitted, but the page could not be reloaded", e);
    }
    return true;
  }

  /** Submit from outside the grid (close dialog). */
  async function submitNow(): Promise<boolean> {
    if (!api || pending() === 0) return true;
    const ok = await onSubmit(api.getChanges());
    return ok;
  }

  const askPending = (n: number) => {
    activateTab(props.tab.id);
    return ask({
      title: "Uncommitted Changes",
      message: `'${props.tab.title}' has ${plural(n, "uncommitted change")}. Submit them to the database before closing?`,
      choices: [
        { label: "Submit", value: "submit", primary: true },
        { label: "Discard", value: "discard" },
        { label: "Cancel", value: "cancel" },
      ],
      cancel: "cancel",
    });
  };

  /**
   * Quitting: only the question about the pending changes; nothing is sent until every prompt of the quit was answered.
   * A transaction that was open before is ended by the quit's own transaction question; one that Submit opens (Tx:
   * Manual) is asked after the submit.
   */
  async function askQuit(): Promise<false | null | (() => Promise<boolean>)> {
    const n = pending();
    if (n === 0) return null;
    const a = await askPending(n);
    if (a === "cancel") return false;
    if (a !== "submit") return null;
    const hadTx = inTx();
    return async () => {
      if (!(await submitNow())) return false;
      return hadTx || confirmEndTransactions({ tabId: props.tab.id, reason: "closing the editor" });
    };
  }

  async function confirmClose(): Promise<boolean> {
    const n = pending();
    if (n > 0) {
      const a = await askPending(n);
      if (a === "cancel") return false;
      if (a === "submit" && !(await submitNow())) return false;
    }
    // an open transaction: Commit / Roll Back / Cancel (the same dialog as for the consoles)
    return confirmEndTransactions({ tabId: props.tab.id, reason: "closing the editor" });
  }

  // ---------------------------------------------------------------- transactions

  /** Opens the transaction session of Tx: Manual (a connection of its own). */
  async function openTxSession(): Promise<string> {
    await ensureConnected(dsId);
    const id = await openSession(dsId);
    setSid(id);
    setTxStatus("idle");
    return id;
  }

  /** Reads the server's state of the session into the signal. */
  async function syncTxStatus(id: string): Promise<void> {
    try {
      setTxStatus(await sessionTxStatus(id));
    } catch (e) {
      if (isSessionLost(e)) sessionLost();
    }
  }

  /**
   * The session is gone (connection lost, data source disconnected / deactivated): the server rolled the transaction
   * back with it. The next read / submit opens a new session (Manual mode).
   */
  function sessionLost(o: { closed?: boolean } = {}): void {
    const had = inTx();
    const old = sid();
    setSid(undefined);
    setTxStatus("idle");
    if (old) void closeSession(old).catch(() => {}); // releases a dead session (the backend accepts that)
    if (o.closed) {
      if (had) {
        out?.log("error", "the transaction was rolled back: connection closed");
        notify({ kind: "warning", title: "The transaction was rolled back", body: `The connection of '${props.tab.title}' was closed, so its open transaction was rolled back. Reload the page to see the data as the database holds it.` });
      } else out?.log("text", "connection closed");
    } else if (had) {
      out?.log("error", CONNECTION_LOST_TX_LOG);
      notify({ kind: "warning", title: "The transaction was rolled back", body: `The connection of '${props.tab.title}' was lost, so its open transaction was rolled back. Reload the page to see the data as the database holds it.` });
    } else out?.log("text", CONNECTION_LOST_LOG);
  }

  /** After `sessionLost`: a new session for the next operation (Manual mode), `undefined` in Auto mode / on failure. */
  async function recoverSession(): Promise<string | undefined> {
    sessionLost();
    if (txMode() !== "manual") return undefined;
    try {
      return await openTxSession();
    } catch (e) {
      fail("Cannot reopen the transaction session", e);
      return undefined;
    }
  }

  // the data source was disconnected while this editor holds a transaction session
  createEffect(() => {
    if (!connectedDataSourceIds().has(dsId) && untrack(sid)) sessionLost({ closed: true }); // reopened on the next read / submit
  });

  /** Tx: Manual opens a session for this tab; back to Auto asks about an open transaction and drops the session. */
  async function setTxMode(m: "auto" | "manual"): Promise<void> {
    if (m === txMode()) return;
    if (m === "manual") {
      try {
        await openTxSession();
        setTxModeSignal("manual");
      } catch (e) {
        fail("Cannot start the transaction session", e);
      }
      return;
    }
    const had = inTx();
    if (had && !(await confirmEndTransactions({ tabId: props.tab.id, reason: "switching to the Auto transaction mode", keepsSession: true }))) return;
    const id = sid();
    setSid(undefined);
    setTxStatus("idle");
    setTxModeSignal("auto");
    if (id) void closeSession(id).catch(() => {});
    if (had) void reloadPage({}, { keepTotal: true }); // show what the database holds now
  }

  /**
   * Commit / Roll Back of the open transaction. Returns whether it ended. `reload`: reload the page when the data on
   * screen may not be the database's (rolled back by us or by the server).
   */
  let txError: string | null = null;
  async function endTx(kind: "commit" | "rollback", reload = true): Promise<boolean> {
    txError = null;
    const id = sid();
    if (!id || !inTx()) return true;
    try {
      const r = await endTransaction(id, kind);
      if (r.status) setTxStatus(r.status);
      else await syncTxStatus(id);
      const how = r.ended[0] ? classifyTxEnd(kind === "commit" ? "COMMIT" : "ROLLBACK", r.ended[0]) : kind;
      if (how === "connectionLost") {
        sessionLost();
        return true; // the connection took the transaction with it
      }
      if (how === "serverRollback") {
        out?.log("error", SERVER_ROLLBACK_LOG);
        notify({ kind: "error", title: SERVER_ROLLBACK_TITLE, body: SERVER_ROLLBACK_BODY });
      } else out?.log("text", how === "rollback" ? "transaction rolled back" : "transaction committed");
      // the grid must not keep values that are no longer in the database
      if (reload && (how === "rollback" || how === "serverRollback")) void reloadPage();
      return true;
    } catch (e) {
      if (isSessionLost(e)) {
        sessionLost();
        return true; // the connection took the transaction with it
      }
      txError = errText(e);
      fail(kind === "commit" ? "Cannot commit the transaction" : "Cannot roll back the transaction", e);
      await syncTxStatus(id);
      return false;
    }
  }
  const commit = () => void endTx("commit");
  const rollback = () => void endTx("rollback");
  onCleanup(() => {
    const id = sid();
    // the server rolls back what is still open
    if (id) void closeSession(id).catch(() => {});
  });

  // ---------------------------------------------------------------- cancel

  /**
   * Cancel Running Statements. A page load stops being waited for (its late result is dropped; `table_data` has no
   * server-side cancel). A submit cannot be abandoned safely, since it may still commit.
   */
  function cancelRunning(): void {
    if (applying()) {
      notify({ kind: "info", title: "The submit cannot be cancelled", body: "It is a single transaction; waiting for the server to finish it." });
      return;
    }
    if (src.loading()) {
      src.cancel();
      notify({ kind: "info", title: "Loading cancelled", body: "The result of the query is ignored." });
    }
  }
  const busy = () => src.loading() || applying();

  const openDdl = () => void openDdlTab(dsId, ref);

  onCleanup(
    registerController({
      tabId: props.tab.id,
      dsId,
      title: () => props.tab.title,
      root: () => root,
      editable,
      pendingCount: pending,
      submit: () => api?.submit(),
      revertSelected: () => api?.revertSelected(),
      addRow: () => api?.addRow(),
      deleteRows: () => api?.deleteRows(),
      reload,
      nextPage,
      prevPage,
      openDdl,
      confirmClose,
      askQuit,
      txMode,
      inTx,
      txStatus,
      endTx: (kind) => endTx(kind, false),
      txError: () => txError,
      commit,
      rollback,
      exportData: () => setExportDlg(true),
    }),
  );

  // unsaved-changes marker on the tab
  createEffect(
    on(
      () => pending() > 0 || inTx(),
      (dirty) => {
        if (!!props.tab.modified !== dirty) updateTab(props.tab.id, { modified: dirty });
      },
    ),
  );

  // a new Settings page size reloads the pages that follow it (not when the pill chose one, or edits are pending)
  createEffect(
    on(
      () => settings.gridPageSize,
      () => {
        if (src.columns() && src.followsDefaultSize() && pending() === 0) void reloadPage({ page: 0 });
      },
      { defer: true },
    ),
  );

  // status bar: transaction mode (microtask: after the console's cleanup of the same tab switch)
  createEffect(() => {
    const text = txLabel(txMode(), txStatus());
    if (props.active && editable()) queueMicrotask(() => setStatus("txMode", text));
  });

  // focus the grid when the tab is shown
  createEffect(
    on(
      () => props.active,
      (a) => {
        if (!a) return;
        setStatus({ caret: null, aggregator: "No aggregator selected" });
        requestAnimationFrame(() => api?.focus());
      },
    ),
  );

  // status bar: row:col and the aggregate of the selection
  const onSelection = (info: SelectionInfo) => {
    if (!props.active) return;
    setGridSelection(props.tab.id, info);
  };

  // ---------------------------------------------------------------- toolbar bits

  const sortChange = (sort: SortSpec[]) => {
    const orderBy = sortToOrderBy(driver(), cols() ?? [], sort);
    setOrderText(orderBy);
    void reloadPage({ orderBy, page: 0 });
  };

  const txMenu = (r: DOMRect) =>
    openMenu(
      [
        { type: "header", label: "Transaction Mode" },
        { label: "Auto", checked: txMode() === "auto", run: () => void setTxMode("auto") },
        { label: "Manual", checked: txMode() === "manual", run: () => void setTxMode("manual") },
        {
          type: "hint",
          label: txMode() === "manual" ? "Manually commit changes submitted to the database" : "Changes submitted to the database are auto-committed",
        },
      ],
      { x: r.left, y: r.bottom + 2 },
    );

  // foreign keys of the table: `Go To` / F4 of the cells and the key icon of their columns
  const fk = createFkNavigation(() => dsId, () => (ref.kind === "table" ? ref : null));
  /** `Export Table to Clipboard` of the cell menu: every row of the filtered table in the current extractor. */
  const exportToClipboard = () => void doExport(exportOptions(), "clipboard", { path: "", chosen: false });

  const extractorMenu = (r: DOMRect) =>
    openMenu(extractorMenuItems(extractor(), setExtractor), { x: r.right - 230, y: r.bottom + 2, minWidth: 230, title: "Data Extractors" });

  const exportOptions = (): ExportOptions => ({ ...defaultExportOptions(driver()), format: extractor(), tableName: tableName() });

  /** What the Export Data dialog exports: the rows the editor holds when they are all loaded, else the query again. */
  const exportSource = (): ExportSource => {
    const q = src.applied();
    return {
      dsId,
      label: tableName(),
      sql: selectSql(driver(), ref, q.where, q.orderBy),
      options: exportOptions(),
      loaded: () => ({ columns: cols() ?? [], rows: src.pageRows(), complete: wholeTableLoaded() }),
    };
  };

  /** Every row of the (filtered) table is in memory: the page is the first one and nothing follows it. */
  const wholeTableLoaded = () => !!cols() && src.rowOffset() === 0 && !src.hasMore() && src.complete();

  async function doExport(options: ExportOptions, target: ExportTarget, out: ExportPath): Promise<void> {
    setExportDlg(false);
    setExtractor(options.format);
    const q = src.applied();
    if (target === "file") {
      await exportTableQuery(dsId, ref, driver(), options, "file", out, { where: q.where, orderBy: q.orderBy });
      return;
    }
    const fmt = EXPORT_FORMATS.find((f) => f.value === options.format) ?? EXPORT_FORMATS[0];
    try {
      const cs = cols();
      const sql = selectSql(driver(), ref, q.where, q.orderBy);
      const text = cs && wholeTableLoaded() ? await exportToString({ columns: cs, rows: src.pageRows() }, options) : await exportQueryToString(dsId, sql, options);
      await writeClipboard(text);
      notify({ kind: "success", title: "Copied to the clipboard", body: `${fmt.label} of ${plural(src.rowCount(), "row")}`, timeout: 4000 });
    } catch (e) {
      fail("Export failed", e);
    }
  }

  const showPreview = () => {
    const cs = cols();
    const changes = api?.getChanges() ?? [];
    if (!cs || changes.length === 0) return;
    setSqlPopup({ sql: previewSql(driver(), ref, cs, changes), submit: true });
  };
  const showQuery = () => {
    const q = src.applied();
    setSqlPopup({ sql: tableQuerySql(driver(), ref, q.where, q.orderBy, q.pageSize, q.page), submit: false });
  };

  const totalRows = () => {
    const t = src.total();
    return pageSize() !== "all" && t != null && t > src.rowCount() ? t : null;
  };

  return (
    <div class="dgt-view" ref={root} data-table-tab={props.tab.id}>
      <GridToolbar
        editable={editable()}
        hasChanges={pending() > 0}
        running={busy()}
        onCancel={cancelRunning}
        txMode={txMode() === "manual" ? "Manual" : "Auto"}
        onTxMenu={txMenu}
        onCommit={commit}
        onRollback={rollback}
        txActive={inTx()}
        txFailed={txStatus() === "failed"}
        extractor={EXPORT_FORMATS.find((f) => f.value === extractor())?.label ?? "CSV"}
        onExtractorMenu={extractorMenu}
        onReload={reload}
        onAddRow={() => api?.addRow()}
        onDeleteRows={() => api?.deleteRows()}
        onRevert={() => api?.revertSelected()}
        onPreview={showPreview}
        onSubmit={() => api?.submit()}
        onDDL={openDdl}
        onSql={showQuery}
        onExport={() => setExportDlg(true)}
        transposed={!!view()?.transposed}
        onTransposeChange={() => api?.toggleTranspose()}
        onRecordView={() => api?.toggleRecordView()}
        recordViewOpen={!!view()?.sidePanel}
        onFind={() => api?.openFind()}
        findOpen={!!view()?.findOpen}
        localFilterEnabled={view()?.localFilterEnabled ?? true}
        localFilterActive={!!view()?.localFilterActive}
        onLocalFilterEnabledChange={(on) => api?.setLocalFilterEnabled(on)}
        onClearLocalFilter={() => api?.clearLocalFilter()}
        onManageColumns={(anchor) => api?.openManageColumns(anchor)}
        columnsHidden={(view()?.hiddenColumns ?? 0) > 0}
      />
      <Show when={ds() && cols()}>
        <FilterBar
          driver={driver()}
          objectRef={ref}
          columns={cols()!}
          sourceLabel={sourceLabel()}
          where={whereText()}
          orderBy={orderText()}
          onWhereChange={setWhereText}
          onOrderByChange={setOrderText}
          onApply={() => void applyFilter()}
        />
      </Show>
      <div class="dgt-body">
        <Show when={gridCols()}>
          {(columns) => (
            <DataGrid
              columns={columns()}
              rowCount={src.rowCount()}
              getRow={src.getRow}
              rowNumberOffset={src.rowOffset()}
              version={src.version()}
              editable={editable()}
              onSubmit={onSubmit}
              onChangesChange={setPending}
              tableName={tableName()}
              sort={sortSpecs()}
              sortMode="external"
              onSortChange={sortChange}
              onReload={reload}
              onColumnFilter={(col, anchor) => setColFilter({ col, anchor })}
              navigation={fk.navigation}
              fkColumns={fk.fkColumns}
              dialect={driver()}
              extractorLabel={EXPORT_FORMATS.find((f) => f.value === extractor())?.label ?? "CSV"}
              onChangeExtractor={(at) => openMenu(extractorMenuItems(extractor(), setExtractor), { x: at.x, y: at.y, minWidth: 230, title: "Data Extractors" })}
              onExportToClipboard={exportToClipboard}
              onSelectionChange={onSelection}
              onViewChange={setView}
              apiRef={(a) => (api = a)}
            >
              <GridPagingPill
                rowCount={src.rowCount()}
                totalRows={totalRows()}
                pageSize={pageSize()}
                onPageSizeChange={setPageSize}
                onCountRows={() => void countRows()}
                onFirstPage={page() > 0 ? () => goPage(0) : undefined}
                onPreviousPage={page() > 0 ? prevPage : undefined}
                onNextPage={src.hasMore() ? nextPage : undefined}
                onLastPage={src.hasMore() ? () => void lastPage() : undefined}
              />
            </DataGrid>
          )}
        </Show>
        <Show when={error() && !cols()}>
          <div class="dgt-message dgt-error">
            <div>{error()}</div>
            <a class="dgt-link" onClick={reload}>
              Retry
            </a>
          </div>
        </Show>
      </div>

      <Show when={choice()}>
        {(c) => <ChoiceDialog title={c().title} message={c().message} choices={c().choices} cancel={c().cancel} onAnswer={answer} />}
      </Show>
      <Show when={sqlPopup()}>
        {(p) => (
          <SqlPopup
            sql={p().sql}
            dialect={driver()}
            primary={p().submit ? { label: "Submit", run: () => (setSqlPopup(null), api?.submit()) } : undefined}
            secondaryLabel={p().submit ? "Cancel" : "Close"}
            onClose={() => (setSqlPopup(null), api?.focus())}
          />
        )}
      </Show>
      <Show when={exportDlg()}>
        <ExportDialog
          options={exportOptions()}
          source={tableName()}
          fileBase={exportFileBase(tableName())}
          preview={(o) => exportPreview(exportSource(), o)}
          onClose={() => setExportDlg(false)}
          onExport={(o, t, out) => void doExport(o, t, out)}
        />
      </Show>
      <Show when={colFilter()}>
        {(f) => (
          <ColumnFilterPopup
            column={cols()![f().col]}
            anchor={f().anchor}
            onClose={() => setColFilter(null)}
            onApply={(op, value) => {
              const cond = buildCondition(driver(), cols()![f().col], op, value);
              const where = appendCondition(whereText().trim(), cond);
              setColFilter(null);
              setWhereText(where);
              void applyFilter();
            }}
          />
        )}
      </Show>
    </div>
  );
}
