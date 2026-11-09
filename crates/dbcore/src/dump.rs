//! Whole-schema dump to a `.sql` file, in `pg_dump` / `mysqldump` style.
//!
//! [`ConnectionManager::dump_schema`] writes the schema of a data source to a writer:
//!
//! * PostgreSQL: rebuilt from the catalogs (`pg_get_constraintdef`, `pg_get_indexdef`,
//!   `pg_get_viewdef`, `pg_get_triggerdef`). Order: header → sequences (serial and standalone, not the
//!   identity-owned ones) → `create table` (no foreign keys) → data `INSERT`s (foreign-key topological
//!   order) → sequence/identity `setval` resync → `create index` → `alter table .. add constraint` (FKs) →
//!   views → triggers (under `include_routines`).
//! * MySQL: `SHOW CREATE ...`, data inserts wrapped in `SET FOREIGN_KEY_CHECKS=0` / `1`.
//! * SQLite: `sqlite_master.sql`, data inserts wrapped in `PRAGMA foreign_keys=OFF` / `ON`.
//! * Oracle: rebuilt from the `ALL_*` dictionary views. Order: header (`ALTER SESSION SET CURRENT_SCHEMA` with a
//!   target schema; names are unqualified) → standalone sequences (`START WITH` the current value) →
//!   `CREATE TABLE` (identity, virtual columns, PK / unique / check; no foreign keys) → data `INSERT`s with
//!   NLS-independent literals (`COMMIT` every `commit_every` rows and at the end of each table) → indexes →
//!   foreign keys → views → package specs, functions / procedures, package bodies, triggers (each ended by a `/`
//!   line). Dropping (`drop_if_exists`) is a PL/SQL block that ignores "does not exist".
//!
//! Scope (v1): plain base tables only (PG `relkind = 'r'` and not a partition; SQLite tables; MySQL base
//! tables). Owner and comment statements are not written. `file_per_table` is not implemented.

use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::conn::{Live, Pool};
use crate::ddl::unqualify_schema;
use crate::error::{DbError, Result};
use crate::exec::query_pool;
use crate::export::sql_literal_typed;
use crate::import::CancellationToken;
use crate::manager::ConnectionManager;
use crate::model::*;
use crate::quote::{oracle_time_literal, qualified, quote_ident, quote_literal, OracleTimeKind};

// ---------------------------------------------------------------- options / progress / result

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DumpOptions {
    /// Dump table data as `INSERT` statements.
    pub data: bool,
    /// Emit `drop .. if exists` before each `create`.
    pub drop_if_exists: bool,
    pub include_views: bool,
    /// PostgreSQL: standalone and `serial` sequences.
    pub include_sequences: bool,
    /// Stored routines (and triggers).
    pub include_routines: bool,
    /// Restore into this schema / database instead of the dumped one.
    pub target_schema: Option<String>,
    /// Rows per `INSERT` statement.
    pub batch_size: usize,
    /// Dump only these tables (and their indexes and the foreign keys among them). Views, routines and
    /// standalone sequences are skipped when a subset is given. `None`: every table.
    pub tables: Option<Vec<String>>,
    /// `false`: data only (no `create` / `drop` statements; the sequence resync is kept).
    pub include_ddl: bool,
    /// Emit a `COMMIT` every N rows and at the end of each table's data. `0`: never (Oracle: only at the end
    /// of each table's data). SQLite has no use for it.
    pub commit_every: usize,
}

