# DataGrip parity audit — prioritized (2026-11-07)

Merged from three senior-UX audits (shell/settings/themes, explorer/dialogs/table editors, console/editor/grid/output). Full specs per item (what ours does now, what it should do, measurements, files) are in `audit/audit-shell.md`, `audit/audit-explorer.md`, `audit/audit-console.md`. DataGrip references: `screens/`; our app: `app-screens/` (same filenames, see `app-screens/MANIFEST.md`).

Totals: 17 High, 35 Medium, 26 Low.

## High

| ID | Item | Effort | DataGrip ref | Likely files |
|---|---|---|---|---|
| CON-01 | Editor right-click shows the native WebKit menu instead of an editor context menu | S | 112-editor-context-menu-dark.png | src/components/editor/SqlEditor.tsx, src/components/ui/Menu.tsx, src/features/console/actions.ts |
| CON-02 | No live inspections: syntax errors appear only after execution, unresolved names have no tooltip, the widget stays green | L | 114-editor-inspection-error-tooltip-dark.png, 115-editor-unresolved-reference-dark.png | src/components/editor/semantic.ts, src/components/editor/inspect.ts |
| CON-03 | Execution running state: no live timer, no gutter spinner, no pending result tab | M | 120-query-running-state-dark.png | src/features/console/session.ts, src/features/output/model.ts, src/components/editor/gutter.ts |
| CON-04 | Ctrl+B / Ctrl+Click and Ctrl+Q do nothing in the editor | M | 117-editor-quick-doc-ctrl-q-dark.png | src/components/editor/SqlEditor.tsx, src/components/editor/navigate.ts, src/features/explorer/QuickDoc.tsx |
| EXP-01 | Modify Table dialog (Ctrl+F6) is missing | L | 104-modify-table-dialog-dark.png, 104b-modify-table-column-selected-dark.png | src/features/table/ModifyTable.tsx, src/features/explorer/actions.ts, src/features/table/sql.ts |
| EXP-02 | New › Table (Create Table dialog) and the object types of the New submenu are missing | M | 105-create-table-dialog-dark.png, 17-dbexplorer-context-menu-schema-new-submenu-dark.png | src/features/explorer/actions.ts, crates/dbcore/src/ddl.rs. |
| EXP-03 | Import Data from file is missing | L | 107-import-data-dialog-dark.png, 107b-import-data-dialog-source-format-dark.png | src/features/table/importData.tsx, src/features/explorer/actions.ts, crates/dbcore/src/table.rs |
| EXP-04 | New data sources are not introspected and get no console; no introspection progress anywhere | M | 02-main-after-adding-sources-introspecting-dark.png, 06-statusbar-introspection-progress-dark.png | src/features/datasource/session.ts, src/features/explorer/core.ts, src/state/status.ts |
| GRID-01 | Grid "Export Data" opens no Export Data dialog (the native save dialog appears straight away) | M | 106-export-data-dialog-dark.png | src/features/table/Popups.tsx, src/features/table/exportData.tsx, src/features/output/export.ts |
| GRID-02 | Console result toolbar has dead disabled buttons (SQL, Open in Editor Tab, DDL) and shows the edit group on read-only results | S | 51-results-grid-and-console-dark.png, 53-results-table-query-editable-toolbar-dark.png | src/features/output/OutputToolbar.tsx, src/components/grid/GridToolbar.tsx, src/features/output/model.ts |
| SHELL-01 | Edit and Code main-menu items are permanently disabled | M | 126-main-menu-edit-dark.png | src/state/core-actions.ts, src/state/actions.ts, src/components/editor/commands.ts |
| SHELL-02 | Main menu structure and contents differ from DataGrip (no Run menu, extra Code/Tools, missing in-scope items) | M | 93-main-menu-file-dark.png, 127-view-tool-windows-submenu-dark.png | src/components/shell/menus.ts, src/state/core-actions.ts, src/state/layout.ts |
| SHELL-03 | No split editor (Split Right / Split Down) | L | 133-split-editor-dark.png, 113-editor-tab-context-menu-dark.png | src/components/shell/EditorArea.tsx, src/state/tabs.ts, src/components/ui/Tabs.tsx |
| SHELL-04 | No Recent Files (Ctrl+E) and no Switcher (Ctrl+Tab) | M | 124-recent-files-ctrl-e-dark.png | src/state/tabs.ts, src/features/navigate/RecentFiles.tsx, src/features/navigate/index.ts |
| SHELL-05 | No Files tool window, no scratch files, no opening .sql files | L | 125-files-toolwindow-dark.png, 103-run-sql-script-target-chooser-dark.png | src/state/layout.ts, src/state/tabs.ts, src/features/files/ |
| SHELL-06 | No Services tool window (sessions / connections overview) | L | 100-services-toolwindow-dark.png | src/state/layout.ts, src/features/services/, src/features/output/LogView.tsx |
| SHELL-07 | Tool-window system is two fixed windows: no "…" more-windows button, no right anchor, no slot sharing, no Move/Resize/Maximize | L | 03-crop-main-toolbar-dark.png, 127-view-tool-windows-submenu-dark.png | src/state/layout.ts, src/components/shell/Shell.tsx, src/components/shell/ToolWindowPanel.tsx |

