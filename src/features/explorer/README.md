# Database Explorer (`explorer.body`, `explorer.toolbar`, `explorer.headerActions`)

Importing `src/features/explorer` registers the slots and the actions below (on the next task after the
import, so that they override the shell's stubs, which `<App/>` registers when it renders).

## Files
`core.ts` data source list, lazy loading (connect on expand, "Loading..." row, error node + balloon), refresh, reveal,
persistence (`explorer.state`), status-bar crumbs. `model.ts` node kinds, icons, hints, object references.
`commands.ts` open table / DDL / console tabs, copy, drop, deactivate. `actions.ts` action registry + context menu.
`ExplorerBody.tsx` / `ExplorerToolbar.tsx` / `dialogs.tsx` UI. `schema.ts` reactive `schemaSnapshotFor` and the
sequences / routines that the SQL editor's completion gets through `setCompletionExtrasProvider` (components/editor/extras.ts).
`rename.ts` Shift+F6 (`ALTER ... RENAME` per DBMS, identifier quoting), `QuickDoc.tsx` Ctrl+Q popup,
`SchemaSelector.tsx` popup of the schema badge (saves the schema filter in the UI state, then reloads the tree; no reconnect).
`icons/` explorer-local icons (see icons/README.md).

## Module API (`src/features/explorer/index.ts`)
* `getSelectedNode(): ExplorerNodeInfo | undefined` (`{ id, dsId, kind, name, label, path, extra, objectRef }`)
* `refreshNode(idOrPath)` node id, or `[dsId, ...backend path]`
* `revealObject(dsId, objectRef): Promise<boolean>` expands + selects the object (columns, keys, indexes too)
* `schemaSnapshotFor(dsId, schema?)` reactive; loads once, reloads after a refresh of that data source;
  `loadSchemaSnapshot(dsId, schema?)` promise variant
* `ensureConnected(dsId)` connects a data source if needed (spinner on its tree node, connection state); idempotent
* `reloadDataSources()` (also on window focus and on the `prometeo:datasources-changed` window event),
  `refreshConnectionState()`, `openTableTab(node.data)` / `openDdlTab` / `newConsole(dsId?)` / `jumpToConsole(dsId?)`

## Background tasks, new data sources, colors
* Every load of a data source (connect, expand, Refresh) is a status bar task (`startTask` in `src/state/status.ts`):
  `Performing complete introspection (<DBMS>)` for new data sources and Refresh (Ctrl+F5, only if it lasts > 300 ms),
  `Connecting to <ds>` / `Loading <ds>` for the rest, with cancel (drops the results, the node shows "Introspection cancelled").
* OK in the Data Sources dialog with new data sources fires `onDataSourcesCreated` (`datasource/events.ts`):
  `bootstrap.ts` opens one console tab each (the last one active) and connects + introspects them in the background.
* "Set Color": a data source's color is part of its configuration, schemas / tables keep theirs in the explorer state
  (`nodeColors`). Rows below a colored node are tinted (`--dg-ds-tint-mix`); editor tabs and the console background of
  that data source too (`tabs.color`, kept in sync by `index.ts`).
* Object comments (schema / table / view / database) are hover tooltips (`tooltip`, editor font), not inline hints.

## Actions
`db.newConsole` (Ctrl+Shift+Q), `db.jumpToConsole` (Ctrl+Shift+F10), `db.refresh` (Ctrl+F5), `db.disconnect` (Ctrl+F2,
"Deactivate"), `db.editData` (F4), `db.gotoDdl` (Ctrl+B), `db.drop` (Delete), `db.rename`
(Shift+F6, inline editor + confirmation with the SQL), `db.quickDoc` (Ctrl+Q), `db.copyReference`
(Ctrl+Alt+Shift+C), `db.copyName`, `db.copyDdl`, `db.ddlToConsole`, `db.duplicateDataSource`, `explorer.locate`,
`explorer.expandAll`, `explorer.collapseAll`, `db.modifyObject` (Ctrl+F6, Modify Table / Schema dialog of feature
`schema-editor`), `db.new` (Alt+Insert, the New popup: Table, View, Sequence, Schema ... per DBMS). Shortcuts of `db.refresh / disconnect / editData / gotoDdl / drop /
copyReference` only apply while the explorer tree has focus (`when` guard). Shift+Enter in the tree opens
`db.properties` (feature `datasource`) for the selected data source; "New > Data Source" runs
`db.newDataSource.<mariadb|mysql|postgres|sqlite>`; "Export Data..." runs `grid.export` with
`{ dsId, objectRef }`.

## Tabs opened
* table: `{ id: "table:<dsId>:<schema>.<name>", kind: "table", title: "<name> [<ds name>]", data: { dsId, objectRef } }`
* ddl: `{ id: "ddl:<dsId>:<schema>.<name>[(<signature>)]", kind: "ddl", title: "<name> (DDL) [<ds name>]", data: { dsId, objectRef } }`
  (columns / keys / indexes / triggers open the DDL and data of their table)
* console: `{ id: "console:<dsId>:<name>", kind: "console", title: "<name> [<ds name>]", data: { dsId, consoleName } }`
