# Audit: explorer group (Database Explorer, Data Sources dialog, table/schema editors, WHERE/ORDER BY, Import, Run configurations)

Auditor: explorer. Compared docs/ux/screens/* (DataGrip 2026.3) with docs/ux/app-screens/* (HEAD d95fc56 release build), datagrip-map.md §2, §3, §6, §7, §9 and evidence §5, and checked every "missing" claim in the code (`src/features/explorer`, `src/features/datasource`, `src/features/table`, `src/features/ddl`, `crates/dbcore/src`, `src-tauri/src`). Side-by-side images: scratchpad/exp/cmp/*.png. I took no new app screenshots: the manifest already covers every state in this group, and the code settles the rest.

Out of scope and not proposed: Data Source from Cloud Provider, Data Source Templates (they need a JetBrains account), Workspace Data Source, Join Across Data Sources [New], Air/AI button, Diagnostics (it sends logs to JetBrains), Search Error / Troubleshooting web links, the promo banners in the Import/Export dialogs, JDBC driver download/licence.

---

### EXP-01 Modify Table dialog (Ctrl+F6) is missing  — Impact: High  — Effort: L
- Area: table/schema editors
- DataGrip reference: docs/ux/screens/104-modify-table-dialog-dark.png, 104b-modify-table-column-selected-dark.png; evidence §5 `DatabaseView.Ddl.AlterObject` = Ctrl+F6
- Ours now: MISSING. There is no action, no menu item and no shortcut. `contextMenuItems()` in src/features/explorer/actions.ts has no "Modify Table…", and nothing in `src/` binds Ctrl+F6. Columns, keys, indexes and checks cannot be changed except by typing ALTER statements in a console.
- Should:
  - **Entry points:** explorer context menu item `Modify Table… Ctrl+F6` (second item, right after `New ›`), `Modify Schema… Ctrl+F6` on schemas, and `Modify Column…` / `Modify Index…` etc. on child nodes. In those cases the dialog opens with that child preselected.
  - **Dialog:** in-app modal of about 775x760, no title strip, body bg `--dg-panel-bg` (#191A1C dark).
  - **Left pane (about 280px), object tree:**
    - Root `categories  postgres.shop [postgres@localhost]`, with the gray qualifier in hint style.
    - Folders `columns N`, `keys N`, `foreign keys N`, `indexes N`, `checks N`. Rows use the same 24px rows and icons as the explorer.
    - Toolbar above it: `+` (a popup that adds a Column / Key / Foreign Key / Index / Check to the selected folder), `−`, duplicate, ↑, ↓ (column order, MySQL only), and ← → back/forward.
  - **Right pane, property sheet for the selected node:**
    - A header chip with the node icon and name.
    - Label column 135px, Inter 13. Fields are 28px tall, radius 4, with a 1px #43454A border.
    - Table: Name, Comment (expand ↗), and for PG Tablespace and Owner. Persistence, With OIDs, Partition Expression/Key, Options and Access Method can be read-only or omitted.
    - Column: Name, Comment, Data Type (a SQL-highlighted combo with the dialect's types), Not Null ✓, Default Expression, Generated Always As, plus Identity on PG.
    - Key / Index: Name, Columns (a multi-select list), Unique. FK: Name, Target table, Columns ↔ Target columns, On update, On delete.
  - **Bottom:** a collapsible `⌄ Preview` section holding a read-only SqlEditor with the generated `alter table …` statements. It shows a green ✓ when there is nothing to apply. Gear and "open in console" icons sit on the right of the section header.
  - **Footer:** `?` on the left. `OK` (primary, runs the statements in one session and then refreshes the table node) and `Cancel` on the right.
  - **Cancel with pending changes** asks "You're about to lose your changes" with OK/Cancel.
  - **SQLite:** for changes SQLite cannot ALTER, generate the DataGrip-style table rebuild script (create new table, copy, drop, rename).
- Files: new src/features/table/ModifyTable.tsx (+ css), src/features/explorer/actions.ts (menu + action `db.modifyObject` with shortcut Ctrl+F6, `when: explorerFocused`), src/features/table/sql.ts or a new crates/dbcore/src/ddl.rs `alter_script()` per driver, reusing `runDdl` from src/features/explorer/commands.ts.

### EXP-02 New › Table (Create Table dialog) and the object types of the New submenu are missing  — Impact: High  — Effort: M (on top of EXP-01)
- Area: explorer New popup / context menu, table editors
- DataGrip reference: 105-create-table-dialog-dark.png, 17-dbexplorer-context-menu-schema-new-submenu-dark.png, datagrip-map §2 "On a schema, the New submenu"
- Ours now: the context-menu `New ›` has only `Query Console` and `Data Source ›` (`newSub()` in actions.ts:247). The toolbar `+` has `Data Source ›` and `Query Console` only. You cannot create a table, view, schema or sequence through the UI.
- Should:
  - **New submenu on a schema or tables folder:**
    - `Query Console Ctrl+Shift+Q`
    - sep
    - `Table`, `View`, `Materialized View` (PG), `Sequence` (PG), `Schema` (PG; MySQL "Database"), `Role`/`User` (PG/MySQL, optional)
    - sep
    - `Data Source ›`
    - sep
    - `Driver` (it opens the Drivers page)
  - **Create Table:** the EXP-01 dialog in create mode.
    - The root is named `table_name`. Its empty folders are columns / keys / foreign keys / indexes / checks.
    - The Preview starts as `create table shop.table_name\n(\n);`. The Name field is focused with its text selected.
  - **View / Materialized View / Sequence / Schema:** the same dialog shape with only Name + Comment, plus the query (an SQL editor) for views or start/increment for sequences.
  - **Alt+Insert** in the explorer opens this New popup (GAP-CAPTURES 105 confirms Alt+Insert there). The first item is preselected and the list has speed search.
- Files: src/features/explorer/actions.ts (`newSub`, `newMenuItems`, new action `db.new` with Alt+Insert, `when: explorerFocused`), ModifyTable.tsx (create mode), crates/dbcore/src/ddl.rs.

### EXP-03 Import Data from file is missing  — Impact: High  — Effort: L
- Area: Import Data dialog
- DataGrip reference: 107-import-data-dialog-dark.png, 107b-import-data-dialog-source-format-dark.png
- Ours now: MISSING. `Import/Export ›` holds only `Export Data…` (actions.ts:268) and is shown only on tables. The backend has no bulk-insert or import command (`crates/dbcore/src` and `src-tauri/src/commands.rs` have none).
- Should:
  - **Menu:** `Import/Export ›` on a schema, tables folder or table:
    - `Import Data from File(s)…`
    - `Export Data to File(s)…` (existing)
  - **Flow:** a native open dialog (filters csv/tsv/txt/json) opens the Import dialog, about 900x700:
    - **Left tree:** `from: file.csv` > `to: table_name schema [ds]`, with a toolbar (+ − copy ↑ ↓).
    - **Source node selected (107b):** Path (read-only), Encoding `UTF-8 ⌄`, Format `CSV ⌄` (CSV/TSV/custom delimiter), `First row is header ✓`, `First column is header`, `Trim whitespaces`, and the list of detected columns in italics.
    - **Target node selected (107):** Schema ⌄, Table ⌄ with a green `New: auto` badge when the table will be created, and a Mapping table (`to: Column` / `to: Type` / `from: Column`, each a combo, `<Auto> (col)` default). Also `Write errors to file` ✓ with a path, and `Insert inconvertible values as null`.
    - **Bottom tabs:** `Data Preview` (the first 10 rows in our grid, read-only) and `DDL Preview` (`create table …`).
    - **Footer:** OK / Cancel. Cancel with changes asks the "lose your changes" confirm.
  - **Backend:** a `import_file(dsId, target, mapping, options)` Tauri command that streams rows in batched INSERTs inside one transaction and emits progress. The status bar shows `Importing file.csv…` with cancel, and a balloon reports `N rows imported to table` or the errors.
- Files: new src/features/table/importData.tsx, src/features/explorer/actions.ts, crates/dbcore/src/table.rs or a new import.rs, src-tauri/src/commands.rs, src/api/db.ts and src/api/mock.ts.

### EXP-04 New data sources are not introspected and get no console; no introspection progress anywhere  — Impact: High  — Effort: M
- Area: explorer introspection states, status bar progress
- DataGrip reference: 02-main-after-adding-sources-introspecting-dark.png, 06-statusbar-introspection-progress-dark.png
- Ours now: after OK in the dialog both data sources sit collapsed and idle. The editor stays empty (app-screens/02, PARTIAL). Nothing connects until a node is expanded. `status.task` is never set (manifest 06 MISSING), so the status bar never shows progress, even on Ctrl+F5.
- Should:
  - **On OK/Apply with new data sources:**
    - Open one `console [<ds>]` tab per new data source; the last one is active.
    - Start connecting and introspecting each one in the background.
  - **While a data source is introspecting:**
    - The data-source icon becomes a 16px spinner.
    - The badge shows `…` (the same 1px #43454A box, radius 3).
  - **Status bar progress widget**, at the right group, before the caret position:
    - The text `Performing complete introspection (PostgreSQL)`.
    - A 120px determinate bar (track #393B40, fill #3574F0, 4px tall, radius 2).
    - A `⊗` cancel button, and `+N` when more tasks are queued.
  - **Same widget for Refresh (Ctrl+F5):** use it for any refresh that takes longer than 300 ms, and for EXP-03 imports.
  - **On failure:** the node shows the error child row (this already exists) and an error balloon appears.
- Files: src/features/datasource/session.ts (after save), src/features/explorer/core.ts (`ensureConnected`, `refreshNode`; set `status.task`), src/state/status.ts, the status bar component in src/components/shell/, src/features/explorer/commands.ts (`newConsole`).

### EXP-05 Run SQL script / Run/Debug Configurations ("Database Script") are missing  — Impact: Medium  — Effort: L
- Area: Run configurations, Run SQL script
- DataGrip reference: 102-run-configurations-dialog-dark.png, 102b-run-configurations-add-new-dark.png, 103-run-sql-script-target-chooser-dark.png, 103b-…-datasource-popup, 103c-…-run-output; GAP-CAPTURES rows 102/103
- Ours now: MISSING. There is no Run menu and no run configurations. The app cannot open .sql files (no `plugin-dialog` open outside GeneralTab's SQLite file picker), so there is nothing to run.
- Should:
  - **Explorer entry:** context menu `SQL Scripts › Run SQL Script…` on a data source or schema. A native file dialog (multi-select *.sql) opens the run-configuration editor dialog.
  - **Main menu entries:** `Run › Run… Alt+Shift+F10` and `Run › Edit Configurations…`.
  - **Run-configuration editor dialog:**
    - **Header:** Name (focused, with its text selected) and `Allow multiple instances`. "Store as project file" is not needed.
    - **`Target data source / schema:` list:** toolbar + − ↑ ↓. `+` opens a filterable popup that lists only data sources of a compatible dialect, with their schemas. A row reads `postgres@localhost / postgres.public`, the schema part gray italic.
    - **Execute:** radio buttons `( ) Script text` (with an SQL editor) and `(•) Script files` (with a file list, + −).
    - **Below:** a collapsible `Before launch`, which may be left empty, and the toggles `Show this page`, `Activate tool window` and `Focus tool window`.
    - **Footer:** a validation line `❗ Error: No configured target data sources` in red #F75464 while invalid. Buttons `▷ Run` (primary; disabled while invalid), Cancel and Apply (disabled until something changes).
  - **Run/Debug Configurations dialog (Edit Configurations…):**
    - **Left:** a tree with `Database Script` > configs; temporary ones are drawn dim. Toolbar + − copy. `+` opens the `Add New Configuration` popup with `Database Script` only.
    - **Right:** the same editor.
    - **Footer:** `▷ Run`, OK, Cancel, Apply.
  - **Running:** a `Run` tool window tab `scratch.sql` with the output log in the same format as the Output pane (103c). It has rerun ⟳ and stop ■ on its left toolbar. Configurations persist per project.
- Files: new src/features/runconfig/ (dialog, model, persistence via src/state/persist.ts), src/components/shell main-menu definitions (Run menu), backend: reuse `executeCollect` per file with the split.rs statement splitter.

### EXP-06 Tree hover tooltip with the object comment; comments should not be inline hints  — Impact: Medium  — Effort: S
- Area: explorer tree rows / tooltips
- DataGrip reference: 134-tree-hover-tooltip-dark.png (GAP-CAPTURES 134); 14-dbexplorer-tree-postgres-expanded-dark.png
- Ours now:
  - **No hover tooltip (manifest 134 MISSING):** `Tree.tsx:472` sets `title` only for error placeholders (core.ts:292).
  - **Comments drawn inline:** our schema rows show their comment as gray hint text (`public  standard public schema`, `shop  Demo shop`; app-screens/14). DataGrip shows no comment there. `hintOf()` in model.ts:172 returns `tn.hint` (the comment) for schemas.
- Should:
  - **Inline hints:** do not draw comments as hints for schemas, tables, views or databases. Keep the type, count and signature hints.
  - **Tooltip:** after ~1 s of hover over a node that has a comment, show a tooltip with the comment text, using the existing `dg-tooltip` look but in the editor monospace font (JetBrains Mono 13), placed below-right of the pointer. Nodes without a comment show nothing.
  - **Badge tooltip:** the `2 of 6` database badge tooltip shows the database comment.
  - **Hover background:** none, as today.
- Files: src/features/explorer/model.ts (`hintOf`), src/features/explorer/core.ts (`mkNode`: `tooltip: tn.extra.comment ?? (schema hint)`), src/components/ui/Tree.tsx (route `tooltip` through `data-tip` with a mono variant class), src/components/ui/Tooltip.tsx (a `data-tip-mono` flag).

### EXP-07 Data source color is saved but never shown; no "Set Color" in the context menu  — Impact: Medium  — Effort: S
- Area: explorer tree / editor tabs
- DataGrip reference: 15/16 context menus (`Set Color ›`), datagrip-map §2 context menus
- Ours now: the dialog has a `Color ⌄` selector (DataSourceDialog.tsx:257) and `color` is stored (model.ts:125/232). Nothing reads it: no `.color` use in the explorer, tabs or editor.
- Should:
  - **Context menu:** add `Set Color ›` after `Rename…` (data source, schema, table). Submenu: `No Color`, sep, the 7 IDE colors (Blue, Green, Orange, Purple, Red, Yellow, Gray, each with a 12px swatch), sep, `Custom…`.
  - **Tree:** a colored data source paints the background of its row and all its descendants with the color at about 18% alpha (dark) / 25% (light), behind the selection.
  - **Editor tabs and console:** editor tabs of that data source get the same tint, and the console editor background is tinted. This is DataGrip's production/dev cue.
- Files: src/features/explorer/actions.ts, src/features/explorer/commands.ts (`updateDataSource` with color), src/components/ui/Tree.tsx (row style hook), src/components/ui/Tabs.tsx, src/features/console/ConsoleView.tsx, src/theme/dark.css and light.css (color tokens).

### EXP-08 Missing explorer shortcuts from the DataGrip keymap  — Impact: Medium  — Effort: S
- Area: keyboard shortcuts (datagrip-map §9, evidence §5)
- Ours now: registered in the explorer are Ctrl+Shift+Q, Ctrl+Shift+F10, Ctrl+F5, Ctrl+F2, F4, Ctrl+B, Delete, Ctrl+Alt+Shift+C, Shift+F6, Ctrl+Q and Shift+Enter. Verified absent from `src/` (grep of every `shortcut:` definition):
  - `Ctrl+Alt+Shift+G` / `Ctrl+Shift+C`: Generate DDL to Clipboard. The action `db.copyDdl` exists with no shortcut.
  - `Ctrl+Alt+Shift+B`: Generate DDL to Query Console (`db.ddlToConsole`, no shortcut).
  - `Alt+Insert`: New popup in the explorer (see EXP-02).
  - `Ctrl+F6`: Modify object (EXP-01).
  - `Alt+Shift+B`: Select in Database Explorer from a console or table tab. We only have the header "Select Opened Object" button (`explorer.locate`) with no key.
  - `Ctrl+Alt+Shift+Q`: New Query File (only if query files exist; otherwise skip).
- Should: add these shortcuts to the existing actions. Use `when: explorerFocused` for the tree-only ones; `Alt+Shift+B` is global (`explorer.locate`, and it also focuses the explorer). Show them in the menus: `Generate DDL to Clipboard  Ctrl+Alt+Shift+G`, `Generate DDL to Query Console  Ctrl+Alt+Shift+B`.
- Files: src/features/explorer/actions.ts, src/state/keymap test (src/state/keymap.test.ts) to lock them.

### EXP-09 Context menus: missing items, order and mnemonics  — Impact: Medium  — Effort: M
- Area: explorer context menus
- DataGrip reference: 15-dbexplorer-context-menu-table-dark.png, 16-…datasource-dark.png, 17-…schema-new-submenu-dark.png; datagrip-map §2 "Context menus"
- Ours now:
  - **On a table:** 10 entries: New, Copy/Paste, Edit Data, Refresh | Rename | Quick Documentation, Navigation | SQL Scripts, Import/Export | Drop. The schema menu has no Modify Schema.
  - **On a data source:** Properties | New, Copy/Paste, Refresh, Deactivate | Rename | Quick Doc, Navigation | Remove.
  - **Other differences:** no underlined mnemonics. While the menu is open the right-clicked row stays focused-blue #2A4371; DataGrip turns it unfocused gray #33353B (13/15 refs).
- Should (in-scope items only, in DataGrip order):
  - **Table:**
    - `New ›`, `Modify Table… Ctrl+F6`, `Copy/Paste ›`, `Edit Data F4`, `Refresh Ctrl+F5`
    - sep
    - `Rename… Shift+F6`, `Set Color ›`
    - sep
    - `Quick Documentation Ctrl+Q`, `Navigation ›`
    - sep
    - `SQL Scripts ›`, `Import/Export ›`
    - sep
    - `Drop… Delete`
  - **Data source:**
    - `Properties Ctrl+Alt+Shift+S`
    - sep
    - `New ›`, `Copy/Paste ›`, `Refresh Ctrl+F5`, `Deactivate Ctrl+F2`
    - sep
    - `Rename… Shift+F6`, `Set Color ›`
    - sep
    - `Quick Documentation Ctrl+Q`, `Navigation ›`
    - sep
    - `SQL Scripts ›` (Run SQL Script…, Generate DDL to…), `Import/Export ›`
    - sep
    - `Remove Data Source… Delete`
  - **Schema:** add `Modify Schema… Ctrl+F6` after `New ›`.
  - **`SQL Scripts ›` submenu:**
    - `Generate DDL to Clipboard Ctrl+Alt+Shift+G`
    - `Generate DDL to Query Console Ctrl+Alt+Shift+B`
    - `SQL Generator… Ctrl+Alt+G` (an optional popup showing SELECT / INSERT / UPDATE / DELETE templates for the table)
    - `Run SQL Script…` (EXP-05)
  - **`Navigation ›` submenu:** `Go to DDL Ctrl+B`, `Jump to Query Console… Ctrl+Shift+F10`, `Select in Database Explorer Alt+Shift+B` (only from tabs).
  - **Later, optional:** `Compare Schema Structure With… Ctrl+D` (L effort) and `Find Usages Alt+F7` (search consoles for the name).
  - **Mnemonics:** underline the mnemonic letter (Rename = R, Quick Documentation = D, Find Usages = U) when the menu opens from the keyboard (Shift+F10 / Menu key), or always, to match the refs.
  - **Row state while the menu is open:** the row switches to the unfocused selection color.
- Files: src/features/explorer/actions.ts (`contextMenuItems`), src/components/ui/Menu.tsx (mnemonic `&` parsing, already used by the main menu? verify), src/components/ui/Tree.tsx (blur state while the menu is open).

### EXP-10 Schema selector popup: missing toolbar, pattern and "Default schema" rows  — Impact: Medium  — Effort: M
- Area: schema selector (badge click)
- DataGrip reference: 20-dbexplorer-schema-selector-popup-dark.png, 21-…expanded-dark.png, 35-datasource-tab-schemas-dark.png
- Ours now: a flat checkbox list (`All schemas` / `postgres` / schemas with a `system` suffix) plus the footer (app-screens/20). It has no toolbar, no `All databases` / `Default database` level and no patterns. The Schemas tab of the dialog is the same: `All schemas` / `main`, with no `Default schema (main)` row and no `Schema pattern:` / `Object filter:` fields (app-screens/35).
- Should:
  - **Toolbar:** a 28px strip with refresh ⟳ (re-lists the schemas), expand all, collapse all, and `—`.
  - **Rows:**
    - `All databases  add pattern` and `Default database (postgres)` above the database node.
    - Under the database node: `All schemas  add pattern`, `Default schema (public)`, then the schemas alphabetically. Each schema has a gray suffix `(Default schema)` / `(Default database)`. System schemas keep the gray suffix.
    - Checkbox states: checked, unchecked, mixed (dash).
  - **`add pattern` link:** opens an inline text field accepting `sch*`, `!temp*`, comma-separated. The pattern is stored in the existing schema-filter state.
  - **Schemas tab:** the same tree, plus bottom fields `Schema pattern:` (expand ↗; mirrors the checkbox state as text, e.g. `postgres:public,sales`) and `Object filter:` (an optional table-name glob per schema).
  - **Footer:** unchanged.
- Files: src/features/explorer/SchemaSelector.tsx, src/features/explorer/schemaFilter.ts, src/state/schema-filter.ts, src/features/datasource/SchemasTab.tsx and schemas.ts.

### EXP-11 PostgreSQL tree: no "Database Objects" / "Server Objects"; sequences lack type hint; schema order  — Impact: Medium  — Effort: M
- Area: explorer tree nodes
- DataGrip reference: 14-dbexplorer-tree-postgres-expanded-dark.png, 71-…where-orderby-applied-dark.png
- Ours now:
  - **Missing nodes:** under `postgres` there is no `Database Objects` (extensions, event triggers, foreign data wrappers…) and no `Server Objects` (roles, tablespaces, databases).
  - **Sequence hints:** sequences have no hint (DataGrip: `clients_id_seq integer`, `ticket_seq bigint`).
  - **Schema order:** schemas are ordered public-first (`order by (nspname = 'public') desc, nspname`, introspect.rs:233). DataGrip lists them alphabetically: inventory, public, sales.
  - **Data source order:** data sources are in creation order (`ux-sample.db` above `postgres@localhost`). DataGrip sorts them alphabetically.
- Should:
  - **Schema and data-source order:** alphabetical, case-insensitive.
  - **Sequence hint:** the data type, from `pg_sequence.seqtypid` via `format_type`.
  - **`Server Objects` node:** folder icon with a DB badge, sibling of the database node. It holds `roles N` (with role icons; hint `login` / `superuser`) and `tablespaces N`.
  - **`Database Objects` node:** under the database; holds `extensions N` (name + version hint).
  - **MySQL:** `Server Objects` > `users N`.
  - **Read-only nodes:** they need only Quick Doc and DDL (`create role …`).
- Files: crates/dbcore/src/introspect.rs (PG schema list, sequences query at :306-317, new folders), src/features/explorer/model.ts (folder labels, icons), src/features/explorer/icons.ts, src/features/explorer/core.ts (data-source sort).

### EXP-12 DDL view is read-only and schema-qualified  — Impact: Medium  — Effort: M
- Area: DDL view
- DataGrip reference: 73-ddl-view-dark.png, datagrip-map §7
- Ours now: `src/features/ddl/DdlView.tsx:64` mounts the editor `readOnly`. The generated text qualifies every name (`create table sales.invoices`, `references sales.clients`, `on sales.invoices`). DataGrip writes `create table invoices`, `references clients`, `on invoices (client_id)`. We also have no intention bulb or inspections inside it.
- Should:
  - **Unqualified names:** generate object names without the schema when the object is in the same schema as the DDL subject; qualify only cross-schema references.
  - **Editable DDL:** make the DDL editor editable with full SQL highlighting and completion. On edit, show the 28px editor banner `The DDL was modified.  Submit  |  Revert` (Submit: the ALTER script produced by the EXP-01 diff engine, previewed in the Modify dialog's Preview before it runs).
  - **Until EXP-01 exists:** keep it read-only but allow selection, Ctrl+C and Ctrl+F.
- Files: src/features/ddl/DdlView.tsx, crates/dbcore/src/ddl.rs (qualification).

### EXP-13 Explorer toolbar: "Compare" slot and tooltip text; New popup items  — Impact: Low  — Effort: S
- Area: explorer toolbar / New popup
- DataGrip reference: 19-crop-dbexplorer-header-toolbar-x2-dark.png, 10-dbexplorer-new-menu-dark.png
- Ours now:
  - **Toolbar:** `+ DS | ⟳ ■ | >_ ▦ DDL | 👁`. The 2nd button's tooltip says `Data Source Properties` (DataGrip: `Data Sources…  Ctrl+Alt+Shift+S`).
  - **`+` popup:** `Data Source ›`, sep, `Query Console`.
  - **View Options:** a single item `Show System Schemas`.
- Should:
  - **Tooltip:** the 2nd button's tooltip reads `Data Sources…  Ctrl+Alt+Shift+S`.
  - **`+` popup:**
    - `Data Source ›`
    - `Data Source from URL` (a dialog with one text field that parses `jdbc:`/`postgres://`/`mysql://`/file paths and opens the data source dialog prefilled)
    - `DDL Data Source` (skip if not planned)
    - `Import from Clipboard` (pastes a data source XML/JSON exported by `Copy/Paste › Copy`; optional)
    - sep
    - `Query Console Ctrl+Shift+Q`
    - `Driver` (opens the Drivers page)
  - **Compare button:** leave out; add it only together with Compare Schema Structure.
  - **View Options:** `Show System Schemas` ✓, sep, `Sort Alphabetically` ✓, `Group Data Sources` (only with folders, EXP-14), `Show Intermediate Nodes`.
- Files: src/features/explorer/ExplorerToolbar.tsx, src/features/explorer/actions.ts (`newMenuItems`).

### EXP-14 Data source folders (New › Folder, Move ›) are missing  — Impact: Low  — Effort: M
- Area: explorer tree organisation
- DataGrip reference: 10-dbexplorer-new-menu-dark.png (`Folder`), 16 (`Move ›`)
- Ours now: there is no folder concept (`folder` exists in types.ts only as a tree folder kind, not as a group of data sources).
- Should:
  - **`New › Folder`:** creates a named folder node (folder icon #548AF7) at the top level.
  - **`Move ›` on a data source:** lists `(root)`, the existing folders and `New Folder…`. Drag and drop of data source rows onto a folder also works.
  - **Storage:** folders persist in the data source config as `group`. The Data Sources dialog list shows the folders as groups, with headers like `Project Data Sources`.
- Files: src/api/types.ts (DataSource.group), src-tauri/src/store.rs, src/features/explorer/core.ts, actions.ts, src/features/datasource/DataSourceDialog.tsx.

### EXP-15 Options tab: missing Switch schema and Introspection options  — Impact: Low  — Effort: S
- Area: Data Sources dialog › Options
- DataGrip reference: 33-datasource-tab-options-dark.png
- Ours now: the Connection section lacks `Switch schema: Automatic ⌄`. The Startup script is a single-line field without expand ↗ / editor icons. Introspection has only `Show system schemas`. The row pitch is 34px; DataGrip's is about 40px (y 167, 196, 231, 270, 310, 351, 388).
- Should:
  - **Connection section:**
    - Add `Switch schema: Automatic ⌄ / Manual / Disabled`, which decides whether choosing a schema in the console widget runs `SET search_path` / `USE`.
    - Make the Startup script field 28px with expand ↗, opening a multi-line SQL editor popup.
  - **Introspection section:**
    - `Auto sync` ✓: re-introspect after DDL run in a console.
    - `Load sources for: All excl. system schemas ⌄ / All / None`: routine and view bodies.
    - `Show system schemas`, moved into this section.
    - `Track databases/schemas creation and deletion` ✓.
  - **Row pitch:** use DataGrip's vertical spacing (checkbox rows 29px, combo rows 35–40px).
- Files: src/features/datasource/OptionsTab.tsx, model.ts, datasource.css, crates/dbcore/src/manager.rs (switch-schema behaviour).

### EXP-16 Advanced tab shows one property; should list the driver's real options  — Impact: Low  — Effort: S
- Area: Data Sources dialog › Advanced
- DataGrip reference: 36-datasource-tab-advanced-dark.png
- Ours now: a single row, `connectTimeout`, plus an `Add property` link (app-screens/36).
- Should:
  - **Pre-populated table:** list the options our sqlx backend actually honours per driver. Set values are bold (as DataGrip does for `date_class TEXT`). A selected row shows its description under the table in the `Property description.` area.
    - **PG:** `application_name`, `connectTimeout`, `options`, `statement_timeout`, `sslmode`, `sslrootcert`.
    - **MySQL:** `charset`, `collation`, `timezone`, `connectTimeout`, `ssl-mode`.
    - **SQLite:** `busy_timeout`, `journal_mode`, `foreign_keys`, `synchronous`, `create`, `read_only`.
  - **JDBC-only parts:** VM options, VM environment and Working directory do not apply; leave them out.
- Files: src/features/datasource/AdvancedTab.tsx, drivers.ts (option catalogue), crates/dbcore/src/conn.rs (honour them).

### EXP-17 Drivers page is a read-only info page without list structure  — Impact: Low  — Effort: S
- Area: Data Sources dialog › Drivers
- DataGrip reference: 129-datasource-drivers-tab-dark.png, 129b-datasource-drivers-search-dark.png
- Ours now: 4 drivers in a flat list. The right pane has Name / Library / URL template / Default port / SSL modes as read-only fields. There is no group header, no speed search and no `Create Data Source` link (manifest 129 PARTIAL, 129b MISSING).
- Should:
  - **List:** a `Complete Support` gray group header above the 4 drivers. Typing filters the list with the speed-search field and orange match highlight, as in the explorer; Esc clears.
  - **Right pane:** keep the info and add an `Options` tab with the driver-level defaults that new data sources inherit (keep-alive, auto-disconnect, Tx mode).
  - **Footer:** a `Create Data Source` link at the bottom-left of the right pane (blue #548AF7) that switches to Data Sources with a new data source of that driver.
  - **List toolbar:** the Data Sources list toolbar gets the missing `⚙` (Go to driver) button after duplicate.
- Files: src/features/datasource/DriversPage.tsx, DataSourceDialog.tsx, datasource.css.

### EXP-18 SSH tunnel and SSL certificate files are disabled  — Impact: Low (Medium for remote users)  — Effort: L
- Area: Data Sources dialog › SSH/SSL
- DataGrip reference: 128-datasource-tab-ssh-ssl-dark.png, 34-datasource-tab-ssh-ssl-dark.png
- Ours now: `Use SSH tunnel`, the SSH configuration and Local port are always disabled with the hint "SSH tunnels are not supported yet". CA / client cert / client key are always disabled with "Certificate files are not supported yet" (SshSslTab.tsx:19-62). Only `sslmode` is wired (conn.rs:176/216). The `Use truststore` and `Client key password` rows are absent.
- Should:
  - **SSL:** wire CA file / Client certificate / Client key to sqlx (`PgConnectOptions::ssl_root_cert`, `ssl_client_cert`, `ssl_client_key`; MySQL `ssl_ca`, `ssl_client_cert`, `ssl_client_key`) and enable them when `Use SSL` is checked. Add `Client key password: <hidden>  Save: Forever ⌄` (PG only if supported, otherwise omit). The success popup then shows `SSL: yes`/`no`, as in DataGrip (38).
  - **SSH:** a local port forward (russh or ssh2 crate) with Host / Port / User / Auth type (Password / Key pair / OpenSSH agent) / Private key file / Passphrase, `Local port: <Dynamic>`, and a `Test Connection` that reports the tunnel step. Until it is implemented, keep the section disabled; that is acceptable and not a dead button.
- Files: src/features/datasource/SshSslTab.tsx, model.ts, crates/dbcore/src/conn.rs, src-tauri/src/state.rs.

### EXP-19 Test Connection result popup details  — Impact: Low  — Effort: S
- Area: Data Sources dialog footer / Test Connection
- DataGrip reference: 38-datasource-postgresql-test-succeeded-dark.png, 39-…test-failed-dark.png, 123b-connection-failed-result-popup-dark.png
- Ours now:
  - **Success:** the popup lacks the `SSL: no` line and the `✎` after the DBMS version.
  - **Failure:** the popup lacks the grayed DBMS / Case sensitivity / Driver lines from the last successful test.
  - **Anchoring:** the popup is anchored right of the link (x≈1046 in the dialog vs DataGrip's x≈33, left-aligned with the dialog body), about 610px wide vs DataGrip's 420 (success) / 820 (failure).
  - **While connecting:** no spinner after the `Test Connection` link.
- Should:
  - **Lines:** add `SSL: yes|no` after `Ping:`.
  - **Failure body:** show the last known DBMS lines in `--dg-text-muted` (#6F737A dark), then a blank line, then the message.
  - **Position:** the popup's left edge 20px from the dialog's left edge, its pointer above the link.
  - **While connecting:** a 16px spinner right of the link, and the link disabled.
  - **Footer version text:** keep it; it should read `PostgreSQL 16.15`, as ours already does.
- Files: src/features/datasource/TestBar.tsx, datasource.css.

### EXP-20 Explorer empty state lacks "All Data Sources ›" and the editor-area "New Data Source" button  — Impact: Low  — Effort: S
- Area: explorer empty state
- DataGrip reference: 00-welcome-empty-project-dark.png, datagrip-map §2 "Empty state"
- Ours now: `Create Data Source` with PostgreSQL / MySQL / SQLite buttons (ExplorerBody.tsx:163). The editor area shows only the shortcut hints (New Query Console / Go to Database Object / Search Everywhere).
- Should:
  - **Explorer button list:** PostgreSQL, MySQL, then `MariaDB`, SQLite, and a last button `All Data Sources ›` that opens the `Data Source ›` driver submenu anchored to it. Buttons are full-width, 34px tall, radius 6, bg #26282C, 16px icon, Inter 13.
  - **Editor area, while there are no data sources:** a centered `New Data Source` button (48px tall, radius 8, bg #26282C, DB icon), plus `Data Sources…` if wanted. Agent Session, Online Help, Plugins, YouTube are out of scope.
- Files: src/features/explorer/ExplorerBody.tsx, explorer.css, src/components/shell/Placeholders.tsx (editor empty state; coordinate with the shell auditor).

### EXP-21 Table data editor WHERE / ORDER BY bar: filter history and Ctrl+Alt+Shift+F  — Impact: Low  — Effort: S
- Area: table data editor filter bar
- DataGrip reference: 70/71/72 table data editor screenshots; evidence §5 `Console.TableResult.EditFilterCriteria` = Ctrl+Alt+Shift+F
- Ours now: the bar matches visually (app-screens/71: funnel/sort icons, monospace labels, SQL highlighting, × clear, Enter applies). In code, FilterBar.tsx has no history and no focus shortcut; Ctrl+Alt+Shift+F is not bound.
- Should:
  - **Ctrl+Alt+Shift+F:** in a table editor, focuses the WHERE field with its text selected.
  - **Funnel icon:** clicking it, or pressing Alt+Down in an empty field, opens a history popup with the last 20 distinct WHERE filters applied to this table (per table, persisted), newest first. Ditto the sort icon for ORDER BY.
  - **Completion:** besides the columns, also offer functions in WHERE completion (manifest 72 PARTIAL). That belongs to the shared completion and is noted for the editor auditor.
- Files: src/features/table/FilterBar.tsx, src/features/table/actions.ts, src/state/persist.ts.

---

## Not verified / notes
- Alt+Insert opening the New popup in the explorer comes from GAP-CAPTURES row 105 ("Alt+Insert (New popup…)"); it is not in evidence §5.
- The underlined mnemonics in menus (EXP-09): whether `Menu.tsx` already supports them for the main menu is shared with the shell auditor.
- The "Comment" suffix (EXP-06): DataGrip may have a View Options toggle for comments; the reference shows them off by default.
- The SQLite `tables 6` vs `5` difference (19b) comes from the sample DB (DataGrip probably counts `sqlite_sequence`); I did not verify it.
