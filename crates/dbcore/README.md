# dbcore

Database core of Prometeo DataGrip: connections, introspection, query execution with
paging/cancellation, table editing, DDL, export and query history. No Tauri dependency;
the Tauri layer wraps `ConnectionManager` (cheap to `clone`, `Send + Sync`, every public
async method returns a `Send` future - checked at compile time by `tests/send.rs`).

Drivers: `sqlx` 0.8 (PostgreSQL, MySQL/MariaDB, SQLite), concrete pools per driver
(`Pool::{Pg, My, Lite}`), tokio + rustls.

## API overview

```rust
let mgr = ConnectionManager::new();
mgr.test_connection(&cfg).await                    // -> TestResult { ok, server_version, message, elapsed_ms }
mgr.connect(&cfg).await / mgr.disconnect(id).await // pool per data source id
let s = mgr.open_session(id).await?;               // dedicated connection (console): tx state, SET/USE persist
mgr.open_session_with(id, &init_sql).await?        // same, after running init_sql (re-apply search_path / USE / isolation)
mgr.session_tx_status(&s)?                         // Idle | Active | Failed; session_in_transaction() = Active or Failed
mgr.session_state(&s)?                             // SessionState { tx_status, in_transaction, connection_lost, transaction_lost }
mgr.introspect(id, &path).await                    // -> Vec<TreeNode>, lazy; introspect_with(.., &IntrospectOptions{show_system})
mgr.schema_snapshot(id, schema).await              // flat tables/views + columns for completion
mgr.ddl(id, &ObjectRef).await                      // -> String
let h = mgr.execute(&s, sql, ExecOptions{max_rows, stop_on_error}).await?; // h.id, h.events (mpsc of ExecEvent)
mgr.fetch_more(&h.id, result_index, count).await   // rows from the still-open stream
mgr.cancel(&h.id)                                  // pg_cancel_backend / KILL QUERY / sqlite3_interrupt
mgr.table_data(id, &ObjectRef, &TableDataRequest).await   // -> ResultSet (+ total_hint)
mgr.apply_changes(id, &ObjectRef, &[RowChange]).await     // one transaction -> ApplyResult
mgr.table_data_in_session(&s, &ObjectRef, &req).await     // same, on the session connection (sees its open transaction)
mgr.apply_changes_in_session(&s, &ObjectRef, &[RowChange]).await // same, inside the session's transaction (savepoint)
mgr.export_query(id, sql, &ExportOptions, writer).await   // stream every row; export_result()/export_to_string() for a ResultSet
split_statements(sql, driver) / statement_at(sql, caret_byte, driver) / statement_at_utf16(..)
QueryHistory::new(path).append/list/search/clear   // JSON lines
```

JSON shapes are in `src/model.rs` (camelCase). Cell values: SQL NULL = `null`; ints beyond
2^53 and all `numeric/decimal/money` are strings; binary = `{"$bin": hex preview, "len": n}`;
PG arrays are JSON arrays (SQL INSERT export writes them back as `'{1,2}'` array literals); json/dates/times/intervals/enums/uuid are the server's text.

### Editing tables without a primary key

`table_data` returns `ResultSet.row_locators` (parallel to `rows`, never a column) for tables
that have no PK: PostgreSQL `"<tableoid>:(<block>,<offset>)"` (`tableoid` keeps inherited /
partitioned tables unambiguous), SQLite the integer `rowid` (WITHOUT ROWID tables always have
a PK; a column called `rowid` makes it use `_rowid_` / `oid`). The UI keeps the locator of
each row and sends it back as `RowChange.row_locator` for update / delete; `key` is then
ignored. Locators are only valid until the row is rewritten, so reload after `apply_changes`.
MySQL has no locator: the change matches all column values and ends with `LIMIT 1`; `JSON`
columns are compared as `CAST(col AS CHAR)`, `DECIMAL` via `CAST(? AS DECIMAL(65,30))`, text
columns with `COLLATE utf8mb4_bin` (default collations ignore case), `FLOAT` / `DOUBLE` with a
relative tolerance (1e-5 / 1e-12) because the displayed text is not the stored binary value,
and a truncated binary preview is left out of the key. Without a locator PG / SQLite use
`ctid = (select ctid .. where <key> limit 1)` / `rowid = (select rowid ..)`, so a change never
touches more than one row. Every update / delete must affect **exactly one** row: 0 gives
`No row matched ...`, more gives `Unexpected update count: n`, and the whole batch rolls back.

### Editing on a session (manual transaction mode)

