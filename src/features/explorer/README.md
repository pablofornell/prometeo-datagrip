# Database Explorer (`explorer.body`, `explorer.toolbar`, `explorer.headerActions`)

Importing `src/features/explorer` registers the slots and the actions below (on the next task after the
import, so that they override the shell's stubs, which `<App/>` registers when it renders).

## Files
`core.ts` data source list, lazy loading (connect on expand, "Loading..." row, error node + balloon), refresh, reveal,
persistence (`explorer.state`), status-bar crumbs. `model.ts` node kinds, icons, hints, object references.
`commands.ts` open table / DDL / console tabs, copy, drop, deactivate. `actions.ts` action registry + context menu.
`ExplorerBody.tsx` / `ExplorerToolbar.tsx` / `dialogs.tsx` UI. `schema.ts` reactive `schemaSnapshotFor`.
`icons/` explorer-local icons (see icons/README.md).

## Module API (`src/features/explorer/index.ts`)
* `getSelectedNode(): ExplorerNodeInfo | undefined` (`{ id, dsId, kind, name, label, path, extra, objectRef }`)
* `refreshNode(idOrPath)` node id, or `[dsId, ...backend path]`
* `revealObject(dsId, objectRef): Promise<boolean>` expands + selects the object (columns, keys, indexes too)
* `schemaSnapshotFor(dsId, schema?)` reactive; loads once, reloads after a refresh of that data source;
  `loadSchemaSnapshot(dsId, schema?)` promise variant
* `reloadDataSources()` (also on window focus and on the `prometeo:datasources-changed` window event),
  `refreshConnectionState()`, `openTableTab(node.data)` / `openDdlTab` / `newConsole(dsId?)` / `jumpToConsole(dsId?)`

## Actions
`db.newConsole` (Ctrl+Shift+Q), `db.jumpToConsole` (Ctrl+Shift+F10), `db.refresh` (Ctrl+F5), `db.disconnect` (Ctrl+F2,
"Deactivate"), `db.editData` (F4), `db.gotoDdl` (Ctrl+B), `db.drop` (Delete), `db.copyReference`
(Ctrl+Alt+Shift+C), `db.copyName`, `db.copyDdl`, `db.ddlToConsole`, `db.duplicateDataSource`, `explorer.locate`,
`explorer.expandAll`, `explorer.collapseAll`. Shortcuts of `db.refresh / disconnect / editData / gotoDdl / drop /
copyReference` only apply while the explorer tree has focus (`when` guard). Shift+Enter in the tree opens
`db.properties` (feature `datasource`) for the selected data source; "New > Data Source" runs
`db.newDataSource.<mariadb|mysql|postgres|sqlite>`; "Export Data..." runs `grid.export` with
`{ dsId, objectRef }`.

## Tabs opened
* table: `{ id: "table:<dsId>:<schema>.<name>", kind: "table", title: "<name> [<ds name>]", data: { dsId, objectRef } }`
* ddl: `{ id: "ddl:<dsId>:<schema>.<name>[(<signature>)]", kind: "ddl", title: "<name> (DDL) [<ds name>]", data: { dsId, objectRef } }`
  (columns / keys / indexes / triggers open the DDL and data of their table)
* console: `{ id: "console:<dsId>:<name>", kind: "console", title: "<name> [<ds name>]", data: { dsId, consoleName } }`
