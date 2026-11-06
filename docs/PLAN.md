# Prometeo DataGrip — Plan and architecture contract

Goal: a desktop database client that replicates JetBrains DataGrip (New UI, Dark theme
by default, Light theme also), built with Rust + Tauri 2. It must be fast and use little memory.

## Stack (fixed — do not change without coordinator approval)
- Shell: Tauri 2 (`src-tauri/`), Rust stable 1.99.
- Frontend: SolidJS + TypeScript + Vite (`src/`). No UI component library. Plain CSS with
  CSS variables (theme tokens in `src/theme/`).
- SQL editor: CodeMirror 6 (`@codemirror/lang-sql`), styled to match the IntelliJ editor.
- Data grid: own virtualized grid (DOM, row/column virtualization). Must handle 100k+ rows.
- DB core: Rust library crate `crates/dbcore` (no Tauri dependency). Drivers through
  `sqlx` 0.8 (PostgreSQL, MySQL/MariaDB, SQLite). Async with tokio.
- Cargo workspace at repo root: `members = ["src-tauri", "crates/*"]`.

## Repository layout
```
Cargo.toml            workspace
crates/dbcore/        connections, introspection, query execution, editing, DDL, export
src-tauri/            Tauri app: commands wrap dbcore; app state; persistence
src/                  SolidJS UI
  theme/              tokens (dark.css, light.css), fonts
  assets/icons/       SVG icons copied from intellij-community (Apache-2.0, see NOTICE)
  components/         shell, toolwindows, tree, editor, grid, dialogs
docs/ux/              DataGrip UX map, screenshots, theme tokens
```

## Feature scope (v1)
1. Main window shell: New UI main toolbar, left tool-window stripe, Database Explorer,
   editor tabs, bottom Services/results panel, status bar. Resizable splitters.
2. Data Sources and Drivers dialog: create/edit/delete/test connection (PG, MySQL, SQLite).
3. Database Explorer tree: data source > database > schema > tables/views/routines/sequences
   > columns/keys/indexes/foreign keys. Lazy load, refresh, speed search, context menu.
4. Query console: SQL editor with highlighting, completion of schema objects, execute
   statement at caret (Ctrl+Enter), execute all, cancel, multiple result tabs, output log.
5. Results/Table data grid: virtualized, column resize, sort, filter (WHERE), paging,
   cell editing + insert/delete rows + submit (Ctrl+Enter) / revert, copy as TSV/CSV,
   value editor, NULL rendering, row numbers.
6. Open table data (double click table), DDL view, Go to object (Ctrl+N style popup).
7. Export results (CSV, JSON, SQL INSERT). Query history.
8. Persist: data sources (passwords in OS keyring if available, else app config),
   open consoles, layout sizes.

## Tauri command API (contract between src-tauri and src)
All commands are async, return `Result<T, String>` and use camelCase JSON.
- `list_data_sources() -> DataSource[]`, `save_data_source(ds)`, `delete_data_source(id)`
- `test_connection(ds) -> { ok, serverVersion, message, elapsedMs }`
- `connect(id)`, `disconnect(id)`
- `introspect(id, path: string[]) -> TreeNode[]` (lazy children for a tree path)
- `get_ddl(id, objectRef) -> string`
- `execute(id, sessionId, sql, options{ maxRows }) -> ExecutionId`; results stream by events
  `exec://<executionId>` with payloads `{kind: "resultset"|"update"|"error"|"done", ...}`
- `fetch_more(executionId, resultIndex, count)`, `cancel(executionId)`
- `table_data(id, tableRef, {where, orderBy, offset, limit})`
- `apply_changes(id, tableRef, changes[]) -> { applied }`
- `export_result(...)`, `query_history(...)`

## Out of scope (user decision, 2026-11-06)
We clone only the operative part of DataGrip: working with databases.
Do NOT build: JetBrains account/login, licensing/trial/activation, the update system
(Toolbox, "update available" balloons, patch download), plugin marketplace, AI Assistant,
telemetry/data sharing consent, "What's New"/tips of the day/onboarding tours,
Code With Me, settings sync, JetBrains branding. Remove these items from the UI too
(no dead buttons for them). If a DataGrip screen mixes them with operative parts, copy only
the operative parts.
