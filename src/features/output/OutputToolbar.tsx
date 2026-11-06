/** The 34px toolbar under the header: log mini toolbar on the Output tab, the grid toolbar on result tabs. */
import { Show, type JSX } from "solid-js";
import { GridToolbar } from "../../components/grid";
import { ActionButton, type MenuItem, openMenu } from "../../components/ui";
import { FORMATS, copyResult, exportResultToFile, formatLabel } from "./export";
import { currentOutput, type ConsoleOutput, type ResultTab } from "./model";

function ResultToolbar(props: { out: ConsoleOutput; tab: ResultTab }): JSX.Element {
  const host = () => props.out.host;
  const tab = () => props.tab;
  const at = (items: MenuItem[], anchor: DOMRect | HTMLElement) =>
    openMenu(items, anchor instanceof HTMLElement ? { anchor } : { x: anchor.left, y: anchor.bottom + 2 });

  return (
    <div>
      <GridToolbar
        running={props.out.running()}
        viewMode={tab().viewMode()}
        onViewModeChange={tab().setViewMode}
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
      <ActionButton action="sql.cancel" icon="stop" />
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
