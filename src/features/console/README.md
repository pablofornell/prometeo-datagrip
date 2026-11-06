# Query console + Database Output (`src/features/console`, `src/features/output`)

* `console/`: slot `editor.view.console` (`ConsoleView.tsx`: toolbar + `SqlEditor` bound to the console file, debounced
  autosave), `session.ts` (`ConsoleSession`: one DB session per console, execution, Tx mode, schema switcher),
  `history.tsx` (Ctrl+Alt+E), `actions.ts` (`sql.execute`, `sql.executeScript`, `sql.cancel`, `sql.commit`,
  `sql.rollback`, `sql.history`), `title.ts` (result tab names).
* `output/`: slots `output.header|headerActions|toolbar|body`; `model.ts` holds one `ConsoleOutput` (log + result tabs)
  per console tab; `format.ts` is the DataGrip log wording (unit tested).
* Statements the console sends itself (BEGIN, COMMIT, `SET search_path`, `select current_schema()`) end with
  `/*prometeo:internal*/` so the history popup hides them.
* Uses `ensureConnected` from the explorer module (`../explorer`).

## Editable results, Tx Manual (console + output + table editor)

* A result is **editable** when the statement is a plain single-table `SELECT` (`editable.ts`: no join, group by,
  distinct, set operation; for MySQL / SQLite no function call in the select list) and the table's metadata
  (`introspect` columns + keys) shows a primary key, or else a unique key, fully contained in the result. PG
  `ColumnMeta.tableRef` and the statement parse must agree (a view reports its base table, so it stays read-only).
  Otherwise the edit group of the toolbar stays grayed, as in DataGrip.
* **We never add `ctid` / `rowid` to the user's SQL** (DataGrip does not rewrite statements either): row locators
  exist only in `table_data`, so a result of a table without PK / unique key is read-only. The table editor edits
  those tables.
* Submit: Tx Auto uses `applyChanges` (own transaction); Tx Manual uses `apply_changes_in_session` on the console's
  session, in a savepoint of the open transaction, so Commit / Roll Back of the console decide. The result is
  executed again afterwards (it shows the session's own uncommitted changes).
* The table editor has its own session in Tx Manual (`table/session.ts`): reads (`table_data_in_session`) and edits
  go through it; Commit / Roll Back strip under the toolbar; closing the tab with an open transaction asks.

## Transactions, lost sessions, data safety

* The transaction state is the **server's**: `txStatus` events of `execute`, `sessionTxStatus`, `txEnded` (never keyword
  tracking). `idle` / `active` / `failed` show in the console toolbar (`Tx: Manual (failed)`), the status bar and the
  table editor. A `COMMIT` that ends with `committed: false` (PG rolled a failed transaction back) logs a red line, raises an
  error balloon and reloads the edited result / table page.
* A result column is editable (or part of the key) only when it is a plain reference to that table column
  (`editable.ts: selectItems / plainSources`): `select customer_id as id` and `id + 1 as id` are read-only.
* A lost connection (`isConnectionLost` in `state/connection-errors.ts`: the `error` event's `connectionLost`, a `[08006]` /
  `[08S01]` message prefix, or the old `Session '..' does not exist`) drops the session, resets the tx state, logs
  `The connection was lost. The transaction was rolled back.` plus a balloon, and the next run reopens it with `initSql`
  (the user's `SET search_path` text as written, else the saved schema / `USE`, + non-default isolation level).
* After `SET search_path` / `SET SCHEMA` the real schema is read with `select current_schema()` (`"$user", public` is not a
  schema called `$user`), never while a result is paging: `schemaReadable()` / `settleSchema()` defer it.
* Nothing runs on the session while a paged result is open, except what the user asks for; when `fetch_more` fails the
  result shows a banner and an Output line that the rows shown are NOT the whole result.
* `txguard.ts`: `confirmEndTransactions({ dsId?, tabId?, reason })` asks Commit / Roll Back / Cancel for the consoles and table
  editors in scope. Used by the console tab's `beforeClose`, the table tab close, Tx: Auto switch and the app quit; the
  explorer (deactivate) and the data source dialog (settings changed) call it too. A transaction that cannot be ended is
  never a dead end: a lost connection counts as ended (rolled back, the user is told); a failed COMMIT offers Roll Back /
  Close Anyway / Cancel. `quit.ts`: a second quit request while the prompt is open quits.
* The schema filter of the explorer is UI state (`state/schema-filter.ts`), not `options.visibleSchemas`: options are part of
  the backend's connection fingerprint, so saving them reconnects and drops every session and open transaction.