## Medium

| ID | Item | Effort | DataGrip ref | Likely files |
|---|---|---|---|---|
| CON-05 | Failed statement: no editor error banner, and the Output switches to the log | S | 121-query-error-result-dark.png, 121b-query-error-output-tab-dark.png | src/features/console/session.ts, src/features/console/console.css, crates/dbcore/src/exec.rs |
| CON-06 | Alt+Enter intentions and gutter bulb missing | M | 116-editor-alt-enter-intentions-dark.png | src/components/editor/intentions.ts, src/features/console/session.ts |
| CON-07 | Query parameters (`?`, `:name`, `$1`) are sent as-is: there is no parameter prompt | M |  | src/features/console/session.ts, src/features/console/params.tsx, src/components/editor/lexer.ts |
| CON-08 | Live templates (Ctrl+J, abbreviation + Tab) do not exist | M | 119-editor-parameter-or-live-template-dark.png, 119b-editor-live-template-variable-dark.png | src/components/editor/complete.ts, src/components/editor/templates.ts |
| CON-09 | Query History is a flat popup, not DataGrip's two-pane list + preview dialog | S | 101-query-history-popup-dark.png | src/features/console/history.tsx, src/features/console/console.css |
| CON-10 | Explain Plan is absent (toolbar, editor menu, result tab) | L | 135-explain-plan-dark.png, 04-crop-editor-tabs-and-console-toolbar-dark.png | crates/dbcore/src/exec.rs, src/features/console/ConsoleToolbar.tsx, src/features/output/ |
| CON-11 | Console toolbar lacks the In-Editor Results toggle and the Playground/Script resolve-mode widget | M | 04-crop-editor-tabs-and-console-toolbar-dark.png, 45-console-file-resolve-mode-menu-dark.png | src/features/console/ConsoleToolbar.tsx, src/components/editor/semantic.ts |
| CON-12 | Editor tabs: no split, no reopen closed tab; tab menu has 4 items | M | 113-editor-tab-context-menu-dark.png, 133-split-editor-dark.png | src/components/shell/EditorArea.tsx, src/state/tabs.ts, src/features/console/ConsoleView.tsx |
| EXP-05 | Run SQL script / Run/Debug Configurations ("Database Script") are missing | L | 102-run-configurations-dialog-dark.png, 102b-run-configurations-add-new-dark.png | src/features/runconfig/, src/state/persist.ts, src/components/shell |
| EXP-06 | Tree hover tooltip with the object comment; comments should not be inline hints | S | 134-tree-hover-tooltip-dark.png, 14-dbexplorer-tree-postgres-expanded-dark.png | src/features/explorer/model.ts, src/features/explorer/core.ts, src/components/ui/Tree.tsx |
| EXP-07 | Data source color is saved but never shown; no "Set Color" in the context menu | S |  | src/features/explorer/actions.ts, src/features/explorer/commands.ts, src/components/ui/Tree.tsx |
| EXP-08 | Missing explorer shortcuts from the DataGrip keymap | S |  | src/features/explorer/actions.ts, src/state/keymap, src/state/keymap.test.ts |
| EXP-09 | Context menus: missing items, order and mnemonics | M | 15-dbexplorer-context-menu-table-dark.png | src/features/explorer/actions.ts, src/components/ui/Menu.tsx, src/components/ui/Tree.tsx |
| EXP-10 | Schema selector popup: missing toolbar, pattern and "Default schema" rows | M | 20-dbexplorer-schema-selector-popup-dark.png, 35-datasource-tab-schemas-dark.png | src/features/explorer/SchemaSelector.tsx, src/features/explorer/schemaFilter.ts, src/state/schema-filter.ts |
| EXP-11 | PostgreSQL tree: no "Database Objects" / "Server Objects"; sequences lack type hint; schema order | M | 14-dbexplorer-tree-postgres-expanded-dark.png | crates/dbcore/src/introspect.rs, src/features/explorer/model.ts, src/features/explorer/icons.ts |
| EXP-12 | DDL view is read-only and schema-qualified | M | 73-ddl-view-dark.png | src/features/ddl/DdlView.tsx, crates/dbcore/src/ddl.rs |
| GRID-03 | Cell context menu misses DataGrip's local-filter, aggregate, SQL-expression and navigation items | M | 108-grid-cell-context-menu-dark.png | src/components/grid/DataGrid.tsx |
| GRID-04 | Column header menu: wrong item set, and right-click selects the whole column | M | 109-grid-column-header-context-menu-dark.png | src/components/grid/DataGrid.tsx |
| GRID-05 | Data extractor chooser has 5 formats; DataGrip's "Data Extractors" popup has sections and more formats | M | 110-grid-data-extractor-menu-dark.png | src/features/output/export.ts, crates/dbcore, src/api/types.ts |
| GRID-06 | No foreign-key navigation from cells (Go To › Related / Referenced rows, F4) | M |  | src/components/grid/DataGrid.tsx, src/features/output/OutputToolbar.tsx, src/features/table/TableView.tsx |
| GRID-07 | Date/time and boolean cells have no dedicated editor | M | 132-grid-date-cell-editor-dark.png, 132-grid-boolean-cell-dark.png | src/components/grid/DataGrid.tsx, src/components/grid/DateEditor.tsx, src/components/grid/format.ts |
| GRID-08 | Console results page by infinite scroll; the pill never shows "N+" and its page menu is all disabled | S | 56-grid-rows-pill-page-size-menu-dark.png | src/features/output/ResultView.tsx, src/components/grid/GridToolbar.tsx, src/features/console/actions.ts |
| GRID-09 | Status bar shows no aggregator or row:col for console result grids | S | 57-grid-sorted-selected-cell-dark.png, 98-grid-aggregates-tab-dark.png | src/features/output/ResultView.tsx, src/components/grid/DataGrid.tsx, src/state/status.ts |
| SHELL-08 | Editor tab context menu is a 4-item subset; "Close Other Tabs" enabled with one tab | M | 113-editor-tab-context-menu-dark.png | src/components/shell/EditorArea.tsx, src/state/tabs.ts |
| SHELL-09 | Status bar never shows background tasks (introspection, connect, export) | S | 06-statusbar-introspection-progress-dark.png | src/state/status.ts, src/components/shell/StatusBar.tsx, src/features/explorer/core.ts |
| SHELL-10 | Menu bar: hovering another title does not switch menus; clicking one closes the bar | S |  | src/components/ui/Menu.tsx, src/components/shell/MainToolbar.tsx, src/styles/ui.css |
| SHELL-11 | Keymap is read-only and incomplete | L | 97-settings-keymap-dark.png, 94-settings-keymap-execution-dark.png | src/features/settings/KeymapPage.tsx, src/state/actions.ts, src/state/settings.ts |
| SHELL-12 | Settings has no Editor › Color Scheme page | L | 130-settings-color-scheme-dark.png, 130b-settings-color-scheme-sql-keyword-dark.png | src/features/settings/model.ts, src/state/settings.ts, src/theme/dark.css |
| SHELL-13 | Settings › Appearance has only the Theme combo | M | 97-settings-appearance-dark.png | src/features/settings/pages.tsx, src/state/settings.ts, src/styles/tokens-extra.css |
| SHELL-14 | Settings tree is missing most in-scope Database and Editor pages | L | 131-settings-database-general-dark.png, 131b-settings-database-other-dark.png | src/features/settings/model.ts, src/state/settings.ts |
| SHELL-15 | Search Everywhere: hidden schemas leak, missing object kinds, no Text tab, no settings/options results | M | 91-search-everywhere-all-dark.png, 90-goto-database-object-ctrl-n-dark.png | src/features/navigate/sources.ts, src/state/schema-filter.ts |
| SHELL-16 | Missing global navigation shortcuts | M |  | src/state/core-actions.ts, src/state/actions.ts, src/state/layout.ts |
| SHELL-17 | Notifications have no history, no tool window and no status-bar bell | M | 81-notification-balloon-info-dark.png, 05-crop-statusbar-dark.png | src/components/ui/Notification.tsx, src/components/shell/StatusBar.tsx, src/state/layout.ts |
| SHELL-18 | Status bar breadcrumbs follow the explorer, not the focused component; stale widgets | S | 05-crop-statusbar-dark.png | src/components/shell/StatusBar.tsx, src/state/status.ts, src/features/explorer/core.ts |
| SHELL-19 | Gear menu and theme switching: no Keymap…, no "Theme…" quick-switch popup | S | 92-settings-gear-menu-dark.png, 96-theme-quick-switch-dark.png | src/components/shell/menus.ts, src/state/core-actions.ts, src/components/ui/Menu.tsx |

