/**
 * Notifications: the history behind the balloons (`components/ui/Notification`), the Notifications tool window
 * (declared in `TOOL_WINDOWS`, src/state/layout.ts; this module plugs its body in) and its actions
 * `notifications.menu` (Window > Notifications), `notifications.expireAll`, `notifications.clearAll`.
 * The status bar bell lives in components/shell/StatusBar.tsx.
 */
import { clearNotifications, expireNotifications, notificationHistory } from "../../components/ui";
import { registerActions } from "../../state/actions";
import { showToolWindow } from "../../state/layout";
import { registerSlot } from "../../state/slots";
import { NotificationsBody, NotificationsHeaderActions } from "./NotificationsBody";
import "./notifications.css";

const disposers = [
  registerSlot("notifications.body", NotificationsBody),
  registerSlot("notifications.header", NotificationsHeaderActions),
  registerActions([
    { id: "notifications.menu", title: "Notifications", icon: "notifications", run: () => showToolWindow("notifications") },
    { id: "notifications.expireAll", title: "Expire All Notifications", run: () => expireNotifications() },
    { id: "notifications.clearAll", title: "Clear All Notifications", enabled: () => notificationHistory().length > 0, run: () => clearNotifications() },
  ]),
];

if (import.meta.hot) import.meta.hot.dispose(() => disposers.forEach((d) => d()));
