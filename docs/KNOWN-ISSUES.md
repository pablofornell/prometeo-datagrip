# Known issues and limits

This list holds what is not fixed or not built yet, and what is not verified. Each item says what happens and,
where it helps, what to do instead. Update the list when an item is fixed.

## Not verified yet

- **Full Rust test pass of the last fix round.** Each change was tested on its own against live Oracle 23 Free,
  PostgreSQL 16 and MySQL 8.4, and clippy, `cargo fmt --check`, `tsc` and vitest pass. The complete
  `cargo test --workspace` run with the three databases was stopped because the build machine ran out of
  memory. Run `make test-all` (or `cargo test --workspace -- --test-threads=1` with the database URLs set) on a
  machine with about 6 GB free.
- **Manual UI pass.** These screens are covered by unit tests only and nobody has clicked through them yet:
  multi-select in the Database Explorer (mouse and keyboard), Find Usages popup, Compare Schemas tab, value
  viewer tabs (JSON, Image, Hex), Dump to SQL File dialog, Run SQL Script progress, diagram of selected tables,
  data source color settings.
- **Windows installer.** It is not built on the development machine (no MSVC linker there). The CI job on
  `windows-latest` builds it, and only for a version tag.

## SQL dump and restore

- **Oracle objects that are not dumped:** object tables (`CREATE TABLE .. OF type`), materialized view logs,
  data of collection columns and of object columns with non-scalar attributes (skipped with a warning).
- **Oracle partitioning that is created without partitions:** reference partitioning and composite partitioning
  over HASH. The table is created unpartitioned and the dump has a warning. A GLOBAL partitioned index is created
  as a plain index.
- **Oracle materialized views with FAST refresh** come back as FORCE, because the logs are not dumped. A
  prebuilt-table materialized view keeps its container as a normal table.
- **Oracle object types used by a table in another schema:** a full restore with "drop if exists" stops with
  ORA-02303 instead of forcing the drop (`FORCE` would make that table's columns unusable).
- **Oracle constraints on hidden columns** are skipped whole with a warning. An FK on such a column can still be
  written partially. An FK that references a skipped key fails on restore (ORA-02270).
- **PostgreSQL foreign tables** are skipped with a warning.
- **One file only:** the "file per table" output is not built.
- **Run SQL Script, single transaction (the default):** Oracle and MySQL commit DDL themselves, so a rollback
  cannot undo `CREATE` / `ALTER` / `DROP`. DDL detection uses the first keyword, so DDL inside a PL/SQL block is
  not detected. One statement longer than 64 MB is refused.

## Compare Schemas

- Routine bodies are not migrated: the script gets a note to change them by hand.
- Column order is not migrated (new columns are added at the end).
- A system-named index (Oracle `SYS_…`) is not created; the script gets a note.
- Not read: SQLite CHECK constraints, MySQL / MariaDB sequences, PostgreSQL collations. MariaDB default values
  are not verified (only MySQL 8.4 was available).
- The live apply test covers type, size, nullability, default, dropped column, new tables with FKs, PK change
  with FKs, unnamed keys, unique, check, index and view changes. Disabled constraints and an added NOT NULL
  column without default are covered by unit tests only.

## Find Usages

- SQLite: a primary or unique key target finds nothing.
- Column targets use a word match, so a common column name (for example `ID`) gives false hits.
- PostgreSQL and MySQL routine line numbers count from the start of the body, not of the `CREATE` statement.
- Oracle: units owned by Oracle-maintained users can still appear in the list (only the text search excludes
  them).

## Value viewer

- The JSON tab is read-only; edit JSON in the Text tab.
- The full value is read on a separate connection: changes not yet committed in a manual-transaction console
  are not visible.
- Oracle `LONG` and `LONG RAW` columns are read whole before the 32 MB cap applies.
- An Oracle CLOB with emoji near the piece limits is read piece by piece: about 5 s per MB.
- For an Oracle CLOB / NCLOB that was cut, the size is shown in characters (UTF-16 units), not bytes.
- A 32 MB value crosses the UI bridge as about 43 MB of base64.

## Excel export

- Timestamps with a time zone and dates before 1900-03-01 are written as text.
- Transpose is not available for Excel.
- Peak memory for one million rows is not measured.

## SQL editor

- JOIN ... ON completion from foreign keys does not use derived tables or CTEs as the other side (their columns
  are not known); it uses the nearest earlier base table that has a foreign key with the new table.

## Database Explorer

- After a refresh, children that were selected are not selected again when they come back; only the lead
  node is saved between sessions.
- A multi-table drop orders by the cached schema snapshot: refresh first when tables changed outside the app.
  On SQLite a drop of tables in an FK cycle can fail while foreign keys are on.

## Export

- A cancel that arrives after the last row is written still reports success (the file is complete).

## Security

- On Windows the fallback password file is restricted with `icacls`; this is not tested with a domain account.
  See [SECURITY.md](SECURITY.md).