`apply_changes_in_session` / `table_data_in_session` run on the **session's** connection (Tauri commands of the
same names). Inside an open transaction (`session_in_transaction`, i.e. after `BEGIN` / `START TRANSACTION` was
executed on the session) the batch runs in a `SAVEPOINT`: success releases it and the changes stay uncommitted
until the caller runs `COMMIT` / `ROLLBACK`; a failing change rolls back to the savepoint, so the transaction
survives (also on PostgreSQL, where an error would otherwise abort it) and `committed == false`. Outside a
transaction the batch gets a transaction of its own, like `apply_changes`. `committed == true` therefore means
"applied". The same exactly-one-row rule applies. An open paging result of the session is released first (inside
a transaction its remaining rows are drained, like a new `execute`); `Busy` while a statement runs. Row
locators (`ctid`, `rowid`) come only from `table_data`, never from an ad-hoc query, so editing a console result
uses the table's PK / unique key.

PG values are cast to the column's base type **without** length / precision
(`format_type(oid, NULL)`, domains resolved, `character` -> `bpchar`, `bit` -> `bit varying`),
so the assignment performs the length check: `varchar(5)` + 10 characters fails with
`[22001] value too long ...` instead of being truncated.

`table_data` rejects a `where` / `order by` fragment with a statement separator (`;` outside
quotes and comments). MySQL `TINYINT(1)` / `BOOLEAN` cells are integers (0 / 1 / 5; sqlx
cannot tell them from `BOOL`), `BIT(n)` is a number. SQLite `:memory:` data sources use a
named shared-cache database (`file:prometeo-<id>-<uuid>?mode=memory&cache=shared`) kept alive
by one connection until `disconnect`, so the pool and every console see the same database.

Tree paths and folder keys are documented at the top of `src/introspect.rs`.

### Execution, paging, cancellation

See the module docs in `src/exec.rs`. In short: statements run one by one on the session
connection (PG/MySQL use the text protocol, so every type decodes from the server's own
text rendering). The first `max_rows` rows are sent in the `resultset` event; for the **last**
statement of a script the row stream stays open in the execution task and `fetch_more`
pulls the next rows from it (no `LIMIT/OFFSET` re-runs). Earlier statements of a script
are truncated to `max_rows` (with a `message` event).

**An open result is not kept forever.** It is closed when (a) a new `execute` starts on the
same session (the previous result is closed first), (b) `close_execution` / `cancel` /
`close_session` is called, or (c) no `fetch_more` arrives for `ExecOptions.keep_open_secs`
seconds (default **120**, `0` = never; a `message` event says so). Closing cancels the server
query (`pg_cancel_backend` / `KILL QUERY` / interrupt), which releases its locks; inside an
explicit transaction the remaining rows are drained instead so the transaction survives.
Afterwards `fetch_more` fails with `result set is closed`; `close_execution` / `cancel` on a
closed execution are no-ops. `Done` is sent only after the session is idle again, so an
`execute` issued as a reaction to `Done` is never rejected with `Busy`.
A call that returns several result sets (`select 1; select 1, 2`, MySQL `CALL`) never panics:
the grid shows the first result set of each statement, `export_query` exports the rows of the
first column set (equally shaped result sets are appended, others skipped).

### Transaction state and events

`ExecEvent` carries the transaction state of the session, which follows what the **server** does with the
transaction, not just the keywords typed (see `src/tx.rs`): `TxStatus { status: idle | active | failed }` after the
statement that changed it, and `TxEnded { index, committed, tag }` when a transaction ended (`tag`: `COMMIT`,
`ROLLBACK`, `IMPLICIT COMMIT`, `PREPARE TRANSACTION`, `CONNECTION LOST`).

* **MySQL**: no probe statement is ever sent (a probe changes `show warnings`, `row_count()`, `found_rows()` and, with
  `autocommit = 0`, opens a transaction itself). The state is derived from the statements: `@@autocommit` is read once
  when the session opens; `SET [SESSION] autocommit = 0|1|ON|OFF` / `SET @@autocommit` is followed; with
  `autocommit = 0` every statement except `SET`, `USE`, `SHOW WARNINGS|ERRORS`, `SELECT` without `FROM`, `PREPARE`, `KILL`
  and the like opens a transaction; `BEGIN` / `START TRANSACTION` / `XA START` commit what is open and start one;
  `COMMIT` / `ROLLBACK` / `XA COMMIT|ROLLBACK` end it (`AND CHAIN` starts the next); the statements of the MySQL
  manual 15.3.3 "Statements That Cause an Implicit Commit" (DDL, `GRANT`/`REVOKE`/`SET PASSWORD`, `LOCK TABLES`,
  `UNLOCK TABLES` after a lock, `ANALYZE|CHECK|OPTIMIZE|REPAIR TABLE`, `FLUSH`, `RESET`, replication control, ...;
  not `CREATE|DROP TEMPORARY TABLE`) end it with `TxEnded { committed: true, tag: "IMPLICIT COMMIT" }` (also when they
  fail, except with a syntax error: they commit before they run); `SET autocommit = 1` commits only when it was 0;
  a deadlock (1213) rolls it back. A `KILL QUERY` (cancel) rolls back the statement only: the transaction stays
  `active`. Not seen: commits inside stored routines (`CALL p()`) and `SET autocommit = <expression>`.
