/** Content of an editor pane without tabs (slot `editor.empty`): shortcut hints, plus "New Data Source" while there is none. */
import { For, Show, type JSX } from "solid-js";
import { Icon } from "../../components/ui";
import { actionShortcut, getAction, runAction } from "../../state/actions";
import { explorerDataSources } from "../explorer";

const HINTS: [string, string][] = [
  ["Search Everywhere", "nav.searchEverywhere"],
  ["Go to Database Object", "nav.gotoObject"],
  ["Recent Files", "nav.recentFiles"],
  ["New Query Console", "db.newConsole"],
];

export function EmptyEditor(): JSX.Element {
  return (
    <div class="dg-placeholder-center dg-empty-editor">
      <table class="dg-empty-hints">
        <tbody>
          <For each={HINTS}>
            {([label, id]) => (
              <tr>
                <td>{label}</td>
                <td class="dg-key">{actionShortcut(getAction(id)) ?? ""}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={explorerDataSources().length === 0}>
        <button type="button" class="dg-empty-btn" onClick={() => void runAction("db.dataSources")}>
          <Icon name="dg/manage-data-sources" />
          <span>New Data Source</span>
        </button>
      </Show>
    </div>
  );
}
