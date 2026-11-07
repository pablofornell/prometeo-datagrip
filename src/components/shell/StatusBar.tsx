import { For, Show, type JSX } from "solid-js";
import { AGGREGATORS, aggregatorChoice, aggregatorText, focusArea, setAggregator, status, tasks } from "../../state/status";
import { activeTabId } from "../../state/tabs";
import { Icon } from "../ui/Icon";
import { openMenu } from "../ui";

/** The result grid of the active console tab, while it has the focus: its cell position / aggregate replace the caret. */
const gridStatus = () => (focusArea() === "grid" && status.grid?.tabId === activeTabId() ? status.grid : null);
const position = () => (gridStatus() ? gridStatus()!.pos : status.caret);
/** Aggregator widget: only while a grid has the focus (it is a grid selection aggregate). */
const aggregator = () => {
  if (focusArea() !== "grid") return null;
  const g = gridStatus();
  return g ? aggregatorText(g) : status.aggregator;
};

/** 34px status bar on the window background: breadcrumbs left, operative widgets right. */
export function StatusBar(): JSX.Element {
  return (
    <footer class="dg-statusbar">
      <nav class="dg-status-path">
        <For each={status.path}>
          {(c, i) => (
            <>
              <Show when={i() > 0}>
                <Icon name="chevron-right" class="dg-status-sep" />
              </Show>
              <span class="dg-status-crumb" classList={{ "dg-clickable": !!c.onClick }} onClick={() => c.onClick?.()}>
                <Show when={c.icon}>
                  <Icon name={c.icon} />
                </Show>
                {c.label}
              </span>
            </>
          )}
        </For>
      </nav>
      <div class="dg-status-right">
        <Show when={tasks()[0]}>
          {(t) => (
            <span class="dg-status-widget dg-status-task">
              <span>{t().title}</span>
              <span class="dg-progress">
                <span class="dg-progress-bar" classList={{ "dg-indeterminate": t().progress === undefined }} style={{ width: (t().progress ?? 0.3) * 100 + "%" }} />
              </span>
              <Show when={t().onCancel}>
                <span class="dg-status-cancel" title="Cancel" onClick={() => t().onCancel!()}>
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.5" fill="currentColor" opacity="0.55" />
                    <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="var(--dg-statusbar-bg)" stroke-width="1.4" stroke-linecap="round" />
                  </svg>
                </span>
              </Show>
              <Show when={tasks().length > 1}>
                <span
                  class="dg-status-more"
                  title="Show all background tasks"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openMenu(
                      tasks().map((x) => ({ label: x.title, enabled: false })),
                      { x: r.left, y: r.top - 4, compact: true, title: "Background Tasks" },
                    );
                  }}
                >
                  +{tasks().length - 1}
                </span>
              </Show>
            </span>
          )}
        </Show>
        <Show when={aggregator()}>
          {(a) => (
            <span
              class="dg-status-widget dg-clickable"
              title="Aggregator"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openMenu(
                  AGGREGATORS.map((x) => ({ label: x, checked: aggregatorChoice() === x, run: () => setAggregator(x) })),
                  { x: r.left, y: r.top - 4, compact: true },
                );
              }}
            >
              {a()}
            </span>
          )}
        </Show>
        {/* DataGrip's status bar has no transaction widget in Auto mode; Manual is worth a reminder. */}
        <Show when={!!status.txMode && status.txMode !== "Tx: Auto"}>
          <span class="dg-status-widget">{status.txMode}</span>
        </Show>
        <Show when={position()}>
          {(c) => (
            <span class="dg-status-widget">
              {c().line}:{c().col}
            </span>
          )}
        </Show>
        {/* the editor widgets belong to an open editor tab */}
        <Show when={activeTabId() && status.lineSeparator}>
          <span class="dg-status-widget">{status.lineSeparator}</span>
        </Show>
        <Show when={activeTabId() && status.encoding}>
          <span class="dg-status-widget">{status.encoding}</span>
        </Show>
        <Show when={activeTabId() && (status.indent ?? (status.caret ? "4 spaces" : null))}>
          {(t) => <span class="dg-status-widget">{t()}</span>}
        </Show>
        <Show when={status.readOnly !== null}>
          <span class="dg-status-widget dg-status-icon" title={status.readOnly ? "Read-only" : "Writable"}>
            <Icon name="dg/locked" class={status.readOnly ? "" : "dg-dim"} />
          </span>
        </Show>
      </div>
    </footer>
  );
}
