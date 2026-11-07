/**
 * Presentational pieces around the grid, all driven by props/callbacks:
 *   GridToolbar     - the 34px action toolbar (reload, add/remove row, revert, preview, submit, Tx, export...)
 *   GridFilterBar   - the table-editor WHERE | ORDER BY row (30px)
 *   GridPagingPill  - the floating "N rows" pill with the page-size menu
 * Tooltips are the shared ones of src/components/ui (`tip()`: text + gray shortcut).
 */
import { Show, createSignal, type JSX } from "solid-js";
import { tip } from "../ui/Tooltip";
import { GridMenu, type MenuItem } from "./GridMenu";
import type { ViewMode } from "./types";
import "./grid.css";

type Icon =
  | "reload"
  | "stop"
  | "add"
  | "remove"
  | "revert"
  | "preview"
  | "submit"
  | "commit"
  | "rollback"
  | "find"
  | "filter"
  | "record"
  | "export"
  | "openTab"
  | "columns"
  | "viewAs"
  | "gear"
  | "more"
  | "chevron"
  | "sortBy"
  | "table"
  | "text"
  | "pin"
  | "pinOn";

function Btn(props: {
  icon: Icon;
  title: string;
  shortcut?: string;
  disabled?: boolean;
  selected?: boolean;
  green?: boolean;
  /** Blue state dot (e.g. hidden columns). */
  dot?: boolean;
  onClick?: (e: MouseEvent) => void;
}): JSX.Element {
  return (
    <button
      class="dgg-tbtn"
      classList={{ selected: props.selected, green: props.green, dot: props.dot }}
      disabled={props.disabled}
      {...tip(props.title, props.shortcut)}
      onClick={(e) => props.onClick?.(e)}
      tabIndex={-1}
    >
      <i class={"dgg-i i-" + props.icon} />
    </button>
  );
}

const Sep = () => <span class="dgg-tsep" />;

export interface GridToolbarProps {
  /** Result can be edited (table results): enables the edit group. */
  editable?: boolean;
  /** The result has no rows (and no pending new row): Delete Rows is disabled. */
  emptyResult?: boolean;
  /** Pending changes exist: enables revert / preview / submit (submit turns green). */
  hasChanges?: boolean;
  /** A statement is running: enables "Cancel Running Statements". */
  running?: boolean;
  viewMode?: ViewMode;
  onViewModeChange?: (m: ViewMode) => void;

  /** Transaction mode label ("Auto" / "Manual"); the Tx widget is shown for editable results only. */
  txMode?: string;
  onTxMenu?: (anchor: DOMRect) => void;
  /** Commit / Roll Back buttons after the Tx widget (shown while the mode is Manual and a handler is given). */
  onCommit?: () => void;
  onRollback?: () => void;
  /** A manual transaction is open: enables commit / roll back. */
  txActive?: boolean;
  /** The transaction failed (PG aborted state): shown in red, only Roll Back is useful. */
  txFailed?: boolean;

  /** Extractor format shown in the `CSV ⌄` widget. */
  extractor?: string;
  onExtractorMenu?: (anchor: DOMRect) => void;

  onReload?: () => void;
  onCancel?: () => void;
  onAddRow?: () => void;
  onDeleteRows?: () => void;
  onRevert?: () => void;
  onPreview?: () => void;
  onSubmit?: () => void;
  onDDL?: () => void;
  /** `Pin Tab`: keeps the result tab when the next execution would replace it. The button is hidden without a handler. */
  pinned?: boolean;
  onPin?: () => void;
  onFind?: () => void;
  /** The Find bar is open (button shown pressed). */
  findOpen?: boolean;
  /** Plain click handler of the local filter button. Ignored when `onLocalFilterEnabledChange` is given (menu instead). */
  onLocalFilter?: () => void;
  /** Local filter menu (`Enable Local Filter` check + `Clear Local Filter For All Columns`), like DataGrip. */
  localFilterEnabled?: boolean;
  /** A column filter is active (button shown pressed). */
  localFilterActive?: boolean;
  onLocalFilterEnabledChange?: (on: boolean) => void;
  onClearLocalFilter?: () => void;
  onRecordView?: () => void;
  /** The record view side panel is open (button shown pressed). */
  recordViewOpen?: boolean;
  onSql?: () => void;
  onOpenInEditor?: () => void;
  /** Gets the export button, so the menu / dialog can open under it. */
  onExport?: (anchor: HTMLElement) => void;
  /** Receives the button rectangle (open the column list under it: `api.openManageColumns(anchor)`). */
  onManageColumns?: (anchor: DOMRect) => void;
  /** Some columns are hidden: the button gets a blue dot. */
  columnsHidden?: boolean;
  /** `View as > Transpose` check; the item is enabled when `onTransposeChange` is given. */
  transposed?: boolean;
  onTransposeChange?: (on: boolean) => void;
  onOptions?: (anchor: DOMRect) => void;
}

