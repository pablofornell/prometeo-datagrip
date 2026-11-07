# App screenshots manifest (Prometeo DataGrip clone vs DataGrip 2026.3)

Captured 2026-11-07 from the real release binary (`target/release/prometeo-datagrip`, HEAD `d95fc56`) on a private Xvfb `:9`, no window manager, window 1600x1000 at 0,0, private `PROMETEO_CONFIG_DIR`/`PROMETEO_DATA_DIR` under `/tmp/claude-1000/app-shots/`, `PROMETEO_NO_KEYRING=1`.
Data: SQLite `/tmp/claude-1000/ux-sample.db` and PostgreSQL `127.0.0.1:54329` (data source host `localhost`, user `postgres`). I created the schemas `sales` (clients, invoices, v_unpaid, client_total(), clients_id_seq, invoices_id_seq, ticket_seq) and `inventory` (items) to match the DataGrip reference. The schema `shop` was already there. I left it in place and hid it with the schema selector ("3 of 6").

How the crops were made:
- 1600x1000 references are full window captures.
- 1920-wide references are full 1920x1000 root captures; the area right of the window is empty root.
- Dialog references (1000x720 data sources, 900x700 settings) are the dialog body **without** our in-app 38-41 px title bar. DataGrip was shot without a WM, so its references have no title bar.
- Other crops use the same size and zoom as the reference and are anchored on the same element: the clicked tree row, toolbar button, popup corner, etc. Our element positions differ slightly, so the origin was shifted to keep the element at the same place.

Status: **CAPTURED** = same state reached; **PARTIAL** = the state exists but a visible part differs or is missing; **MISSING** = our app cannot reach the state. No PNG is written for MISSING.

## Shell
- 00-welcome-empty-project-dark — CAPTURED — first launch, empty config. Diff: no project/VCS widgets and no status bar contents; empty editor shows shortcut hints instead of DataGrip's 3 action buttons; no cloud or demo sections (out of scope).
- 01-main-window-dark — CAPTURED — PG console with `SELECT * FROM sales.invoices i WHERE i.paid = false` run, tabs clients / invoices (DDL) / SQLite console, invoices selected. Diff: no "Database Objects/virtual views/Server Objects" nodes; SQLite data source listed first; console toolbar has fewer buttons (no Playground, no explain); invoice amounts differ (random seed).
- 01-main-window-light — CAPTURED — same state in Islands Light. Diff: as dark; status bar right side is shorter.
- 02-main-after-adding-sources-introspecting-dark — PARTIAL — captured 150 ms after OK in the data sources dialog. Diff: no consoles open automatically, no introspection spinner or status-bar progress, no "Default SQL dialect" balloon.
- 03-crop-main-toolbar-dark — CAPTURED — crop 0,0 1600x43. Diff: centre group has only 2 tool-window buttons (Explorer, Output). Files, Services and "…" are missing. Window controls are drawn on the right.
- 03b-crop-main-toolbar-left-x3-dark — CAPTURED — 0,0 400x43 x3. Diff: only the hamburger; no project or VCS widget (VCS is out of scope).
- 03c-crop-main-toolbar-right-x3-dark — CAPTURED — 1360,0 240x43 x3. Diff: search + gear + min/max/close instead of New Session/search/gear.
- 04-crop-editor-tabs-and-console-toolbar-dark — CAPTURED — 500,43 1100x77. Diff: console toolbar lacks the explain, settings-plan and Playground widgets; our 4 tabs vs DataGrip's 2.
- 05-crop-statusbar-dark — CAPTURED — 0,960 1600x40. Diff: no notifications/trial widgets; breadcrumbs match.
- 06-statusbar-introspection-progress-dark — MISSING — expanded and refreshed (Ctrl+F5) a data source while bursting 30 fps captures: no progress ever shows. `status.task` (StatusBar progress widget) is never set anywhere in `src/`.

