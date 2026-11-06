import { Show, type JSX } from "solid-js";
import { ActionButton, SpeedSearchField, ToolbarSeparator, matchRanges, openMenu } from "../../components/ui";
import { newMenuItems } from "./actions";
import { dataSourceDialogAvailable, dataSourceProperties } from "./commands";
import { searchQuery, selectedNode, setShowSystemObjects, showSystemObjects } from "./core";

/** The 34px toolbar under the header: New, Data Source Properties | Refresh, Deactivate | Console, Edit Data, DDL | View Options. */
export function ExplorerToolbar(): JSX.Element {
  let newBtn!: HTMLButtonElement;
  let viewBtn!: HTMLButtonElement;
  const noMatch = () => !matchRanges(selectedNode()?.label ?? "", searchQuery());
  return (
    <div class="dg-toolbar dg-tw-toolbar dg-explorer-toolbar">
      <ActionButton
        icon="add"
        title="New"
        dropdown
        ref={(el) => (newBtn = el)}
        onClick={() => openMenu(newMenuItems(), { anchor: newBtn, title: "New", compact: true, minWidth: 290 })}
      />
      <ActionButton
        icon="dg/manage-data-sources"
        title="Data Source Properties"
        shortcut="Ctrl+Alt+Shift+S"
        disabled={!dataSourceDialogAvailable()}
        onClick={() => dataSourceProperties(selectedNode()?.data.dsId)}
      />
      <ToolbarSeparator />
      <ActionButton icon="refresh" action="db.refresh" />
      <ActionButton icon="dg/kill-process" action="db.disconnect" />
      <ToolbarSeparator />
      <ActionButton icon="dg/console" action="db.jumpToConsole" />
      <ActionButton icon="dg/edit-data" action="db.editData" />
      <ActionButton class="dg-explorer-ddl" action="db.gotoDdl" title="Go to DDL">
        DDL
      </ActionButton>
      <ToolbarSeparator />
      <ActionButton
        icon="show"
        title="View Options"
        dropdown
        ref={(el) => (viewBtn = el)}
        onClick={() =>
          openMenu(
            [{ label: "Show System Schemas", checked: () => showSystemObjects(), run: () => setShowSystemObjects(!showSystemObjects()) }],
            { anchor: viewBtn },
          )
        }
      />
      <Show when={searchQuery()}>
        <div class="dg-explorer-search">
          <SpeedSearchField query={searchQuery()} noMatch={noMatch()} />
        </div>
      </Show>
    </div>
  );
}

/** Header buttons (visible on hover): select opened object, expand all, collapse all. */
export function ExplorerHeaderActions(): JSX.Element {
  return (
    <>
      <ActionButton icon="locate" action="explorer.locate" />
      <ActionButton icon="expand-all" action="explorer.expandAll" />
      <ActionButton icon="collapse-all" action="explorer.collapseAll" />
    </>
  );
}