export function GridToolbar(props: GridToolbarProps): JSX.Element {
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const mode = () => props.viewMode ?? "table";
  const ed = () => !!props.editable;

  const openViewAs = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pick = (m: ViewMode) => () => props.onViewModeChange?.(m);
    setMenu({
      x: r.right,
      y: r.bottom + 2,
      items: [
        { label: "Transpose", primary: true, checked: !!props.transposed, disabled: !props.onTransposeChange, onSelect: () => props.onTransposeChange?.(!props.transposed) },
        { separator: true },
        { label: "Table", checked: mode() === "table", onSelect: pick("table") },
        { label: "Tree", disabled: true },
        { label: "Text", checked: mode() === "text", onSelect: pick("text") },
      ],
    });
  };

  const openLocalFilterMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 2,
      items: [
        { label: "Enable Local Filter", checked: props.localFilterEnabled !== false, onSelect: () => props.onLocalFilterEnabledChange?.(props.localFilterEnabled === false) },
        { label: "Clear Local Filter For All Columns", disabled: !props.onClearLocalFilter, onSelect: props.onClearLocalFilter },
      ],
    });
  };

  return (
    <div class="dgg-tb" role="toolbar">
      <Btn icon="table" title={mode() === "table" ? "Switch to Text" : "Switch to Table"} selected={mode() === "table"} onClick={() => props.onViewModeChange?.(mode() === "table" ? "text" : "table")} />
      <Sep />
      <Btn icon="reload" title="Reload Page" shortcut="Ctrl+F5" onClick={props.onReload} />
      <Btn icon="stop" title="Cancel Running Statements" shortcut="Ctrl+F2" disabled={!props.running} onClick={props.onCancel} />
      <Sep />
      {/* a read-only result (join, aggregate, view) has no edit group, like DataGrip */}
      <Show when={ed()}>
        <Btn icon="add" title="Add Row" shortcut="Alt+Insert" onClick={props.onAddRow} />
        <Btn icon="remove" title="Delete Rows" shortcut="Ctrl+Y" disabled={props.emptyResult} onClick={props.onDeleteRows} />
        <Btn icon="revert" title="Revert Selected" shortcut="Ctrl+Alt+Z" disabled={!props.hasChanges} onClick={props.onRevert} />
        <Btn icon="preview" title="Preview Pending Changes" disabled={!props.hasChanges} onClick={props.onPreview} />
        <Btn icon="submit" title="Submit" shortcut="Ctrl+Enter" disabled={!props.hasChanges} green={!!props.hasChanges} onClick={props.onSubmit} />
        <button
          class="dgg-tbtn text tx"
          classList={{ failed: !!props.txFailed }}
          {...tip("Transaction Mode")}
          tabIndex={-1}
          onClick={(e) => props.onTxMenu?.((e.currentTarget as HTMLElement).getBoundingClientRect())}
        >
          Tx: {props.txMode ?? "Auto"}{props.txFailed ? " (failed)" : ""}
          <i class="dgg-i i-chevron" />
        </button>
        <Show when={props.txMode === "Manual" && (props.onCommit || props.onRollback)}>
          <Btn icon="commit" title="Commit" shortcut="Ctrl+Alt+Shift+Enter" disabled={!props.txActive || !props.onCommit} onClick={() => props.onCommit?.()} />
          <Btn icon="rollback" title="Roll Back" disabled={!props.txActive || !props.onRollback} onClick={() => props.onRollback?.()} />
        </Show>
      </Show>
      <Show when={ed()}>
        <Sep />
      </Show>
      <Show when={props.onDDL}>
        <button class="dgg-tbtn text" {...tip("Go to DDL")} tabIndex={-1} onClick={() => props.onDDL?.()}>
          DDL
        </button>
      </Show>
      <Show when={props.onPin}>
        <Btn icon={props.pinned ? "pinOn" : "pin"} title={props.pinned ? "Unpin Tab" : "Pin Tab"} selected={props.pinned} onClick={() => props.onPin?.()} />
      </Show>
      <Sep />
      <Btn icon="find" title="Find on Current Page" shortcut="Ctrl+F" disabled={!props.onFind} selected={props.findOpen} onClick={() => props.onFind?.()} />
      <Btn
        icon="filter"
        title="Table Result Local Filter"
        disabled={!props.onLocalFilter && !props.onLocalFilterEnabledChange}
        selected={props.localFilterActive}
        onClick={(e) => (props.onLocalFilterEnabledChange ? openLocalFilterMenu(e) : props.onLocalFilter?.())}
      />
      <Btn icon="record" title="Record View" shortcut="Ctrl+Shift+Enter" disabled={!props.onRecordView} selected={props.recordViewOpen} onClick={() => props.onRecordView?.()} />

      <span class="dgg-tspacer" />

      <Show when={props.onSql}>
        <button class="dgg-tbtn text" {...tip("Show the query that produced this result set")} tabIndex={-1} onClick={() => props.onSql?.()}>
          SQL
        </button>
      </Show>
      <Show when={props.onOpenInEditor}>
        <Btn icon="openTab" title="Open in Editor Tab" onClick={props.onOpenInEditor} />
      </Show>
      <Show when={props.onSql || props.onOpenInEditor}>
        <Sep />
      </Show>
      <button
        class="dgg-tbtn text fmt"
        {...tip("Extractor")}
        tabIndex={-1}
        onClick={(e) => props.onExtractorMenu?.((e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        {props.extractor ?? "CSV"}
        <i class="dgg-i i-chevron" />
      </button>
      <Sep />
      <Btn icon="export" title="Export Data" disabled={!props.onExport} onClick={(e) => props.onExport?.(e.currentTarget as HTMLElement)} />
      <Sep />
      <Btn
        icon="columns"
        title="Manage Columns"
        shortcut="Ctrl+F12"
        disabled={!props.onManageColumns}
        dot={props.columnsHidden}
        onClick={(e) => props.onManageColumns?.((e.currentTarget as HTMLElement).getBoundingClientRect())}
      />
      <Btn icon="viewAs" title="View as" onClick={openViewAs} />
      <Btn icon="gear" title="Show Options Menu" disabled={!props.onOptions} onClick={(e) => props.onOptions?.((e.currentTarget as HTMLElement).getBoundingClientRect())} />

      <Show when={menu()}>{(m) => <GridMenu x={m().x} y={m().y} items={m().items} alignRight onClose={() => setMenu(null)} />}</Show>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export interface GridFilterBarProps {
  where: string;
  orderBy: string;
  onWhereChange: (v: string) => void;
  onOrderByChange: (v: string) => void;
  /** Enter in either field. */
  onApply: () => void;
}

/** `WHERE | ORDER BY` row of the table data editor. */
export function GridFilterBar(props: GridFilterBarProps): JSX.Element {
  const half = (
    kind: "where" | "order",
    label: string,
    value: () => string,
    set: (v: string) => void,
  ): JSX.Element => (
    <div class="dgg-fb-half">
      <i class={"dgg-i " + (kind === "where" ? "i-filter" : "i-sortBy")} />
      <span class="dgg-fb-label" classList={{ filled: value().length > 0 }}>
        {label}
      </span>
      <input
        class="dgg-fb-input"
        value={value()}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => set(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            props.onApply();
          } else if (e.key === "Escape" && value()) {
            e.preventDefault();
            set("");
          }
        }}
      />
      <Show when={value().length > 0}>
        <button
          class="dgg-fb-clear"
          {...tip("Clear")}
          tabIndex={-1}
          onClick={() => {
            set("");
            props.onApply();
          }}
        >
          {"×"}
        </button>
      </Show>
    </div>
  );
  return (
    <div class="dgg-fb">
      {half("where", "WHERE", () => props.where, props.onWhereChange)}
      {half("order", "ORDER BY", () => props.orderBy, props.onOrderByChange)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export type PageSize = number | "all";

export interface GridPagingPillProps {
  /** Rows currently loaded. */
  rowCount: number;
  /** Known total (after "Count Rows"); shown as `N of M rows`. */
  totalRows?: number | null;
  pageSize: PageSize;
  defaultPageSize?: number;
  onPageSizeChange?: (size: PageSize) => void;
  onCountRows?: () => void;
  /** The statement still runs: `of N+` after the count (the total is not known yet). */
  loading?: boolean;
  /** Gray `of N` segment: the rows loaded in all pages; `ofMore` makes it `of N+` (the server has more). */
  ofTotal?: number;
  ofMore?: boolean;
  onFirstPage?: () => void;
  onPreviousPage?: () => void;
  onNextPage?: () => void;
  onLastPage?: () => void;
}

const SIZES: PageSize[] = [10, 100, 250, 500, 1000, "all"];

/** Floating pill at the bottom center of the grid. Place it as a child of `<DataGrid>`. */
export function GridPagingPill(props: GridPagingPillProps): JSX.Element {
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const label = () => {
    const n = props.rowCount.toLocaleString("en-US");
    const noun = props.rowCount === 1 ? "row" : "rows";
    return props.totalRows != null ? `${n} of ${props.totalRows.toLocaleString("en-US")} ${noun}` : `${n} ${noun}`;
  };
  const def = () => props.defaultPageSize ?? 500;
  const ofText = () => {
    if (props.ofTotal != null) return `of ${props.ofTotal.toLocaleString("en-US")}${props.ofMore ? "+" : ""}`;
    return props.loading ? `of ${props.rowCount.toLocaleString("en-US")}+` : null;
  };

  const openSizes = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.top - 4,
      items: [
        { label: "Count Rows", primary: true, disabled: !props.onCountRows, onSelect: props.onCountRows },
        { separator: true },
        { label: "Page Size", header: true },
        ...SIZES.map<MenuItem>((s) => ({
          label: s === "all" ? "All" : s.toLocaleString("en-US") + (s === def() ? "  Default" : ""),
          checked: props.pageSize === s,
          onSelect: () => props.onPageSizeChange?.(s),
        })),
      ],
    });
  };
  const openMore = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.top - 4,
      items: [
        { label: "First Page", disabled: !props.onFirstPage, onSelect: props.onFirstPage },
        { label: "Previous Page", shortcut: "Ctrl+Alt+Up", disabled: !props.onPreviousPage, onSelect: props.onPreviousPage },
        { label: "Next Page", shortcut: "Ctrl+Alt+Down", disabled: !props.onNextPage, onSelect: props.onNextPage },
        { label: "Last Page", disabled: !props.onLastPage, onSelect: props.onLastPage },
      ],
    });
  };

  return (
    <div class="dgg-pill">
      <button class="dgg-pill-main" onClick={openSizes} tabIndex={-1}>
        <span>{label()}</span>
        <i class="dgg-i i-chevron" />
      </button>
      <Show when={ofText()}>
        {(t) => (
          <>
            <span class="dgg-pill-sep" />
            <span class="dgg-pill-of">{t()}</span>
          </>
        )}
      </Show>
      <span class="dgg-pill-sep" />
      <button class="dgg-pill-more" onClick={openMore} tabIndex={-1} {...tip("More")}>
        <i class="dgg-i i-more" />
      </button>
      <Show when={menu()}>{(m) => <GridMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(null)} />}</Show>
    </div>
  );
}