## Database explorer
- 10-dbexplorer-new-menu-dark — CAPTURED — "+" in explorer toolbar (data sources already exist). Diff: only "Data Source ›" and "Query Console"; DataGrip has 9 items + Folder/Driver.
- 11-dbexplorer-new-datasource-submenu-dark — CAPTURED — hover Data Source. Diff: 4 drivers vs DataGrip's ~30 (expected).
- 12-dbexplorer-tree-sqlite-expanded-focused-dark — CAPTURED — orders expanded (columns, keys, fks, indexes), focused. Diff: no `checks` folder and no `sqlite_master`/`Server Objects`; ds order SQLite first.
- 13-dbexplorer-tree-selection-unfocused-dark — CAPTURED — crop 0,41 500x860 after clicking the editor. Diff: same as 12; selection grey matches.
- 14-dbexplorer-tree-postgres-expanded-dark — CAPTURED — crop 0,41 500x920, output hidden. Diff: schemas are not alphabetical (public first); `public` shows the comment "standard public schema"; sequences have no type hint; no Database Objects/virtual views/Server Objects.
- 15-dbexplorer-context-menu-table-dark — PARTIAL — right-click invoices, crop 0,120 520x770. Diff: 10 items vs ~22. Missing: Modify Table, Set Color, Join Across Data Sources, Compare, Find Usages, Introspection Level, Object Actions, Tools, Diagrams, Diagnostics.
- 15-dbexplorer-context-menu-table-light — PARTIAL — same, light, clients tab with WHERE/ORDER BY behind, 1920 wide. Diff: as dark.
- 16-dbexplorer-context-menu-datasource-dark — PARTIAL — right-click postgres@localhost, crop 0,144 440x610. Diff: no Move, Set Color, Compare, Introspection Level, Tools, Diagrams, DDL Mapping, Diagnostics.
- 17-dbexplorer-context-menu-schema-new-submenu-dark — PARTIAL — right-click public › New, crop 0,190 820x640. Diff: New has Query Console, Table, Materialized View, View, Sequence, Schema, Data Source; missing Query File, Operator, Collation, Language, Database, Role, User, Virtual View, Data Source from ..., Driver. `Modify Schema…  Ctrl+F6` is there.
- 18-dbexplorer-speed-search-dark — CAPTURED — typed `inv` in tree, crop 0,41 500x480. Diff: the first match (inventory) gets selected, so the selection differs; highlight style matches.
- 19-crop-dbexplorer-header-toolbar-x2-dark — CAPTURED — 0,43 500x77 x2. Diff: toolbar has no "compare" and "jump to console" icons (DDL present).
- 19b-crop-dbexplorer-tree-rows-x2-dark — CAPTURED — 0,120 420x360 x2, orders selected. Diff: rows shifted one row up because SQLite ds is first; `tables 5` vs `6`.
- 20-dbexplorer-schema-selector-popup-dark — PARTIAL — click "1" badge on postgres@localhost, crop 180,164 290x580. Diff: opens already expanded at schema level. No "0 connections" toolbar, no "All databases"/"Default database" rows, no "add pattern".
- 21-dbexplorer-schema-selector-expanded-dark — PARTIAL — same popup after unchecking `shop`, crop 180,164 300x480. Diff: as 20; no "Default schema" row.
- 134-tree-hover-tooltip-dark — MISSING — hovered `clients` for 2.5 s: no tooltip appears.

