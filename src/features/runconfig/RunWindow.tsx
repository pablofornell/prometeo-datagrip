/** The Run tool window: one tab per run of a Database Script, with the output log and rerun / stop on the left. */
import { Show, type JSX } from "solid-js";
import { ActionButton, Tabs } from "../../components/ui";
import { LogView } from "../output/LogView";
import { formatDuration } from "../output/format";
import { activeRun, activeRunId, closeRun, runs, setActiveRun, startRun } from "./run";
import { configById } from "./store";

export function RunHeader(): JSX.Element {
  return (
    <div class="dgr-run-header">
      <Tabs
        variant="result"
        items={runs().map((r) => ({ id: r.id, title: r.title, icon: "dg/sql-script", closeable: true }))}
        active={activeRunId()}
        onSelect={setActiveRun}
        onClose={closeRun}
      />
    </div>
  );
}

export function RunBody(): JSX.Element {
  const rerun = () => {
    const r = activeRun();
    if (r) startRun(configById(r.cfgId) ?? r.cfg);
  };
  return (
    <Show when={activeRun()} fallback={<div class="dg-placeholder-center">Run a database script to see its output here</div>}>
      {(r) => (
        <div class="dgr-run">
          <div class="dgr-run-tb">
            <ActionButton icon="rerun" title="Rerun" disabled={r().running()} onClick={rerun} />
            <ActionButton icon="stop" title="Stop" disabled={!r().running()} onClick={() => r().stop()} />
            <Show when={r().out.lastMs() !== null && !r().running()}>
              <span class="dgr-run-ms">{formatDuration(r().out.lastMs()!)}</span>
            </Show>
          </div>
          <LogView out={r().out} />
        </div>
      )}
    </Show>
  );
}
