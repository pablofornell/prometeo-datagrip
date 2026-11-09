/** One result tab: data grid (editable when the result is one table with a usable key) + the floating paging pill. */
import { Show, createMemo, type JSX } from "solid-js";
import { DataGrid, GridPagingPill } from "../../components/grid";
import type { GridChange, GridColumn, PageSize, SelectionInfo } from "../../components/grid";
import { notify, openMenu } from "../../components/ui";
import { setGridSelection } from "../../state/status";
import { createFkNavigation } from "../table/fkNav";
import { SqlPopup } from "../table/Popups";
import { copyResult, copyText, extractorMenuItems, formatLabel, isBinaryFormat } from "./export";
import type { ConsoleOutput, ResultTab } from "./model";
import { resultTableRef } from "./tableOf";

export function ResultView(props: { tab: ResultTab; out: ConsoleOutput; selected: boolean }): JSX.Element {
  const tab = () => props.tab;
  let root!: HTMLDivElement;
  // a numeric page size shows one page of the rows loaded so far (earlier pages stay loaded); "All" scrolls on
  const paged = () => tab().pageRows() > 0;
  const start = () => (paged() ? tab().pageStart() : 0);
  const shown = () => (paged() ? Math.max(0, Math.min(tab().pageRows(), tab().rowCount() - start())) : tab().rowCount());
  // `of N+` while the server has more rows, `of N` once all pages are loaded
  const ofTotal = () => (tab().hasMore() || (paged() && tab().rowCount() > shown()) ? tab().rowCount() : undefined);
  const nav = createFkNavigation(
    () => props.out.host?.dsId ?? "",
    () => resultTableRef(tab(), props.out.host),
  );
  // read-only columns of an editable result (expressions, aliases, generated columns); the key columns get the key icon
  /** Page changes would orphan the pending edits (their row numbers belong to the page). */
  const pageChange = (go: () => unknown) => {
    if (tab().pending() > 0) {
      notify({ kind: "warning", title: "Pending changes", body: "Submit or revert the pending changes before changing the page." });
      return;
    }
    void go();
  };
  const columns = createMemo<GridColumn[]>(() => {
    const e = tab().edit();
    if (!e) return tab().columns;
    return tab().columns.map((c, i) => {
      if (!e.editable[i]) return { ...c, readOnly: true };
      return e.key.includes(c.name) ? { ...c, isPk: true } : c;
    });
  });
  const host = () => props.out.host;
  // status bar (while this grid has the focus): active cell `row:col` and the aggregate of the selection
  let lastSelection: SelectionInfo | undefined;
  const reportSelection = (info: SelectionInfo | undefined = lastSelection) => {
    lastSelection = info;
    if (info && props.selected) setGridSelection(props.out.tabId, info);
  };
  const previewSql = () => {
    try {
      return host()?.previewEdits(tab(), tab().gridApi?.getChanges() ?? []) ?? "";
    } catch (e) {
      return `-- ${String((e as Error)?.message ?? e)}`;
    }
  };
  // changes carry the row index of the page: the tab's rows are indexed from the first loaded row
  const toTabRows = (changes: GridChange[]) => (start() ? changes.map((c) => (c.kind === "insert" ? c : { ...c, row: c.row + start() })) : changes);
  const changePageSize = (size: PageSize) => {
    if (size === tab().pageSize()) return;
    props.out.host?.rerun(tab(), size);
  };
  return (
    <div
      ref={root}
      class="dgo-result"
      classList={{ "dg-hidden": !props.selected, "dgo-loading-tab": tab().loading() }}
      tabindex={-1}
      data-focus-target={props.selected ? "" : undefined}
      onFocus={(e) => e.target === root && root.querySelector<HTMLElement>(".dgg")?.focus()}
      onFocusIn={() => reportSelection()}
    >
      <Show when={tab().partial()}>
        {(m) => (
          <div class="dgo-partial" role="alert">
            <span>{m().charAt(0).toUpperCase() + m().slice(1)}</span>
            <a class="dgo-partial-link" onClick={() => props.out.host?.rerun(tab())}>
              Reload
            </a>
          </div>
        )}
      </Show>
      <DataGrid
        columns={tab().loading() ? [] : columns()}
        rowCount={shown()}
        getRow={(i) => tab().rows[start() + i]}
        version={tab().version() + start() * 8191}
        rowNumberOffset={start()}
        hasMore={tab().hasMore()}
        loadingMore={tab().loadingMore()}
        onNeedMore={paged() ? undefined : () => void tab().loadMore(5000)}
        bottomPad={40}
        navigation={nav.navigation}
        fkColumns={nav.fkColumns}
        dialect={props.out.dialect}
        initialColumns={tab().columnsState}
        onColumnsChange={(s) => (tab().columnsState = s)}
        extractorLabel={formatLabel(tab().extractor())}
        onChangeExtractor={(at) => openMenu(extractorMenuItems(tab().extractor(), tab().setExtractor), { x: at.x, y: at.y, minWidth: 230, title: "Data Extractors" })}
        onExportToClipboard={host() && !isBinaryFormat(tab().extractor()) ? () => void copyResult(tab(), host()!, tab().extractor()) : undefined}
        viewMode={tab().viewMode()}
        onCopy={(text) => void copyText(text)}
        onReload={() => props.out.host?.rerun(tab())}
        tableName={tab().meta.find((c) => c.tableRef)?.tableRef ?? undefined}
        editable={!!tab().edit()}
        onSubmit={(changes) => host()?.applyEdits(tab(), toTabRows(changes)) ?? false}
        onChangesChange={tab().setPending}
        onViewChange={tab().setView}
        onSelectionChange={reportSelection}
        apiRef={(a) => (tab().gridApi = a)}
      >
        <GridPagingPill
          rowCount={shown()}
          pageSize={tab().pageSize()}
          onPageSizeChange={changePageSize}
          onCountRows={tab().hasMore() ? () => void tab().loadAll() : undefined}
          loading={tab().loading()}
          ofTotal={ofTotal()}
          ofMore={tab().hasMore()}
          onFirstPage={tab().canPrevPage() ? () => pageChange(() => tab().firstPage()) : undefined}
          onPreviousPage={tab().canPrevPage() ? () => pageChange(() => tab().prevPage()) : undefined}
          onNextPage={tab().canNextPage() ? () => pageChange(() => tab().nextPage()) : undefined}
          onLastPage={tab().canNextPage() ? () => pageChange(() => tab().lastPage()) : undefined}
        />
      </DataGrid>
      <Show when={tab().loading()}>
        <div class="dgo-loading" aria-label="Running">
          <span class="dg-spokes dgo-bigspin" />
        </div>
      </Show>
      <Show when={tab().showQuery()}>
        <SqlPopup
          title="Query"
          sql={tab().sql}
          dialect={props.out.dialect}
          primary={host()?.insertSql ? { label: "Open in Console", run: () => (tab().setShowQuery(false), host()?.insertSql?.(tab().sql)) } : undefined}
          secondaryLabel="Close"
          onClose={() => tab().setShowQuery(false)}
        />
      </Show>
      <Show when={tab().preview()}>
        <SqlPopup
          sql={previewSql()}
          dialect={props.out.dialect}
          primary={{ label: "Submit", run: () => (tab().setPreview(false), tab().gridApi?.submit()) }}
          secondaryLabel="Cancel"
          onClose={() => (tab().setPreview(false), tab().gridApi?.focus())}
        />
      </Show>
    </div>
  );
}
