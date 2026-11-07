/** Body of the Database Output: the log or the selected result grid (every result stays mounted, hidden). */
import { For, Show, type JSX } from "solid-js";
import { LogView } from "./LogView";
import { type ConsoleOutput, PLAN_TAB, currentOutput } from "./model";
import { PlanView } from "./PlanView";
import { ResultView } from "./ResultView";

/** The log is shown next to the selected result (not on its own tab, not beside the plan). */
const aside = (o: ConsoleOutput): boolean => o.logAside() && o.selected() !== PLAN_TAB && o.selected() !== "output";

export function OutputBody(): JSX.Element {
  const out = currentOutput;
  return (
    <Show when={out()} fallback={<div class="dg-placeholder-center">Run a query to see its output here</div>}>
      {(o) => (
        <div class="dgo-body" classList={{ "dgo-aside": aside(o()) }}>
          <div class="dgo-pane dgo-pane-log" classList={{ "dg-hidden": o().selected() !== "output" && !aside(o()) }}>
            <LogView out={o()} />
          </div>
          <Show when={o().plan()}>
            {(p) => (
              <div class="dgo-pane" classList={{ "dg-hidden": o().selected() !== PLAN_TAB }}>
                <PlanView tab={p()} />
              </div>
            )}
          </Show>
          <For each={o().results()}>{(r) => <ResultView tab={r} out={o()} selected={o().selected() === r.id} />}</For>
        </div>
      )}
    </Show>
  );
}
