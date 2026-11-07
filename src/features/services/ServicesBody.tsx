/** Services tool window body: toolbar column, connections tree, and the Information / Output pane. */
import { For, type JSX, Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import { connect } from "../../api/db";
import { ActionButton, Icon, Tabs, ToolbarSeparator, Tree, type MenuItem, type TreeController, openMenu } from "../../components/ui";
import { Splitter } from "../../components/ui/Splitter";
import { runAction } from "../../state/actions";
import { closeTab } from "../../state/tabs";
import type { ConsoleSession } from "../console";
import { allSessions, sessionOf } from "../console/registry";
import { connectedDataSourceIds, explorerDataSources, jumpToConsole, newConsole } from "../explorer";
import { dataSourceProperties, deactivate } from "../explorer/commands";
import { dsIconUrl } from "../output/dsicon";
import { LogView } from "../output/LogView";
import { outputOf } from "../output/model";
import {
  type SvcItem,
  type SvcSession,
  buildTree,
  dataSourceInfo,
  expandableIds,
} from "./model";

const sessionsOf = (): ConsoleSession[] => allSessions().filter((s) => !!s.sessionId);

function toSvc(s: ConsoleSession): SvcSession {
  return { tabId: s.tabId, dsId: s.ds.id, name: s.consoleName, ms: s.out.lastMs() };
}

/**
 * Close Session: a console and its session live and die together (an open console tab re-opens its session at
 * once), so this closes the console tab, which asks Commit / Roll Back about an open transaction and ends the session.
 */
async function closeConsoleSession(s: ConsoleSession | undefined): Promise<void> {
  if (s) await closeTab(s.tabId);
}

function TreeLabel(props: { item: SvcItem }): JSX.Element {
  const d = () => props.item.data;
  return (
    <>
      <Show when={d().kind === "root"}>
        <Icon name="folder" class="dg-tree-icon" />
      </Show>
      <Show when={d().kind === "ds"}>
        <span class="dg-tree-icon dg-svc-icon">
          <Icon src={dsIconUrl(d().driver!)} />
          <Show when={d().connected}>
            <i class="dg-svc-dot" />
          </Show>
        </span>
      </Show>
      <Show when={d().kind === "session"}>
        <span class="dg-tree-icon dg-svc-icon">
          <Icon name="dg/console-run" />
          <i class="dg-svc-dot" />
        </span>
      </Show>
      <Show when={d().kind === "console"}>
        <span class="dg-tree-icon dg-svc-icon">
          <Icon src={dsIconUrl(d().driver!)} />
          <i class="dg-svc-dot" />
        </span>
      </Show>
      <span class="dg-tree-label">{props.item.label}</span>
      <Show when={props.item.hint}>
        <span class="dg-tree-hint">{props.item.hint}</span>
      </Show>
    </>
  );
}

function Information(props: { dsId: string }): JSX.Element {
  const ds = () => explorerDataSources().find((d) => d.id === props.dsId);
  const connected = () => connectedDataSourceIds().has(props.dsId);
  // connect() of a connected data source only reads back its server version
  const [version] = createResource(
    () => (connected() ? props.dsId : null),
    async (id) => (await connect(id).catch(() => null))?.serverVersion ?? null,
  );
  return (
    <div class="dg-svc-pane">
      <div class="dg-svc-pane-tabs">
        <Tabs variant="result" items={[{ id: "info", title: "Information", closeable: false }]} active="info" />
      </div>
      <Show when={ds()}>
        {(d) => (
          <div class="dg-svc-info">
            <For each={dataSourceInfo(d(), connected() && version.loading ? "…" : version())}>
              {(group) => (
                <div class="dg-svc-info-group">
                  <For each={group}>
                    {(r) => (
                      <div>
                        <b>{r.label}:</b> {r.value}
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

export function ServicesBody(): JSX.Element {
  const [showInactive, setShowInactive] = createSignal(true);
  const [sel, setSel] = createSignal<SvcItem | undefined>();
  const [treeW, setTreeW] = createSignal(465);
  let ctrl: TreeController<SvcItem> | undefined;
  let eyeBtn!: HTMLButtonElement;
  let txBtn!: HTMLButtonElement;

  const roots = createMemo(() => buildTree(explorerDataSources(), connectedDataSourceIds(), sessionsOf().map(toSvc), showInactive()));

  // new data sources / sessions show expanded, like DataGrip (the tree only knows a node once its parent is expanded)
  const seen = new Set<string>();
  createEffect(() => {
    let fresh = false;
    for (const id of expandableIds(roots())) {
      if (!seen.has(id)) fresh = true;
      seen.add(id);
    }
    if (fresh) void ctrl?.expandAll();
  });
  // a selected node that went away (session closed, data source disconnected) falls back to its data source / nothing
  createEffect(() => {
    const s = sel();
    if (!s) return;
    const exists = (list: SvcItem[]): boolean => list.some((n) => n.id === s.id || (n.children ? exists(n.children) : false));
    if (!exists(roots())) setSel(undefined);
  });

  const sessionOfSel = (): ConsoleSession | undefined => {
    const t = sel()?.data.tabId;
    return t ? sessionOf(t) : undefined;
  };
  const dsIdOfSel = () => sel()?.data.dsId;
  const connectedSel = () => !!dsIdOfSel() && connectedDataSourceIds().has(dsIdOfSel()!);

  const jump = (s: ConsoleSession | undefined) => s?.focusEditor();

  const itemsFor = (it: SvcItem): MenuItem[] => {
    const d = it.data;
    const s = d.tabId ? sessionOf(d.tabId) : undefined;
    if (d.kind === "ds")
      return [
        { label: "New Query Console", icon: "dg/console", enabled: true, run: () => void newConsole(d.dsId) },
        { label: "Jump to Query Console…", run: () => void jumpToConsole(d.dsId) },
        { type: "separator" },
        { label: "Data Source Properties", icon: "dg/manage-data-sources", run: () => dataSourceProperties(d.dsId) },
        { label: "Disconnect", icon: "dg/kill-process", enabled: !!d.connected, run: () => void deactivate(d.dsId) },
      ];
    if (s)
      return [
        { label: "Close Session", icon: "close", run: () => void closeConsoleSession(s) },
        { label: "Disconnect", icon: "dg/kill-process", run: () => void deactivate(d.dsId) },
        { type: "separator" },
        { label: "Commit", icon: "dg/commit", enabled: () => s.inTx(), run: () => void s.endTx("commit") },
        { label: "Roll Back", icon: "dg/rollback", enabled: () => s.inTx(), run: () => void s.endTx("rollback") },
        { type: "separator" },
        { label: "Jump to Console", icon: "dg/console", run: () => jump(s) },
      ];
    return [];
  };

  const outOfSel = () => {
    const t = sel()?.data.tabId;
    return t ? outputOf(t) : undefined;
  };

  return (
    <div class="dg-svc">
      <div class="dg-svc-vtb">
        <ActionButton
          icon="dg/console"
          title={sessionOfSel() ? "Jump to Console" : "New Query Console"}
          disabled={!dsIdOfSel()}
          onClick={() => (sessionOfSel() ? jump(sessionOfSel()) : void newConsole(dsIdOfSel()))}
        />
        <ActionButton icon="dg/manage-data-sources" title="Data Source Properties" disabled={!dsIdOfSel()} onClick={() => dataSourceProperties(dsIdOfSel())} />
        <ActionButton
          icon={sessionOfSel() ? "close" : "dg/kill-process"}
          class={sessionOfSel() ? "" : "dg-svc-disconnect"}
          title={sessionOfSel() ? "Close Session" : "Disconnect"}
          disabled={!connectedSel()}
          onClick={() => (sessionOfSel() ? void closeConsoleSession(sessionOfSel()) : void deactivate(dsIdOfSel()))}
        />
      </div>
      <div class="dg-svc-left" style={{ width: treeW() + "px" }}>
        <div class="dg-toolbar dg-svc-toolbar">
          <Show when={sessionOfSel()}>
            {(s) => (
              <button type="button" class="dgc-text-btn" tabindex={-1} ref={txBtn} onMouseDown={(e) => e.preventDefault()} onClick={() => s().openTxMenu(txBtn)}>
                <span>Tx: {s().txMode() === "manual" ? "Manual" : "Auto"}</span>
                <Icon name="chevron-down" size={16} />
              </button>
            )}
          </Show>
          <ActionButton icon="add" title="Add Service" onClick={() => void runAction("db.dataSources")} />
          <ActionButton
            icon="show"
            title="Show Options"
            ref={(el) => (eyeBtn = el)}
            onClick={() =>
              openMenu([{ label: "Show Inactive Data Sources", checked: showInactive, run: () => setShowInactive(!showInactive()) }], { anchor: eyeBtn })
            }
          />
          <ToolbarSeparator />
          <ActionButton icon="expand-all" title="Expand All" onClick={() => void ctrl?.expandAll()} />
          <ActionButton icon="collapse-all" title="Collapse All" onClick={() => ctrl?.collapseAll()} />
        </div>
        <Tree<SvcItem>
          class="dg-svc-tree"
          roots={roots()}
          selectedId={sel()?.id ?? null}
          onSelect={setSel}
          renderLabel={(it) => <TreeLabel item={it} />}
          onContextMenu={(it, e) => {
            if (!it) return;
            setSel(it);
            const items = itemsFor(it);
            if (items.length) openMenu(items, { x: e.clientX, y: e.clientY });
          }}
          onActivate={(it) => {
            if (it.data.kind === "session" || it.data.kind === "console") {
              jump(it.data.tabId ? sessionOf(it.data.tabId) : undefined);
              return true;
            }
            if (it.data.kind === "ds") {
              dataSourceProperties(it.data.dsId);
              return true;
            }
            return false;
          }}
          ref={(c) => {
            ctrl = c;
            if (seen.size) void c.expandAll();
          }}
        />
      </div>
      <Splitter orientation="vertical" size={treeW()} min={200} max={() => 900} onResize={setTreeW} class="dg-svc-split" />
      <div class="dg-svc-right">
        <Show when={sel()?.data.kind === "ds"}>
          <Information dsId={sel()!.data.dsId!} />
        </Show>
        <Show when={outOfSel()}>{(o) => <LogView out={o()} />}</Show>
      </div>
    </div>
  );
}
