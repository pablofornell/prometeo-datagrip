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
mgr.introspect(id, &path).await                    // -> Vec<TreeNode>, lazy; introspect_with(.., &IntrospectOptions{show_system})
mgr.schema_snapshot(id, schema).await              // flat tables/views + columns for completion
mgr.ddl(id, &ObjectRef).await                      // -> String
let h = mgr.execute(&s, sql, ExecOptions{max_rows, stop_on_error}).await?; // h.id, h.events (mpsc of ExecEvent)
mgr.fetch_more(&h.id, result_index, count).await   // rows from the still-open stream
mgr.cancel(&h.id)                                  // pg_cancel_backend / KILL QUERY / sqlite3_interrupt
mgr.table_data(id, &ObjectRef, &TableDataRequest).await   // -> ResultSet (+ total_hint)
mgr.apply_changes(id, &ObjectRef, &[RowChange]).await     // one transaction -> ApplyResult
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