impl Default for DumpOptions {
    fn default() -> Self {
        DumpOptions {
            data: true,
            drop_if_exists: false,
            include_views: true,
            include_sequences: true,
            include_routines: false,
            target_schema: None,
            batch_size: 500,
            tables: None,
            include_ddl: true,
            commit_every: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpProgress {
    /// Short phase label ("schema", "sequences", "tables", "data", "indexes", "foreign keys",
    /// "views", "routines").
    pub phase: String,
    pub tables_done: usize,
    pub tables_total: usize,
    pub rows: u64,
    /// The table being written (`None` between tables).
    pub table: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DumpResult {
    pub tables: usize,
    pub rows: u64,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------- helpers

type Row = Vec<Option<String>>;

fn s(r: &Row, i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
}

fn pl(d: Driver, v: &str) -> String {
    quote_literal(d, v)
}

async fn first_cell(pool: &Pool, sql: &str) -> Result<Option<String>> {
    Ok(pool
        .query_strings(sql)
        .await?
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next())
        .flatten())
}

/// Fetches the `create` DDL column of a `SHOW CREATE <what>` result. The DDL lives in column 1 for
/// tables/views (`[name, create sql]`) and column 2 for routines/triggers (`[name, sql_mode, create sql]`).
async fn my_show(pool: &Pool, what: &str, schema: &str, name: &str, col: usize) -> Result<String> {
    let sql = format!(
        "show create {what} {}.{}",
        quote_ident(Driver::MySql, schema),
        quote_ident(Driver::MySql, name)
    );
    let rows = pool.query_strings(&sql).await?;
    Ok(rows.first().map(|r| s(r, col)).unwrap_or_default())
}

fn end_stmt(mut s: String) -> String {
    if !s.trim_end().ends_with(';') {
        s.push(';');
    }
    s
}

/// `numeric(12,2)` -> `numeric(12, 2)`.
fn spaced_type(t: &str) -> String {
    if t.contains('(') && !t.contains(", ") {
        t.replace(',', ", ")
    } else {
        t.to_string()
    }
}

/// Lower-cases the keywords of SQL the server wrote (`pg_get_constraintdef`, `pg_get_indexdef`, ...).
/// Quoted identifiers and string literals are kept.
fn lower_keywords(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\'' || c == '"' {
            out.push(c);
            while let Some(d) = it.next() {
                out.push(d);
                if d == c {
                    if it.peek() == Some(&c) {
                        out.push(it.next().unwrap());
                    } else {
                        break;
                    }
                }
            }
        } else if c.is_alphabetic() || c == '_' {
            let mut w = String::from(c);
            while let Some(&d) = it.peek() {
                if d.is_alphanumeric() || d == '_' || d == '$' {
                    w.push(d);
                    it.next();
                } else {
                    break;
                }
            }
            let letters = w.chars().filter(|x| x.is_alphabetic()).count();
            if letters >= 2 && !w.chars().any(|x| x.is_lowercase()) {
                out.push_str(&w.to_lowercase());
            } else {
                out.push_str(&w);
            }
        } else if c.is_ascii_digit() {
            out.push(c);
            while let Some(&d) = it.peek() {
                if d.is_alphanumeric() || d == '_' || d == '.' {
                    out.push(d);
                    it.next();
                } else {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ---------------------------------------------------------------- topo sort

/// Topological order of `tables` such that every table comes after the tables its foreign keys reference
/// (`edges` are `(referenced, referencing)` pairs). Stable for ties; on a cycle the remaining tables keep
/// their original order.
pub fn topo_sort(tables: &[String], edges: &[(String, String)]) -> Vec<String> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let index: HashMap<&String, usize> = tables.iter().enumerate().map(|(i, t)| (t, i)).collect();
    let mut indeg = vec![0usize; tables.len()];
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); tables.len()];
    let mut seen = HashSet::new();
    for (referenced, referencing) in edges {
        let (Some(&r), Some(&f)) = (index.get(referenced), index.get(referencing)) else {
            continue;
        };
        if r == f || !seen.insert((r, f)) {
            continue;
        }
        adj[r].push(f);
        indeg[f] += 1;
    }
    let mut queue: VecDeque<usize> = (0..tables.len()).filter(|&i| indeg[i] == 0).collect();
    let mut order = Vec::with_capacity(tables.len());
    while let Some(i) = queue.pop_front() {
        order.push(tables[i].clone());
        for &n in &adj[i] {
            indeg[n] -= 1;
            if indeg[n] == 0 {
                queue.push_back(n);
            }
        }
    }
    if order.len() < tables.len() {
        let in_order: HashSet<usize> = order.iter().map(|t| index[t]).collect();
        for (i, t) in tables.iter().enumerate() {
            if !in_order.contains(&i) {
                order.push(t.clone());
            }
        }
    }
    order
}

// ---------------------------------------------------------------- schema rename

fn utf8_char_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

/// Index of the byte just past the closing `q` starting at `start` (the quote itself), honouring `qq`
/// doubling; `sql.len()` when the quote is never closed.
fn quoted_end(sql: &str, start: usize, q: u8) -> usize {
    let b = sql.as_bytes();
    let mut j = start + 1;
    while j < b.len() {
        if b[j] == q {
            if j + 1 < b.len() && b[j + 1] == q {
                j += 2;
                continue;
            }
            return j + 1;
        }
        j += 1;
    }
    sql.len()
}

fn ident_prev(out: &str) -> bool {
    out.chars()
        .last()
        .is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '$' | '"'))
}

/// Rewrites the schema prefix of identifiers and `regclass` string literals from `from` to `to` in
/// server-written SQL: `from.` and `"from".` outside string literals / quoted identifiers / comments,
/// and `'from.` at the start of a string literal (`nextval('from.seq'::regclass)`). Comments, dollar-quoted
/// bodies and unrelated text are copied unchanged.
pub fn rename_schema_prefix(sql: &str, from: &str, to: &str) -> String {
    let plain = format!("{from}.");
    let mut out = String::with_capacity(sql.len());
    let b = sql.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let rest = &sql[i..];
        if rest.starts_with("--") {
            let end = rest.find('\n').map(|p| i + p).unwrap_or(sql.len());
            out.push_str(&sql[i..end]);
            i = end;
        } else if rest.starts_with("/*") {
            let end = rest.find("*/").map(|p| i + p + 2).unwrap_or(sql.len());
            out.push_str(&sql[i..end]);
            i = end;
        } else if b[i] == b'\'' {
            let end = quoted_end(sql, i, b'\'');
            let lit = &sql[i..end];
            if lit.starts_with(&format!("'{from}.")) {
                out.push('\'');
                out.push_str(to);
                out.push('.');
                out.push_str(&lit[1 + from.len() + 1..]);
            } else {
                out.push_str(lit);
            }
            i = end;
        } else if b[i] == b'"' {
            let end = quoted_end(sql, i, b'"');
            let ident = sql[i..end].trim_matches('"');
            if sql[end..].starts_with('.') && ident == from {
                out.push_str(&quote_ident(Driver::Postgres, to));
                out.push('.');
                i = end + 1;
            } else {
                out.push_str(&sql[i..end]);
                i = end;
            }
        } else if b[i] == b'$' {
            match rest[1..].find('$').map(|p| i + 1 + p + 1) {
                Some(te) => {
                    let tag = &sql[i..te];
                    let end = sql[te..]
                        .find(tag)
                        .map(|p| te + p + tag.len())
                        .unwrap_or(sql.len());
                    out.push_str(&sql[i..end]);
                    i = end;
                }
                None => {
                    out.push('$');
                    i += 1;
                }
            }
        } else if rest.starts_with(&plain) && !ident_prev(&out) {
            out.push_str(to);
            out.push('.');
            i += plain.len();
        } else {
            let cl = utf8_char_len(b[i]);
            out.push_str(&sql[i..i + cl]);
            i += cl;
        }
    }
    out
}

/// MySQL `SHOW CREATE VIEW / PROCEDURE / FUNCTION / TRIGGER` text made portable: without the
/// `DEFINER=user@host` clause (that account rarely exists on another server, and the restore fails)
/// and without the `` `schema`. `` qualifier (the dump runs after `USE target`), as mysqldump does.
pub fn my_portable(sql: &str, schema: &str) -> String {
    let mut s = sql.to_string();
    if let Some(at) = s.find("DEFINER=") {
        let end = s[at..].find(' ').map_or(s.len(), |e| at + e + 1);
        s.replace_range(at..end, "");
    }
    s.replace(&format!("`{}`.", schema.replace('`', "``")), "")
}

fn maybe_rename(sql: &str, schema: &str, target: &str) -> String {
    if target == schema {
        sql.to_string()
    } else {
        rename_schema_prefix(sql, schema, target)
    }
}

// ---------------------------------------------------------------- progress / data writer

fn report(
    progress: &(dyn Fn(DumpProgress) + Send + Sync),
    phase: &str,
    tables_done: usize,
    tables_total: usize,
    rows: u64,
) {
    report_table(progress, phase, tables_done, tables_total, rows, None);
}

fn report_table(
    progress: &(dyn Fn(DumpProgress) + Send + Sync),
    phase: &str,
    tables_done: usize,
    tables_total: usize,
    rows: u64,
    table: Option<&str>,
) {
    progress(DumpProgress {
        phase: phase.to_string(),
        tables_done,
        tables_total,
        rows,
        table: table.map(str::to_string),
    });
}

/// `true` when `name` is part of the dump (`tables` is the optional subset of the options).
fn wanted(subset: &Option<Vec<String>>, name: &str) -> bool {
    subset.as_ref().is_none_or(|t| t.iter().any(|x| x == name))
}

struct RowsState {
    names: Vec<String>,
    types: Vec<String>,
    batch: Vec<String>,
    rows: u64,
    /// Rows written since the last `commit`.
    since_commit: u64,
}

/// Writes the pending batch; with `commit_every` set, a `commit` follows once that many rows are out.
fn flush_rows<W: Write>(
    w: &mut W,
    driver: Driver,
    dst: &str,
    cols: &[String],
    st: &mut RowsState,
    commit_every: Option<usize>,
) -> Result<()> {
    if st.batch.is_empty() {
        return Ok(());
    }
    let cols_q: Vec<String> = cols.iter().map(|c| quote_ident(driver, c)).collect();
    writeln!(w, "insert into {dst} ({}) values", cols_q.join(", "))?;
    writeln!(
        w,
        "    {};",
        st.batch.join(
            ",
    "
        )
    )?;
    st.rows += st.batch.len() as u64;
    st.since_commit += st.batch.len() as u64;
    st.batch.clear();
    if commit_every.is_some_and(|n| n > 0 && st.since_commit >= n as u64) {
        writeln!(w, "commit;")?;
        st.since_commit = 0;
    }
    Ok(())
}

/// Streams `select * from <src>` and writes `insert into <dst> ...` batches. Binary values are read in
/// full (`bin_limit = usize::MAX`). `commit_every`: `None` writes no `commit`, `Some(n)` one every `n` rows
/// and at the end. Returns the number of rows written.
#[allow(clippy::too_many_arguments)]
async fn dump_rows<W: Write>(
    live: &Live,
    driver: Driver,
    w: &mut W,
    src: &str,
    dst: &str,
    batch_size: usize,
    commit_every: Option<usize>,
    cancel: &CancellationToken,
    progress: &(dyn Fn(DumpProgress) + Send + Sync),
    table: &str,
    tables_done: usize,
    tables_total: usize,
) -> Result<u64> {
    let mut st = RowsState {
        names: Vec::new(),
        types: Vec::new(),
        batch: Vec::new(),
        rows: 0,
        since_commit: 0,
    };
    let sql = format!("select * from {src}");
    query_pool(live, &sql, usize::MAX, |cols, row| {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        if st.names.is_empty() {
            st.names = cols.iter().map(|c| c.name.clone()).collect();
            st.types = cols.iter().map(|c| c.type_name.clone()).collect();
        }
        let vals: Vec<String> = row
            .iter()
            .enumerate()
            .map(|(i, c)| {
                sql_literal_typed(driver, c, st.types.get(i).map(String::as_str).unwrap_or(""))
            })
            .collect();
        st.batch.push(format!("({})", vals.join(", ")));
        if st.batch.len() >= batch_size {
            let names = st.names.clone();
            flush_rows(w, driver, dst, &names, &mut st, commit_every)?;
            report_table(
                progress,
                "data",
                tables_done,
                tables_total,
                st.rows,
                Some(table),
            );
        }
        Ok(())
    })
    .await?;
    let names = st.names.clone();
    flush_rows(w, driver, dst, &names, &mut st, commit_every)?;
    if commit_every.is_some() && st.since_commit > 0 {
        writeln!(w, "commit;")?;
    }
    Ok(st.rows)
}

// ---------------------------------------------------------------- entry point

impl ConnectionManager {
    /// Dumps the objects of `schema` (PG schema, MySQL database, SQLite `main`) to `w` as SQL text.
    /// `cancel` aborts and returns [`DumpResult::cancelled`]; `progress` is called between phases and
    /// after every data batch.
    pub async fn dump_schema<W: Write + Send>(
        &self,
        ds_id: &str,
        schema: &str,
        opts: &DumpOptions,
        cancel: &CancellationToken,
        progress: &(dyn Fn(DumpProgress) + Send + Sync),
        w: W,
    ) -> Result<DumpResult> {
        let started = Instant::now();
        let live = self.live(ds_id)?;
        let mut w = BufWriter::new(w);
        let mut res = DumpResult::default();
        let outcome = match live.driver() {
            Driver::Postgres => {
                dump_pg(&live, schema, opts, cancel, progress, &mut w, &mut res).await
            }
            Driver::MySql => dump_my(&live, schema, opts, cancel, progress, &mut w, &mut res).await,
            Driver::Sqlite => {
                dump_lite(&live, schema, opts, cancel, progress, &mut w, &mut res).await
            }
            Driver::Oracle => {
                dump_ora(&live, schema, opts, cancel, progress, &mut w, &mut res).await
            }
        };
        res.elapsed_ms = started.elapsed().as_millis() as u64;
        match outcome {
            Ok(()) => {
                w.flush()?;
                Ok(res)
            }
            Err(DbError::Cancelled) => {
                let _ = w.flush();
                res.cancelled = true;
                Ok(res)
            }
            Err(e) => Err(e),
        }
    }
}

// ---------------------------------------------------------------- PostgreSQL

fn pg_rel_expr(schema: &str, name: &str) -> String {
    format!(
        "(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = {} and c.relname = {})",
        pl(Driver::Postgres, schema),
        pl(Driver::Postgres, name)
    )
}

fn pg_qname(schema: &str, name: &str) -> String {
    qualified(Driver::Postgres, Some(schema), name)
}

/// `create sequence`, `alter table add constraint`, `setval` and FK edges of one table.
struct PgTable {
    create_sql: String,
    /// `(referenced table of the same schema or "", statement)`
    fk_stmts: Vec<(String, String)>,
    /// `alter sequence .. owned by ..` of serial columns (DDL).
    owned: Vec<String>,
    /// `setval` of serial / identity columns.
    setval: Vec<String>,
}

async fn dump_pg<W: Write>(
    live: &Live,
    schema: &str,
    opts: &DumpOptions,
    cancel: &CancellationToken,
    progress: &(dyn Fn(DumpProgress) + Send + Sync),
    w: &mut W,
    res: &mut DumpResult,
) -> Result<()> {
    let pool = &live.pool;
    let target = opts.target_schema.as_deref().unwrap_or(schema);
    let d = Driver::Postgres;

    writeln!(w, "--")?;
    writeln!(w, "-- Prometeo DataGrip dump")?;
    writeln!(w, "-- {}", live.server_version)?;
    writeln!(w, "--")?;
    writeln!(w)?;
    for line in [
        "SET statement_timeout = 0;",
        "SET lock_timeout = 0;",
        "SET idle_in_transaction_session_timeout = 0;",
        "SET client_encoding = 'UTF8';",
        "SET standard_conforming_strings = on;",
        "SET check_function_bodies = false;",
        "SET client_min_messages = warning;",
        "SET row_security = off;",
    ] {
        writeln!(w, "{line}")?;
    }
    writeln!(w)?;

    // ---- sequences (serial + standalone, not the identity-owned ones). The sequences a column default
    // needs (serial) are always written; `include_sequences` only controls the standalone ones.
    {
        let rows = pool
            .query_strings(&format!(
                "select c.relname, s.data_type::text, s.start_value::text, s.increment_by::text, \
                        s.min_value::text, s.max_value::text, s.cache_size::text, s.cycle::text, \
                        coalesce(s.last_value::text, ''), \
                        coalesce((select t.relname from pg_depend de join pg_class t on t.oid = de.refobjid \
                                  where de.objid = c.oid and de.deptype = 'a' and de.refobjsubid > 0 limit 1), '') \
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace \
                 left join pg_sequences s on s.schemaname = n.nspname and s.sequencename = c.relname \
                 where c.relkind = 'S' and n.nspname = {} \
                   and not exists (select 1 from pg_depend de where de.objid = c.oid and de.deptype = 'i') \
                 order by c.relname",
                pl(d, schema)
            ))
            .await?;
        let mut any = false;
        for r in &rows {
            let name = &s(r, 0);
            let owner = s(r, 9);
            let standalone = owner.is_empty();
            let keep = if standalone {
                opts.include_sequences && opts.tables.is_none()
            } else {
                wanted(&opts.tables, &owner)
            };
            if !keep {
                continue;
            }
            if opts.include_ddl {
                if opts.drop_if_exists {
                    writeln!(
                        w,
                        "drop sequence if exists {} cascade;",
                        pg_qname(target, name)
                    )?;
                }
                let mut create = format!(
                    "create sequence {}\n    as {}\n    start with {}\n    increment by {}\n    minvalue {}\n    maxvalue {}\n    cache {}",
                    pg_qname(target, name),
                    s(r, 1),
                    s(r, 2),
                    s(r, 3),
                    s(r, 4),
                    s(r, 5),
                    s(r, 6)
                );
                if s(r, 7) == "true" {
                    create.push_str("\n    cycle");
                }
                create.push(';');
                writeln!(w, "{create}")?;
                any = true;
            }
            // keep the current value of a used sequence (serial ones are resynced from the data later)
            if opts.data && !s(r, 8).is_empty() && (opts.include_ddl || standalone) {
                writeln!(
                    w,
                    "select setval({}, {}, true);",
                    pl(d, &pg_qname(target, name)),
                    s(r, 8)
                )?;
                any = true;
            }
        }
        if any {
            writeln!(w)?;
        }
    }

    // ---- list tables and collect their definitions + FK edges
    let tables: Vec<String> = pool
        .query_strings(&format!(
            "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace \
             where c.relkind = 'r' and not c.relispartition and n.nspname = {} order by c.relname",
            pl(d, schema)
        ))
        .await?
        .iter()
        .map(|r| s(r, 0))
        .filter(|t| wanted(&opts.tables, t))
        .collect();

    let mut defs: HashMap<String, PgTable> = HashMap::new();
    let mut edges: Vec<(String, String)> = Vec::new();
    for name in &tables {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        let (table, fk_edges) = pg_table_parts(pool, schema, target, name).await?;
        edges.extend(fk_edges);
        defs.insert(name.clone(), table);
    }

    let order = topo_sort(&tables, &edges);
    report(progress, "schema", 0, order.len(), res.rows);

    // ---- create tables + data (FK topological order)
    for (i, name) in order.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        let t = &defs[name];
        if opts.include_ddl {
            writeln!(w, "--")?;
            writeln!(w, "-- Name: {}; Type: TABLE", name)?;
            writeln!(w, "--")?;
            if opts.drop_if_exists {
                writeln!(
                    w,
                    "drop table if exists {} cascade;",
                    pg_qname(target, name)
                )?;
            }
            writeln!(w, "{}", t.create_sql)?;
            writeln!(w)?;
        }
        if opts.data {
            let src = pg_qname(schema, name);
            let dst = pg_qname(target, name);
            let rows = dump_rows(
                live,
                d,
                w,
                &src,
                &dst,
                opts.batch_size.max(1),
                (opts.commit_every > 0).then_some(opts.commit_every),
                cancel,
                progress,
                name,
                i + 1,
                order.len(),
            )
            .await?;
            res.rows += rows;
            writeln!(w)?;
        }
        res.tables += 1;
        report(progress, "tables", i + 1, order.len(), res.rows);
    }

    // ---- sequence / identity resync
    {
        let mut any = false;
        for name in &tables {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let t = &defs[name];
            if opts.include_ddl {
                for stmt in &t.owned {
                    writeln!(w, "{stmt}")?;
                    any = true;
                }
            }
            if opts.data {
                for stmt in &t.setval {
                    writeln!(w, "{stmt}")?;
                    any = true;
                }
            }
        }
        if any {
            writeln!(w)?;
        }
    }

    // ---- indexes
    report(progress, "indexes", order.len(), order.len(), res.rows);
    for name in tables.iter().filter(|_| opts.include_ddl) {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        let rel = pg_rel_expr(schema, name);
        let rows = pool
            .query_strings(&format!(
                "select pg_get_indexdef(i.indexrelid) from pg_index i join pg_class ic on ic.oid = i.indexrelid \
                 where i.indrelid = {rel} \
                   and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid and c.contype in ('p','u','x')) \
                 order by ic.relname"
            ))
            .await?;
        for r in &rows {
            writeln!(
                w,
                "{};",
                maybe_rename(&lower_keywords(&s(r, 0)), schema, target)
            )?;
        }
    }

    // ---- foreign keys
    report(progress, "foreign keys", order.len(), order.len(), res.rows);
    for name in tables.iter().filter(|_| opts.include_ddl) {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        // a foreign key to a table left out of the subset could not be restored
        for (referenced, stmt) in &defs[name].fk_stmts {
            if referenced.is_empty() || wanted(&opts.tables, referenced) {
                writeln!(w, "{stmt}")?;
            }
        }
    }

    // ---- views
    if opts.include_views && opts.include_ddl && opts.tables.is_none() {
        report(progress, "views", order.len(), order.len(), res.rows);
        let rows = pool
            .query_strings(&format!(
                "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace \
                 where c.relkind = 'v' and n.nspname = {} order by c.relname",
                pl(d, schema)
            ))
            .await?;
        for r in &rows {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let name = &s(r, 0);
            let def = first_cell(
                pool,
                &format!("select pg_get_viewdef({}, true)", pg_rel_expr(schema, name)),
            )
            .await?
            .ok_or_else(|| DbError::NotFound(format!("View {schema}.{name} not found")))?;
            if opts.drop_if_exists {
                writeln!(w, "drop view if exists {} cascade;", pg_qname(target, name))?;
            }
            // pg_get_viewdef already ends with `;`
            writeln!(
                w,
                "{}",
                end_stmt(format!(
                    "create view {} as\n{}",
                    pg_qname(target, name),
                    maybe_rename(&def, schema, target)
                ))
            )?;
            writeln!(w)?;
        }
    }

    // ---- triggers
    if opts.include_routines && opts.include_ddl && opts.tables.is_none() {
        report(progress, "routines", order.len(), order.len(), res.rows);
        for name in &tables {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let rel = pg_rel_expr(schema, name);
            let rows = pool
                .query_strings(&format!(
                    "select pg_get_triggerdef(oid) from pg_trigger where tgrelid = {rel} and not tgisinternal order by tgname"
                ))
                .await?;
            for r in &rows {
                writeln!(
                    w,
                    "{};",
                    maybe_rename(&lower_keywords(&s(r, 0)), schema, target)
                )?;
            }
        }
    }

    Ok(())
}

/// `create table` (no FK), the deferred `alter table .. add constraint` FK statements, the `setval`
/// statements of serial / identity columns, and the FK edges `(referenced, referencing)`.
async fn pg_table_parts(
    pool: &Pool,
    schema: &str,
    target: &str,
    name: &str,
) -> Result<(PgTable, Vec<(String, String)>)> {
    let d = Driver::Postgres;
    let rel = pg_rel_expr(schema, name);
    let qname = pg_qname(target, name);

    let unlogged = match first_cell(
        pool,
        &format!("select c.relpersistence::text from pg_class c where c.oid = {rel}"),
    )
    .await?
    .as_deref()
    {
        Some("u") => "unlogged ",
        _ => "",
    };

    let cols = pool
        .query_strings(&format!(
            "select a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull::text, \
                    coalesce(pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity::text, a.attgenerated::text, \
                    case when a.attcollation <> t.typcollation then (select quote_ident(collname) from pg_collation where oid = a.attcollation) else '' end, \
                    coalesce(pg_get_serial_sequence(a.attrelid::regclass::text, a.attname), '') \
             from pg_attribute a join pg_type t on t.oid = a.atttypid \
             left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum \
             where a.attrelid = {rel} and a.attnum > 0 and not a.attisdropped order by a.attnum"
        ))
        .await?;

    let cons = pool
        .query_strings(&format!(
            "select c.conname, c.contype::text, pg_get_constraintdef(c.oid), \
                    (select n.nspname from pg_class rc join pg_namespace n on n.oid = rc.relnamespace where rc.oid = c.confrelid), \
                    (select rc.relname from pg_class rc where rc.oid = c.confrelid) \
             from pg_constraint c where c.conrelid = {rel} and c.contype in ('p','u','c','x','f') and c.conparentid = 0 \
             order by (c.contype = 'p') desc, (c.contype = 'u') desc, (c.contype = 'c') desc, (c.contype = 'x') desc, (c.contype = 'f') desc, c.conname"
        ))
        .await?;

    let mut items: Vec<String> = Vec::new();
    let mut owned: Vec<String> = Vec::new();
    let mut setval: Vec<String> = Vec::new();
    for r in &cols {
        let col = &s(r, 0);
        items.push(format!("    {}", pg_col_line(r, schema, target)));
        if !s(r, 7).is_empty() {
            // a serial sequence is created on its own above: tie it to its column again, so that
            // pg_get_serial_sequence finds it (and it is dropped with the table), as pg_dump does
            if s(r, 4).is_empty() {
                owned.push(format!(
                    "alter sequence {} owned by {}.{};",
                    maybe_rename(&s(r, 7), schema, target),
                    pg_qname(target, name),
                    quote_ident(d, col)
                ));
            }
            setval.push(pg_setval(target, name, col));
        }
    }

    let mut fk_stmts = Vec::new();
    let mut fk_edges = Vec::new();
    for r in &cons {
        let conname = quote_ident(d, &s(r, 0));
        let kind = s(r, 1).chars().next().unwrap_or('c');
        let def = maybe_rename(&lower_keywords(&s(r, 2)), schema, target);
        if kind == 'f' {
            let same_schema = s(r, 3) == schema;
            fk_stmts.push((
                if same_schema { s(r, 4) } else { String::new() },
                format!("alter table {qname}\n    add constraint {conname} {def};"),
            ));
            if same_schema {
                fk_edges.push((s(r, 4), name.to_string()));
            }
        } else {
            items.push(format!("    constraint {conname} {def}"));
        }
    }

    let create_sql = format!(
        "create {unlogged}table {qname}\n(\n{}\n);",
        items.join(",\n")
    );
    Ok((
        PgTable {
            create_sql,
            fk_stmts,
            owned,
            setval,
        },
        fk_edges,
    ))
}

fn pg_col_line(r: &Row, schema: &str, target: &str) -> String {
    let name = quote_ident(Driver::Postgres, &s(r, 0));
    let mut l = spaced_type(&s(r, 1));
    if !s(r, 6).is_empty() {
        l.push_str(&format!(" collate {}", s(r, 6)));
    }
    match s(r, 4).as_str() {
        "a" => l.push_str(" generated always as identity"),
        "d" => l.push_str(" generated by default as identity"),
        _ => {}
    }
    if s(r, 5) == "s" {
        l.push_str(&format!(
            " generated always as ({}) stored",
            maybe_rename(&lower_keywords(&s(r, 3)), schema, target)
        ));
    } else if !s(r, 3).is_empty() && s(r, 4).is_empty() {
        // a `nextval('schema.seq'::regclass)` default must follow the renamed schema
        l.push_str(&format!(
            " default {}",
            maybe_rename(&lower_keywords(&s(r, 3)), schema, target)
        ));
    }
    if s(r, 2) == "true" {
        l.push_str(" not null");
    }
    format!("{name} {l}")
}

/// `select setval(pg_get_serial_sequence('schema.table', 'col'), max(col), count > 0);` — restores the
/// sequence value from the restored data.
fn pg_setval(schema: &str, table: &str, col: &str) -> String {
    let d = Driver::Postgres;
    let qname = pg_qname(schema, table);
    let colq = quote_ident(d, col);
    format!(
        "select setval(pg_get_serial_sequence({}, {}), coalesce((select max({colq}) from {qname}), 1), (select count(*) > 0 from {qname}));",
        pl(d, &format!("{schema}.{table}")),
        pl(d, col)
    )
}

// ---------------------------------------------------------------- MySQL

async fn dump_my<W: Write>(
    live: &Live,
    schema: &str,
    opts: &DumpOptions,
    cancel: &CancellationToken,
    progress: &(dyn Fn(DumpProgress) + Send + Sync),
    w: &mut W,
    res: &mut DumpResult,
) -> Result<()> {
    let pool = &live.pool;
    let d = Driver::MySql;
    let target = opts.target_schema.as_deref().unwrap_or(schema);

    writeln!(w, "--")?;
    writeln!(w, "-- Prometeo DataGrip dump")?;
    writeln!(w, "-- {}", live.server_version)?;
    writeln!(w, "--")?;
    writeln!(w)?;
    writeln!(w, "SET NAMES utf8;")?;
    writeln!(w, "SET FOREIGN_KEY_CHECKS = 0;")?;
    writeln!(w)?;
    writeln!(w, "USE {};", quote_ident(d, target))?;
    writeln!(w)?;

    // list tables + FK edges
    let tables: Vec<String> = pool
        .query_strings(&format!(
            "select table_name from information_schema.tables \
             where table_schema = {} and table_type = 'BASE TABLE' order by table_name",
            pl(d, schema)
        ))
        .await?
        .iter()
        .map(|r| s(r, 0))
        .filter(|t| wanted(&opts.tables, t))
        .collect();

    let fk_rows = pool
        .query_strings(&format!(
            "select table_name, referenced_table_name from information_schema.key_column_usage \
             where table_schema = {} and referenced_table_schema = {} and referenced_table_name is not null",
            pl(d, schema),
            pl(d, schema)
        ))
        .await?;
    let mut edges: Vec<(String, String)> = Vec::new();
    for r in &fk_rows {
        edges.push((s(r, 1), s(r, 0)));
    }

    let order = topo_sort(&tables, &edges);
    report(progress, "schema", 0, order.len(), res.rows);

    for (i, name) in order.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        if opts.include_ddl {
            let create = end_stmt(my_show(pool, "table", schema, name, 1).await?);
            writeln!(w, "--")?;
            writeln!(w, "-- Name: {}; Type: TABLE", name)?;
            writeln!(w, "--")?;
            if opts.drop_if_exists {
                writeln!(w, "drop table if exists {};", quote_ident(d, name))?;
            }
            writeln!(w, "{create}")?;
            writeln!(w)?;
        }
        if opts.data {
            let src = qualified(d, Some(schema), name);
            let dst = qualified(d, Some(target), name);
            let rows = dump_rows(
                live,
                d,
                w,
                &src,
                &dst,
                opts.batch_size.max(1),
                (opts.commit_every > 0).then_some(opts.commit_every),
                cancel,
                progress,
                name,
                i + 1,
                order.len(),
            )
            .await?;
            res.rows += rows;
            writeln!(w)?;
        }
        res.tables += 1;
        report(progress, "tables", i + 1, order.len(), res.rows);
    }

