import { For, Show, type JSX } from "solid-js";
import { Slot } from "../../state/slots";
import {
  activateTab,
  activeTabId,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  moveTab,
  setPinned,
  tabs,
} from "../../state/tabs";
import { ActionButton } from "../ui/ActionButton";
import { type MenuItem, openMenu } from "../ui/Menu";
import { Tabs } from "../ui/Tabs";
import { EditorEmptyPlaceholder, EditorViewPlaceholder } from "./Placeholders";

/** The editor island: pill tab strip + one mounted view per open tab (inactive ones hidden, state kept). */
export function EditorArea(): JSX.Element {
  let moreBtn!: HTMLButtonElement;

  const tabMenu = (id: string): MenuItem[] => {
    const t = tabs().find((x) => x.id === id);
    return [
      { label: "Close", shortcut: "Ctrl+F4", enabled: !!t?.closeable, run: () => closeTab(id) },
      { label: "Close Other Tabs", run: () => closeOtherTabs(id) },
      { label: "Close All Tabs", run: () => closeAllTabs() },
      { type: "separator" },
      { label: t?.pinned ? "Unpin Tab" : "Pin Tab", run: () => setPinned(id, !t?.pinned) },
    ];
  };

  return (
    <section class="dg-island dg-editor-area" data-editor-area tabindex={-1}>
      <Tabs
        variant="editor"
        items={tabs()}
        active={activeTabId()}
        onSelect={activateTab}
        onClose={closeTab}
        onUnpin={(id) => setPinned(id, false)}
        onReorder={moveTab}
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
                  ...(tabs().length ? ([{ type: "separator" }] as MenuItem[]) : []),
                  ...tabs().map<MenuItem>((t) => ({
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
      <div class="dg-editor-body">
        <For each={tabs()}>
          {(t) => (
            <div class="dg-editor-view" classList={{ "dg-hidden": t.id !== activeTabId() }}>
              <Slot id={"editor.view." + t.kind} tab={t} active={t.id === activeTabId()} fallback={EditorViewPlaceholder} />
            </div>
          )}
        </For>
        <Show when={tabs().length === 0}>
          <Slot id="editor.empty" fallback={EditorEmptyPlaceholder} />
        </Show>
      </div>
    </section>
  );
}
