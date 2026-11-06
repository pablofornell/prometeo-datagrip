/**
 * Placeholders rendered by the shell until another module registers the real component for a slot
 * (see README.md). The explorer placeholder doubles as a living demo of the Tree and the toolbar widgets.
 */
import type { JSX } from "solid-js";
import type { EditorTab } from "../../state/tabs";
import { ActionButton, ToolbarSeparator } from "../ui/ActionButton";
import { Tree, type TreeItem } from "../ui/Tree";
import { openMenu } from "../ui/Menu";

const folder = (id: string, label: string, count: number, children: TreeItem[]): TreeItem => ({
  id,
  label,
  hint: String(count),
  icon: "folder",
  hasChildren: true,
  children,
});

const col = (t: string, name: string, type: string, icon = "dg/column"): TreeItem => ({
  id: `${t}.${name}`,
  label: name,
  hint: type,
  icon,
});

const table = (schema: string, name: string, cols: TreeItem[]): TreeItem => ({
  id: `${schema}.${name}`,
  label: name,
  icon: "dg/table",
  hasChildren: true,
  data: cols,
});

const DEMO: TreeItem[] = [
  {
    id: "ds",
    label: "postgres@localhost",
    badge: "1",
    icon: "dg/dbms",
    hasChildren: true,
    children: [
      {
        id: "db",
        label: "postgres",
        badge: "3 of 5",
        icon: "dg/database",
        hasChildren: true,
        children: [
          { id: "inventory", label: "inventory", icon: "dg/schema", hasChildren: true, children: [] },
          { id: "public", label: "public", icon: "dg/schema", hasChildren: true, children: [] },
          {
            id: "sales",
            label: "sales",
            icon: "dg/schema",
            hasChildren: true,
            children: [
              folder("sales.tables", "tables", 2, [
                table("sales", "clients", [col("clients", "id", "integer", "dg/column-gold-key")]),
                table("sales", "invoices", [
                  col("invoices", "id", "integer = nextval('sales.inv…)", "dg/column-gold-key"),
                  col("invoices", "client_id", "integer", "dg/column-blue-key"),
                  col("invoices", "amount", "numeric(12,2)"),
                  col("invoices", "issued", "date"),
                  col("invoices", "paid", "boolean"),
                ]),
              ]),
              folder("sales.views", "views", 1, [table("sales", "v_open", [])]),
            ],
          },
        ],
      },
    ],
  },
];

/** Resolves table columns lazily (simulates introspection latency). */
async function demoLoad(item: TreeItem): Promise<TreeItem[]> {
  await new Promise((r) => setTimeout(r, 250));
  const cols = item.data as TreeItem[] | undefined;
  return [folder(item.id + ".columns", "columns", cols?.length ?? 0, cols ?? [])];
}

export function ExplorerBodyPlaceholder(): JSX.Element {
  return (
    <Tree
      roots={DEMO}
      loadChildren={demoLoad}
      initialExpanded={["ds", "db", "sales", "sales.tables"]}
      onContextMenu={(item, e) =>
        item &&
        openMenu(
          [
            { label: "New", children: [{ label: "Table" }, { label: "View" }] },
            { label: "Refresh", shortcut: "Ctrl+F5", icon: "refresh", run: () => {} },
            { type: "separator" },
            { label: "Drop…", shortcut: "Delete" },
          ],
          { x: e.clientX, y: e.clientY },
        )
      }
    />
  );
}

/** Same geometry as the real explorer toolbar (34px, 22px buttons, 4px gap, hairline groups). */
export function ExplorerToolbarPlaceholder(): JSX.Element {
  return (
    <div class="dg-toolbar dg-tw-toolbar">
      <ActionButton icon="add" title="New" dropdown />
      <ActionButton icon="dg/manage-data-sources" title="Data Sources…" action="db.dataSources" />
      <ToolbarSeparator />
      <ActionButton icon="refresh" title="Refresh" action="db.refresh" />
      <ToolbarSeparator />
      <ActionButton icon="dg/console" title="Jump to Query Console…" action="db.jumpToConsole" />
      <ActionButton icon="dg/edit-data" title="Edit Data" action="db.editData" />
    </div>
  );
}

export function OutputBodyPlaceholder(): JSX.Element {
  return <div class="dg-placeholder-center">Run a query to see its output here</div>;
}

export function EditorViewPlaceholder(props: { tab: EditorTab }): JSX.Element {
  return (
    <div class="dg-placeholder-center">
      <div>
        {props.tab.title}
        <div class="dg-placeholder-sub">editor.view.{props.tab.kind} (placeholder)</div>
      </div>
    </div>
  );
}

export function EditorEmptyPlaceholder(): JSX.Element {
  return (
    <div class="dg-placeholder-center">
      <table class="dg-empty-hints">
        <tbody>
          <tr>
            <td>New Query Console</td>
            <td class="dg-key">Ctrl+Shift+Q</td>
          </tr>
          <tr>
            <td>Go to Database Object</td>
            <td class="dg-key">Ctrl+N</td>
          </tr>
          <tr>
            <td>Search Everywhere</td>
            <td class="dg-key">Shift Shift</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
