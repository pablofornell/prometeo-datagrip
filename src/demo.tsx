/**
 * Dev-only demo content for visual checks (`?demo=1`): opens a few tabs and fills the status bar so
 * the shell can be compared with the DataGrip screenshots. Never active in production builds.
 */
import { setStatus } from "./state/status";
import { openTab } from "./state/tabs";
import { showToolWindow } from "./state/layout";
import { notify } from "./components/ui/Notification";
import { openMenu } from "./components/ui/Menu";
import { Tabs } from "./components/ui/Tabs";
import { registerSlot } from "./state/slots";

export function loadDemo(): void {
  const q = new URLSearchParams(location.search);
  if (!q.has("demo")) return;
  (window as unknown as Record<string, unknown>).__dg = { openMenu, notify };
  openTab({ id: "c1", title: "console [postgres@localhost]", kind: "console", icon: "dg/console" });
  openTab({ id: "t1", title: "clients [postgres@localhost]", kind: "table", icon: "dg/table" });
  openTab({ id: "d1", title: "invoices (DDL) [postgres@localhost]", kind: "ddl", icon: "dg/table" });
  openTab({ id: "c2", title: "console [ux-sample.db]", kind: "console", icon: "dg/console" });
  if (q.get("demo") !== "tab4") openTab({ id: "c1", title: "console [postgres@localhost]", kind: "console", icon: "dg/console" });
  setStatus({
    path: [
      { label: "Database Consoles" },
      { label: "postgres@localhost" },
      { label: "console [postgres@localhost]", icon: "dg/console" },
    ],
    caret: { line: 1, col: 53 },
    lineSeparator: "LF",
    encoding: "UTF-8",
    readOnly: false,
  });
  if (q.has("output")) showToolWindow("output", false);
  registerSlot("output.header", () => (
    <Tabs
      variant="result"
      active="r1"
      items={[
        { id: "o", title: "Output", icon: "dg/console", closeable: false },
        { id: "r1", title: "postgres.sales.invoices", icon: "dg/table" },
      ]}
    />
  ));
  if (q.has("notify"))
    notify({
      title: "Default SQL dialect",
      body: "You can set PostgreSQL as default SQL dialect for this project or configure SQL dialects.",
      timeout: 0,
      actions: [{ label: "configure", run: () => {} }],
    });
}