## Data source dialog
- 30-datasource-sqlite-general-dark — CAPTURED — explorer "SQLite" quick button. Diff: default file is empty plus a "Create the file if it does not exist" checkbox, and Problems shows "File is not specified". DataGrip pre-fills identifier.sqlite. The dialog has no "Save as Template" and no help "?" button.
- 31-datasource-sqlite-driver-not-downloaded-dark — MISSING — not applicable: drivers are built in (sqlx), so nothing is ever downloaded.
- 32-datasource-sqlite-test-connection-succeeded-dark — CAPTURED — file `/tmp/claude-1000/ux-sample.db`, Test Connection. Diff: popup at a different x; driver text "sqlx SQLite (ver. 0.8)".
- 33-datasource-tab-options-dark — PARTIAL — Options tab. Diff: no "Switch schema", and the Introspection section only has "Show system schemas" (no Auto sync/Load sources/session template).
- 34-datasource-tab-ssh-ssl-dark — PARTIAL — SSH/SSL tab (SQLite). Diff: whole tab disabled with "SSH tunnels are not supported yet"/"SSL does not apply to SQLite"; no truststore row/key password.
- 35-datasource-tab-schemas-dark — CAPTURED — after "Apply and load schemas". Diff: just "All schemas"/"main"; no Default schema row, no Schema pattern/Object filter fields.
- 36-datasource-tab-advanced-dark — PARTIAL — Advanced tab. Diff: one property (connectTimeout) vs DataGrip's full driver property list; no VM options/environment/working dir.
- 37-datasource-postgresql-general-dark — CAPTURED — "+" › PostgreSQL in dialog. Diff: near 1:1 (no Save as Template, the user field spans the full width).
- 37-datasource-postgresql-general-light — CAPTURED — Ctrl+Alt+Shift+S, select postgres@localhost, light theme. Diff: our dialog shows the saved port 54329 (reference: 55432).
- 38-datasource-postgresql-test-succeeded-dark — CAPTURED — port 54329 + password. Diff: no "SSL: no" line.
- 38-datasource-postgresql-test-succeeded-light — CAPTURED — light. Diff: as dark.
- 39-datasource-postgresql-test-failed-dark — CAPTURED — port 55499. Diff: Failed popup has only Copy (no Search Error/Troubleshooting) and no DBMS/driver lines.
- 123-connection-failed-dark — CAPTURED — same failed state as 39 (dialog crop).
- 123b-connection-failed-result-popup-dark — CAPTURED — full window, port 54399, Cancel afterwards (not saved). Diff: DataGrip host 127.0.0.1/No auth; our popup lacks Search Error/Troubleshooting.
- 128-datasource-tab-ssh-ssl-dark — PARTIAL — SSH/SSL tab of the PG data source. Diff: SSH section disabled ("not supported yet").
- 129-datasource-drivers-tab-dark — PARTIAL — left rail Drivers icon. Diff: read-only info page (name/library/URL template/port/SSL modes); no driver files, no URL template table, no search.
- 129b-datasource-drivers-search-dark — MISSING — the Drivers list has no search field.
- 138-datasource-dialog-light — CAPTURED — full window, light, PG general tab.

