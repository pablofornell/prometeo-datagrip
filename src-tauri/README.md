# src-tauri: command layer over `crates/dbcore`

`src/state.rs` holds `AppState` and all command logic (no Tauri types, testable without a
webview), `src/commands.rs` are thin `#[tauri::command]` adapters, `src/store.rs` the on-disk
stores. TypeScript side: `src/api/types.ts` (types), `src/api/db.ts` (one function per command),
`src/api/mock.ts` (browser mock, used automatically when not running inside Tauri).

All commands are `async`, return `Result<T, String>` (the string is the real server / OS
message) and use camelCase JSON; argument names are camelCase in JS (`ds_id` -> `dsId`).

| Rust command | TS function | Notes |
|---|---|---|
| `app_info` | `appInfo()` | name, version, `configDir`, `dataDir`, `passwordStorage`, `startupWarnings` (corrupt config files that were set aside) |
| `list_data_sources` | `listDataSources()` | no passwords; `hasPassword`, `passwordStorage: "keyring"\|"file"` |
| `save_data_source(ds)` | `saveDataSource(ds)` | empty id = new; `password` null keeps / `""` clears / text replaces; disconnects if connection settings changed |
| `delete_data_source(id)` | `deleteDataSource(id)` | also removes keyring entry and consoles |
| `duplicate_data_source(id)` | `duplicateDataSource(id)` | name `"<name> 1"` |
| `test_connection(ds)` | `testConnection(ds)` | unsaved config OK; null password = stored one |
| `connect(id)` / `disconnect(id)` | `connect` / `disconnect` | `connected_data_sources` -> `connectedDataSources()` |
| `open_session(dsId, initSql?)` / `close_session(sessionId)` | `openSession(dsId, initSql?)` / `closeSession` | `initSql: string[]` runs on the new connection first (re-apply `SET search_path` / `USE` / isolation of a reopened console); `session_in_transaction` -> `sessionInTransaction` (open = active or failed); `session_tx_status` -> `sessionTxStatus` (`idle`/`active`/`failed`; `idle` when the connection died); `session_state` -> `sessionState` (`{ txStatus, inTransaction, connectionLost, transactionLost }`, consistent with the two previous ones). `close_session` of a dead session succeeds. See "Lost connection" below |
| `introspect(dsId, path, showSystem)` | `introspect(dsId, path, showSystem?)` | paths: see `crates/dbcore/src/introspect.rs` |
| `get_ddl(dsId, object)` | `getDdl` | `object: ObjectRef` |
| `schema_snapshot(dsId, schema?)` | `schemaSnapshot` | completion data |
| `execute(sessionId, sql, options?, onEvent: Channel)` | `execute(sessionId, sql, handlers, options)` | see below |
| `fetch_more(executionId, resultIndex, count)` | `fetchMore` | next rows of the open result |
| `cancel(executionId)` / `close_execution(executionId)` | `cancelExecution` / `closeExecution` | cancel of a finished execution is a no-op |
| `table_data(dsId, table, request?)` | `tableData` | `request`: whereClause, orderBy, offset, limit, countTotal |
| `apply_changes(dsId, table, changes)` | `applyChanges` | `Ok` even when rolled back: check `committed` / `results[i].error` |
| `choose_export_path(suggestedName?, format?)` | `chooseExportPath` | opens the Save dialog from the backend; returns the path or `null`. Only these paths are accepted by `export_query` / `export_result` (once, 5 min) |
| `export_query(dsId, sql, options, path)` | `exportQuery` / `exportQueryToFile` | streams ALL rows to a dialog-chosen file; returns row count |
| `export_query_to_string(dsId, sql, options)` | `exportQueryToString` | |
| `export_result(result, options, path)` | `exportResult` / `exportResultToFile` | in-memory result set to a dialog-chosen file |
| `export_to_string(result, options)` | `exportToString` | clipboard |
| `split_statements(sql, driver)` / `statement_at(sql, caretUtf16, driver)` | `splitStatements` / `statementAt` | same splitter as the backend, UTF-16 offsets |
| `history_list(dsId?, offset?, limit?)` / `history_search(text, dsId?, limit?)` / `history_clear` | `historyList` / `historySearch` / `historyClear` | entries are added by `execute` |
| `get_ui_state(key)` / `set_ui_state(key, value)` / `flush_ui_state` | `getUiState` / `setUiState` / `flushUiState` | debounced 400 ms, flushed on exit |
| `list_consoles` / `read_console` / `write_console` / `create_console` / `delete_console` / `rename_console` | `listConsoles` ... | `create_console` -> `console`, `console_1`, ... |

