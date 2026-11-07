# schema-editor: Modify Table, New Table, New View / Sequence / Schema

Entry points (from the explorer, `index.tsx`): `modifyObject(node)` (Ctrl+F6), `newTable(node)`, `newObjectOf(kind, node)`,
`newObjectTypes(node)` (the object entries of the New submenu per DBMS), `canModify(node)`.

- `model.ts` the table as edited (`TableDef`: columns, keys, foreign keys, indexes, checks) with stable `uid`s (keys / FKs / indexes also carry `columnUids`: renames follow the uid, not the name), type lists.
- `load.ts` builds the model from the explorer folders (`introspect`) plus catalog queries (owner, tablespace, MySQL generated
  columns / collation, SQLite original SQL: checks, `autoincrement`, triggers). `parseSqliteTable` is the SQLite `create table` reader.
- `sqlgen.ts` pure DDL: `createTablePlan`, `alterTablePlan(driver, loaded, edited)`, `validateTable`. PostgreSQL / MySQL alter in
  place (MySQL: one `alter table` with all clauses); SQLite does what ALTER can and otherwise emits the DataGrip-style rebuild
  (`<t>_dg_tmp`: create, copy, drop, rename to the old name, indexes, triggers; a table rename is a statement of its own after
  it) between `pragma foreign_keys = off` / `legacy_alter_table = on` and their reset. `sqliteRefs.ts` follows renamed columns
  into trigger / expression-index SQL; `keywords.ts` the per-dialect keyword lists `ident` quotes.
- `objects.ts` DDL of view / materialized view / sequence / schema (and Modify Schema on PostgreSQL).
- `apply.ts` runs a plan on a session of its own, in one transaction for PostgreSQL and SQLite (MySQL DDL commits itself: a
  `PlanError.applied > 0` makes the dialog reload the table before a retry).
- `Frame.tsx`, `TableEditor.tsx`, `ObjectEditor.tsx`, `fields.tsx`, `schema-editor.css` the dialog (tree + property sheet + live preview).

Known limits: SQLite rebuilds drop COLLATE / ON CONFLICT clauses and refuse tables with generated columns (a warning / error is
shown under the preview); PostgreSQL partial and INCLUDE indexes and SQLite partial / expression indexes are locked (drop only); a SQLite rebuild refuses a
rename when a trigger mentions the column where it cannot tell whose column it is; existing generated columns cannot be edited.