## Low

| ID | Item | Effort | DataGrip ref | Likely files |
|---|---|---|---|---|
| CON-13 | Error stripe identifier marks are purple in dark (CSS override bug) | S | 40-console-editor-sql-highlighting-dark.png | src/components/editor/editor.css |
| CON-14 | Tx isolation list: "Read Uncommitted" shown instead of "Database Default"; Tx combo stays active while running | S | 44-console-tx-mode-menu-dark.png | src/features/console/session.ts, src/components/ui/Menu.tsx |
| CON-15 | Schema switcher popup: missing hint row and DataGrip's icon | S | 46-console-schema-switcher-popup-dark.png | src/features/console/session.ts |
| CON-16 | Completion popup details | S | 42-console-completion-popup-tables-dark.png, 139-completion-light.png | src/components/editor/complete.ts |
| CON-17 | Find/Replace bar is missing several controls | S | 118-editor-find-replace-bar-dark.png | src/components/editor/search.ts, src/features/console/ConsoleView.tsx |
| CON-18 | Missing editor shortcuts from the default keymap | S |  | src/components/editor/SqlEditor.tsx |
| CON-19 | No JOIN cardinality inlay hints | M | 40-console-editor-sql-highlighting-dark.png | src/components/editor/semantic.ts, src/components/editor/inlays.ts |
| EXP-13 | Explorer toolbar: "Compare" slot and tooltip text; New popup items | S | 19-crop-dbexplorer-header-toolbar-x2-dark.png, 10-dbexplorer-new-menu-dark.png | src/features/explorer/ExplorerToolbar.tsx, src/features/explorer/actions.ts |
| EXP-14 | Data source folders (New › Folder, Move ›) are missing | M | 10-dbexplorer-new-menu-dark.png | src/api/types.ts, src-tauri/src/store.rs, src/features/explorer/core.ts |
| EXP-15 | Options tab: missing Switch schema and Introspection options | S | 33-datasource-tab-options-dark.png | src/features/datasource/OptionsTab.tsx, crates/dbcore/src/manager.rs |
| EXP-16 | Advanced tab shows one property; should list the driver's real options | S | 36-datasource-tab-advanced-dark.png | src/features/datasource/AdvancedTab.tsx, crates/dbcore/src/conn.rs |
| EXP-17 | Drivers page is a read-only info page without list structure | S | 129-datasource-drivers-tab-dark.png, 129b-datasource-drivers-search-dark.png | src/features/datasource/DriversPage.tsx |
| EXP-18 | SSH tunnel and SSL certificate files are disabled | L | 128-datasource-tab-ssh-ssl-dark.png, 34-datasource-tab-ssh-ssl-dark.png | src/features/datasource/SshSslTab.tsx, crates/dbcore/src/conn.rs, src-tauri/src/state.rs. |
| EXP-19 | Test Connection result popup details | S | 38-datasource-postgresql-test-succeeded-dark.png, 123b-connection-failed-result-popup-dark.png | src/features/datasource/TestBar.tsx |
| EXP-20 | Explorer empty state lacks "All Data Sources ›" and the editor-area "New Data Source" button | S | 00-welcome-empty-project-dark.png | src/features/explorer/ExplorerBody.tsx, src/components/shell/Placeholders.tsx |
| EXP-21 | Table data editor WHERE / ORDER BY bar: filter history and Ctrl+Alt+Shift+F | S |  | src/features/table/FilterBar.tsx, src/features/table/actions.ts, src/state/persist.ts. |
| GRID-10 | Empty result shows a "No rows" text; Delete and Export stay enabled | S | 122-empty-result-dark.png | src/components/grid/DataGrid.tsx, src/features/output/OutputToolbar.tsx |
| GRID-11 | Output log pane: no layout toggle or print; scrollbar placement | S | 52-output-log-pane-dark.png, 54-output-log-with-update-and-error-dark.png | src/features/output/OutputToolbar.tsx |
| GRID-12 | Manage Columns and header: no drag reorder, pin, or "Show all" | M | 98-grid-manage-columns-dark.png | src/components/grid/ManageColumns.tsx |
| GRID-13 | Local filter popup footer never shows the match count | S | 98-grid-local-filter-popup-dark.png, 111-grid-column-filter-popup-dark.png | src/components/grid/LocalFilterPopup.tsx |
| SHELL-20 | Menu polish: mnemonics, Alt+letter, bar-menu separator height | S | 93-main-menu-file-dark.png | src/components/ui/Menu.tsx, src/components/shell/menus.ts, src/components/shell/MainToolbar.tsx |
| SHELL-21 | Editor tab strip: no overflow dropdown, no double-click maximize, tab strip shown when empty, empty-state actions | S | 130-settings-color-scheme-dark.png, 00-welcome-empty-project-dark.png | src/components/ui/Tabs.tsx, src/components/shell/EditorArea.tsx, src/components/shell/Placeholders.tsx |
| SHELL-22 | Hide All Windows (Ctrl+Shift+F12) does not restore the previous set | S |  | src/state/layout.ts |
| SHELL-23 | Tool-window header actions stay visible after focus leaves | S | 01-main-window-dark.png | src/styles/shell.css, src/state/layout.ts |
| SHELL-24 | Remaining hard-coded colours outside the theme files | S |  | src/components/editor/editor.css, src/features/explorer/explorer.css, src/components/grid/grid.css |
| SHELL-25 | Our 136-main-window-light capture does not show the reference state | S | 136-main-window-light.png |  |