    // ---- views
    if opts.include_views && opts.include_ddl && opts.tables.is_none() {
        report(progress, "views", order.len(), order.len(), res.rows);
        let views = pool
            .query_strings(&format!(
                "select table_name from information_schema.views where table_schema = {} order by table_name",
                pl(d, schema)
            ))
            .await?;
        for r in &views {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let name = &s(r, 0);
            let create = my_portable(&my_show(pool, "view", schema, name, 1).await?, schema);
            if opts.drop_if_exists {
                writeln!(w, "drop view if exists {};", quote_ident(d, name))?;
            }
            writeln!(w, "{}", end_stmt(create))?;
            writeln!(w)?;
        }
    }

    // ---- routines and triggers
    if opts.include_routines && opts.include_ddl && opts.tables.is_none() {
        report(progress, "routines", order.len(), order.len(), res.rows);
        let routines = pool
            .query_strings(&format!(
                "select routine_type, routine_name from information_schema.routines \
                 where routine_schema = {} order by routine_name",
                pl(d, schema)
            ))
            .await?;
        for r in &routines {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let kind = s(r, 0).to_ascii_lowercase();
            let name = &s(r, 1);
            let create = my_portable(&my_show(pool, &kind, schema, name, 2).await?, schema);
            if opts.drop_if_exists {
                writeln!(w, "drop {kind} if exists {};", quote_ident(d, name))?;
            }
            writeln!(w, "DELIMITER ;;")?;
            writeln!(w, "{};;", create.trim_end().trim_end_matches(';'))?;
            writeln!(w, "DELIMITER ;")?;
            writeln!(w)?;
        }
        let triggers = pool
            .query_strings(&format!(
                "select trigger_name from information_schema.triggers where trigger_schema = {} order by trigger_name",
                pl(d, schema)
            ))
            .await?;
        for r in &triggers {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let name = &s(r, 0);
            let create = my_portable(&my_show(pool, "trigger", schema, name, 2).await?, schema);
            if opts.drop_if_exists {
                writeln!(w, "drop trigger if exists {};", quote_ident(d, name))?;
            }
            writeln!(w, "DELIMITER ;;")?;
            writeln!(w, "{};;", create.trim_end().trim_end_matches(';'))?;
            writeln!(w, "DELIMITER ;")?;
            writeln!(w)?;
        }
    }

    writeln!(w, "SET FOREIGN_KEY_CHECKS = 1;")?;
    Ok(())
}

// ---------------------------------------------------------------- SQLite

async fn dump_lite<W: Write>(
    live: &Live,
    schema: &str,
    opts: &DumpOptions,
    cancel: &CancellationToken,
    progress: &(dyn Fn(DumpProgress) + Send + Sync),
    w: &mut W,
    res: &mut DumpResult,
) -> Result<()> {
    let pool = &live.pool;
    let d = Driver::Sqlite;
    let sc = if schema.trim().is_empty() {
        "main"
    } else {
        schema
    };

    writeln!(w, "--")?;
    writeln!(w, "-- Prometeo DataGrip dump")?;
    writeln!(w, "-- {}", live.server_version)?;
    writeln!(w, "--")?;
    writeln!(w)?;
    writeln!(w, "PRAGMA foreign_keys = OFF;")?;
    writeln!(w)?;

    let tables: Vec<Row> = pool
        .query_strings(&format!(
            "select name from {}.sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
            quote_ident(d, sc)
        ))
        .await?
        .into_iter()
        .filter(|r| wanted(&opts.tables, &s(r, 0)))
        .collect();

    let total = tables.len();
    report(progress, "schema", 0, total, res.rows);

    for (i, r) in tables.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        let name = &s(r, 0);
        let create = first_cell(
            pool,
            &format!(
                "select sql from {}.sqlite_master where type = 'table' and name = {}",
                quote_ident(d, sc),
                pl(d, name)
            ),
        )
        .await?
        .unwrap_or_default();
        if opts.include_ddl {
            writeln!(w, "--")?;
            writeln!(w, "-- Name: {}; Type: TABLE", name)?;
            writeln!(w, "--")?;
            if opts.drop_if_exists {
                writeln!(w, "drop table if exists {};", quote_ident(d, name))?;
            }
            writeln!(w, "{}", end_stmt(create))?;
            writeln!(w)?;
        }
        if opts.data {
            let qname = quote_ident(d, name);
            let rows = dump_rows(
                live,
                d,
                w,
                &qname,
                &qname,
                opts.batch_size.max(1),
                None,
                cancel,
                progress,
                name,
                i + 1,
                total,
            )
            .await?;
            res.rows += rows;
            writeln!(w)?;
        }
        res.tables += 1;
        report(progress, "tables", i + 1, total, res.rows);
    }

    // ---- indexes (explicit `create index`; PK/UNIQUE indexes have `sql` NULL)
    report(progress, "indexes", total, total, res.rows);
    let indexes = pool
        .query_strings(&format!(
            "select name, sql, tbl_name from {}.sqlite_master where type = 'index' and sql is not null order by name",
            quote_ident(d, sc)
        ))
        .await?;
    for r in indexes
        .iter()
        .filter(|r| opts.include_ddl && wanted(&opts.tables, &s(r, 2)))
    {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        let name = &s(r, 0);
        let create = &s(r, 1);
        if opts.drop_if_exists {
            writeln!(w, "drop index if exists {};", quote_ident(d, name))?;
        }
        writeln!(w, "{}", end_stmt(create.clone()))?;
    }

    // ---- views
    if opts.include_views && opts.include_ddl && opts.tables.is_none() {
        report(progress, "views", total, total, res.rows);
        let views = pool
            .query_strings(&format!(
                "select name, sql from {}.sqlite_master where type = 'view' order by name",
                quote_ident(d, sc)
            ))
            .await?;
        for r in &views {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let name = &s(r, 0);
            let create = &s(r, 1);
            if opts.drop_if_exists {
                writeln!(w, "drop view if exists {};", quote_ident(d, name))?;
            }
            writeln!(w, "{}", end_stmt(create.clone()))?;
            writeln!(w)?;
        }
    }

    // ---- triggers
    if opts.include_routines && opts.include_ddl && opts.tables.is_none() {
        report(progress, "routines", total, total, res.rows);
        let triggers = pool
            .query_strings(&format!(
                "select name, sql from {}.sqlite_master where type = 'trigger' order by name",
                quote_ident(d, sc)
            ))
            .await?;
        for r in &triggers {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let name = &s(r, 0);
            let create = &s(r, 1);
            if opts.drop_if_exists {
                writeln!(w, "drop trigger if exists {};", quote_ident(d, name))?;
            }
            writeln!(w, "{}", end_stmt(create.clone()))?;
            writeln!(w)?;
        }
    }

    writeln!(w, "PRAGMA foreign_keys = ON;")?;
    Ok(())
}

