/** The 34px toolbar under the header: log mini toolbar on the Output tab, the grid toolbar on result tabs. */
import { Show, type JSX } from "solid-js";
import { GridToolbar } from "../../components/grid";
import { ActionButton, Icon, type MenuItem, openMenu } from "../../components/ui";
import { FORMATS, copyResult, exportResultToFile, formatLabel } from "./export";
import { currentOutput, type ConsoleOutput, type ResultTab } from "./model";

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
  return (
    <div>
      <GridToolbar
        running={props.out.running() || tab().applying()}
        editable={edit()}
        hasChanges={tab().pending() > 0}
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
        onExtractorMenu={(r) =>
          at(
            FORMATS.map<MenuItem>((f) => ({ label: f.label, checked: tab().extractor() === f.id, run: () => tab().setExtractor(f.id) })),
            r,
          )
        }
        pinned={tab().pinned()}
        onPin={() => tab().setPinned(!tab().pinned())}
        onExport={(anchor) =>
          at(
            [
              { label: "Export to File...", icon: "export", run: () => host() && void exportResultToFile(tab(), host()!, tab().extractor()) },
              { label: "Copy to Clipboard", icon: "copy", run: () => host() && void copyResult(tab(), host()!, tab().extractor()) },
            ],
            anchor,
          )
        }
        onOptions={(r) =>
          at(
            [
              { label: tab().pinned() ? "Unpin Tab" : "Pin Tab", icon: "pin", run: () => tab().setPinned(!tab().pinned()) },
              { type: "separator" },
              ...FORMATS.map<MenuItem>((f) => ({ label: `Copy as ${f.label}`, run: () => host() && void copyResult(tab(), host()!, f.id) })),
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
    <div class="dg-toolbar dgo-logtb">
      <button ref={tx} type="button" class="dgo-tx" title="Transaction Mode" tabindex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => props.out.host?.openTxMenu(tx)}>
        Tx<i class="dgo-tx-mark" />
      </button>
      <StopButton running={props.out.running()} />
    </div>
  );
}

export function OutputToolbar(): JSX.Element {
  const out = currentOutput;
  return (
    <Show when={out()}>
      {(o) => (
        <Show when={o().current()} fallback={<LogToolbar out={o()} />}>
          {(t) => <ResultToolbar out={o()} tab={t()} />}
        </Show>
      )}
    </Show>
  );
}
