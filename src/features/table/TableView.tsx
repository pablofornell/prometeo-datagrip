/**
 * Table data editor (`editor.view.table`): toolbar, WHERE | ORDER BY bar, the grid on a paged row source,
 * the rows pill, pending-changes preview, export, and the close guard hooks.
 */
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import {
  type ExportOptions,
  type ObjectRef,
  applyChanges,
  closeSession,
  defaultExportOptions,
  exportQueryToString,
  exportToString,
  openSession,
} from "../../api/db";
import {
  DataGrid,
  GridPagingPill,
  GridToolbar,
  type DataGridApi,
  type GridChange,
  type GridColumn,
  type SelectionInfo,
  type SortSpec,
} from "../../components/grid";
import { notify, openMenu } from "../../components/ui";
import { settings } from "../../state/settings";
import { setStatus } from "../../state/status";
import { type EditorTab, activateTab, updateTab } from "../../state/tabs";
import { type ObjectTabData, openDdlTab } from "./commands";
import { registerController } from "./controller";
import { ensureConnected } from "../explorer";
import { dsInfo, errText, loadDataSources, writeClipboard } from "./ds";
import { exportTableQuery } from "./exportData";
import { applyChangesInSession, endTransaction, ensureTransaction } from "./session";
import { FilterBar } from "./FilterBar";
import { ChoiceDialog, ColumnFilterPopup, EXPORT_FORMATS, ExportDialog, SqlPopup, type ExportTarget } from "./Popups";
import { type PageSize, type Query, createTableSource } from "./source";
import { TxBar } from "./TxBar";
import { appendCondition, buildCondition, orderByToSort, previewSql, qualifiedName, selectSql, sortToOrderBy, toRowChanges } from "./sql";
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
  return <TableEditor tab={props.tab} active={props.active} dsId={data.dsId} objectRef={data.objectRef} />;
}

