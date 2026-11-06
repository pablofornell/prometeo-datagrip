/**
 * "Data Sources and Drivers" dialog.
 *
 *   openDataSourceDialog({ selectId?, newDriver? })   open (or re-focus) the dialog
 *   onDataSourcesChanged(cb)                          called after Apply / OK saved or deleted data sources
 *                                                     (also the window event "prometeo:datasources-changed")
 *   visibleSchemas(ds) / isSchemaVisible(ds, path)    read `options.visibleSchemas` (see ./model.ts for all keys)
 *
 * Actions: `db.dataSources`, `db.properties` (ctx = data source id or `{ id }`),
 *          `db.newDataSource.postgres | .mysql | .mariadb | .sqlite`.
 */
import { render } from "solid-js/web";
import { registerAction } from "../../state/actions";
import { type DialogApi, DataSourceDialog } from "./DataSourceDialog";
import { type Dbms, DBMS, DBMS_ORDER, dbmsIcon } from "./drivers";
import "./datasource.css";

export { DATA_SOURCES_CHANGED_EVENT, onDataSourcesChanged } from "./events";
export { isSchemaVisible, visibleSchemas } from "./schemas";

export interface OpenDataSourceDialogOptions {
  /** Data source (backend id) to select. */
  selectId?: string;
  /** Start with a new, unsaved data source of this driver selected. */
  newDriver?: "postgres" | "mysql" | "sqlite" | "mariadb";
}

let api: DialogApi | null = null;
let open = false;

export function openDataSourceDialog(opts: OpenDataSourceDialogOptions = {}): void {
  if (open) {
    if (opts.newDriver) api?.addNew(opts.newDriver as Dbms);
    else if (opts.selectId) api?.select(opts.selectId);
    return;
  }
  open = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <DataSourceDialog
        selectId={opts.selectId}
        newDbms={opts.newDriver as Dbms | undefined}
        register={(a) => (api = a)}
        onClose={() => {
          open = false;
          api = null;
          // let Solid finish the current event before the tree is torn down
          queueMicrotask(() => {
            dispose();
            host.remove();
          });
        }}
      />
    ),
    host,
  );
}

registerAction({
  id: "db.dataSources",
  title: "Data Sources…",
  shortcut: "Ctrl+Alt+Shift+S",
  icon: "dg/manage-data-sources",
  run: () => openDataSourceDialog(),
});

registerAction({
  id: "db.properties",
  title: "Data Source Properties",
  // Shift+Enter belongs to the explorer tree: shown in menus, never dispatched globally
  shortcut: "Shift+Enter",
  when: () => false,
  run: (ctx) => {
    const id = typeof ctx === "string" ? ctx : (ctx as { id?: string } | undefined)?.id;
    openDataSourceDialog({ selectId: id });
  },
});

for (const id of DBMS_ORDER) {
  registerAction({
    id: `db.newDataSource.${id}`,
    title: DBMS[id].label,
    get icon() {
      return dbmsIcon(id);
    },
    run: () => openDataSourceDialog({ newDriver: id }),
  });
}
