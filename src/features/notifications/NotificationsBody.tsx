/** Notifications tool window: every notification raised in this session, newest first. */
import { For, Show, createEffect, createMemo, on, type JSX } from "solid-js";
import { Icon, clearNotifications, markAllNotificationsRead, notificationHistory } from "../../components/ui";
import { isToolWindowVisible } from "../../state/layout";
import { timeText } from "./model";

const KIND_ICON = { info: "info", warning: "warning", error: "error", success: "success" } as const;

const newestFirst = createMemo(() => [...notificationHistory()].reverse());

/** Header buttons: Mark all as read, Clear all. */
export function NotificationsHeaderActions(): JSX.Element {
  return (
    <div class="dg-ntf-head">
      <button type="button" class="dg-ntf-btn" tabindex={-1} disabled={!notificationHistory().some((n) => !n.read)} onMouseDown={(e) => e.preventDefault()} onClick={markAllNotificationsRead}>
        Mark all as read
      </button>
      <button type="button" class="dg-ntf-btn" tabindex={-1} disabled={notificationHistory().length === 0} onMouseDown={(e) => e.preventDefault()} onClick={clearNotifications}>
        Clear all
      </button>
    </div>
  );
}

export function NotificationsBody(): JSX.Element {
  // Entries that arrive while the window is open count as seen; the ones that were unread when it opened keep
  // their bold title until it is hidden again.
  createEffect(
    on(
      () => isToolWindowVisible("notifications"),
      (visible, was) => {
        if (was && !visible) markAllNotificationsRead();
      },
    ),
  );
  return (
    <div class="dg-ntf" data-focus-target tabindex={-1}>
      <Show when={newestFirst().length > 0} fallback={<div class="dg-placeholder-center">No notifications</div>}>
        <For each={newestFirst()}>
          {(n) => (
            <div class="dg-ntf-row" classList={{ "dg-ntf-unread": !n.read, ["dg-ntf-" + (n.kind ?? "info")]: true }}>
              <Icon name={KIND_ICON[n.kind ?? "info"]} class="dg-ntf-icon" />
              <div class="dg-ntf-main">
                <Show when={n.title}>
                  <div class="dg-ntf-title">{n.title}</div>
                </Show>
                <div class="dg-ntf-text">{n.body}</div>
                <Show when={n.actions?.length}>
                  <div class="dg-ntf-links">
                    <For each={n.actions}>
                      {(a) => (
                        <a
                          class="dg-link"
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            a.run();
                          }}
                        >
                          {a.label}
                        </a>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <span class="dg-ntf-time">{timeText(n.time)}</span>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