// ---------------------------------------------------------------- Oracle

/// Longest string literal piece in plain SQL, in bytes (a literal holds at most 4000), and the longest
/// `HEXTORAW` literal, in hex digits.
const ORA_SQL_TEXT: usize = 3000;
const ORA_SQL_HEX: usize = 4000;
/// `N'..'` pieces in plain SQL, in characters.
const ORA_SQL_NCHARS: usize = 1000;
/// PL/SQL string literals reach 32767 bytes: the pieces of a LOB built in a block.
const ORA_PLSQL_TEXT: usize = 30000;
const ORA_PLSQL_NCHARS: usize = 5000;
const ORA_PLSQL_HEX: usize = 30000;
/// A CLOB of more literal pieces than this is built in a PL/SQL block instead of a `||` chain.
const ORA_CHAIN_MAX: usize = 8;
/// `INSERT ALL` takes at most about a thousand values: rows x columns stays below.
const ORA_MAX_VALUES: usize = 990;
/// A batch is written once its text reaches this size, whatever `batch_size` says.
const ORA_MAX_BATCH_BYTES: usize = 1 << 20;

/// How a column's value is written as a literal (derived from the dictionary's `DATA_TYPE`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OraKind {
    Text,
    NText,
    Clob,
    NClob,
    Number,
    BinFloat,
    BinDouble,
    Date,
    Timestamp,
    TimestampTz,
    IntervalDs,
    IntervalYm,
    Raw,
    Blob,
    Bool,
}

fn ora_kind(data_type: &str) -> OraKind {
    let t = data_type.trim().to_ascii_uppercase();
    match t.as_str() {
        "NVARCHAR2" | "NCHAR" => OraKind::NText,
        "CLOB" => OraKind::Clob,
        "NCLOB" => OraKind::NClob,
        "NUMBER" | "FLOAT" => OraKind::Number,
        "BINARY_FLOAT" => OraKind::BinFloat,
        "BINARY_DOUBLE" => OraKind::BinDouble,
        "DATE" => OraKind::Date,
        "RAW" | "LONG RAW" => OraKind::Raw,
        "BLOB" => OraKind::Blob,
        "BOOLEAN" => OraKind::Bool,
        _ if t.starts_with("TIMESTAMP") => {
            if t.contains("TIME ZONE") {
                OraKind::TimestampTz
            } else {
                OraKind::Timestamp
            }
        }
        _ if t.starts_with("INTERVAL DAY") => OraKind::IntervalDs,
        _ if t.starts_with("INTERVAL YEAR") => OraKind::IntervalYm,
        _ => OraKind::Text,
    }
}

/// `s` cut into pieces of at most `max` bytes, on character boundaries.
fn ora_text_pieces(s: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < s.len() {
        let mut end = (start + max).min(s.len());
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        out.push(&s[start..end]);
        start = end;
    }
    out
}

