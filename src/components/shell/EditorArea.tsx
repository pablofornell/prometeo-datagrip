import { type JSX, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { runAction } from "../../state/actions";
import { Slot } from "../../state/slots";
import { type PaneTree } from "../../state/panes";
import {
  activateTab,
  activeTabId,
  closeTab,
  commitSplitRatio,
  focusPane,
  focusedPane,
  isSplit,
  moveTab,
  moveTabToPane,
  paneActiveId,
  paneTabs,
  paneTreeValue,
  setPinned,
  setSplitRatio,
  splitRatio,
  tabs,
} from "../../state/tabs";
import { ActionButton } from "../ui/ActionButton";
import { type MenuItem, openMenu } from "../ui/Menu";
import { Splitter } from "../ui/Splitter";
import { Tabs } from "../ui/Tabs";
import { EditorEmptyPlaceholder, EditorViewPlaceholder } from "./Placeholders";
import { tabMenu } from "./tabMenu";

/**
 * The editor island: a tree of panes (Split Right / Split Down), each with its pill tab strip and its active view.
 *
 * Every tab's view is mounted exactly once, in a pool outside the pane tree, and its DOM node is moved into the body of
 * the pane the tab lives in. Splitting, unsplitting or moving a tab therefore never remounts a console (which would
 * restart its DB session) and keeps the editor state.
 */
export function EditorArea(): JSX.Element {
  const pool = new Map<string, { el: HTMLDivElement; dispose: () => void }>();
  const [bodies, setBodies] = createSignal<ReadonlyMap<string, HTMLElement>>(new Map());

  // create / dispose the views as tabs come and go
  createEffect(() => {
    const list = tabs();
    const present = new Set(list.map((t) => t.id));
    for (const [id, v] of [...pool]) {
      if (present.has(id)) continue;
      v.dispose();
      v.el.remove();
      pool.delete(id);
    }
    for (const t of list) {
      if (pool.has(t.id)) continue;
      const el = document.createElement("div");
      el.className = "dg-editor-view dg-hidden";
      // attach before mounting: editors measure themselves while they are created
      if (t.pane) bodies().get(t.pane)?.appendChild(el);
      const dispose = render(
        () => <Slot id={"editor.view." + t.kind} tab={t} active={t.id === activeTabId()} fallback={EditorViewPlaceholder} />,
        el,
      );
      pool.set(t.id, { el, dispose });
    }
  });

  // put every view into its pane's body; only the pane's active tab is shown
  createEffect(() => {
    const b = bodies();
    for (const t of tabs()) {
      const v = pool.get(t.id);
      const body = t.pane ? b.get(t.pane) : undefined;
      if (!v || !body) continue;
      if (v.el.parentElement !== body) body.appendChild(v.el);
      v.el.classList.toggle("dg-hidden", paneActiveId(t.pane!) !== t.id);
    }
  });

  onCleanup(() => {
    for (const v of pool.values()) v.dispose();
    pool.clear();
  });

  const registerBody = (pane: string, el: HTMLElement) => {
    setBodies((m) => new Map(m).set(pane, el));
    onCleanup(() =>
      setBodies((m) => {
        if (m.get(pane) !== el) return m;
        const n = new Map(m);
        n.delete(pane);
        return n;
      }),
    );
  };

  const renderNode = (node: PaneTree): JSX.Element => {
    if (node.kind === "leaf") return <Pane pane={node.pane} registerBody={registerBody} />;
    let first!: HTMLDivElement;
    let box!: HTMLDivElement;
    const vertical = node.dir === "right"; // "right": side by side, a vertical divider
    const total = () => (vertical ? box.clientWidth : box.clientHeight) - 1;
    return (
      <div class={"dg-split dg-split-" + node.dir} ref={box}>
        <div class="dg-split-child" ref={first} style={{ flex: `${splitRatio(node.id)} 1 0` }}>
          {renderNode(node.a)}
        </div>
        <Splitter
          class="dg-pane-splitter"
          orientation={vertical ? "vertical" : "horizontal"}
          size={vertical ? first.offsetWidth : first.offsetHeight}
          min={120}
          onResize={(px) => setSplitRatio(node.id, px / total())}
          onResizeEnd={commitSplitRatio}
        />
        <div class="dg-split-child" style={{ flex: `${1 - splitRatio(node.id)} 1 0` }}>
          {renderNode(node.b)}
        </div>
      </div>
    );
  };

  return (
    <section class="dg-island dg-editor-area" classList={{ "dg-editor-split": isSplit() }} data-editor-area tabindex={-1}>
      {renderNode(paneTreeValue())}
    </section>
  );
}

function Pane(props: { pane: string; registerBody: (pane: string, el: HTMLElement) => void }): JSX.Element {
  let moreBtn!: HTMLButtonElement;
  const items = () => paneTabs(props.pane);
  const shown = () => paneActiveId(props.pane);

  const showHidden = (ids: string[], anchor: HTMLElement) =>
    openMenu(
      items()
        .filter((t) => ids.includes(t.id))
        .map<MenuItem>((t) => ({ label: t.title, icon: t.icon, run: () => activateTab(t.id) })),
      { anchor, compact: true },
    );

  return (
    <div
      class="dg-pane"
      classList={{ "dg-pane-focused": focusedPane() === props.pane }}
      data-pane={props.pane}
      ref={(el) => el.addEventListener("mousedown", () => focusPane(props.pane), true)}
      onFocusIn={() => focusPane(props.pane)}
    >
      <Show when={items().length > 0}>
        <Tabs
          variant="editor"
          items={items()}
          active={shown()}
          onSelect={activateTab}
          onClose={closeTab}
          onUnpin={(id) => setPinned(id, false)}
          onReorder={(from, to) => {
            const l = items();
            if (l[from] && l[to]) moveTab(tabs().findIndex((t) => t.id === l[from].id), tabs().findIndex((t) => t.id === l[to].id));
          }}
          onDropTab={(id, before) => moveTabToPane(id, props.pane, before)}
          onDoubleClick={() => void runAction("toolwindow.hideAll")}
          onShowHidden={showHidden}
          onContextMenu={(id, e) => openMenu(tabMenu(id), { x: e.clientX, y: e.clientY })}
          trailing={
            <ActionButton
              icon="more-vertical"
              title="Tabs Actions"
              ref={(el) => (moreBtn = el)}
              onClick={() =>
                openMenu(
                  [
                    { action: "tab.closeOthers" },
                    { action: "tab.closeAll" },
                    ...(items().length ? ([{ type: "separator" }] as MenuItem[]) : []),
                    ...items().map<MenuItem>((t) => ({
                      label: t.title,
                      icon: t.icon,
                      checked: t.id === activeTabId(),
                      run: () => activateTab(t.id),
                    })),
                  ],
                  { anchor: moreBtn },
                )
              }
            />
          }
        />
      </Show>
      <div class="dg-editor-body" ref={(el) => props.registerBody(props.pane, el)}>
        <Show when={items().length === 0}>
          <Slot id="editor.empty" fallback={EditorEmptyPlaceholder} />
        </Show>
      </div>
    </div>
  );
}
