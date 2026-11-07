/**
 * Notification balloons (bottom-right, over the editor island). Mount <NotificationHost/> once.
 *
 *   notify({ title: "Default SQL dialect", body: "You can set ... ", kind: "info",
 *            actions: [{ label: "configure", run: () => ... }] })
 */
import { For, Show, createSignal, type JSX } from "solid-js";
import { Icon } from "./Icon";

export interface NotificationAction {
  label: string;
  run: () => void;
}

export interface NotificationOptions {
  title?: string;
  body: JSX.Element | string;
  kind?: "info" | "warning" | "error" | "success";
  /** Links rendered under the body. */
  actions?: NotificationAction[];
  /** Auto-hide delay in ms (default 10000; 0 = sticky). Errors are sticky by default. */
  timeout?: number;
}

/** A notification kept in the history (the Notifications tool window and the status bar bell read it). */
export interface NotificationRecord extends NotificationOptions {
  id: number;
  /** `Date.now()` when it was raised. */
  time: number;
  /** Seen by the user (balloon dismissed with x, tool window shown, "Mark all as read"). */
  read: boolean;
}

const HISTORY_LIMIT = 200;
const [history, setHistory] = createSignal<NotificationRecord[]>([]);
/** Ids of the balloons currently on screen (oldest first); every notification stays in the history. */
const [live, setLive] = createSignal<number[]>([]);
let seq = 0;

/** All notifications, oldest first. */
export const notificationHistory = history;
export const unreadNotificationCount = (): number => history().reduce((n, x) => n + (x.read ? 0 : 1), 0);

export function notify(o: NotificationOptions): number {
  const id = ++seq;
  setHistory((l) => [...l, { ...o, id, time: Date.now(), read: false }].slice(-HISTORY_LIMIT));
  setLive((l) => [...l, id].slice(-4));
  const t = o.timeout ?? (o.kind === "error" ? 0 : 10000);
  if (t > 0) window.setTimeout(() => hideNotification(id), t);
  return id;
}

/** Collapses a balloon into the bell: it stays in the history, unread. */
export function hideNotification(id: number): void {
  setLive((l) => l.filter((x) => x !== id));
}

/** Closes a balloon (x): hidden and counted as read; it stays in the history. */
export function dismissNotification(id: number): void {
  hideNotification(id);
  setHistory((l) => l.map((x) => (x.id === id && !x.read ? { ...x, read: true } : x)));
}

export function markAllNotificationsRead(): void {
  if (history().some((x) => !x.read)) setHistory((l) => l.map((x) => (x.read ? x : { ...x, read: true })));
}

/** Window > Notifications > Expire All: hides every balloon. */
export function expireNotifications(): void {
  setLive([]);
}

/** Forgets the whole history (and its balloons). */
export function clearNotifications(): void {
  setLive([]);
  setHistory([]);
}

const liveItems = () => {
  const ids = new Set(live());
  return history().filter((x) => ids.has(x.id));
};

const KIND_ICON = { info: "info", warning: "warning", error: "error", success: "success" } as const;

export function NotificationHost(): JSX.Element {
  return (
    <div class="dg-notifications">
      <For each={liveItems()}>
        {(n) => (
          <div class={"dg-notification dg-notification-" + (n.kind ?? "info")} role="alert">
            <Icon name={KIND_ICON[n.kind ?? "info"]} class="dg-notification-icon" />
            <div class="dg-notification-content">
              <Show when={n.title}>
                <div class="dg-notification-title">{n.title}</div>
              </Show>
              <div class="dg-notification-body">{n.body}</div>
              <Show when={n.actions?.length}>
                <div class="dg-notification-actions">
                  <For each={n.actions}>
                    {(a) => (
                      <a
                        class="dg-link"
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          dismissNotification(n.id);
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
            <span class="dg-notification-close">
              <span class="dg-notification-hide" title="Hide (keep in the Notifications tool window)" onClick={() => hideNotification(n.id)}>
                <Icon name="chevron-down" />
              </span>
              <span class="dg-notification-dismiss" title="Close" onClick={() => dismissNotification(n.id)}>
                <Icon name="close-small" />
              </span>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}
