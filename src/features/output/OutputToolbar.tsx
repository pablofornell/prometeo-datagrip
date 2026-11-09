/** The 34px toolbar under the header: log mini toolbar on the Output tab, the grid toolbar on result tabs. */
import { Show, type JSX } from "solid-js";
import { GridToolbar } from "../../components/grid";
import type { ObjectRef } from "../../api/types";
import { ActionButton, Icon, type MenuItem, ToolbarSeparator, openMenu, overflowToolbar } from "../../components/ui";
import { openDdlTab, openTableTab } from "../table/commands";
import { EXTRACTORS, copyResult, exportResultData, extractorMenuItems, formatLabel } from "./export";
import { resultTable } from "../console/title";
import { PLAN_TAB, currentOutput, type ConsoleOutput, type ResultTab } from "./model";

/** Cancel Running Statements: gray square while idle, the red stop icon only while something runs. */
export function StopButton(props: { running: boolean; class?: string }): JSX.Element {
  return (
    <ActionButton action="sql.cancel" class={props.class}>
      <Show when={props.running} fallback={<svg class="dg-stop-idle" width="16" height="16" viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1" /></svg>}>
        <Icon name="stop" size={16} />
      </Show>
    </ActionButton>
  );
}

function ResultToolbar(props: { out: ConsoleOutput; tab: ResultTab }): JSX.Element {
  const host = () => props.out.host;
  const tab = () => props.tab;
  const at = (items: MenuItem[], anchor: DOMRect | HTMLElement) =>
    openMenu(items, anchor instanceof HTMLElement ? { anchor } : { x: anchor.left, y: anchor.bottom + 2 });

  const api = () => tab().gridApi;
  const edit = () => !!tab().edit();
  /** The table the result reads (`Go to DDL`): the editable target, else the one table of a plain select. */
  const ddl = (): ObjectRef | null => {
    const h = host();
    if (!h) return null;
    const e = tab().edit();
    if (e) return e.table;
    const parts = resultTable(tab().meta, tab().sql, h.driver);
    if (!parts) return null;
    const schema = parts.length > 1 ? parts[0] : h.driver === "sqlite" ? "main" : (h.schema?.() ?? null);
    return { schema, name: parts[parts.length - 1], kind: "table" };
  };
  return (
    <div>
      <GridToolbar
        running={props.out.running() || tab().applying()}
        editable={edit()}
        hasChanges={tab().pending() > 0}
        emptyResult={tab().rowCount() === 0 && tab().pending() === 0}
        txMode={host()?.txMode() === "manual" ? "Manual" : "Auto"}
        onTxMenu={(r) => host()?.openTxMenu(r)}
        onCommit={() => void host()?.endTx("commit")}
        onRollback={() => void host()?.endTx("rollback")}
        txActive={!!host()?.inTx()}
        txFailed={host()?.txStatus() === "failed"}
        onAddRow={() => api()?.addRow()}
        onDeleteRows={() => api()?.deleteRows()}
        onRevert={() => api()?.revertSelected()}
        onPreview={() => tab().setPreview(true)}
        onSubmit={() => api()?.submit()}
        viewMode={tab().viewMode()}
        onViewModeChange={tab().setViewMode}
        transposed={!!tab().view()?.transposed}
        onTransposeChange={() => api()?.toggleTranspose()}
        onRecordView={() => api()?.toggleRecordView()}
        recordViewOpen={!!tab().view()?.sidePanel}
        onFind={() => api()?.openFind()}
        findOpen={!!tab().view()?.findOpen}
        localFilterEnabled={tab().view()?.localFilterEnabled ?? true}
        localFilterActive={!!tab().view()?.localFilterActive}
        onLocalFilterEnabledChange={(on) => api()?.setLocalFilterEnabled(on)}
        onClearLocalFilter={() => api()?.clearLocalFilter()}
        onManageColumns={(anchor) => api()?.openManageColumns(anchor)}
        columnsHidden={(tab().view()?.hiddenColumns ?? 0) > 0}
        onReload={() => host()?.rerun(tab())}
        onCancel={() => host()?.cancel()}
        extractor={formatLabel(tab().extractor())}
        onExtractorMenu={(r) => openMenu(extractorMenuItems(tab().extractor(), tab().setExtractor), { x: r.right - 230, y: r.bottom + 2, minWidth: 230, title: "Data Extractors" })}
        pinned={tab().pinned()}
        onPin={() => tab().setPinned(!tab().pinned())}
        onSql={() => tab().setShowQuery(true)}
        onOpenInEditor={ddl() ? () => void openTableTab(host()!.dsId, ddl()!) : undefined}
        onDDL={ddl() ? () => void openDdlTab(host()!.dsId, ddl()!) : undefined}
        onExport={tab().rowCount() > 0 || tab().hasMore() ? () => host() && exportResultData(tab(), host()!) : undefined}
        onOptions={(r) =>
          at(
            [
              { label: tab().pinned() ? "Unpin Tab" : "Pin Tab", icon: "pin", run: () => tab().setPinned(!tab().pinned()) },
              { type: "separator" },
              {
                label: "Copy As",
                children: EXTRACTORS.map<MenuItem>((f) => ({ label: f.label, run: () => host() && void copyResult(tab(), host()!, f.id) })),
              },
              { type: "separator" },
              { label: "Close Tab", run: () => props.out.closeResult(tab().id) },
            ],
            r,
          )
        }
      />
    </div>
  );
}

function LogToolbar(props: { out: ConsoleOutput }): JSX.Element {
  let tx!: HTMLButtonElement;
  return (
    <div class="dg-toolbar dgo-logtb" ref={overflowToolbar}>
      <button ref={tx} type="button" class="dgo-tx" title="Transaction Mode" tabindex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => props.out.host?.openTxMenu(tx)}>
        Tx<i class="dgo-tx-mark" />
      </button>
      <StopButton running={props.out.running()} />
      <ToolbarSeparator />
      <ActionButton
        title={props.out.logAside() ? "Output in a separate tab" : "Show Output tab alongside results"}
        selected={props.out.logAside()}
        onClick={() => props.out.setLogAside(!props.out.logAside())}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
          <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
          <path d="M9.5 3.5v9" />
        </svg>
      </ActionButton>
    </div>
  );
}

export function OutputToolbar(): JSX.Element {
  const out = currentOutput;
  return (
    <Show when={out()}>
      {(o) => (
        <Show when={o().selected() !== PLAN_TAB} fallback={<div class="dgo-plan-tb" />}>
        <Show when={o().current()} fallback={<LogToolbar out={o()} />}>
          {(t) => <ResultToolbar out={o()} tab={t()} />}
        </Show>
        </Show>
      )}
    </Show>
  );
}