## Console / editor
- 40-console-editor-sql-highlighting-dark — CAPTURED — pasted the reference SQL in the SQLite console, caret at 8:10, output hidden. Diff: no join-cardinality inlays (`1<->0..n:`), no intention bulb.
- 40-console-editor-sql-highlighting-light — CAPTURED — same, light. Diff: as dark.
- 40b-crop-editor-sql-x1-dark — CAPTURED — 500,118 797x227. Diff: text 1 px higher; no inlays.
- 40c-crop-editor-gutter-sql-x3-dark — CAPTURED — 500,118 397x132 x3. Diff: as 40b.
- 41-console-execute-statement-chooser-popup-dark — CAPTURED — Ctrl+Enter at 8:10. Diff: near 1:1.
- 42-console-completion-popup-tables-dark — CAPTURED — `SELECT * FROM sales.` in PG console (1920). Diff: no `cast` keyword entry and no "Next Tip"; the popup is wider.
- 42-console-completion-popup-light — CAPTURED — `SELECT * FROM sales.cl`, light (1920). Diff: as dark.
- 42b-crop-completion-x2-dark — CAPTURED — 690,141 585x235 x2. Diff: as 42.
- 43-console-completion-popup-columns-dark — PARTIAL — `... i WHERE i.`. Diff: only the 5 columns; DataGrip also lists functions (abbrev, abs…).
- 44-console-tx-mode-menu-dark — CAPTURED — Tx: Auto click, crop 594,86 210x295. Diff: isolation list has Read Uncommitted instead of "Database Default"; menu wider (cropped).
- 45-console-file-resolve-mode-menu-dark — MISSING — no "Playground/Script" resolve-mode widget in the console toolbar.
- 46-console-schema-switcher-popup-dark — PARTIAL — click `postgres.public`, crop 1360,86 240x95 (widget is at the right edge). Diff: no "Connect to database (Enter)" row.
- 47-console-postgres-result-dark — CAPTURED — PG query result. Diff: only one editor tab at that moment; no Playground widget.
- 48-editor-banner-no-datasource-light — MISSING — no "No data sources are configured" banner exists in `src/`, and a console cannot be opened without a data source.
- 101-query-history-popup-dark — CAPTURED — Ctrl+Alt+E in the SQLite console after ~10 runs (popup with search, list and preview).
- 112-editor-context-menu-dark — PARTIAL — right-click in the editor. It shows the **native WebKitGTK menu** (Cut/Copy/Paste/Delete/Select All/Insert Emoji/Insert Unicode Control Character); the app has no editor context menu.
- 113-editor-tab-context-menu-dark — CAPTURED — right-click on a tab: Close / Close Other Tabs / Close All Tabs / Pin Tab (no split actions).
- 114-editor-inspection-error-tooltip-dark — PARTIAL — `SELECT name, FROM products WHERE;` gives no live inspection. Only after executing it does the error underline + red hover tooltip appear.
- 115-editor-unresolved-reference-dark — PARTIAL — `SELECT * FROM custmers;` is coloured red as unresolved, but hovering shows no tooltip.
- 116-editor-alt-enter-intentions-dark — MISSING — Alt+Enter on the unresolved name does nothing.
- 117-editor-quick-doc-ctrl-q-dark — PARTIAL — Ctrl+Q in the editor on `customers` does nothing. The captured popup is Ctrl+Q on `clients` in the **explorer** (Quick Documentation popup with columns).
- 118-editor-find-replace-bar-dark — CAPTURED — Ctrl+R with `customers` selected (find + replace rows, Cc/W/.* toggles, 1/2).
- 119-editor-parameter-or-live-template-dark — MISSING — Ctrl+J does nothing. `sel` only offers the keyword `select`; there are no live templates.
- 119b-editor-live-template-variable-dark — MISSING — same reason.
- 120-query-running-state-dark — PARTIAL — `SELECT pg_sleep(8)` captured at 2.5 s. Diff: red stop buttons and a spinner in the output header are shown, but the header still shows the previous run's time (4 ms) instead of a live timer.
- 121-query-error-result-dark — CAPTURED — `SELECT * FROM no_such_table` run: gutter error, inline red error tooltip, red line in Output.
- 121b-query-error-output-tab-dark — PARTIAL — the same error with the Output tab shown. Diff: no red error strip with "Copy" at the bottom of the editor; the error line lacks DataGrip's `[1]` code prefix.
- 122-empty-result-dark — CAPTURED — `SELECT * FROM customers WHERE id < 0` gives headers, "No rows" and the "0 rows" pill.
- 133-split-editor-dark — MISSING — no split action in the tab menu, the main menu or the keymap.
- 135-explain-plan-dark — MISSING — no Explain Plan action exists (no "explain" in `src/` apart from keywords/mocks).
- 139-completion-light — CAPTURED — full 1600 light window with the `sales.cl` completion.