/// `s` cut into pieces of at most `max` characters.
fn ora_char_pieces(s: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut n = 0;
    for (i, _) in s.char_indices() {
        if n == max {
            out.push(&s[start..i]);
            start = i;
            n = 0;
        }
        n += 1;
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// A value as SQL text, or a LOB too long for a `||` chain that a PL/SQL block has to assemble.
#[derive(Debug, Clone, PartialEq, Eq)]
enum OraLit {
    Sql(String),
    /// `var` is the PL/SQL type of the temporary LOB, `pieces` the expressions `DBMS_LOB.APPEND` adds (for a
    /// BLOB: hex text, converted from a variable: the server needs time quadratic in the size of a literal
    /// `HEXTORAW` argument).
    Lob {
        var: &'static str,
        pieces: Vec<String>,
    },
}

fn ora_q(s: &str) -> String {
    quote_literal(Driver::Oracle, s)
}

/// Text: a plain literal up to 4000 bytes, `TO_CLOB` pieces joined by `||` up to [`ORA_CHAIN_MAX`] pieces, else a
/// PL/SQL block. `nat`: NVARCHAR2 / NCHAR / NCLOB (`N'..'`, `TO_NCLOB`).
fn ora_text_lit(s: &str, nat: bool) -> OraLit {
    if nat {
        let pieces = ora_char_pieces(s, ORA_SQL_NCHARS);
        if pieces.len() <= 1 {
            return OraLit::Sql(format!("N{}", ora_q(s)));
        }
        if pieces.len() <= ORA_CHAIN_MAX {
            return OraLit::Sql(
                pieces
                    .iter()
                    .map(|p| format!("TO_NCLOB(N{})", ora_q(p)))
                    .collect::<Vec<_>>()
                    .join(" || "),
            );
        }
        return OraLit::Lob {
            var: "NCLOB",
            pieces: ora_char_pieces(s, ORA_PLSQL_NCHARS)
                .iter()
                .map(|p| format!("TO_NCLOB(N{})", ora_q(p)))
                .collect(),
        };
    }
    if s.len() <= 4000 {
        return OraLit::Sql(ora_q(s));
    }
    let pieces = ora_text_pieces(s, ORA_SQL_TEXT);
    if pieces.len() <= ORA_CHAIN_MAX {
        return OraLit::Sql(
            pieces
                .iter()
                .map(|p| format!("TO_CLOB({})", ora_q(p)))
                .collect::<Vec<_>>()
                .join(" || "),
        );
    }
    OraLit::Lob {
        var: "CLOB",
        pieces: ora_text_pieces(s, ORA_PLSQL_TEXT)
            .iter()
            .map(|p| format!("TO_CLOB({})", ora_q(p)))
            .collect(),
    }
}

/// BLOB bytes (hex text): `TO_BLOB(HEXTORAW('..'))` up to 2000 bytes (the limit of a SQL RAW). `||` does not
/// join BLOBs (ORA-01465 / ORA-22849), so a longer one is built in a PL/SQL block from `DBMS_LOB.APPEND` pieces
/// (the pieces of a [`OraLit::Lob`] of a BLOB are hex text).
fn ora_blob_lit(hex: &str) -> OraLit {
    if hex.is_empty() {
        return OraLit::Sql("EMPTY_BLOB()".into());
    }
    if hex.len() <= ORA_SQL_HEX {
        return OraLit::Sql(format!("TO_BLOB(HEXTORAW('{hex}'))"));
    }
    OraLit::Lob {
        var: "BLOB",
        pieces: hex
            .as_bytes()
            .chunks(ORA_PLSQL_HEX)
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect(),
    }
}

/// RAW bytes (hex text): `HEXTORAW('..')`; more than a literal holds (extended RAW columns) is joined with
/// `UTL_RAW.CONCAT` (`||` would turn the pieces into text). An empty value is NULL, as in the column.
fn ora_raw_lit(hex: &str) -> String {
    if hex.is_empty() {
        return "NULL".into();
    }
    let mut it = hex
        .as_bytes()
        .chunks(ORA_SQL_HEX)
        .map(|p| format!("HEXTORAW('{}')", String::from_utf8_lossy(p)));
    let first = it.next().unwrap_or_default();
    it.fold(first, |acc, p| format!("UTL_RAW.CONCAT({acc}, {p})"))
}

/// `BINARY_FLOAT` / `BINARY_DOUBLE` value (a JSON number, or the text `NaN` / `Infinity` / `-Infinity`).
fn ora_float_lit(c: &Value, double: bool) -> String {
    let (to, nan, inf) = if double {
        (
            "TO_BINARY_DOUBLE",
            "BINARY_DOUBLE_NAN",
            "BINARY_DOUBLE_INFINITY",
        )
    } else {
        (
            "TO_BINARY_FLOAT",
            "BINARY_FLOAT_NAN",
            "BINARY_FLOAT_INFINITY",
        )
    };
    match c {
        Value::Number(n) => format!("{to}('{:e}')", n.as_f64().unwrap_or(0.0)),
        Value::String(s) => match s.as_str() {
            "NaN" => nan.into(),
            "Infinity" => inf.into(),
            "-Infinity" => format!("-{inf}"),
            other => format!("{to}({})", ora_q(other)),
        },
        other => format!("{to}({})", ora_q(&other.to_string())),
    }
}

/// The literal of a cell of a column of `kind`: NLS independent (`TO_DATE` / `TO_TIMESTAMP(_TZ)` with explicit
/// formats, exact `NUMBER` text, `TO_BINARY_*`, `HEXTORAW`, `TO_CLOB` pieces, `N'..'`).
fn ora_literal(c: &Value, kind: OraKind) -> OraLit {
    let sql = |s: String| OraLit::Sql(s);
    match (c, kind) {
        (Value::Null, _) => sql("NULL".into()),
        (Value::Bool(b), OraKind::Bool) => sql(if *b { "TRUE" } else { "FALSE" }.into()),
        (Value::Bool(b), _) => sql(if *b { "1" } else { "0" }.into()),
        (_, OraKind::BinFloat) => sql(ora_float_lit(c, false)),
        (_, OraKind::BinDouble) => sql(ora_float_lit(c, true)),
        (Value::Number(n), _) => sql(n.to_string()),
        (Value::String(s), OraKind::Number) => {
            let t = s.trim();
            if t.parse::<f64>().is_ok_and(f64::is_finite) && !t.is_empty() {
                sql(t.to_string())
            } else {
                sql(ora_q(s))
            }
        }
        (Value::String(s), OraKind::Date | OraKind::Timestamp | OraKind::TimestampTz) => {
            let k = match kind {
                OraKind::Date => OracleTimeKind::Date,
                OraKind::Timestamp => OracleTimeKind::Timestamp,
                _ => OracleTimeKind::TimestampTz,
            };
            sql(oracle_time_literal(k, s).unwrap_or_else(|| ora_q(s)))
        }
        (Value::String(s), OraKind::IntervalDs) => sql(format!("TO_DSINTERVAL({})", ora_q(s))),
        (Value::String(s), OraKind::IntervalYm) => sql(format!("TO_YMINTERVAL({})", ora_q(s))),
        (Value::Object(m), OraKind::Raw | OraKind::Blob) if m.contains_key("$bin") => {
            let hex = m["$bin"].as_str().unwrap_or("");
            if kind == OraKind::Blob {
                ora_blob_lit(hex)
            } else {
                sql(ora_raw_lit(hex))
            }
        }
        (Value::Object(m), _) if m.contains_key("$bin") => {
            sql(ora_raw_lit(m["$bin"].as_str().unwrap_or("")))
        }
        (Value::String(s), OraKind::NText | OraKind::NClob) => ora_text_lit(s, true),
        (Value::String(s), _) => ora_text_lit(s, false),
        (other, _) => sql(ora_q(&other.to_string())),
    }
}

/// `INSERT INTO dst (cols) VALUES (..);`, or `INSERT ALL .. SELECT 1 FROM DUAL;` for several rows.
fn ora_insert_stmt(dst: &str, cols: &str, rows: &[String]) -> String {
    if rows.len() == 1 {
        return format!("INSERT INTO {dst} ({cols}) VALUES {};", rows[0]);
    }
    let mut out = String::from("INSERT ALL\n");
    for r in rows {
        out.push_str(&format!("    INTO {dst} ({cols}) VALUES {r}\n"));
    }
    out.push_str("SELECT 1 FROM DUAL;");
    out
}

/// One row with a LOB too long for a literal chain: an anonymous block that builds the LOBs in temporary
/// LOBs and inserts the row (ends with the `/` line the splitter wants).
fn ora_block_insert(dst: &str, cols: &str, lits: &[OraLit]) -> String {
    let mut decl = String::new();
    let mut body = String::new();
    let mut free = String::new();
    let mut vals = Vec::new();
    let mut hex_var = false;
    for (i, l) in lits.iter().enumerate() {
        match l {
            OraLit::Sql(e) => vals.push(e.clone()),
            OraLit::Lob { var, pieces } => {
                let v = format!("v{i}");
                decl.push_str(&format!("    {v} {var};\n"));
                body.push_str(&format!("    DBMS_LOB.CREATETEMPORARY({v}, TRUE);\n"));
                for p in pieces {
                    if *var == "BLOB" {
                        body.push_str(&format!(
                            "    h := '{p}';\n    DBMS_LOB.APPEND({v}, TO_BLOB(HEXTORAW(h)));\n"
                        ));
                        hex_var = true;
                    } else {
                        body.push_str(&format!("    DBMS_LOB.APPEND({v}, {p});\n"));
                    }
                }
                free.push_str(&format!("    DBMS_LOB.FREETEMPORARY({v});\n"));
                vals.push(v);
            }
        }
    }
    if hex_var {
        decl.push_str("    h VARCHAR2(32767);\n");
    }
    format!(
        "DECLARE\n{decl}BEGIN\n{body}    INSERT INTO {dst} ({cols}) VALUES ({});\n{free}END;\n/",
        vals.join(", ")
    )
}

/// A PL/SQL block that runs `DROP <what>` and ignores the "does not exist" errors in `ignore`.
fn ora_drop_block(what: &str, ignore: &[i32]) -> String {
    let codes: Vec<String> = ignore.iter().map(|c| c.to_string()).collect();
    format!(
        "BEGIN\n    EXECUTE IMMEDIATE {};\nEXCEPTION\n    WHEN OTHERS THEN\n        IF SQLCODE NOT IN ({}) THEN\n            RAISE;\n        END IF;\nEND;\n/",
        ora_q(&format!("DROP {what}")),
        codes.join(", ")
    )
}

/// `ORA-00942` table or view, `ORA-02289` sequence, `ORA-04043` object.
const ORA_DROP_MISSING: [i32; 3] = [-942, -2289, -4043];

/// `NUMBER(10,2)`, `VARCHAR2(50 CHAR)`, `TIMESTAMP(6) WITH TIME ZONE`, `RAW(16)`, ... of a row of the
/// columns query (`data_type`, `data_type_owner`, `data_length`, `data_precision`, `data_scale`,
/// `char_length`, `char_used` at 2..=8).
fn ora_col_type(r: &Row, schema: &str) -> String {
    let t = s(r, 2);
    let (len, prec, scale, chars) = (s(r, 4), s(r, 5), s(r, 6), s(r, 7));
    match t.as_str() {
        "VARCHAR2" | "CHAR" => format!(
            "{t}({chars} {})",
            if s(r, 8) == "C" { "CHAR" } else { "BYTE" }
        ),
        "NVARCHAR2" | "NCHAR" => format!("{t}({chars})"),
        "NUMBER" => match (prec.is_empty(), scale.is_empty()) {
            (true, true) => "NUMBER".into(),
            (true, false) => format!("NUMBER(*,{scale})"),
            (false, _) if scale.is_empty() || scale == "0" => format!("NUMBER({prec})"),
            _ => format!("NUMBER({prec},{scale})"),
        },
        "FLOAT" => format!("FLOAT({prec})"),
        "RAW" | "UROWID" => format!("{t}({len})"),
        _ => {
            let owner = s(r, 3);
            if owner.is_empty() {
                t
            } else if owner == schema {
                quote_ident(Driver::Oracle, &t)
            } else {
                format!(
                    "{}.{}",
                    quote_ident(Driver::Oracle, &owner),
                    quote_ident(Driver::Oracle, &t)
                )
            }
        }
    }
}

/// `INCREMENT BY .. MINVALUE .. MAXVALUE .. CYCLE | NOCYCLE CACHE n | NOCACHE ORDER | NOORDER`.
fn ora_seq_options(
    inc: &str,
    min: &str,
    max: &str,
    cycle: bool,
    order: bool,
    cache: &str,
) -> String {
    format!(
        "INCREMENT BY {inc} MINVALUE {min} MAXVALUE {max} {} {} {}",
        if cycle { "CYCLE" } else { "NOCYCLE" },
        if cache.is_empty() || cache == "0" || cache == "1" {
            "NOCACHE".to_string()
        } else {
            format!("CACHE {cache}")
        },
        if order { "ORDER" } else { "NOORDER" }
    )
}

/// `START WITH: 5, INCREMENT BY: 1, ...` (`IDENTITY_OPTIONS`) -> `5`.
fn ora_identity_start(options: &str) -> Option<String> {
    let rest = options.split("START WITH:").nth(1)?;
    let v = rest.split(',').next()?.trim();
    (!v.is_empty()).then(|| v.to_string())
}

#[derive(Debug, Clone)]
struct OraIdentity {
    always: bool,
    on_null: bool,
    /// The sequence's next value (`LAST_NUMBER`) and the one it started with.
    last: String,
    first: String,
    options: String,
}

#[derive(Debug, Clone)]
struct OraCol {
    name: String,
    /// Type as written in `create table`.
    ty: String,
    /// Upper-case `DATA_TYPE`.
    base: String,
    kind: OraKind,
    nullable: bool,
    default: Option<String>,
    default_on_null: bool,
    virtual_expr: Option<String>,
    identity: Option<OraIdentity>,
    invisible: bool,
}

/// Row of the columns query -> column.
fn ora_col(r: &Row, schema: &str) -> OraCol {
    let default = Some(s(r, 10).trim().to_string()).filter(|d| !d.is_empty());
    let identity = (s(r, 11) == "YES").then(|| OraIdentity {
        always: s(r, 15) == "ALWAYS",
        on_null: s(r, 13) == "YES",
        last: s(r, 16),
        first: ora_identity_start(&s(r, 23)).unwrap_or_else(|| "1".into()),
        options: ora_seq_options(
            &s(r, 17),
            &s(r, 18),
            &s(r, 19),
            s(r, 20) == "Y",
            s(r, 21) == "Y",
            &s(r, 22),
        ),
    });
    let virt = s(r, 12) == "YES";
    OraCol {
        name: s(r, 1),
        ty: ora_col_type(r, schema),
        base: s(r, 2).to_ascii_uppercase(),
        kind: ora_kind(&s(r, 2)),
        nullable: s(r, 9) != "N",
        default: if identity.is_some() || virt {
            None
        } else {
            default.clone()
        },
        default_on_null: s(r, 13) == "YES",
        virtual_expr: if virt { default } else { None },
        identity,
        invisible: s(r, 14) == "YES",
    }
}

/// One column of `create table`. `data`: rows will follow, so an `ALWAYS` identity is created `BY DEFAULT` (the
/// rows carry their values) and switched back afterwards. `in_pk`: the primary key makes it `NOT NULL`.
fn ora_col_line(c: &OraCol, data: bool, in_pk: bool, fix: &dyn Fn(&str) -> String) -> String {
    let mut l = format!("{} {}", quote_ident(Driver::Oracle, &c.name), c.ty);
    if c.invisible {
        l.push_str(" INVISIBLE");
    }
    if let Some(e) = &c.virtual_expr {
        l.push_str(&format!(" GENERATED ALWAYS AS ({}) VIRTUAL", fix(e)));
    } else if let Some(i) = &c.identity {
        let start = if data { &i.last } else { &i.first };
        let start = if start.is_empty() { &i.first } else { start };
        let kind = if i.always && !data {
            "ALWAYS"
        } else if i.on_null {
            "BY DEFAULT ON NULL"
        } else {
            "BY DEFAULT"
        };
        l.push_str(&format!(
            " GENERATED {kind} AS IDENTITY (START WITH {start} {})",
            i.options
        ));
    } else if let Some(d) = &c.default {
        l.push_str(&format!(
            " DEFAULT {}{}",
            if c.default_on_null { "ON NULL " } else { "" },
            fix(d)
        ));
    }
    if !c.nullable && c.identity.is_none() && c.virtual_expr.is_none() && !in_pk {
        l.push_str(" NOT NULL");
    }
    l
}

/// `TO_CHAR` of the time-zone types, so the zone survives whatever the driver does with it; other columns as is.
fn ora_select_expr(c: &OraCol) -> String {
    let q = quote_ident(Driver::Oracle, &c.name);
    const FMT: &str = "'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM'";
    if c.kind == OraKind::TimestampTz {
        let v = if c.base.contains("LOCAL") {
            format!("CAST({q} AS TIMESTAMP WITH TIME ZONE)")
        } else {
            q.clone()
        };
        format!("TO_CHAR({v}, {FMT}) AS {q}")
    } else {
        q
    }
}

/// `CHECK` condition that only says a column is `NOT NULL` (the column carries that).
fn ora_is_not_null_check(cond: &str) -> bool {
    let c = cond.trim();
    c.starts_with('"')
        && c.ends_with(" IS NOT NULL")
        && c[1..c.len() - " IS NOT NULL".len()].matches('"').count() == 1
}

/// Constraint attributes after the definition.
fn ora_con_tail(deferrable: &str, deferred: &str, status: &str) -> String {
    let mut t = String::new();
    if deferrable == "DEFERRABLE" {
        t.push_str(if deferred == "DEFERRED" {
            " DEFERRABLE INITIALLY DEFERRED"
        } else {
            " DEFERRABLE"
        });
    }
    if status == "DISABLED" {
        t.push_str(" DISABLE");
    }
    t
}

struct OraTable {
    name: String,
    /// Global temporary table: `ON COMMIT ..` clause.
    temp: Option<&'static str>,
    iot: bool,
    partitioned: bool,
    cols: Vec<OraCol>,
    /// Primary key, unique and check constraints (inline `create table` lines).
    items: Vec<String>,
    pk_cols: Vec<String>,
}

impl OraTable {
    fn create_sql(&self, data: bool, fix: &dyn Fn(&str) -> String) -> String {
        let mut lines: Vec<String> = self
            .cols
            .iter()
            .map(|c| {
                format!(
                    "    {}",
                    ora_col_line(c, data, self.pk_cols.contains(&c.name), fix)
                )
            })
            .collect();
        lines.extend(self.items.iter().map(|i| format!("    {i}")));
        let head = if self.temp.is_some() {
            "CREATE GLOBAL TEMPORARY TABLE"
        } else {
            "CREATE TABLE"
        };
        let mut out = format!(
            "{head} {}\n(\n{}\n)",
            quote_ident(Driver::Oracle, &self.name),
            lines.join(",\n")
        );
        if let Some(t) = self.temp {
            out.push_str(&format!("\nON COMMIT {t}"));
        }
        if self.iot {
            out.push_str("\nORGANIZATION INDEX");
        }
        out.push(';');
        out
    }
}

/// Streams the rows of `t` and writes them as `INSERT` statements; `COMMIT` every `commit_every` rows and at
/// the end. Returns the number of rows written.
#[allow(clippy::too_many_arguments)]
async fn dump_rows_ora<W: Write>(
    live: &Live,
    w: &mut W,
    schema: &str,
    t: &OraTable,
    opts: &DumpOptions,
    cancel: &CancellationToken,
    progress: &(dyn Fn(DumpProgress) + Send + Sync),
    tables_done: usize,
    tables_total: usize,
) -> Result<u64> {
    let d = Driver::Oracle;
    let cols: Vec<&OraCol> = t.cols.iter().filter(|c| c.virtual_expr.is_none()).collect();
    if cols.is_empty() {
        return Ok(0);
    }
    let cols_q = cols
        .iter()
        .map(|c| quote_ident(d, &c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let dst = quote_ident(d, &t.name);
    let sql = format!(
        "select {} from {}",
        cols.iter()
            .map(|c| ora_select_expr(c))
            .collect::<Vec<_>>()
            .join(", "),
        qualified(d, Some(schema), &t.name)
    );
    let per_stmt = opts
        .batch_size
        .max(1)
        .min((ORA_MAX_VALUES / cols.len()).max(1));
    let commit_every = opts.commit_every as u64;

    let mut rows = 0u64;
    let mut since_commit = 0u64;
    let mut batch: Vec<String> = Vec::new();
    let mut batch_bytes = 0usize;
    let flush = |w: &mut W,
                 batch: &mut Vec<String>,
                 batch_bytes: &mut usize,
                 since: &mut u64|
     -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        writeln!(w, "{}", ora_insert_stmt(&dst, &cols_q, batch))?;
        *since += batch.len() as u64;
        batch.clear();
        *batch_bytes = 0;
        if commit_every > 0 && *since >= commit_every {
            writeln!(w, "COMMIT;")?;
            *since = 0;
        }
        Ok(())
    };
    query_pool(live, &sql, usize::MAX, |_, row| {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        let lits: Vec<OraLit> = row
            .iter()
            .zip(&cols)
            .map(|(c, col)| ora_literal(c, col.kind))
            .collect();
        rows += 1;
        if lits.iter().any(|l| matches!(l, OraLit::Lob { .. })) {
            // the batch before goes first: the rows keep their order
            flush(w, &mut batch, &mut batch_bytes, &mut since_commit)?;
            writeln!(w, "{}", ora_block_insert(&dst, &cols_q, &lits))?;
            since_commit += 1;
            if commit_every > 0 && since_commit >= commit_every {
                writeln!(w, "COMMIT;")?;
                since_commit = 0;
            }
        } else {
            let vals: Vec<String> = lits
                .into_iter()
                .map(|l| match l {
                    OraLit::Sql(e) => e,
                    OraLit::Lob { .. } => String::new(),
                })
                .collect();
            let tuple = format!("({})", vals.join(", "));
            batch_bytes += tuple.len();
            batch.push(tuple);
            if batch.len() >= per_stmt || batch_bytes >= ORA_MAX_BATCH_BYTES {
                flush(w, &mut batch, &mut batch_bytes, &mut since_commit)?;
            }
        }
        if rows.is_multiple_of(1000) {
            report_table(
                progress,
                "data",
                tables_done,
                tables_total,
                rows,
                Some(t.name.as_str()),
            );
        }
        Ok(())
    })
    .await?;
    flush(w, &mut batch, &mut batch_bytes, &mut since_commit)?;
    if since_commit > 0 {
        writeln!(w, "COMMIT;")?;
    }
    Ok(rows)
}

/// Source of one stored unit, wrapped as `CREATE OR REPLACE` + `/` line.
fn ora_unit_sql(text: &str) -> String {
    format!("CREATE OR REPLACE {}\n/", text.trim())
}

async fn dump_ora<W: Write>(
    live: &Live,
    schema: &str,
    opts: &DumpOptions,
    cancel: &CancellationToken,
    progress: &(dyn Fn(DumpProgress) + Send + Sync),
    w: &mut W,
    res: &mut DumpResult,
) -> Result<()> {
    let pool = &live.pool;
    let d = Driver::Oracle;
    let o = pl(d, schema);
    let qi = |n: &str| quote_ident(d, n);
    // with a target schema the dump runs in it: references to the source schema are made unqualified
    let rename = opts.target_schema.is_some();
    let fix = |t: &str| -> String {
        if rename {
            unqualify_schema(t, schema)
        } else {
            t.to_string()
        }
    };

    writeln!(w, "--")?;
    writeln!(w, "-- Prometeo DataGrip dump")?;
    writeln!(w, "-- {}", live.server_version)?;
    writeln!(w, "-- (SQL*Plus: run SET DEFINE OFF first)")?;
    writeln!(w, "--")?;
    writeln!(w)?;
    if let Some(t) = &opts.target_schema {
        writeln!(w, "ALTER SESSION SET CURRENT_SCHEMA = {};", qi(t))?;
        writeln!(w)?;
    }

    // ---- tables of the dump
    let table_rows = pool
        .query_strings(&format!(
            "select t.table_name, t.temporary, t.duration, t.iot_type, t.partitioned \
             from all_tables t \
             where t.owner = {o} and {} and t.table_name not like 'BIN$%' \
               and t.table_name not like 'SYS\\_%' escape '\\' and t.table_name not like 'MLOG$\\_%' escape '\\' \
               and t.table_name not like 'RUPD$\\_%' escape '\\' \
               and not exists (select 1 from all_external_tables x where x.owner = t.owner and x.table_name = t.table_name) \
             order by t.table_name",
            crate::introspect::ora_table_filter("t")
        ))
        .await?;
    let table_rows: Vec<&Row> = table_rows
        .iter()
        .filter(|r| wanted(&opts.tables, &s(r, 0)))
        .collect();
    let names: Vec<String> = table_rows.iter().map(|r| s(r, 0)).collect();

    // ---- columns (tables and views) in one query
    let col_rows = pool
        .query_strings(&format!(
            "select c.table_name, c.column_name, c.data_type, c.data_type_owner, c.data_length, c.data_precision, \
                    c.data_scale, c.char_length, c.char_used, c.nullable, c.data_default_vc, c.identity_column, \
                    c.virtual_column, c.default_on_null, c.hidden_column, \
                    i.generation_type, sq.last_number, sq.increment_by, sq.min_value, sq.max_value, sq.cycle_flag, \
                    sq.order_flag, sq.cache_size, i.identity_options \
             from all_tab_cols c \
             left join all_tab_identity_cols i on i.owner = c.owner and i.table_name = c.table_name and i.column_name = c.column_name \
             left join all_sequences sq on sq.sequence_owner = i.owner and sq.sequence_name = i.sequence_name \
             where c.owner = {o} and c.user_generated = 'YES' \
             order by c.table_name, c.internal_column_id"
        ))
        .await?;
    let mut cols_of: HashMap<String, Vec<OraCol>> = HashMap::new();
    for r in &col_rows {
        cols_of.entry(s(r, 0)).or_default().push(ora_col(r, schema));
    }

    // ---- primary key, unique and check constraints
    let con_rows = pool
        .query_strings(&format!(
            "select c.table_name, c.constraint_name, c.constraint_type, c.search_condition_vc, c.generated, c.status, \
                    c.deferrable, c.deferred, cc.column_name \
             from all_constraints c \
             left join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name \
             where c.owner = {o} and c.constraint_type in ('P', 'U', 'C') \
             order by c.table_name, decode(c.constraint_type, 'P', 1, 'U', 2, 3), c.constraint_name, cc.position"
        ))
        .await?;
    let mut items_of: HashMap<String, Vec<String>> = HashMap::new();
    let mut pk_of: HashMap<String, Vec<String>> = HashMap::new();
    {
        // one entry per constraint, its columns collected
        let mut cur: Option<(String, String, Vec<String>, &Row)> = None;
        let mut finish = |c: Option<(String, String, Vec<String>, &Row)>| {
            let Some((table, name, columns, r)) = c else {
                return;
            };
            let kind = s(r, 2);
            let cond = s(r, 3);
            let named = if s(r, 4) == "GENERATED NAME" {
                String::new()
            } else {
                format!("CONSTRAINT {} ", qi(&name))
            };
            let tail = ora_con_tail(&s(r, 6), &s(r, 7), &s(r, 5));
            let cols_q = columns.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ");
            let line = match kind.as_str() {
                "P" => {
                    pk_of.insert(table.clone(), columns.clone());
                    format!("{named}PRIMARY KEY ({cols_q}){tail}")
                }
                "U" => format!("{named}UNIQUE ({cols_q}){tail}"),
                _ => {
                    if cond.is_empty() || ora_is_not_null_check(&cond) {
                        return;
                    }
                    format!("{named}CHECK ({}){tail}", fix(&cond))
                }
            };
            items_of.entry(table).or_default().push(line);
        };
        for r in &con_rows {
            let key = (s(r, 0), s(r, 1));
            match &mut cur {
                Some((t, n, cols, _)) if *t == key.0 && *n == key.1 => {
                    if !s(r, 8).is_empty() {
                        cols.push(s(r, 8));
                    }
                }
                _ => {
                    finish(cur.take());
                    let first = if s(r, 8).is_empty() {
                        vec![]
                    } else {
                        vec![s(r, 8)]
                    };
                    cur = Some((key.0, key.1, first, r));
                }
            }
        }
        finish(cur.take());
    }

    // ---- foreign keys (one row per column)
    let fk_rows = pool
        .query_strings(&format!(
            "select c.table_name, c.constraint_name, c.generated, c.delete_rule, c.status, c.deferrable, c.deferred, \
                    cc.column_name, r.owner, r.table_name, rc.column_name \
             from all_constraints c \
             join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name \
             join all_constraints r on r.owner = c.r_owner and r.constraint_name = c.r_constraint_name \
             join all_cons_columns rc on rc.owner = r.owner and rc.constraint_name = r.constraint_name and rc.position = cc.position \
             where c.owner = {o} and c.constraint_type = 'R' \
             order by c.table_name, c.constraint_name, cc.position"
        ))
        .await?;
    let mut edges: Vec<(String, String)> = Vec::new();
    // (table, referenced table in this schema or "", statement)
    let mut fk_stmts: Vec<(String, String, String)> = Vec::new();
    {
        let mut i = 0;
        while i < fk_rows.len() {
            let head = &fk_rows[i];
            let (table, con) = (s(head, 0), s(head, 1));
            let mut j = i;
            let (mut cols, mut refs) = (Vec::new(), Vec::new());
            while j < fk_rows.len() && s(&fk_rows[j], 0) == table && s(&fk_rows[j], 1) == con {
                cols.push(qi(&s(&fk_rows[j], 7)));
                refs.push(qi(&s(&fk_rows[j], 10)));
                j += 1;
            }
            let same = s(head, 8) == schema;
            let ref_table = s(head, 9);
            let target = if same {
                qi(&ref_table)
            } else {
                qualified(d, Some(&s(head, 8)), &ref_table)
            };
            let on_delete = match s(head, 3).as_str() {
                "CASCADE" => " ON DELETE CASCADE",
                "SET NULL" => " ON DELETE SET NULL",
                _ => "",
            };
            let named = if s(head, 2) == "GENERATED NAME" {
                String::new()
            } else {
                format!("CONSTRAINT {} ", qi(&con))
            };
            fk_stmts.push((
                table.clone(),
                if same { ref_table.clone() } else { String::new() },
                format!(
                    "ALTER TABLE {}\n    ADD {named}FOREIGN KEY ({}) REFERENCES {target} ({}){on_delete}{};",
                    qi(&table),
                    cols.join(", "),
                    refs.join(", "),
                    ora_con_tail(&s(head, 5), &s(head, 6), &s(head, 4))
                ),
            ));
            if same && ref_table != table {
                edges.push((ref_table, table));
            }
            i = j;
        }
    }

    // ---- table definitions
    let mut defs: HashMap<String, OraTable> = HashMap::new();
    for r in &table_rows {
        let name = s(r, 0);
        defs.insert(
            name.clone(),
            OraTable {
                name: name.clone(),
                temp: (s(r, 1) == "Y").then(|| {
                    if s(r, 2) == "SYS$SESSION" {
                        "PRESERVE ROWS"
                    } else {
                        "DELETE ROWS"
                    }
                }),
                iot: s(r, 3) == "IOT",
                partitioned: s(r, 4) == "YES",
                cols: cols_of.get(&name).cloned().unwrap_or_default(),
                items: items_of.remove(&name).unwrap_or_default(),
                pk_cols: pk_of.remove(&name).unwrap_or_default(),
            },
        );
    }
    let order = topo_sort(&names, &edges);
    let total = order.len();
    report(progress, "schema", 0, total, res.rows);

    // ---- comments
    let mut tab_comments: HashMap<String, String> = HashMap::new();
    let mut col_comments: HashMap<String, Vec<(String, String)>> = HashMap::new();
    if opts.include_ddl {
        for r in pool
            .query_strings(&format!(
                "select table_name, comments from all_tab_comments where owner = {o} and comments is not null"
            ))
            .await?
        {
            tab_comments.insert(s(&r, 0), s(&r, 1));
        }
        for r in pool
            .query_strings(&format!(
                "select table_name, column_name, comments from all_col_comments where owner = {o} and comments is not null \
                 order by table_name, column_name"
            ))
            .await?
        {
            col_comments.entry(s(&r, 0)).or_default().push((s(&r, 1), s(&r, 2)));
        }
    }
    let write_comments = |w: &mut W, name: &str| -> Result<()> {
        if let Some(c) = tab_comments.get(name) {
            writeln!(w, "COMMENT ON TABLE {} IS {};", qi(name), ora_q(c))?;
        }
        for (col, c) in col_comments.get(name).into_iter().flatten() {
            writeln!(
                w,
                "COMMENT ON COLUMN {}.{} IS {};",
                qi(name),
                qi(col),
                ora_q(c)
            )?;
        }
        Ok(())
    };

    // ---- sequences (standalone; the identity sequences belong to their table)
    if opts.include_ddl && opts.include_sequences && opts.tables.is_none() {
        let rows = pool
            .query_strings(&format!(
                "select sequence_name, min_value, max_value, increment_by, cycle_flag, order_flag, cache_size, last_number \
                 from all_sequences where sequence_owner = {o} \
                   and sequence_name not like 'ISEQ$$\\_%' escape '\\' and sequence_name not like 'SYS\\_%' escape '\\' \
                 order by sequence_name"
            ))
            .await?;
        for r in &rows {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let name = s(r, 0);
            let ascending = !s(r, 3).starts_with('-');
            let start = if opts.data {
                s(r, 7)
            } else if ascending {
                s(r, 1)
            } else {
                s(r, 2)
            };
            if opts.drop_if_exists {
                writeln!(
                    w,
                    "{}",
                    ora_drop_block(&format!("SEQUENCE {}", qi(&name)), &ORA_DROP_MISSING)
                )?;
            }
            writeln!(
                w,
                "CREATE SEQUENCE {} START WITH {start} {};",
                qi(&name),
                ora_seq_options(
                    &s(r, 3),
                    &s(r, 1),
                    &s(r, 2),
                    s(r, 4) == "Y",
                    s(r, 5) == "Y",
                    &s(r, 6)
                )
            )?;
        }
        if !rows.is_empty() {
            writeln!(w)?;
        }
    }

    // ---- create tables + data
    for (i, name) in order.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        let t = &defs[name];
        let with_data = opts.data && t.temp.is_none();
        let identities: Vec<&OraCol> = t.cols.iter().filter(|c| c.identity.is_some()).collect();
        report_table(progress, "tables", i, total, res.rows, Some(name));
        if opts.include_ddl {
            writeln!(w, "--")?;
            writeln!(w, "-- Name: {}; Type: TABLE", name)?;
            writeln!(w, "--")?;
            if t.partitioned {
                writeln!(
                    w,
                    "-- partitioned in the source: the partitions are not dumped"
                )?;
            }
            if opts.drop_if_exists {
                writeln!(
                    w,
                    "{}",
                    ora_drop_block(
                        &format!("TABLE {} CASCADE CONSTRAINTS PURGE", qi(name)),
                        &ORA_DROP_MISSING
                    )
                )?;
            }
            writeln!(w, "{}", t.create_sql(with_data, &fix))?;
            write_comments(w, name)?;
            writeln!(w)?;
        }
        if with_data {
            // rows carry their own identity values: an ALWAYS identity accepts them only as BY DEFAULT
            if !opts.include_ddl {
                for c in identities
                    .iter()
                    .filter(|c| c.identity.as_ref().is_some_and(|i| i.always))
                {
                    writeln!(
                        w,
                        "ALTER TABLE {} MODIFY ({} GENERATED BY DEFAULT AS IDENTITY);",
                        qi(name),
                        qi(&c.name)
                    )?;
                }
            }
            let rows =
                dump_rows_ora(live, w, schema, t, opts, cancel, progress, i + 1, total).await?;
            res.rows += rows;
            // the identity sequences continue after the data
            for c in &identities {
                let Some(id) = &c.identity else { continue };
                if !opts.include_ddl && !id.last.is_empty() {
                    writeln!(
                        w,
                        "ALTER TABLE {} MODIFY ({} GENERATED BY DEFAULT AS IDENTITY (RESTART START WITH {}));",
                        qi(name),
                        qi(&c.name),
                        id.last
                    )?;
                }
                if id.always {
                    writeln!(
                        w,
                        "ALTER TABLE {} MODIFY ({} GENERATED ALWAYS AS IDENTITY);",
                        qi(name),
                        qi(&c.name)
                    )?;
                }
            }
            writeln!(w)?;
        }
        res.tables += 1;
        report_table(progress, "tables", i + 1, total, res.rows, None);
    }

    // ---- indexes (the ones no constraint creates)
    if opts.include_ddl {
        report(progress, "indexes", total, total, res.rows);
        let idx_rows = pool
            .query_strings(&format!(
                "select i.table_name, i.index_name, i.uniqueness, i.index_type, ic.column_name, ic.descend, \
                        e.column_expression \
                 from all_indexes i \
                 join all_ind_columns ic on ic.index_owner = i.owner and ic.index_name = i.index_name \
                 left join all_ind_expressions e on e.index_owner = i.owner and e.index_name = i.index_name \
                                                and e.column_position = ic.column_position \
                 where i.table_owner = {o} and i.owner = {o} and i.generated = 'N' \
                   and i.index_type not in ('LOB', 'IOT - TOP', 'DOMAIN', 'CLUSTER') \
                   and not exists (select 1 from all_constraints k where k.owner = i.owner and k.index_name = i.index_name) \
                 order by i.table_name, i.index_name, ic.column_position"
            ))
            .await?;
        let mut i = 0;
        while i < idx_rows.len() {
            let head = &idx_rows[i];
            let (table, index) = (s(head, 0), s(head, 1));
            let mut cols = Vec::new();
            let mut j = i;
            while j < idx_rows.len() && s(&idx_rows[j], 1) == index && s(&idx_rows[j], 0) == table {
                let r = &idx_rows[j];
                let mut c = if s(r, 6).is_empty() {
                    qi(&s(r, 4))
                } else {
                    fix(&s(r, 6))
                };
                if s(r, 5) == "DESC" {
                    c.push_str(" DESC");
                }
                cols.push(c);
                j += 1;
            }
            i = j;
            if !defs.contains_key(&table) {
                continue;
            }
            let ty = s(head, 3);
            let kind = if ty.contains("BITMAP") {
                "BITMAP "
            } else if s(head, 2) == "UNIQUE" {
                "UNIQUE "
            } else {
                ""
            };
            writeln!(
                w,
                "CREATE {kind}INDEX {} ON {} ({}){};",
                qi(&index),
                qi(&table),
                cols.join(", "),
                if ty.ends_with("/REV") { " REVERSE" } else { "" }
            )?;
        }
    }

    // ---- foreign keys (the ones among the dumped tables)
    if opts.include_ddl {
        report(progress, "foreign keys", total, total, res.rows);
        for (table, referenced, stmt) in &fk_stmts {
            if defs.contains_key(table) && (referenced.is_empty() || defs.contains_key(referenced))
            {
                writeln!(w, "{stmt}")?;
            }
        }
        writeln!(w)?;
    }

    // ---- views (dependency order)
    if opts.include_ddl && opts.include_views && opts.tables.is_none() {
        report(progress, "views", total, total, res.rows);
        let views = pool
            .query_strings(&format!(
                "select view_name, text from all_views where owner = {o} order by view_name"
            ))
            .await?;
        let view_names: Vec<String> = views.iter().map(|r| s(r, 0)).collect();
        let dep_rows = pool
            .query_strings(&format!(
                "select name, referenced_name from all_dependencies \
                 where owner = {o} and type = 'VIEW' and referenced_owner = {o} and referenced_type = 'VIEW'"
            ))
            .await?;
        let view_edges: Vec<(String, String)> =
            dep_rows.iter().map(|r| (s(r, 1), s(r, 0))).collect();
        let con_rows = pool
            .query_strings(&format!(
                "select table_name, constraint_name, constraint_type from all_constraints \
                 where owner = {o} and constraint_type in ('O', 'V')"
            ))
            .await?;
        let text_of: HashMap<String, String> = views.iter().map(|r| (s(r, 0), s(r, 1))).collect();
        for v in topo_sort(&view_names, &view_edges) {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let cols = cols_of
                .get(&v)
                .map(|c| c.iter().map(|c| qi(&c.name)).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            let mut text = fix(text_of[&v].trim());
            // the dictionary text ends in `with check option` without the constraint's name
            if text.to_ascii_lowercase().ends_with("with check option") {
                if let Some(r) = con_rows.iter().find(|r| s(r, 0) == v && s(r, 2) == "V") {
                    text.push_str(&format!(" CONSTRAINT {}", qi(&s(r, 1))));
                }
            }
            // a trailing `--` comment would swallow the `;`
            if text.lines().last().is_some_and(|l| l.contains("--")) {
                text.push('\n');
            }
            writeln!(
                w,
                "CREATE OR REPLACE FORCE VIEW {} ({cols}) AS\n{text};",
                qi(&v)
            )?;
            write_comments(w, &v)?;
            writeln!(w)?;
        }
    }

    // ---- stored units: package specs, functions and procedures (dependency order), package bodies, triggers
    if opts.include_ddl && opts.include_routines && opts.tables.is_none() {
        report(progress, "routines", total, total, res.rows);
        let src_rows = pool
            .query_strings(&format!(
                "select name, type, text from all_source \
                 where owner = {o} and type in ('FUNCTION', 'PROCEDURE', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER') \
                   and name not like 'BIN$%' order by name, type, line"
            ))
            .await?;
        let mut units: HashMap<(String, String), String> = HashMap::new();
        for r in &src_rows {
            units
                .entry((s(r, 1), s(r, 0)))
                .or_default()
                .push_str(&s(r, 2));
        }
        let disabled: Vec<String> = pool
            .query_strings(&format!(
                "select trigger_name from all_triggers where owner = {o} and status = 'DISABLED'"
            ))
            .await?
            .iter()
            .map(|r| s(r, 0))
            .collect();
        let dep_rows = pool
            .query_strings(&format!(
                "select name, referenced_name from all_dependencies \
                 where owner = {o} and type in ('FUNCTION', 'PROCEDURE') and referenced_owner = {o} \
                   and referenced_type in ('FUNCTION', 'PROCEDURE')"
            ))
            .await?;
        let named = |ty: &str| -> Vec<String> {
            let mut v: Vec<String> = units
                .keys()
                .filter(|k| k.0 == ty)
                .map(|k| k.1.clone())
                .collect();
            v.sort();
            v
        };
        let mut subprograms = named("FUNCTION");
        subprograms.extend(named("PROCEDURE"));
        subprograms.sort();
        let sub_edges: Vec<(String, String)> =
            dep_rows.iter().map(|r| (s(r, 1), s(r, 0))).collect();
        let sub_order = topo_sort(&subprograms, &sub_edges);
        let mut plan: Vec<(String, String)> = Vec::new();
        plan.extend(
            named("PACKAGE")
                .into_iter()
                .map(|n| ("PACKAGE".to_string(), n)),
        );
        for n in sub_order {
            let ty = if units.contains_key(&("FUNCTION".to_string(), n.clone())) {
                "FUNCTION"
            } else {
                "PROCEDURE"
            };
            plan.push((ty.to_string(), n));
        }
        plan.extend(
            named("PACKAGE BODY")
                .into_iter()
                .map(|n| ("PACKAGE BODY".to_string(), n)),
        );
        plan.extend(
            named("TRIGGER")
                .into_iter()
                .map(|n| ("TRIGGER".to_string(), n)),
        );
        for (ty, name) in plan {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            let text = &units[&(ty.clone(), name.clone())];
            writeln!(w, "{}", ora_unit_sql(&fix(text)))?;
            if ty == "TRIGGER" && disabled.contains(&name) {
                writeln!(w, "ALTER TRIGGER {} DISABLE;", qi(&name))?;
            }
            writeln!(w)?;
        }
    }

    Ok(())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::split::split_statements;
    use serde_json::json;

    #[test]
    fn topo_sort_orders_referenced_tables_first_and_is_stable() {
        let tables = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        // b references a, c references b
        let edges = vec![
            ("a".to_string(), "b".to_string()),
            ("b".to_string(), "c".to_string()),
        ];
        assert_eq!(
            topo_sort(&tables, &edges),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );

        // reverse input order still yields a, b, c (dependencies win over input order)
        let rev = vec!["c".to_string(), "b".to_string(), "a".to_string()];
        assert_eq!(
            topo_sort(&rev, &edges),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );

        // no edges: input order kept
        assert_eq!(topo_sort(&tables, &[]), tables);
    }

    #[test]
    fn topo_sort_survives_cycles_and_ignores_unknown_tables() {
        let tables = vec!["a".to_string(), "b".to_string()];
        // a <-> b cycle: both must be present
        let order = topo_sort(
            &tables,
            &[
                ("a".to_string(), "b".to_string()),
                ("b".to_string(), "a".to_string()),
            ],
        );
        assert_eq!(order.len(), 2);
        assert!(order.contains(&"a".to_string()) && order.contains(&"b".to_string()));

        // edges referencing tables outside the dump are dropped
        let order = topo_sort(&tables, &[("zzz".to_string(), "a".to_string())]);
        assert_eq!(order, tables);
    }

    #[test]
    fn my_portable_drops_the_definer_and_the_schema_qualifier() {
        let v = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `src`.`v` AS select `src`.`t`.`id` from `src`.`t`";
        assert_eq!(
            my_portable(v, "src"),
            "CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select `t`.`id` from `t`"
        );
        assert_eq!(
            my_portable(
                "CREATE TRIGGER `x` BEFORE INSERT ON `t` FOR EACH ROW SET @a = 1",
                "src"
            ),
            "CREATE TRIGGER `x` BEFORE INSERT ON `t` FOR EACH ROW SET @a = 1"
        );
    }

    #[test]
    fn rename_schema_prefix_rewrites_identifiers_and_regclass_literals() {
        let sql = "create table sales.t (x integer); alter table only sales.t add constraint fk foreign key (a) references sales.clients(id);";
        assert_eq!(
            rename_schema_prefix(sql, "sales", "s2"),
            "create table s2.t (x integer); alter table only s2.t add constraint fk foreign key (a) references s2.clients(id);"
        );

        // quoted identifiers
        assert_eq!(
            rename_schema_prefix("create table \"sales\".t (x int);", "sales", "s2"),
            "create table \"s2\".t (x int);"
        );

        // regclass string literal (serial default)
        assert_eq!(
            rename_schema_prefix(
                "d integer default nextval('sales.t_id_seq'::regclass) not null",
                "sales",
                "s2"
            ),
            "d integer default nextval('s2.t_id_seq'::regclass) not null"
        );

        // a leading `'sales.` inside a string literal is a regclass reference and is rewritten;
        // comments and identifiers that merely contain the word are untouched
        assert_eq!(
            rename_schema_prefix("-- sales.x\nselect 'sales.y', assales.z", "sales", "s2"),
            "-- sales.x\nselect 's2.y', assales.z"
        );
    }

    // ------------------------------------------------------------ Oracle helpers

    fn row(cells: &[&str]) -> Row {
        cells
            .iter()
            .map(|c| {
                if c.is_empty() {
                    None
                } else {
                    Some(c.to_string())
                }
            })
            .collect()
    }

    fn sql(l: OraLit) -> String {
        match l {
            OraLit::Sql(s) => s,
            other => panic!("not plain SQL: {other:?}"),
        }
    }

    #[test]
    fn ora_pieces_keep_characters_whole() {
        assert_eq!(ora_text_pieces("abcdef", 4), vec!["abcd", "ef"]);
        assert!(ora_text_pieces("", 4).is_empty());
        // 'é' takes two bytes: a cut inside it moves back
        assert_eq!(ora_text_pieces("aéé", 2), vec!["a", "é", "é"]);
        assert_eq!(ora_text_pieces("日本語", 6), vec!["日本", "語"]);
        assert_eq!(ora_char_pieces("日本語x", 2), vec!["日本", "語x"]);
        assert_eq!(ora_char_pieces("abc", 3), vec!["abc"]);
        assert!(ora_char_pieces("", 3).is_empty());
    }

    #[test]
    fn ora_text_literals_chunk_long_values() {
        assert_eq!(sql(ora_text_lit("it's", false)), "'it''s'");
        // up to 4000 bytes: a plain literal
        assert_eq!(
            sql(ora_text_lit(&"x".repeat(4000), false)),
            format!("'{}'", "x".repeat(4000))
        );
        // longer: TO_CLOB pieces of at most 3000 bytes joined with ||
        let long = ora_text_lit(&"é".repeat(5000), false); // 10000 bytes
        let text = sql(long);
        assert_eq!(text.matches("TO_CLOB('").count(), 4);
        assert_eq!(text.matches(" || ").count(), 3);
        assert!(!text.contains("'\u{fffd}"));
        // too many pieces for a chain: a block builds it
        match ora_text_lit(&"x".repeat(ORA_SQL_TEXT * (ORA_CHAIN_MAX + 1)), false) {
            OraLit::Lob { var, pieces } => {
                assert_eq!(var, "CLOB");
                assert!(pieces
                    .iter()
                    .all(|p| p.starts_with("TO_CLOB('") && p.len() <= ORA_PLSQL_TEXT + 12));
                assert_eq!(pieces.len(), 1);
            }
            other => panic!("{other:?}"),
        }
        // national text
        assert_eq!(sql(ora_text_lit("日本", true)), "N'日本'");
        let n = sql(ora_text_lit(&"日".repeat(2500), true));
        assert_eq!(n.matches("TO_NCLOB(N'").count(), 3);
        match ora_text_lit(&"日".repeat(ORA_SQL_NCHARS * (ORA_CHAIN_MAX + 1)), true) {
            OraLit::Lob { var, .. } => assert_eq!(var, "NCLOB"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn ora_binary_literals() {
        assert_eq!(ora_raw_lit(""), "NULL");
        assert_eq!(ora_raw_lit("00ff"), "HEXTORAW('00ff')");
        let long = ora_raw_lit(&"ab".repeat(2500)); // 5000 hex digits: two pieces
        assert!(
            long.starts_with("UTL_RAW.CONCAT(HEXTORAW('") && long.matches("HEXTORAW(").count() == 2,
            "{long}"
        );
        assert_eq!(sql(ora_blob_lit("")), "EMPTY_BLOB()");
        assert_eq!(sql(ora_blob_lit("cafe")), "TO_BLOB(HEXTORAW('cafe'))");
        // `||` does not join BLOBs: anything over a RAW literal is built in a block
        match ora_blob_lit(&"ab".repeat(2001)) {
            OraLit::Lob { var, pieces } => {
                assert_eq!(var, "BLOB");
                assert_eq!(pieces, vec!["ab".repeat(2001)]);
            }
            other => panic!("{other:?}"),
        }
        match ora_blob_lit(&"0f".repeat(40000)) {
            OraLit::Lob { pieces, .. } => {
                assert_eq!(pieces.len(), 3);
                assert!(pieces
                    .iter()
                    .all(|p| p.len() <= ORA_PLSQL_HEX && p.len() % 2 == 0));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn ora_literals_do_not_depend_on_nls() {
        let l = |c: Value, k: OraKind| sql(ora_literal(&c, k));
        assert_eq!(l(Value::Null, OraKind::Text), "NULL");
        assert_eq!(
            l(json!("2024-02-29 13:14:15"), OraKind::Date),
            "TO_DATE('2024-02-29 13:14:15', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(
            l(json!("2024-05-01 10:20:30.5"), OraKind::Timestamp),
            "TO_TIMESTAMP('2024-05-01 10:20:30.500000000', 'YYYY-MM-DD HH24:MI:SS.FF9')"
        );
        assert_eq!(
            l(json!("2024-05-01 10:20:30.123456000 +05:30"), OraKind::TimestampTz),
            "TO_TIMESTAMP_TZ('2024-05-01 10:20:30.123456000 +05:30', 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM')"
        );
        assert_eq!(
            l(
                json!("12345678901234567890123456789012345678"),
                OraKind::Number
            ),
            "12345678901234567890123456789012345678"
        );
        assert_eq!(l(json!(12.5), OraKind::Number), "12.5");
        assert_eq!(l(json!(1.5), OraKind::BinFloat), "TO_BINARY_FLOAT('1.5e0')");
        assert_eq!(
            l(json!(0.1), OraKind::BinDouble),
            "TO_BINARY_DOUBLE('1e-1')"
        );
        assert_eq!(
            l(json!(1e300), OraKind::BinDouble),
            "TO_BINARY_DOUBLE('1e300')"
        );
        assert_eq!(l(json!("NaN"), OraKind::BinDouble), "BINARY_DOUBLE_NAN");
        assert_eq!(
            l(json!("-Infinity"), OraKind::BinFloat),
            "-BINARY_FLOAT_INFINITY"
        );
        assert_eq!(
            l(json!({"$bin": "00ff", "len": 2}), OraKind::Raw),
            "HEXTORAW('00ff')"
        );
        assert_eq!(
            l(json!({"$bin": "00ff", "len": 2}), OraKind::Blob),
            "TO_BLOB(HEXTORAW('00ff'))"
        );
        assert_eq!(
            l(json!("+03 04:05:06.789"), OraKind::IntervalDs),
            "TO_DSINTERVAL('+03 04:05:06.789')"
        );
        assert_eq!(
            l(json!("+01-06"), OraKind::IntervalYm),
            "TO_YMINTERVAL('+01-06')"
        );
        assert_eq!(l(json!(true), OraKind::Bool), "TRUE");
        assert_eq!(l(json!("Ünï 'q'"), OraKind::NText), "N'Ünï ''q'''");
        assert_eq!(l(json!("plain"), OraKind::Text), "'plain'");
        // an unparsable date stays a text literal (the server tells)
        assert_eq!(l(json!("n/a"), OraKind::Date), "'n/a'");
    }

    #[test]
    fn ora_kinds_follow_the_data_type() {
        for (t, k) in [
            ("VARCHAR2", OraKind::Text),
            ("NVARCHAR2", OraKind::NText),
            ("NCLOB", OraKind::NClob),
            ("CLOB", OraKind::Clob),
            ("NUMBER", OraKind::Number),
            ("FLOAT", OraKind::Number),
            ("BINARY_DOUBLE", OraKind::BinDouble),
            ("DATE", OraKind::Date),
            ("TIMESTAMP(6)", OraKind::Timestamp),
            ("TIMESTAMP(3) WITH TIME ZONE", OraKind::TimestampTz),
            ("TIMESTAMP(6) WITH LOCAL TIME ZONE", OraKind::TimestampTz),
            ("INTERVAL DAY(2) TO SECOND(6)", OraKind::IntervalDs),
            ("INTERVAL YEAR(2) TO MONTH", OraKind::IntervalYm),
            ("RAW", OraKind::Raw),
            ("BLOB", OraKind::Blob),
            ("ROWID", OraKind::Text),
        ] {
            assert_eq!(ora_kind(t), k, "{t}");
        }
    }

    #[test]
    fn ora_inserts_and_blocks() {
        let rows = vec!["(1, 'a')".to_string()];
        assert_eq!(
            ora_insert_stmt("T", "A, B", &rows),
            "INSERT INTO T (A, B) VALUES (1, 'a');"
        );
        let rows = vec!["(1, 'a')".to_string(), "(2, NULL)".to_string()];
        assert_eq!(
            ora_insert_stmt("T", "A, B", &rows),
            "INSERT ALL\n    INTO T (A, B) VALUES (1, 'a')\n    INTO T (A, B) VALUES (2, NULL)\nSELECT 1 FROM DUAL;"
        );
        let block = ora_block_insert(
            "T",
            "A, B, C, D",
            &[
                OraLit::Sql("1".into()),
                OraLit::Lob {
                    var: "CLOB",
                    pieces: vec!["TO_CLOB('x')".into(), "TO_CLOB('y')".into()],
                },
                OraLit::Lob {
                    var: "BLOB",
                    pieces: vec!["0a0b".into()],
                },
                OraLit::Sql("NULL".into()),
            ],
        );
        assert_eq!(
            block,
            "DECLARE\n    v1 CLOB;\n    v2 BLOB;\n    h VARCHAR2(32767);\nBEGIN\n    DBMS_LOB.CREATETEMPORARY(v1, TRUE);\n    DBMS_LOB.APPEND(v1, TO_CLOB('x'));\n    DBMS_LOB.APPEND(v1, TO_CLOB('y'));\n    DBMS_LOB.CREATETEMPORARY(v2, TRUE);\n    h := '0a0b';\n    DBMS_LOB.APPEND(v2, TO_BLOB(HEXTORAW(h)));\n    INSERT INTO T (A, B, C, D) VALUES (1, v1, v2, NULL);\n    DBMS_LOB.FREETEMPORARY(v1);\n    DBMS_LOB.FREETEMPORARY(v2);\nEND;\n/"
        );
        // the splitter keeps the block whole and ends it at the `/` line
        let one = split_statements(&format!("{block}\nCOMMIT;"), Driver::Oracle);
        assert_eq!(one.len(), 2);
        assert!(one[0].text.starts_with("DECLARE") && one[0].text.ends_with("END;"));
    }

    #[test]
    fn ora_drop_blocks_ignore_missing_objects() {
        let b = ora_drop_block("TABLE T CASCADE CONSTRAINTS PURGE", &ORA_DROP_MISSING);
        assert!(b.contains("EXECUTE IMMEDIATE 'DROP TABLE T CASCADE CONSTRAINTS PURGE'"));
        assert!(b.contains("SQLCODE NOT IN (-942, -2289, -4043)"));
        assert!(b.ends_with("END;\n/"));
        // a quote in a name is doubled inside the statement literal
        assert!(ora_drop_block("TABLE \"it's\"", &[-942]).contains("'DROP TABLE \"it''s\"'"));
        let parts = split_statements(&format!("{b}\nSELECT 1 FROM DUAL;"), Driver::Oracle);
        assert_eq!(parts.len(), 2);
    }

    #[test]
    fn ora_column_types_and_lines() {
        let ty =
            |t: &str, owner: &str, len: &str, prec: &str, scale: &str, chars: &str, used: &str| {
                ora_col_type(
                    &row(&["T", "C", t, owner, len, prec, scale, chars, used]),
                    "DEMO",
                )
            };
        assert_eq!(
            ty("VARCHAR2", "", "200", "", "", "50", "C"),
            "VARCHAR2(50 CHAR)"
        );
        assert_eq!(
            ty("VARCHAR2", "", "50", "", "", "50", "B"),
            "VARCHAR2(50 BYTE)"
        );
        assert_eq!(
            ty("NVARCHAR2", "", "100", "", "", "50", ""),
            "NVARCHAR2(50)"
        );
        assert_eq!(ty("NUMBER", "", "22", "", "", "", ""), "NUMBER");
        assert_eq!(ty("NUMBER", "", "22", "", "2", "", ""), "NUMBER(*,2)");
        assert_eq!(ty("NUMBER", "", "22", "10", "0", "", ""), "NUMBER(10)");
        assert_eq!(ty("NUMBER", "", "22", "12", "2", "", ""), "NUMBER(12,2)");
        assert_eq!(ty("FLOAT", "", "22", "126", "", "", ""), "FLOAT(126)");
        assert_eq!(ty("RAW", "", "16", "", "", "", ""), "RAW(16)");
        assert_eq!(
            ty("TIMESTAMP(6) WITH TIME ZONE", "", "13", "", "", "", ""),
            "TIMESTAMP(6) WITH TIME ZONE"
        );
        assert_eq!(ty("CLOB", "", "4000", "", "", "", ""), "CLOB");
        assert_eq!(ty("ADDR_T", "DEMO", "1", "", "", "", ""), "ADDR_T");
        assert_eq!(ty("ADDR_T", "OTHER", "1", "", "", "", ""), "OTHER.ADDR_T");

        let col = |name: &str, ty: &str| OraCol {
            name: name.into(),
            ty: ty.into(),
            base: ty.into(),
            kind: ora_kind(ty),
            nullable: true,
            default: None,
            default_on_null: false,
            virtual_expr: None,
            identity: None,
            invisible: false,
        };
        let same = |t: &str| t.to_string();
        let mut c = col("ID", "NUMBER");
        c.nullable = false;
        assert_eq!(ora_col_line(&c, true, false, &same), "ID NUMBER NOT NULL");
        assert_eq!(
            ora_col_line(&c, true, true, &same),
            "ID NUMBER",
            "a primary key column is not null already"
        );
        let mut c = col("Mixed Case", "VARCHAR2(5 CHAR)");
        c.default = Some("'x'".into());
        c.default_on_null = true;
        assert_eq!(
            ora_col_line(&c, true, false, &same),
            "\"Mixed Case\" VARCHAR2(5 CHAR) DEFAULT ON NULL 'x'"
        );
        let mut c = col("V", "VARCHAR2(10 BYTE)");
        c.virtual_expr = Some("UPPER(\"A\")".into());
        c.invisible = true;
        assert_eq!(
            ora_col_line(&c, true, false, &same),
            "V VARCHAR2(10 BYTE) INVISIBLE GENERATED ALWAYS AS (UPPER(\"A\")) VIRTUAL"
        );

        let id = |always: bool, on_null: bool| OraIdentity {
            always,
            on_null,
            last: "41".into(),
            first: "1".into(),
            options: ora_seq_options("1", "1", "999", false, false, "20"),
        };
        let mut c = col("ID", "NUMBER");
        c.nullable = false;
        c.identity = Some(id(true, false));
        // with rows an ALWAYS identity is created BY DEFAULT (the rows carry ids) and switched back later;
        // the sequence starts after the values in use
        assert_eq!(
            ora_col_line(&c, true, true, &same),
            "ID NUMBER GENERATED BY DEFAULT AS IDENTITY (START WITH 41 INCREMENT BY 1 MINVALUE 1 MAXVALUE 999 NOCYCLE CACHE 20 NOORDER)"
        );
        assert_eq!(
            ora_col_line(&c, false, true, &same),
            "ID NUMBER GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 999 NOCYCLE CACHE 20 NOORDER)"
        );
        c.identity = Some(id(false, true));
        assert!(ora_col_line(&c, true, true, &same)
            .contains("GENERATED BY DEFAULT ON NULL AS IDENTITY"));
    }

    #[test]
    fn ora_sequence_and_constraint_details() {
        assert_eq!(
            ora_seq_options("5", "1", "100", true, true, "0"),
            "INCREMENT BY 5 MINVALUE 1 MAXVALUE 100 CYCLE NOCACHE ORDER"
        );
        assert_eq!(
            ora_identity_start("START WITH: 5, INCREMENT BY: 1, MAX_VALUE: 99"),
            Some("5".into())
        );
        assert_eq!(ora_identity_start("nothing"), None);
        assert!(ora_is_not_null_check("\"NAME\" IS NOT NULL"));
        assert!(!ora_is_not_null_check("\"A\" IS NOT NULL AND \"B\" > 1"));
        assert!(!ora_is_not_null_check("amount >= 0"));
        assert_eq!(
            ora_con_tail("DEFERRABLE", "DEFERRED", "ENABLED"),
            " DEFERRABLE INITIALLY DEFERRED"
        );
        assert_eq!(
            ora_con_tail("NOT DEFERRABLE", "IMMEDIATE", "DISABLED"),
            " DISABLE"
        );
        assert_eq!(
            ora_unit_sql("  function f return number is begin return 1; end;\n"),
            "CREATE OR REPLACE function f return number is begin return 1; end;\n/"
        );
    }

    #[test]
    fn ora_create_table_layout() {
        let t = OraTable {
            name: "T".into(),
            temp: Some("PRESERVE ROWS"),
            iot: false,
            partitioned: false,
            cols: vec![OraCol {
                name: "X".into(),
                ty: "NUMBER".into(),
                base: "NUMBER".into(),
                kind: OraKind::Number,
                nullable: true,
                default: None,
                default_on_null: false,
                virtual_expr: None,
                identity: None,
                invisible: false,
            }],
            items: vec!["PRIMARY KEY (X)".into()],
            pk_cols: vec!["X".into()],
        };
        assert_eq!(
            t.create_sql(true, &|s| s.to_string()),
            "CREATE GLOBAL TEMPORARY TABLE T\n(\n    X NUMBER,\n    PRIMARY KEY (X)\n)\nON COMMIT PRESERVE ROWS;"
        );
    }

    #[test]
    fn options_default_to_the_whole_schema_with_ddl() {
        let o = DumpOptions::default();
        assert!(o.include_ddl && o.tables.is_none() && o.commit_every == 0);
        let o: DumpOptions =
            serde_json::from_str(r#"{"tables":["a"],"includeDdl":false,"commitEvery":5}"#).unwrap();
        assert_eq!(
            (o.tables, o.include_ddl, o.commit_every),
            (Some(vec!["a".to_string()]), false, 5)
        );
        assert!(
            wanted(&None, "x")
                && wanted(&Some(vec!["x".into()]), "x")
                && !wanted(&Some(vec!["y".into()]), "x")
        );
    }
}
