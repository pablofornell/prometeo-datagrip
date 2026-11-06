/** One result tab: read-only data grid + the floating paging pill. */
import { type JSX } from "solid-js";
import { DataGrid, GridPagingPill } from "../../components/grid";
import type { PageSize } from "../../components/grid";
import { copyText } from "./export";
import type { ConsoleOutput, ResultTab } from "./model";

export function ResultView(props: { tab: ResultTab; out: ConsoleOutput; selected: boolean }): JSX.Element {
  const tab = () => props.tab;
  let root!: HTMLDivElement;
  const chunk = () => {
    const s = tab().pageSize();
    return typeof s === "number" ? Math.max(s, 500) : 5000;
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
        columns={tab().columns}
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
      >
        <GridPagingPill
          rowCount={tab().rowCount()}
          pageSize={tab().pageSize()}
          onPageSizeChange={changePageSize}
          onCountRows={tab().hasMore() ? () => void tab().loadAll() : undefined}
        />
      </DataGrid>
    </div>
  );
}