## Results / grid
- 50-results-first-run-database-output-dark — PARTIAL — first run of the reference SQL. Diff: no "Query results moved to Database Output" tip (onboarding, out of scope); grid columns much wider than DataGrip.
- 51-results-grid-and-console-dark — CAPTURED — same state. Diff: column widths (ours fit to header + padding, DataGrip tighter); no chart/geo/compare toolbar icons.
- 53-results-table-query-editable-toolbar-dark — CAPTURED — `SELECT * FROM customers` result. Diff: shorter toolbar (no chart, coloring, geo, compare, upload).
- 55-grid-view-as-menu-dark — CAPTURED — eye icon, crop 1281,527 380x155. Diff: "Tree" disabled.
- 56-grid-rows-pill-page-size-menu-dark — CAPTURED — rows pill ⌄, crop 696,762 200x200. Diff: "Count Rows" looks disabled (dark text on blue).
- 57-grid-sorted-selected-cell-dark — CAPTURED — sort by first_name, select row 3 city. Diff: status bar lacks "No aggregator selected"/"3:5" for the console tab.
- 58-grid-inline-cell-editor-dark — CAPTURED — double-click, typed Valencia, crop 0,480 1600x520.
- 59-grid-pending-changes-insert-update-delete-dark — CAPTURED — update + delete row 6 + add row. Diff: selected cell in the new row is grey, not blue, until clicked. Reverted afterwards (not submitted).
- 60-grid-preview-pending-changes-popup-dark — CAPTURED — the preview (eye) toolbar button (1920). Diff: SQL statements split over lines and schema-qualified (`main.customers`); INSERT uses DEFAULT VALUES.
- 61-crop-grid-header-rows-x2-dark — CAPTURED — 0,525 700x255 x2 in the pending state.
- 98-grid-transpose-dark — CAPTURED — View as › Transpose (local filter ES/FR active). Diff: DataGrip's grid layout has a tiny editor; ours has 4 tabs and a 90 px editor.
- 98-grid-find-dark — CAPTURED — Ctrl+F `er1` in the grid.
- 98-grid-record-view-dark — CAPTURED — record view button, row 3 email selected. Diff: near 1:1.
- 98-grid-value-tab-dark — CAPTURED — Value tab.
- 98-grid-aggregates-tab-dark — CAPTURED — Aggregates tab; same values as DataGrip.
- 98-grid-manage-columns-dark — CAPTURED — columns icon, email unchecked. Diff: no drag handles/pin per row, no "Show all".
- 98-grid-local-filter-menu-dark — CAPTURED — filter toolbar icon.
- 98-grid-local-filter-popup-dark — CAPTURED — country funnel, ES+FR checked. Diff: no "Number of matches 16" footer (ours: "Select a checkbox to filter rows").
- 106-export-data-dialog-dark — PARTIAL — explorer invoices › Import/Export › Export Data… opens a small Export Data dialog (Extractor, Output, NULL text, Write column names). The grid's "Export to File…" goes straight to the native GTK save dialog.
- 108-grid-cell-context-menu-dark — CAPTURED — right-click a cell (Edit Cell, Set NULL/DEFAULT, Add/Clone/Delete Row, Copy As, Transpose, Record View, Manage Columns, Reload).
- 109-grid-column-header-context-menu-dark — CAPTURED — right-click the email header (sort, copy name, fit width, hide column).
- 110-grid-data-extractor-menu-dark — CAPTURED — CSV ⌄: CSV/TSV/JSON/SQL Inserts/Markdown.
- 111-grid-column-filter-popup-dark — CAPTURED — country header funnel opens "Local Filter For 'country'" (value list with counts).
- 132-grid-date-cell-editor-dark — PARTIAL — double-click on invoices.issued gives a plain text field; no date picker.
- 132-grid-boolean-cell-dark — PARTIAL — double-click on clients.active gives a plain text field "false"; no checkbox or toggle.
- 137-grid-light — CAPTURED — light main window with a grid cell selected.

## Output
- 52-output-log-pane-dark — CAPTURED — Output tab after the first run. Diff: no Tx/stop/layout mini-toolbar labels beyond `Tx.`/stop; no print button.
- 54-output-log-with-update-and-error-dark — CAPTURED — crop 0,486 1600x480 after products/customers/UPDATE/error runs. Diff: extra repeated runs in the log; no `[1]` error code; fetching time shown as 0 ms.
- 100-services-toolwindow-dark — MISSING — there is no Services tool window (View › Tool Windows lists only Database Explorer and Database Output).
- 125-files-toolwindow-dark — MISSING — there is no Files/Project tool window.

