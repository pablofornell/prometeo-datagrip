# src-tauri: command layer over `crates/dbcore`

`src/state.rs` holds `AppState` and all command logic (no Tauri types, testable without a
webview), `src/commands.rs` are thin `#[tauri::command]` adapters, `src/store.rs` the on-disk
stores. TypeScript side: `src/api/types.ts` (types), `src/api/db.ts` (one function per command),
`src/api/mock.ts` (browser mock, used automatically when not running inside Tauri).

All commands are `async`, return `Result<T, String>` (the string is the real server / OS
message) and use camelCase JSON; argument names are camelCase in JS (`ds_id` -> `dsId`).

| Rust command | TS function | Notes |
|---|---|---|
| `app_info` | `appInfo()` | name, version, `configDir`, `dataDir`, `passwordStorage` |
| `list_data_sources` | `listDataSources()` | no passwords; `hasPassword`, `passwordStorage: "keyring"\|"file"` |
| `save_data_source(ds)` | `saveDataSource(ds)` | empty id = new; `password` null keeps / `""` clears / text replaces; disconnects if connection settings changed |
| `delete_data_source(id)` | `deleteDataSource(id)` | also removes keyring entry and consoles |
| `duplicate_data_source(id)` | `duplicateDataSource(id)` | name `"<name> 1"` |
| `test_connection(ds)` | `testConnection(ds)` | unsaved config OK; null password = stored one |
| `connect(id)` / `disconnect(id)` | `connect` / `disconnect` | `connected_data_sources` -> `connectedDataSources()` |
| `open_session(dsId)` / `close_session(sessionId)` | `openSession` / `closeSession` | `session_in_transaction` -> `sessionInTransaction` |
| `introspect(dsId, path, showSystem)` | `introspect(dsId, path, showSystem?)` | paths: see `crates/dbcore/src/introspect.rs` |
| `get_ddl(dsId, object)` | `getDdl` | `object: ObjectRef` |
| `schema_snapshot(dsId, schema?)` | `schemaSnapshot` | completion data |
| `execute(sessionId, sql, options?, onEvent: Channel)` | `execute(sessionId, sql, handlers, options)` | see below |
| `fetch_more(executionId, resultIndex, count)` | `fetchMore` | next rows of the open result |
| `cancel(executionId)` / `close_execution(executionId)` | `cancelExecution` / `closeExecution` | cancel of a finished execution is a no-op |
| `table_data(dsId, table, request?)` | `tableData` | `request`: whereClause, orderBy, offset, limit, countTotal |
| `apply_changes(dsId, table, changes)` | `applyChanges` | `Ok` even when rolled back: check `committed` / `results[i].error` |
| `export_query(dsId, sql, options, path)` | `exportQuery` | streams ALL rows to a file; returns row count |
| `export_query_to_string(dsId, sql, options)` | `exportQueryToString` | |
| `export_result(result, options, path)` | `exportResult` | in-memory result set to a file |
| `export_to_string(result, options)` | `exportToString` | clipboard |
| `split_statements(sql, driver)` / `statement_at(sql, caretUtf16, driver)` | `splitStatements` / `statementAt` | same splitter as the backend, UTF-16 offsets |
| `history_list(dsId?, offset?, limit?)` / `history_search(text, dsId?, limit?)` / `history_clear` | `historyList` / `historySearch` / `historyClear` | entries are added by `execute` |
| `get_ui_state(key)` / `set_ui_state(key, value)` / `flush_ui_state` | `getUiState` / `setUiState` / `flushUiState` | debounced 400 ms, flushed on exit |
| `list_consoles` / `read_console` / `write_console` / `create_console` / `delete_console` / `rename_console` | `listConsoles` ... | `create_console` -> `console`, `console_1`, ... |

## Execution events

`execute` returns the execution id immediately. Events are pushed through a
`tauri::ipc::Channel<ExecEvent>` (ordered, no global events): `statement`, `resultset`,
`update`, `error`, `message`, `done` (always last). The frontend helper `execute()` creates
the channel, dispatches to `onStatement/onResultSet/...` callbacks and returns
`{ executionId, cancel(), close(), fetchMore(resultIndex, count), done }`. A history entry
is written when `done` passes through. The execution stays registered (for `fetchMore`)
until dbcore's execution task ends.

## Persistence

* `<app_config_dir>/data-sources.json` (Linux: `~/.config/dev.prometeo.datagrip/`)
* `<app_config_dir>/ui-state.json`
* `<app_data_dir>/consoles/<dsId>/<name>.sql`, `<app_data_dir>/history.jsonl`
  (Linux: `~/.local/share/dev.prometeo.datagrip/`)
* Passwords: OS keyring (service `dev.prometeo.datagrip`, user `data-source:<id>`); if the
  keyring is unreachable they are stored in `data-sources.json` and flagged `"file"`.
* Env overrides: `PROMETEO_CONFIG_DIR`, `PROMETEO_DATA_DIR`, `PROMETEO_NO_KEYRING=1`.

## Tests

```sh
PROMETEO_PG_URL=postgres://postgres:prometeo@127.0.0.1:54329/postgres \
  cargo test -p prometeo-datagrip -- --nocapture     # BENCH lines = timings
```
