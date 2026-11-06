import { For, type JSX, Show } from "solid-js";
import { Highlighted, Icon, Tree } from "../../components/ui";
import { theme } from "../../state/theme";
import { DRIVERS, showContextMenu } from "./actions";
import {
  dataSourceProperties,
  newDataSource,
  openDdl,
  openTable,
} from "./commands";
import {
  badges,
  busy,
  connected,
  loadChildren,
  loaded,
  onExpandedChange,
  onSelect,
  roots,
  saved,
  setController,
  setSearchQuery,
} from "./core";
import { DialogHost } from "./dialogs";
import { LOCAL, localIconUrl, providerIcon } from "./icons";
import { type ENode, TABLE_CHILD, TABLE_LIKE } from "./model";
import { NodeIcon } from "./NodeIcon";

/** Enter / F4 / double click. Returns true when handled; otherwise the tree toggles folders. */
function activate(n: ENode, via: "enter" | "f4" | "dblclick"): boolean {
  const d = n.data;
  if (d.kind === "loading" || d.kind === "error") return false;
  if (TABLE_LIKE.includes(d.kind) || TABLE_CHILD.includes(d.kind)) {
    if (d.kind === "trigger" && via !== "f4") void openDdl(d);
    else void openTable(d);
    return true;
  }
  if (d.kind === "sequence" || d.kind === "function" || d.kind === "procedure" || d.kind === "routine") {
    void openDdl(d);
    return true;
  }
  if (d.kind === "dataSource" && via === "f4") {
    dataSourceProperties(d.dsId);
    return true;
  }
  return false;
}

function onKey(e: KeyboardEvent, n: ENode | undefined): boolean {
  if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) {
    if (n) dataSourceProperties(n.data.dsId);
    return true;
  }
  return false;
}

function DsIcon(props: { node: ENode }): JSX.Element {
  const loading = () => busy().has(props.node.id);
  return (
    <span class="dg-tree-icon dg-explorer-ds-icon">
      <Show when={!loading()} fallback={<span class="dg-spinner" />}>
        <Icon src={localIconUrl(providerIcon(props.node.data.driver).slice(LOCAL.length), theme())} />
        <Show when={connected().has(props.node.id)}>
          <i class="dg-explorer-dot" />
        </Show>
      </Show>
    </span>
  );
}

function renderLabel(item: ENode, query: string): JSX.Element {
  const d = item.data;
  if (d.kind === "loading") return <span class="dg-tree-label dg-explorer-loading">{item.label}</span>;
  if (d.kind === "error")
    return (
      <>
        <NodeIcon name="error" class="dg-tree-icon" />
        <span class="dg-tree-label dg-explorer-error" title={item.label}>
          {item.label}
        </span>
      </>
    );
  const badge = () => (d.kind === "dataSource" && busy().has(item.id) ? "…" : badges()[item.id]);
  return (
    <>
      <Show when={d.kind === "dataSource"} fallback={<NodeIcon name={d.icon} class="dg-tree-icon" />}>
        <DsIcon node={item} />
      </Show>
      <span class={"dg-tree-label" + (d.synthetic ? " dg-explorer-synth" : "")}>
        <Highlighted text={item.label} query={query} />
      </span>
      <Show when={badge()}>
        <span class="dg-tree-badge">{badge()}</span>
      </Show>
      <Show when={item.hint}>
        <span class={"dg-tree-hint" + (d.kind === "folder" ? " dg-explorer-count" : "")}>{item.hint}</span>
      </Show>
    </>
  );
}

const EMPTY_STATE_DBMS = ["postgres", "mysql", "sqlite"] as const;

/** Empty state (no data sources): one button per supported DBMS. */
function EmptyState(): JSX.Element {
  return (
    <div class="dg-explorer-empty">
      <div class="dg-explorer-empty-label">Create Data Source</div>
      <For each={EMPTY_STATE_DBMS.map((id) => DRIVERS.find((d) => d.driver === id)!)}>
        {(d) => (
          <button type="button" class="dg-explorer-empty-btn" onClick={() => newDataSource(d.driver)}>
            <Icon src={localIconUrl(providerIcon(d.driver).slice(LOCAL.length), theme())} />
            <span>{d.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}

export function ExplorerBody(): JSX.Element {
  return (
    <>
      <Show when={loaded()}>
        <Tree<ENode>
          class="dg-explorer-tree"
          roots={roots()}
          loadChildren={loadChildren}
          initialExpanded={saved.expanded}
          selectedId={saved.selected}
          onSelect={onSelect}
          onExpandedChange={onExpandedChange}
          onActivate={activate}
          onContextMenu={showContextMenu}
          onKey={onKey}
          onSpeedSearchChange={setSearchQuery}
          speedSearchField={false}
          renderLabel={renderLabel}
          emptyText={<EmptyState />}
          ref={setController}
        />
      </Show>
      <DialogHost />
    </>
  );
}