## Table editor / DDL
- 70-table-data-editor-dark — CAPTURED — double-click clients, output hidden. Diff: near 1:1 (shorter toolbar).
- 70-table-data-editor-light — CAPTURED — light, WHERE `active = false` / ORDER BY `name DESC` + Output tab (same as the reference). Diff: log is not wrapped per keyword as in DataGrip.
- 71-table-data-editor-where-orderby-applied-dark — CAPTURED — WHERE + ORDER BY applied, 5 rows.
- 72-table-editor-where-completion-dark — PARTIAL — typing `active = fa` (1920). Diff: offers only `false`/`default`; DataGrip also lists functions.
- 73-ddl-view-dark — CAPTURED — invoices (DDL) tab. Diff: object names are schema-qualified (`sales.invoices`, `references sales.clients`).
- 73-ddl-view-light — CAPTURED — light. Diff: as dark.
- 104-modify-table-dialog-dark — PARTIAL — Ctrl+F6 on shop.categories (PostgreSQL), full window. Diff: no Persistence / With OIDs / Partition / Options / Access Method rows, no `?` help and gear buttons, the indexes folder leaves out the indexes behind keys, the Comment field has no expand button.
- 104b-modify-table-column-selected-dark — PARTIAL — same dialog with the column `name` selected. Diff: no Storage / Min / Max / Step rows of the identity section, otherwise the same fields.
- 105-create-table-dialog-dark — PARTIAL — New > Table on the `tables` folder of shop (Alt+Insert, Table). Diff: no virtual columns / virtual foreign keys folders, no Persistence / Partition rows.
- 107-import-data-dialog-dark — MISSING — Import/Export submenu only has Export Data…
- 107b-import-data-dialog-source-format-dark — MISSING — same reason.
- 102-run-configurations-dialog-dark — MISSING — no run configurations and no Run menu.
- 102b-run-configurations-add-new-dark — MISSING — same reason.
- 103-run-sql-script-target-chooser-dark — MISSING — no files or .sql scripts to run, and no target chooser.
- 103b-run-sql-script-datasource-popup-dark — MISSING — same reason.
- 103c-run-sql-script-run-output-dark — MISSING — same reason.

## Popups / notifications
- 80-notification-balloon-trial-dark — MISSING — out of scope (licensing/trial).
- 81-notification-balloon-info-dark — CAPTURED — info balloon "The console is busy" (Ctrl+Enter while pg_sleep runs), crop 1208,873 390x90. The reference shows "Default SQL dialect" text; same balloon style.
- 82-gotit-tooltip-tip-dark — MISSING — out of scope (tips/onboarding).
- 83-tooltip-with-shortcut-dark — CAPTURED — hover Add Row, crop 115,528 200x60.
- 90-goto-database-object-ctrl-n-dark — CAPTURED — Ctrl+N `cli`, crop 440,187 720x620. Diff: tabs All/Database/Consoles/Actions (no Files/Code/Text), no extra filter icons; hint "Type / to see commands" absent.
- 91-search-everywhere-all-dark — PARTIAL — toolbar 🔍 + `invo`. Diff: only DB objects. No keys/indexes, actions, settings or text matches. It lists `invoice_seq` from the **hidden** schema `shop`.
- 92-settings-gear-menu-dark — PARTIAL — gear, crop 1379,32 245x220. Diff: Settings / Theme › / Restore Default Layout only (Plugins, Backup and Sync are out of scope; no Keymap…, View Mode…, Customize Main Toolbar).
- 96-theme-quick-switch-dark — PARTIAL — gear › Theme submenu, crop 1185,66 215x290. Diff: a 3-item submenu (Follow System/Islands Dark/Islands Light) instead of the numbered "Theme…" quick-switch popup.
- 124-recent-files-ctrl-e-dark — MISSING — Ctrl+E does nothing.

