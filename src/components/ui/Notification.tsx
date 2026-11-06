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

interface Item extends NotificationOptions {
  id: number;
}

const [items, setItems] = createSignal<Item[]>([]);
let seq = 0;

export function notify(o: NotificationOptions): number {
  const id = ++seq;
  setItems((l) => [...l, { ...o, id }].slice(-4));
  const t = o.timeout ?? (o.kind === "error" ? 0 : 10000);
  if (t > 0) window.setTimeout(() => dismissNotification(id), t);
  return id;
}

export function dismissNotification(id: number): void {
  setItems((l) => l.filter((x) => x.id !== id));
}

const KIND_ICON = { info: "info", warning: "warning", error: "error", success: "success" } as const;

export function NotificationHost(): JSX.Element {
  return (
    <div class="dg-notifications">
      <For each={items()}>
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
            <span class="dg-notification-close" onClick={() => dismissNotification(n.id)}>
              <Icon name="chevron-down" />
            </span>
          </div>
        )}
      </For>
    </div>
  );
}
