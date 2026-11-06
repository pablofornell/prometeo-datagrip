/** Database Output header: `Output` + result tabs, console / duration on the right, "Open Client in Editor". */
import { Show, type JSX } from "solid-js";
import { ActionButton, Icon, Tabs, type MenuItem, openMenu } from "../../components/ui";
import { activateTab, tabs } from "../../state/tabs";
import { dsIconUrl } from "./dsicon";
import { formatDuration } from "./format";
import { type ConsoleOutput, allOutputs, currentOutput } from "./model";

const tabTitle = (o: ConsoleOutput): string => tabs().find((t) => t.id === o.tabId)?.title ?? "console";

export function OutputHeader(): JSX.Element {
  const out = currentOutput;
  const items = () => {
    const o = out();
    return [
      { id: "output", title: "Output", icon: "dg/console", closeable: false },
      ...(o?.results() ?? []).map((r) => ({ id: r.id, title: r.title(), icon: "dg/table", closeable: true, pinned: r.pinned() })),
    ];
  };

  const tabMenu = (id: string): MenuItem[] => {
    const o = out();
    const r = o?.results().find((x) => x.id === id);
    if (!o || !r) return [];
    return [
      { label: r.pinned() ? "Unpin Tab" : "Pin Tab", icon: "pin", run: () => r.setPinned(!r.pinned()) },
      { type: "separator" },
      { label: "Close Tab", run: () => o.closeResult(id) },
      { label: "Close Other Tabs", run: () => o.closeOthers(id) },
    ];
  };

  const switchMenu = (anchor: HTMLElement) => {
    const list = allOutputs();
    openMenu(
      list.map<MenuItem>((o) => ({ label: tabTitle(o), icon: "dg/console", checked: o === out(), run: () => activateTab(o.tabId) })),
      { anchor, minWidth: 220 },
    );
  };
  let srcBtn!: HTMLButtonElement;

  return (
    <div class="dgo-header">
      <Tabs
        variant="result"
        items={items()}
        active={out()?.selected() ?? "output"}
        onSelect={(id) => out()?.select(id)}
        onClose={(id) => out()?.closeResult(id)}
        onUnpin={(id) => out()?.results().find((r) => r.id === id)?.setPinned(false)}
        onContextMenu={(id, e) => openMenu(tabMenu(id), { x: e.clientX, y: e.clientY })}
      />
      <button ref={srcBtn} type="button" class="dgo-source" tabindex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => switchMenu(srcBtn)}>
        <Show
          when={out()}
          fallback={<span class="dgo-source-title">No Output</span>}
        >
          {(o) => (
            <>
              <Show when={o().running()} fallback={<img class="dg-icon" width="16" height="16" src={dsIconUrl(o().dialect)} alt="" />}>
                <span class="dgo-spinner" />
              </Show>
              <span class="dgo-source-title">{tabTitle(o())}</span>
              <Show when={o().lastMs() !== null}>
                <span class="dgo-source-ms">{formatDuration(o().lastMs()!)}</span>
              </Show>
            </>
          )}
        </Show>
        <Icon name="chevron-down" size={16} />
      </button>
    </div>
  );
}

/** Right side of the header (visible on hover / focus): open the console editor. */
export function OutputHeaderActions(): JSX.Element {
  return (
    <ActionButton
      icon="locate"
      title="Open Client in Editor"
      disabled={!currentOutput()}
      onClick={() => currentOutput()?.host?.focusEditor()}
    />
  );
}
