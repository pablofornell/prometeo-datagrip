/** One result tab: data grid (editable when the result is one table with a usable key) + the floating paging pill. */
import { Show, createMemo, type JSX } from "solid-js";
import { DataGrid, GridPagingPill } from "../../components/grid";
import type { GridColumn, PageSize } from "../../components/grid";
import { SqlPopup } from "../table/Popups";
import { copyText } from "./export";
import type { ConsoleOutput, ResultTab } from "./model";

export function ResultView(props: { tab: ResultTab; out: ConsoleOutput; selected: boolean }): JSX.Element {
  const tab = () => props.tab;
  let root!: HTMLDivElement;
  const chunk = () => {
    const s = tab().pageSize();
    return typeof s === "number" ? Math.max(s, 500) : 5000;
  };
  // read-only columns of an editable result (expressions, aliases, generated columns); the key columns get the key icon
  const columns = createMemo<GridColumn[]>(() => {
    const e = tab().edit();
    if (!e) return tab().columns;
    return tab().columns.map((c, i) => {
      if (!e.editable[i]) return { ...c, readOnly: true };
      return e.key.includes(c.name) ? { ...c, isPk: true } : c;
    });
  });
  const host = () => props.out.host;
  const previewSql = () => {
    try {
      return host()?.previewEdits(tab(), tab().gridApi?.getChanges() ?? []) ?? "";
    } catch (e) {
      return `-- ${String((e as Error)?.message ?? e)}`;
    }
  };
  const changePageSize = (size: PageSize) => {
    if (size === tab().pageSize()) return;
    props.out.host?.rerun(tab(), size);
  };
  return (
    <div
      ref={root}
      class="dgo-result"
      classList={{ "dg-hidden": !props.selected }}
      tabindex={-1}
      data-focus-target={props.selected ? "" : undefined}
      onFocus={(e) => e.target === root && root.querySelector<HTMLElement>(".dgg")?.focus()}
    >
      <DataGrid
        columns={columns()}
        rowCount={tab().rowCount()}
        getRow={(i) => tab().rows[i]}
        version={tab().version()}
        hasMore={tab().hasMore()}
        loadingMore={tab().loadingMore()}
        onNeedMore={() => void tab().loadMore(chunk())}
        viewMode={tab().viewMode()}
        onCopy={(text) => void copyText(text)}
        onReload={() => props.out.host?.rerun(tab())}
        tableName={tab().meta.find((c) => c.tableRef)?.tableRef ?? undefined}
        editable={!!tab().edit()}
        onSubmit={(changes) => host()?.applyEdits(tab(), changes) ?? false}
        onChangesChange={tab().setPending}
        apiRef={(a) => (tab().gridApi = a)}
      >
        <GridPagingPill
          rowCount={tab().rowCount()}
          pageSize={tab().pageSize()}
          onPageSizeChange={changePageSize}
          onCountRows={tab().hasMore() ? () => void tab().loadAll() : undefined}
        />
      </DataGrid>
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