function TableEditor(props: { tab: EditorTab; active: boolean; dsId: string; objectRef: ObjectRef }): JSX.Element {
  const { dsId } = props;
  const ref = props.objectRef;
  // Tx: Manual works on a session of its own; its id makes the source read through it (it sees the open transaction)
  const [txMode, setTxModeSignal] = createSignal<"auto" | "manual">("auto");
  const [sid, setSid] = createSignal<string | undefined>();
  const [inTx, setInTx] = createSignal(false);
  const [applying, setApplying] = createSignal(false);
  const src = createTableSource(dsId, ref, {}, sid);
  const ds = () => dsInfo(dsId);
  const driver = () => ds()?.driver ?? "postgres";
  let root!: HTMLDivElement;
  let api: DataGridApi | undefined;

  const [whereText, setWhereText] = createSignal("");
  const [orderText, setOrderText] = createSignal("");
  const [pending, setPending] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [choice, setChoice] = createSignal<Choice | null>(null);
  const [sqlPopup, setSqlPopup] = createSignal<{ sql: string; submit: boolean } | null>(null);
  const [exportDlg, setExportDlg] = createSignal(false);
  const [extractor, setExtractor] = createSignal<ExportOptions["format"]>("csv");
  const [colFilter, setColFilter] = createSignal<{ col: number; anchor: DOMRect } | null>(null);

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
        await ensureConnected(dsId);
        await src.load();
      } catch (e) {
        // shown inside the tab: restoring many tabs must not raise a balloon each (the explorer closes tabs of
        // deleted data sources at startup, see features/explorer/restore.ts)
        setError(errText(e));
      }
    })();
  });
  onCleanup(() => src.dispose());

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
      const id = txMode() === "manual" ? sid() : undefined;
      if (id) {
        await ensureTransaction(id, driver());
        setInTx(true);
      }
      const res = id ? await applyChangesInSession(dsId, id, ref, rowChanges) : await applyChanges(dsId, ref, rowChanges);
      if (!res.committed) {
        const bad = res.results.find((r) => r.error);
        notify({ kind: "error", title: "Cannot submit the changes", body: bad?.error ?? "The transaction was rolled back." });
        return false;
      }
    } catch (e) {
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

  async function confirmClose(): Promise<boolean> {
    const n = pending();
    if (n > 0) {
      activateTab(props.tab.id);
      const a = await ask({
        title: "Uncommitted Changes",
        message: `'${props.tab.title}' has ${plural(n, "uncommitted change")}. Submit them to the database before closing?`,
        choices: [
          { label: "Submit", value: "submit", primary: true },
          { label: "Discard", value: "discard" },
          { label: "Cancel", value: "cancel" },
        ],
        cancel: "cancel",
      });
      if (a === "cancel") return false;
      if (a === "submit" && !(await submitNow())) return false;
    }
    if (inTx()) {
      activateTab(props.tab.id);
      const a = await ask({
        title: "Active Transaction",
        message: `'${props.tab.title}' has an open transaction with changes that are not committed yet.`,
        choices: [
          { label: "Commit", value: "commit", primary: true },
          { label: "Roll Back", value: "rollback" },
          { label: "Cancel", value: "cancel" },
        ],
        cancel: "cancel",
      });
      if (a === "cancel") return false;
      return endTx(a === "commit" ? "commit" : "rollback", false);
    }
    return true;
  }

  // ---------------------------------------------------------------- transactions

  /** Tx: Manual opens a session for this tab; back to Auto commits an open transaction and drops the session. */
  async function setTxMode(m: "auto" | "manual"): Promise<void> {
    if (m === txMode()) return;
    if (m === "manual") {
      try {
        await ensureConnected(dsId);
        setSid(await openSession(dsId));
        setTxModeSignal("manual");
      } catch (e) {
        fail("Cannot start the transaction session", e);
      }
      return;
    }
    if (inTx() && !(await endTx("commit", false))) return;
    const id = sid();
    setSid(undefined);
    setTxModeSignal("auto");
    if (id) void closeSession(id).catch(() => {});
  }

  /** Commit / Roll Back of the open transaction. Returns whether it ended. `reload`: show the rolled back data. */
  async function endTx(kind: "commit" | "rollback", reload = true): Promise<boolean> {
    const id = sid();
    if (!id || !inTx()) return true;
    try {
      await endTransaction(id, kind);
    } catch (e) {
      fail(kind === "commit" ? "Cannot commit the transaction" : "Cannot roll back the transaction", e);
      return false;
    }
    setInTx(false);
    if (kind === "rollback" && reload) void reloadPage();
    return true;
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
      txMode,
      inTx,
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
    const text = txMode() === "manual" ? (inTx() ? "Tx: Manual (active)" : "Tx: Manual") : "Tx: Auto";
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
    const n = info.numeric;
    setStatus({
      caret: info.row ? { line: info.row, col: info.col ?? 1 } : null,
      aggregator: n && n.count > 1 ? `SUM: ${n.sum}` : info.cells > 1 ? "SUM: Not enough values" : "No aggregator selected",
    });
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

  const extractorMenu = (r: DOMRect) =>
    openMenu(
      EXPORT_FORMATS.map((f) => ({ label: f.label, checked: extractor() === f.value, run: () => setExtractor(f.value) })),
      { x: r.left, y: r.bottom + 2, compact: true },
    );

  const exportOptions = (): ExportOptions => ({ ...defaultExportOptions(driver()), format: extractor(), tableName: tableName() });

  async function doExport(options: ExportOptions, target: ExportTarget): Promise<void> {
    setExportDlg(false);
    setExtractor(options.format);
    const q = src.applied();
    if (target === "file") {
      await exportTableQuery(dsId, ref, driver(), options, "file", { where: q.where, orderBy: q.orderBy });
      return;
    }
    const fmt = EXPORT_FORMATS.find((f) => f.value === options.format) ?? EXPORT_FORMATS[0];
    try {
      const cs = cols();
      const sql = selectSql(driver(), ref, q.where, q.orderBy);
      const text = cs && src.complete() ? await exportToString({ columns: cs, rows: src.pageRows() }, options) : await exportQueryToString(dsId, sql, options);
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
    const size = q.pageSize === "all" ? "" : ` limit ${q.pageSize + 1}${q.page ? ` offset ${q.page * q.pageSize}` : ""}`;
    setSqlPopup({ sql: selectSql(driver(), ref, q.where, q.orderBy, false).replace("select *", "select t.*").replace(/ from (\S+)/, " from $1 t") + size, submit: false });
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
      />
      <Show when={editable() && txMode() === "manual"}>
        <TxBar inTx={inTx()} onCommit={commit} onRollback={rollback} shortcut="Ctrl+Alt+Shift+Enter" />
      </Show>
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
              onSelectionChange={onSelection}
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
        <ExportDialog options={exportOptions()} target="file" onClose={() => setExportDlg(false)} onExport={(o, t) => void doExport(o, t)} />
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
