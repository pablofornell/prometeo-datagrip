import { For, Show, createEffect, createSignal, on, type JSX } from "solid-js";
import { isTauri } from "../../api/tauri";
import { minimizeWindow, toggleMaximizeWindow, closeWindow } from "../../api/window";
import { ACTION_IDS } from "../../state/core-actions";
import { TOOL_WINDOWS, isToolWindowVisible, toggleToolWindow } from "../../state/layout";
import { menuBarOpen, setMenuBarOpen } from "../../state/ui";
import { ActionButton } from "../ui/ActionButton";
import { Icon } from "../ui/Icon";
import { closeMenu, openMenu } from "../ui/Menu";
import { tip } from "../ui/Tooltip";
import { GEAR_MENU, MAIN_MENU } from "./menus";

/** 43px Islands main toolbar: hamburger / inline menu bar, tool-window buttons (centered), search, gear, window controls. */
export function MainToolbar(): JSX.Element {
  const [maximized, setMaximized] = createSignal(false);
  const [openIdx, setOpenIdx] = createSignal(-1);
  const barItems: HTMLElement[] = [];
  let gearBtn!: HTMLButtonElement;

  const showMenu = (i: number) => {
    const n = MAIN_MENU.length;
    const idx = (i + n) % n;
    const el = barItems[idx];
    if (!el) return;
    setOpenIdx(idx);
    openMenu(MAIN_MENU[idx].items, {
      anchor: el,
      variant: "bar",
      gap: 4,
      onClose: () => {
        // Closed for real (not replaced by a neighbour menu): the bar collapses back to the hamburger.
        if (openIdx() === idx) {
          setOpenIdx(-1);
          setMenuBarOpen(false);
        }
      },
      onHorizontal: (d) => showMenu(idx + d),
    });
  };

  // `menuBarOpen` is toggled by the hamburger and by the Alt+\ action; opening drops down File.
  createEffect(
    on(
      menuBarOpen,
      (open) => {
        if (open) {
          if (openIdx() < 0) queueMicrotask(() => showMenu(0));
        } else if (openIdx() >= 0) {
          setOpenIdx(-1);
          closeMenu();
        }
      },
      { defer: true },
    ),
  );

  const dragProps = { "data-tauri-drag-region": "" } as Record<string, string>;

  return (
    <header class="dg-main-toolbar" {...dragProps}>
      <div class="dg-toolbar-left" {...dragProps}>
        <Show
          when={menuBarOpen()}
          fallback={
            <ActionButton
              icon="menu@20x20"
              iconSize={20}
              size={30}
              title="Main Menu"
              shortcut="Alt+\\"
              class="dg-toolbar-btn"
              onClick={() => setMenuBarOpen(true)}
            />
          }
        >
          <nav class="dg-menubar">
            <For each={MAIN_MENU}>
              {(m, i) => (
                <span
                  class="dg-menubar-item"
                  classList={{ "dg-active": openIdx() === i() }}
                  ref={(el) => (barItems[i()] = el)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (openIdx() === i()) setMenuBarOpen(false);
                    else showMenu(i());
                  }}
                  onMouseEnter={() => {
                    if (openIdx() >= 0 && openIdx() !== i()) showMenu(i());
                  }}
                >
                  {m.label}
                </span>
              )}
            </For>
          </nav>
        </Show>
      </div>

      <div class="dg-toolbar-center" {...dragProps}>
        <For each={TOOL_WINDOWS}>
          {(t) => (
            <button
              type="button"
              class="dg-toolwindow-button"
              classList={{ "dg-selected": isToolWindowVisible(t.id) }}
              tabindex={-1}
              {...tip(t.title, t.shortcut)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleToolWindow(t.id)}
            >
              <Icon name={t.icon} size={20} />
            </button>
          )}
        </For>
      </div>

      <div class="dg-toolbar-right" {...dragProps}>
        <ActionButton
          icon="search@20x20"
          iconSize={20}
          size={30}
          action={ACTION_IDS.searchEverywhere}
          title="Search Everywhere"
          class="dg-toolbar-btn"
          onClick={() => {}}
        />
        <ActionButton
          icon="settings@20x20"
          iconSize={20}
          size={30}
          title="IDE and Project Settings"
          class="dg-toolbar-btn"
          ref={(el) => (gearBtn = el)}
          onClick={() => openMenu(GEAR_MENU, { anchor: gearBtn })}
        />
        <Show when={isTauri()}>
          <div class="dg-window-controls">
            <button type="button" class="dg-window-btn" aria-label="Minimize" onClick={() => void minimizeWindow()}>
              <Icon name="window-minimize" />
            </button>
            <button
              type="button"
              class="dg-window-btn"
              aria-label="Maximize"
              onClick={() => {
                setMaximized(!maximized());
                void toggleMaximizeWindow();
              }}
            >
              <Icon name={maximized() ? "window-restore" : "window-maximize"} />
            </button>
            <button type="button" class="dg-window-btn dg-window-close" aria-label="Close" onClick={() => void closeWindow()}>
              <Icon name="window-close" />
            </button>
          </div>
        </Show>
      </div>
    </header>
  );
}