## Execution events

`execute` returns the execution id immediately. Events are pushed through a
`tauri::ipc::Channel<ExecEvent>` (ordered, no global events): `statement`, `resultset`,
`update`, `error` (with `connectionLost`), `message`, `txStatus`, `txEnded`, `done` (always last; `txStatus`/`txEnded` can follow it after a user cancel inside a PostgreSQL transaction or a lost connection found while paging). The frontend helper `execute()` creates
the channel, dispatches to `onStatement/onResultSet/...` callbacks and returns
`{ executionId, cancel(), close(), fetchMore(resultIndex, count), done }`. A history entry
is written when `done` passes through. The execution stays registered (for `fetchMore`)
until dbcore's execution task ends.

## Lost connection

If a statement fails because the connection is gone (socket closed / reset, `pg_terminate_backend`, `KILL <id>`,
server shutdown), the `error` event has `connectionLost: true` and a message starting with `[08006] ` (PostgreSQL,
SQLite) or `[08S01] ` (MySQL), e.g. `[08006] An I/O error occurred while sending to the backend.`; every other error has
`connectionLost: false`. The script stops. The session is then dead: `sessionTxStatus` is `idle`, and when a
transaction was open `txEnded { committed: false, tag: "CONNECTION LOST" }` and `txStatus { idle }` follow the error
(they also arrive, outside `done`, when the loss is found by `fetchMore`, which then fails with the same message).
`sessionState` returns `{ txStatus, inTransaction, connectionLost, transactionLost }`. Later `execute` /
`tableDataInSession` / `applyChangesInSession` calls on the dead session fail at once with the same error (`COMMIT` and
`ROLLBACK` too) - except when no transaction was open: then the next `execute` opens a new connection first (a
`message` event says settings like `search_path` / `USE db` were reset). With `transactionLost` the UI decides:
`closeSession` (always succeeds) and `openSession` a new one.

## Persistence

* `<app_config_dir>/data-sources.json` (Linux: `~/.config/dev.prometeo.datagrip/`)
* `<app_config_dir>/ui-state.json`
* `<app_data_dir>/consoles/<dsId>/<name>.sql`, `<app_data_dir>/history.jsonl`
  (Linux: `~/.local/share/dev.prometeo.datagrip/`)
* Passwords: OS keyring (service `dev.prometeo.datagrip`, user `data-source:<id>`); if the
  keyring is unreachable they are stored in `data-sources.json` and flagged `"file"`.
* `data-sources.json` and `ui-state.json` are written with mode `0600` (the first can hold the plain-text
  password fallback). A password typed into a connection URL (`user:pass@`, `?password=`) is moved to the
  keyring on save and the stored / returned URL never has it; error messages and the test-connection message
  are scrubbed of it.
* A corrupt `data-sources.json` / `ui-state.json` does not stop the app: it is renamed to
  `<file>.corrupt-<unix seconds>`, the app starts with an empty one and `app_info().startupWarnings` lists it.
* Env overrides: `PROMETEO_CONFIG_DIR`, `PROMETEO_DATA_DIR`, `PROMETEO_NO_KEYRING=1`.

## Tests

```sh
PROMETEO_PG_URL=postgres://postgres:prometeo@127.0.0.1:54329/postgres \
  cargo test -p prometeo-datagrip -- --nocapture     # BENCH lines = timings
```
