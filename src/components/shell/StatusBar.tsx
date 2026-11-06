import { For, Show, type JSX } from "solid-js";
import { status } from "../../state/status";
import { activeTabId } from "../../state/tabs";
import { Icon } from "../ui/Icon";

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
        <Show when={status.task}>
          {(t) => (
            <span class="dg-status-widget dg-status-task">
              <span>{t().title}</span>
              <span class="dg-progress">
                <span class="dg-progress-bar" classList={{ "dg-indeterminate": t().progress === undefined }} style={{ width: (t().progress ?? 0.3) * 100 + "%" }} />
              </span>
              <Show when={t().onCancel}>
                <span class="dg-status-cancel" onClick={() => t().onCancel!()}>
                  <Icon name="close-small" />
                </span>
              </Show>
            </span>
          )}
        </Show>
        <Show when={status.aggregator}>
          <span class="dg-status-widget">{status.aggregator}</span>
        </Show>
        {/* DataGrip's status bar has no transaction widget in Auto mode; Manual is worth a reminder. */}
        <Show when={status.txMode?.includes("Manual")}>
          <span class="dg-status-widget">{status.txMode}</span>
        </Show>
        <Show when={status.caret}>
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