## Navigation / main menu
- 93-main-menu-file-dark — PARTIAL — hamburger, crop 0,0 600x660. Diff: 7 items (New Query Console, Data Sources…, Close Tab, Close All Tabs, Settings…, Export Data…, Exit); menu bar has no Run/VCS.
- 126-main-menu-edit-dark — PARTIAL — hamburger + Right. Diff: every Edit item is shown **disabled** although the editor had focus before the menu opened.
- 126-main-menu-view-dark — PARTIAL — Tool Windows ›, Hide Active Tool Window, Hide All Windows, Appearance ›.
- 126-main-menu-navigate-dark — CAPTURED — Navigate menu (via keyboard).
- 126-main-menu-window-dark — CAPTURED — Window menu (via keyboard).
- 126-main-menu-run-dark — MISSING — there is no Run menu (File, Edit, View, Navigate, Code, Tools, Window, Help).
- 127-view-tool-windows-submenu-dark — PARTIAL — View › Tool Windows: only Database Explorer (Alt+1) and Database Output (Alt+8).

## Settings
- 94-settings-keymap-execution-dark — PARTIAL — Keymap, search `Execute`, crop 590,290 950x560. Diff: flat Database group (Execute, Execute Script); no Execution sub-groups, Commit/Rollback rows, "inherited from" hints.
- 95-settings-keymap-database-groups-dark — PARTIAL — collapse all + expand Database (1920). Diff: only 4 top folders (Editor Actions, Main Menu, Tool Windows, Database); Database is a flat action list with no sub-groups.
- 97-settings-appearance-dark — PARTIAL — only the Theme combo (no editor colour scheme, UI font, UI options).
- 97-settings-database-data-editor-dark — CAPTURED — Database › Data Editor and Viewer.
- 97-settings-database-query-execution-dark — CAPTURED — Database › Query Execution.
- 97-settings-editor-font-dark — CAPTURED — Editor › Font with live preview. Diff: no ligatures/Typography settings.
- 97-settings-editor-general-appearance-dark — CAPTURED — Editor › General › Appearance.
- 97-settings-keymap-dark — CAPTURED — Keymap page ("Keymap: XWin read-only", tree with key caps). Diff: no keymap combo/gear and no find-by-shortcut button.
- 97-settings-search-font-dark — PARTIAL — search `font`: finds only Editor › Font (DataGrip also lists Data Editor, Appearance, Keymap, Color Scheme…).
- 130-settings-color-scheme-dark — MISSING — no Editor › Color Scheme page.
- 130b-settings-color-scheme-sql-keyword-dark — MISSING — same reason.
- 131-settings-database-general-dark — MISSING — the Database root page only links to its 2 sub-pages; there is no General page.
- 131b-settings-database-other-dark — MISSING — same reason.

## Themes
- 136-main-window-light — CAPTURED — Islands Light main window (explorer expanded + console + grid).
- (light variants 01/15/37/38/40/42/70/73 are listed in their areas above; 137/138/139 in grid/dialog/editor.)

## Bugs / oddities seen while capturing
1. The Test Connection result popup stays open when you switch tabs or click elsewhere in the dialog. Only Escape closes it.
2. Ctrl+Alt+Shift+S with `postgres@localhost` selected in the explorer opens the dialog on `ux-sample.db` (the data source of the active console), not the selected one.
3. With the main menu open, moving the mouse over another top-level title does not switch menus, and clicking one closes the bar. Only the arrow keys switch.
4. Main menu › Edit shows every item disabled even when the editor had focus.
5. Right-click in the SQL editor shows the native WebKitGTK menu (Insert Emoji…).
6. After switching from a result grid to a console tab, "No aggregator selected" stays in the status bar.
7. Search Everywhere / Ctrl+N list objects from a schema hidden by the schema selector (`shop`).
8. While a query runs, the output header keeps the previous run's time instead of a live timer.
9. The first click on the explorer "+" right after Escape-closing a context menu only shows the tooltip; the menu opens on the second click.
