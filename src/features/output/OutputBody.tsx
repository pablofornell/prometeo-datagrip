/** Body of the Database Output: the log or the selected result grid (every result stays mounted, hidden). */
import { For, Show, type JSX } from "solid-js";
import { LogView } from "./LogView";
import { currentOutput } from "./model";
import { ResultView } from "./ResultView";

export function OutputBody(): JSX.Element {
  const out = currentOutput;
  return (
    <Show when={out()} fallback={<div class="dg-placeholder-center">Run a query to see its output here</div>}>
      {(o) => (
        <div class="dgo-body">
          <div class="dgo-pane" classList={{ "dg-hidden": o().selected() !== "output" }}>
            <LogView out={o()} />
          </div>
          <For each={o().results()}>{(r) => <ResultView tab={r} out={o()} selected={o().selected() === r.id} />}</For>
        </div>
      )}
    </Show>
  );
}