* **PostgreSQL**: tracked (sqlx hides the `ReadyForQuery` status) from `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT`
  plus errors and corrected by SQLSTATE `25P02` / `25P01`; verified against a real server for `COMMIT|ROLLBACK
  AND CHAIN`, `END`, `ABORT`, `PREPARE TRANSACTION` (a failing one rolls back), `COMMIT|ROLLBACK PREPARED`, failing
  deferred constraints and savepoint errors (`tests/tx_pg.rs`, with a test-only `SAVEPOINT` probe as ground truth).
  `COMMIT` of a failed transaction succeeds without an error but the server rolls back (tag `ROLLBACK`): reported as
  `TxEnded { committed: false, tag: "ROLLBACK" }` plus a `message`. A **user cancel** inside a transaction cancels the
  query and PostgreSQL aborts the transaction: the session becomes `failed` (event `TxStatus`) and a later `COMMIT`
  reports `committed: false`. Transaction control inside `DO` blocks / procedures is not seen.
* **SQLite**: `sqlite3_get_autocommit` (exact).

`apply_changes_in_session` refuses to edit in a `failed` transaction.

### Lost connections

When a statement or command fails because the connection is gone (sqlx I/O / TLS errors, a closed pool, a crashed
worker, a protocol error from a closed socket; PostgreSQL `08xxx` and `57P01` / `57P02` / `57P03`; MySQL 2006 / 2013 /
1927 / 1053), the error is a `DbError::ConnectionLost` and:

1. its message starts with the SQLSTATE in brackets: `[08006] ` (PostgreSQL, SQLite) or `[08S01] ` (MySQL), e.g.
   `[08006] An I/O error occurred while sending to the backend.` (+ a `Cause:` line), `[08006] FATAL: terminating
   connection due to administrator command`, `[08S01] Communications link failure: the connection to the server was lost.`;
2. the `Error` event has `connection_lost: true` (JSON `connectionLost`; `false` for every other error) and the script stops;
3. the session is **dead**: its transaction status becomes `Idle`, `TxEnded { committed: false, tag: "CONNECTION LOST" }`
   and `TxStatus { idle }` follow the error when a transaction was open (also for a failure found by `fetch_more`,
   `table_data_in_session`, `apply_changes_in_session`), and `session_state` says `connection_lost` (and
   `transaction_lost` when a transaction was open);
4. later calls on the session return the same `[08006]` / `[08S01]` error at once instead of hanging (`execute`: an
   `Error` event with `connection_lost: true`; `COMMIT` / `ROLLBACK` included; table calls: `Err`);
5. `close_session` on a dead session succeeds; `session_tx_status` / `session_in_transaction` are `Idle` / `false`;
6. if **no** transaction was open when the connection died, the next `execute` (or table call) on that session id
   reopens a connection transparently (a `message` event says that session settings - `SET`, `USE`, `search_path` -
   were reset); if one was open, the session keeps returning the error and the UI decides (`close_session`, then
   `open_session`).

Tests: `tests/tx_pg.rs` (`pg_terminate_backend` of the session pid from a second session) and `tests/tx_mysql.rs`
(`KILL <connection id>`).

`Error` events carry `position` (1-based, Unicode code points, as PostgreSQL reports it) and `position_utf16`
(1-based UTF-16 code units, for the editor), the latter computed against the statement text that was sent.

dbcore keeps no session settings: pass `init_sql` to `open_session_with` to re-apply `SET search_path`, `USE db`,
the isolation level, ... on a reopened session. A failing statement closes the connection and returns its error.

## Tests

Unit tests and SQLite integration tests always run:

```sh
cargo test -p dbcore
```

PostgreSQL / MySQL integration tests are gated on environment variables and are silently
skipped (they pass trivially) when the variable is not set. They load the fixtures in
`tests/fixtures/` (`pg_seed.sql`: schema `shop`, `mysql_seed.sql`: database `demo`; each
with a 100k-row `big_table` and an `all_types` table) on first use, and skip loading when
`big_table` already has 100000 rows. To force a reload drop `shop` (PG) / `big_table` (MySQL).

```sh
docker run -d --name prometeo-pg -e POSTGRES_PASSWORD=prometeo -p 54329:5432 postgres:16
docker run -d --name prometeo-mysql -e MYSQL_ROOT_PASSWORD=prometeo -e MYSQL_DATABASE=demo -p 33069:3306 mysql:8

export PROMETEO_PG_URL=postgres://postgres:prometeo@localhost:54329/postgres
export PROMETEO_MYSQL_URL=mysql://root:prometeo@localhost:33069/demo
cargo test -p dbcore -- --nocapture      # --nocapture prints the timing numbers
```

Timing output lines start with `BENCH` (first 500 rows of the 100k table).
