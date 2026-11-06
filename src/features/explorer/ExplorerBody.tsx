import { For, type JSX, Show } from "solid-js";
import { Highlighted, Icon, Tree } from "../../components/ui";
import { theme } from "../../state/theme";
import { DRIVERS, showContextMenu } from "./actions";
import {
  cancelRename,
  commitRename,
  dataSourceProperties,
  newDataSource,
  openDdl,
  openTable,
  renaming,
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
import { openSchemaSelector } from "./SchemaSelector";

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

/** In-place name editor (Shift+F6). Enter asks for confirmation, Escape or leaving the field cancels. */
function RenameInput(props: { node: ENode }): JSX.Element {
  let done = false;
  const finish = (commit: boolean, text: string) => {
    if (done) return;
    done = true;
    if (commit) void commitRename(props.node, text);
    else cancelRename();
  };
  return (
    <input
      class="dg-explorer-rename"
      value={props.node.data.name}
      spellcheck={false}
      ref={(el) =>
        queueMicrotask(() => {
          el.focus();
          el.select();
        })
      }
      onMouseDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation(); // not the tree's speed search nor the global keymap
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true, e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false, "");
        }
      }}
      onBlur={() => finish(false, "")}
    />
  );
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
      <Show
        when={renaming() === item.id}
        fallback={
          <span class={"dg-tree-label" + (d.synthetic ? " dg-explorer-synth" : "")}>
            <Highlighted text={item.label} query={query} />
          </span>
        }
      >
        <RenameInput node={item} />
      </Show>
      <Show when={badge()}>
        {/* the schema badge (`1`, `2 of 4`) opens the schema selector popup */}
        <span
          class="dg-tree-badge"
          classList={{ "dg-schema-badge": d.kind === "dataSource" || d.kind === "database" }}
          onMouseDown={(e) => (d.kind === "dataSource" || d.kind === "database") && e.stopPropagation()}
          onDblClick={(e) => (d.kind === "dataSource" || d.kind === "database") && e.stopPropagation()}
          onClick={(e) => {
            if (d.kind !== "dataSource" && d.kind !== "database") return;
            e.stopPropagation();
            void openSchemaSelector(d.dsId, e.currentTarget);
          }}
        >
          {badge()}
        </span>
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
