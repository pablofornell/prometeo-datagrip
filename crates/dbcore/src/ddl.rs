//! DDL reconstruction for the "DDL" tab / "Go to DDL".
//!
//! * PostgreSQL: rebuilt from the catalogs (`pg_get_constraintdef`, `pg_get_indexdef`,
//!   `pg_get_viewdef`, `pg_get_functiondef`, `pg_get_triggerdef`) in DataGrip's style: lower-case keywords,
//!   `-- auto-generated definition`, aligned column names, single-column constraints under their column,
//!   one statement per paragraph (`alter table .. owner to`, `create index .. on ..`). Text the server writes
//!   itself (view bodies, function bodies) is passed through unchanged.
//! * MySQL: `SHOW CREATE ...` (server text, unchanged; our own `create index` is lower-case).
//! * SQLite: `sqlite_master.sql` (stored text, unchanged).

use crate::conn::{Live, Pool};
use crate::error::{DbError, Result};
use crate::manager::ConnectionManager;
use crate::model::*;
use crate::quote::{quote_ident, quote_literal};

fn g(r: &[Option<String>], i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
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

fn end_stmt(mut s: String) -> String {
    let t = s.trim_end().to_string();
    s = t;
    if !s.ends_with(';') {
        s.push(';');
    }
    s
}

impl ConnectionManager {
    /// DDL text of an object (`CREATE TABLE ...`). For indexes, constraints and columns
    /// it returns the corresponding `CREATE INDEX` / `ALTER TABLE ... ADD ...` statement.
    pub async fn ddl(&self, ds_id: &str, obj: &ObjectRef) -> Result<String> {
        self.ddl_with(ds_id, obj, false).await
    }

    /// Like [`ddl`](Self::ddl); with `unqualified` the names in the object's own schema are written without the
    /// schema (`create table invoices`, `references clients`), as DataGrip's DDL view does. The text then no longer
    /// says where the object lives: use it for display, not for scripts that run elsewhere.
    pub async fn ddl_with(
        &self,
        ds_id: &str,
        obj: &ObjectRef,
        unqualified: bool,
    ) -> Result<String> {
        let live = self.live(ds_id)?;
        match live.driver() {
            Driver::Postgres => {
                let text = pg_ddl(&live, obj).await?;
                let routine = matches!(
                    obj.kind,
                    NodeKind::Function | NodeKind::Procedure | NodeKind::Routine
                );
                Ok(match (&obj.schema, unqualified && !routine) {
                    (Some(sc), true) => unqualify_schema(&text, sc),
                    _ => text,
                })
            }
            Driver::MySql => my_ddl(&live, obj).await,
            Driver::Sqlite => lite_ddl(&live, obj).await,
        }
    }
}

// ============================================================ PostgreSQL

/// Removes the `schema.` prefix of identifiers outside string literals, quoted identifiers and comments
/// (`create table sales.invoices` -> `create table invoices`, `"My Schema".t` -> `t`).
pub fn unqualify_schema(sql: &str, schema: &str) -> String {
    let plain = format!("{schema}.");
    let quoted = format!("{}.", quote_ident(Driver::Postgres, schema));
    let prefixes = [quoted.as_str(), plain.as_str()];
    let ident_char = |c: char| c.is_alphanumeric() || matches!(c, '_' | '$' | '.' | '"');
    let mut out = String::with_capacity(sql.len());
    let mut prev: Option<char> = None;
    let mut rest = sql;
    while let Some(c) = rest.chars().next() {
        // literals / quoted identifiers / comments are copied unchanged
        let skip_to = match c {
            '\'' => Some(('\'', 1)),
            '-' if rest.starts_with("--") => Some(('\n', 2)),
            _ => None,
        };
        if let Some((end, from)) = skip_to {
            let mut len = from;
            let body = &rest[from..];
            let mut it = body.char_indices().peekable();
            let mut closed = None;
            while let Some((i, ch)) = it.next() {
                if ch == end {
                    if end == '\'' && matches!(it.peek(), Some((_, '\''))) {
                        it.next();
                        continue;
                    }
                    closed = Some(i + ch.len_utf8());
                    break;
                }
            }
            len += closed.unwrap_or(body.len());
            out.push_str(&rest[..len]);
            prev = rest[..len].chars().last();
            rest = &rest[len..];
            continue;
        }
        if !prev.is_some_and(ident_char) {
            if let Some(p) = prefixes.iter().find(|p| rest.starts_with(**p)) {
                rest = &rest[p.len()..];
                continue;
            }
        }
        out.push(c);
        prev = Some(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

fn pl(v: &str) -> String {
    quote_literal(Driver::Postgres, v)
}

/// `quote_ident` evaluated by the server (exact PG rules for reserved words etc).
async fn pgq(pool: &Pool, ident: &str) -> Result<String> {
    Ok(
        first_cell(pool, &format!("select quote_ident({})", pl(ident)))
            .await?
            .unwrap_or_else(|| ident.to_string()),
    )
}

async fn pg_qname(pool: &Pool, schema: &str, name: &str) -> Result<String> {
    Ok(format!(
        "{}.{}",
        pgq(pool, schema).await?,
        pgq(pool, name).await?
    ))
}

fn pg_rel_expr(schema: &str, name: &str) -> String {
    format!(
        "(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = {} and c.relname = {})",
        pl(schema),
        pl(name)
    )
}

async fn pg_ddl(live: &Live, o: &ObjectRef) -> Result<String> {
    let pool = &live.pool;
    let sc = o.schema.clone().unwrap_or_else(|| "public".into());
    match o.kind {
        NodeKind::Table => pg_table_ddl(pool, &sc, &o.name).await,
        NodeKind::View => {
            let def = first_cell(pool, &format!("select pg_get_viewdef({}, true)", pg_rel_expr(&sc, &o.name)))
                .await?
                .ok_or_else(|| DbError::NotFound(format!("View {sc}.{} not found", o.name)))?;
            let mut stmts = vec![
                AUTO_GENERATED.to_string(),
                format!("create or replace view {} as\n{}", pg_qname(pool, &sc, &o.name).await?, end_stmt(def)),
            ];
            stmts.extend(pg_extras(pool, &sc, &o.name, false, true).await?);
            Ok(join_stmts(stmts))
        }
        NodeKind::MaterializedView => {
            let def = first_cell(pool, &format!("select pg_get_viewdef({}, true)", pg_rel_expr(&sc, &o.name)))
                .await?
                .ok_or_else(|| DbError::NotFound(format!("Materialized view {sc}.{} not found", o.name)))?;
            let def = def.trim_end().trim_end_matches(';').to_string();
            let mut stmts = vec![
                AUTO_GENERATED.to_string(),
                format!("create materialized view {} as\n{}\nwith data;", pg_qname(pool, &sc, &o.name).await?, def),
            ];
            stmts.extend(pg_extras(pool, &sc, &o.name, true, false).await?);
            Ok(join_stmts(stmts))
        }
        NodeKind::Function | NodeKind::Procedure | NodeKind::Routine => {
            let sig = match &o.signature {
                Some(s) => format!("and pg_get_function_identity_arguments(p.oid) = {}", pl(s)),
                None => String::new(),
            };
            let def = first_cell(
                pool,
                &format!(
                    "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace \
                     where n.nspname = {} and p.proname = {} {sig} order by p.oid limit 1",
                    pl(&sc),
                    pl(&o.name)
                ),
            )
            .await?
            .ok_or_else(|| DbError::NotFound(format!("Routine {sc}.{} not found", o.name)))?;
            Ok(end_stmt(def))
        }
        NodeKind::Sequence => {
            let row = pool
                .query_strings(&format!(
                    "select quote_ident(schemaname) || '.' || quote_ident(sequencename), data_type::text, start_value::text, \
                            increment_by::text, min_value::text, max_value::text, cache_size::text, cycle::text, \
                            quote_ident(sequenceowner) \
                     from pg_sequences where schemaname = {} and sequencename = {}",
                    pl(&sc),
                    pl(&o.name)
                ))
                .await?;
            let r = row.first().ok_or_else(|| DbError::NotFound(format!("Sequence {sc}.{} not found", o.name)))?;
            let mut create = format!(
                "create sequence {}\n    as {}\n    start with {}\n    increment by {}\n    minvalue {}\n    maxvalue {}\n    cache {}",
                g(r, 0),
                g(r, 1),
                g(r, 2),
                g(r, 3),
                g(r, 4),
                g(r, 5),
                g(r, 6)
            );
            if g(r, 7) == "true" {
                create.push_str("\n    cycle");
            }
            create.push(';');
            Ok(join_stmts(vec![
                AUTO_GENERATED.to_string(),
                create,
                format!("alter sequence {} owner to {};", g(r, 0), g(r, 8)),
            ]))
        }
        NodeKind::Index => first_cell(
            pool,
            &format!(
                "select pg_get_indexdef(c.oid) from pg_class c join pg_namespace n on n.oid = c.relnamespace \
                 where n.nspname = {} and c.relname = {} and c.relkind in ('i','I')",
                pl(&sc),
                pl(&o.name)
            ),
        )
        .await?
        .map(|d| format!("{};", index_def(&d)))
        .ok_or_else(|| DbError::NotFound(format!("Index {sc}.{} not found", o.name))),
        NodeKind::Trigger => {
            let t = o.table.clone().ok_or_else(|| DbError::InvalidArgument("trigger needs a table".into()))?;
            first_cell(
                pool,
                &format!(
                    "select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = {} and t.tgname = {}",
                    pg_rel_expr(&sc, &t),
                    pl(&o.name)
                ),
            )
            .await?
            .map(|d| format!("{};", trigger_def(&d)))
            .ok_or_else(|| DbError::NotFound(format!("Trigger {} not found", o.name)))
        }
        NodeKind::PrimaryKey | NodeKind::ForeignKey | NodeKind::UniqueKey | NodeKind::Check => {
            let t = o.table.clone().ok_or_else(|| DbError::InvalidArgument("constraint needs a table".into()))?;
            let def = first_cell(
                pool,
                &format!(
                    "select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = {} and c.conname = {}",
                    pg_rel_expr(&sc, &t),
                    pl(&o.name)
                ),
            )
            .await?
            .ok_or_else(|| DbError::NotFound(format!("Constraint {} not found", o.name)))?;
            Ok(format!(
                "alter table {}\n    add constraint {} {};",
                pg_qname(pool, &sc, &t).await?,
                pgq(pool, &o.name).await?,
                lower_keywords(&def)
            ))
        }
        NodeKind::Column => {
            let t = o.table.clone().ok_or_else(|| DbError::InvalidArgument("column needs a table".into()))?;
            let rows = pool.query_strings(&pg_column_lines_sql(&sc, &t)).await?;
            let r = rows
                .iter()
                .find(|r| g(r, 8) == o.name)
                .ok_or_else(|| DbError::NotFound(format!("Column {} not found", o.name)))?;
            Ok(format!("alter table {}\n    add {};", pg_qname(pool, &sc, &t).await?, pg_column_line(r)))
        }
        NodeKind::Schema => {
            let owner = first_cell(
                pool,
                &format!("select pg_get_userbyid(nspowner) from pg_namespace where nspname = {}", pl(&o.name)),
            )
            .await?;
            Ok(match owner {
                Some(ow) => format!("create schema {} authorization {};", pgq(pool, &o.name).await?, pgq(pool, &ow).await?),
                None => format!("create schema {};", pgq(pool, &o.name).await?),
            })
        }
        NodeKind::Database => Ok(format!("create database {};", pgq(pool, &o.name).await?)),
        k => Err(DbError::Unsupported(format!("No DDL for {k:?}"))),
    }
}

fn pg_column_lines_sql(schema: &str, table: &str) -> String {
    format!(
        "select quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull::text, \
                coalesce(pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity::text, a.attgenerated::text, \
                coalesce(col_description(a.attrelid, a.attnum), ''), \
                case when a.attcollation <> t.typcollation then (select quote_ident(collname) from pg_collation where oid = a.attcollation) else '' end, \
                a.attname, pg_get_serial_sequence(a.attrelid::regclass::text, a.attname) \
         from pg_attribute a join pg_type t on t.oid = a.atttypid \
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum \
         where a.attrelid = {} and a.attnum > 0 and not a.attisdropped order by a.attnum",
        pg_rel_expr(schema, table)
    )
}

/// Column name (as quoted by the server) and the rest of its definition.
fn pg_column_parts(r: &[Option<String>]) -> (String, String) {
    let serial = !g(r, 9).is_empty() && g(r, 3).starts_with("nextval(");
    let ty = match (serial, g(r, 1).as_str()) {
        (true, "integer") => "serial".to_string(),
        (true, "bigint") => "bigserial".to_string(),
        (true, "smallint") => "smallserial".to_string(),
        _ => spaced_type(&g(r, 1)),
    };
    let serial_type = serial && matches!(g(r, 1).as_str(), "integer" | "bigint" | "smallint");
    let mut l = ty;
    if !g(r, 7).is_empty() {
        l.push_str(&format!(" collate {}", g(r, 7)));
    }
    match g(r, 4).as_str() {
        "a" => l.push_str(" generated always as identity"),
        "d" => l.push_str(" generated by default as identity"),
        _ => {}
    }
    let default = lower_keywords(&g(r, 3));
    if g(r, 5) == "s" {
        l.push_str(&format!(" generated always as ({default}) stored"));
    } else if !default.is_empty() && g(r, 4).is_empty() && !serial_type {
        l.push_str(&format!(" default {default}"));
    }
    // `serial` already means not null
    if g(r, 2) == "true" && !serial_type {
        l.push_str(" not null");
    }
    (g(r, 0), l)
}

fn pg_column_line(r: &[Option<String>]) -> String {
    let (name, rest) = pg_column_parts(r);
    format!("{name} {rest}")
}

/// `numeric(12,2)` -> `numeric(12, 2)` (DataGrip's spelling).
fn spaced_type(t: &str) -> String {
    if t.contains('(') && !t.contains(", ") {
        t.replace(',', ", ")
    } else {
        t.to_string()
    }
}

/// One `pg_constraint` row of a table.
struct PgCon {
    name: String,
    kind: char,
    /// `pg_get_constraintdef`, keywords lower-cased
    def: String,
    /// column names (unquoted); one entry for a column constraint
    cols: Vec<String>,
    /// foreign key whose referenced columns are the primary key of the target (DataGrip omits them)
    ref_is_pk: bool,
}

impl PgCon {
    fn from_row(r: &[Option<String>]) -> PgCon {
        PgCon {
            name: g(r, 0),
            kind: g(r, 1).chars().next().unwrap_or('c'),
            def: lower_keywords(&g(r, 2)),
            cols: g(r, 3)
                .split(',')
                .filter(|c| !c.is_empty())
                .map(str::to_string)
                .collect(),
            ref_is_pk: g(r, 4) == "true",
        }
    }

    /// The name PostgreSQL generates when none is given; such names are not written out.
    fn is_default_name(&self, table: &str) -> bool {
        let want = match self.kind {
            'p' => format!("{table}_pkey"),
            'u' => format!("{table}_{}_key", self.cols.join("_")),
            'f' => format!("{table}_{}_fkey", self.cols.join("_")),
            'c' if self.cols.len() == 1 => format!("{table}_{}_check", self.cols[0]),
            'c' => format!("{table}_check"),
            _ => return false,
        };
        self.name == want
    }

    /// Whether the constraint is written under its column (`primary key`, `unique`, `references t`, `check (..)`).
    fn inline_clause(&self) -> Option<String> {
        if self.cols.len() != 1 {
            return None;
        }
        match self.kind {
            'p' if strip_parens(&self.def) == "primary key" => Some("primary key".into()),
            'u' if strip_parens(&self.def) == "unique" => Some("unique".into()),
            'f' => {
                let rest = self.def.split_once(") references ").map(|(_, r)| r)?;
                Some(references(rest, self.ref_is_pk))
            }
            'c' => Some(self.def.clone()),
            _ => None,
        }
    }

    fn table_clause(&self) -> String {
        if self.kind == 'f' {
            if let Some((cols, rest)) = self.def.split_once(") references ") {
                return format!("{}) {}", cols, references(rest, self.ref_is_pk));
            }
        }
        self.def.clone()
    }

    /// Lines of the constraint at `indent` spaces: `clause`, or `constraint name` + the clause one level deeper.
    fn lines(&self, table: &str, clause: &str, indent: usize) -> String {
        let pad = " ".repeat(indent);
        if self.is_default_name(table) {
            format!("{pad}{clause}")
        } else {
            format!("{pad}constraint {}\n{pad}    {clause}", self.name)
        }
    }
}

/// `primary key (id)` -> `primary key` (the text with every parenthesised group removed, trimmed).
fn strip_parens(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in s.chars() {
        match c {
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `clients(id) on delete cascade` -> `clients on delete cascade` when the referenced column is the target's
/// primary key, else `clients (id) on delete cascade`.
fn references(rest: &str, ref_is_pk: bool) -> String {
    let (target, after) = match rest.find('(') {
        Some(open) => (rest[..open].trim_end(), &rest[open..]),
        None => return format!("references {rest}"),
    };
    let (cols, tail) = match after.find(')') {
        Some(close) => (&after[..=close], after[close + 1..].trim_start()),
        None => return format!("references {rest}"),
    };
    let mut out = format!("references {target}");
    if !ref_is_pk {
        out.push_str(&format!(" {cols}"));
    }
    if !tail.is_empty() {
        out.push(' ');
        out.push_str(tail);
    }
    out
}

async fn pg_table_ddl(pool: &Pool, sc: &str, name: &str) -> Result<String> {
    let rel = pg_rel_expr(sc, name);
    let head = pool
        .query_strings(&format!(
            "select c.relkind::text, c.relpersistence::text, coalesce(pg_get_partkeydef(c.oid), ''), c.relispartition::text, \
                    coalesce(pg_get_expr(c.relpartbound, c.oid), ''), \
                    coalesce((select quote_ident(pn.nspname) || '.' || quote_ident(pc.relname) from pg_inherits i \
                              join pg_class pc on pc.oid = i.inhparent join pg_namespace pn on pn.oid = pc.relnamespace \
                              where i.inhrelid = c.oid limit 1), ''), \
                    coalesce(obj_description(c.oid, 'pg_class'), ''), \
                    quote_ident(pg_get_userbyid(c.relowner)) \
             from pg_class c where c.oid = {rel}"
        ))
        .await?;
    let h = head
        .first()
        .ok_or_else(|| DbError::NotFound(format!("Table {sc}.{name} not found")))?;
    let qname = pg_qname(pool, sc, name).await?;
    let unlogged = if g(h, 1) == "u" { "unlogged " } else { "" };

    let mut stmts = vec![AUTO_GENERATED.to_string()];
    let mut comments = Vec::new();
    if g(h, 3) == "true" {
        stmts.push(format!(
            "create {unlogged}table {qname}\n    partition of {} {};",
            g(h, 5),
            lower_keywords(&g(h, 4))
        ));
    } else {
        let cols = pool.query_strings(&pg_column_lines_sql(sc, name)).await?;
        let cons: Vec<PgCon> = pool
            .query_strings(&format!(
                "select quote_ident(c.conname), c.contype::text, pg_get_constraintdef(c.oid), \
                        coalesce((select string_agg(a.attname, ',' order by k.o) \
                                  from unnest(c.conkey) with ordinality as k(n, o) \
                                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n), ''), \
                        (c.contype = 'f' and exists (select 1 from pg_constraint p where p.conrelid = c.confrelid \
                                                       and p.contype = 'p' and p.conkey = c.confkey))::text \
                 from pg_constraint c \
                 where c.conrelid = {rel} and c.contype in ('p','u','c','f','x') and c.conparentid = 0 \
                 order by (c.contype = 'p') desc, (c.contype = 'u') desc, (c.contype = 'c') desc, (c.contype = 'f') desc, c.conname"
            ))
            .await?
            .iter()
            .map(|r| PgCon::from_row(r))
            .collect();

        let mut table_level: Vec<&PgCon> = Vec::new();
        let mut inline: Vec<Vec<(&PgCon, String)>> = vec![Vec::new(); cols.len()];
        for c in &cons {
            let target = c.inline_clause().and_then(|cl| {
                cols.iter()
                    .position(|r| g(r, 8) == c.cols[0])
                    .map(|i| (i, cl))
            });
            match target {
                Some((i, cl)) => inline[i].push((c, cl)),
                None => table_level.push(c),
            }
        }

        let parts: Vec<(String, String)> = cols.iter().map(|r| pg_column_parts(r)).collect();
        let width = parts
            .iter()
            .map(|(n, _)| n.chars().count())
            .max()
            .unwrap_or(0);
        let mut items: Vec<String> = Vec::new();
        for (i, (n, rest)) in parts.iter().enumerate() {
            let mut item = format!("    {n:<width$} {rest}");
            for (c, clause) in &inline[i] {
                item.push('\n');
                item.push_str(&c.lines(name, clause, 8));
            }
            items.push(item);
        }
        for c in table_level {
            items.push(c.lines(name, &c.table_clause(), 4));
        }
        let mut create = format!(
            "create {unlogged}table {qname}\n(\n{}\n)",
            items.join(",\n")
        );
        if !g(h, 2).is_empty() {
            create.push_str(&format!("\npartition by {}", lower_keywords(&g(h, 2))));
        }
        create.push(';');
        stmts.push(create);

        if !g(h, 6).is_empty() {
            comments.push(format!("comment on table {qname} is {};", pl(&g(h, 6))));
        }
        for r in &cols {
            if !g(r, 6).is_empty() {
                comments.push(format!(
                    "comment on column {qname}.{} is {};",
                    g(r, 0),
                    pl(&g(r, 6))
                ));
            }
        }
    }
    stmts.extend(comments);
    stmts.push(format!("alter table {qname}\n    owner to {};", g(h, 7)));
    stmts.extend(pg_extras(pool, sc, name, true, true).await?);
    Ok(join_stmts(stmts))
}

/// Indexes (not backing a constraint) and triggers appended to table / view DDL, one statement each.
async fn pg_extras(
    pool: &Pool,
    sc: &str,
    name: &str,
    indexes: bool,
    triggers: bool,
) -> Result<Vec<String>> {
    let rel = pg_rel_expr(sc, name);
    let mut out = Vec::new();
    if indexes {
        let rows = pool
            .query_strings(&format!(
                "select pg_get_indexdef(i.indexrelid) from pg_index i join pg_class ic on ic.oid = i.indexrelid \
                 where i.indrelid = {rel} \
                   and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid and c.contype in ('p','u','x')) \
                 order by ic.relname"
            ))
            .await?;
        out.extend(rows.iter().map(|r| format!("{};", index_def(&g(r, 0)))));
    }
    if triggers {
        let rows = pool
            .query_strings(&format!(
                "select pg_get_triggerdef(oid) from pg_trigger where tgrelid = {rel} and not tgisinternal order by tgname"
            ))
            .await?;
        out.extend(rows.iter().map(|r| format!("{};", trigger_def(&g(r, 0)))));
    }
    Ok(out)
}

// ---------------------------------------------------------------- text helpers

const AUTO_GENERATED: &str = "-- auto-generated definition";

/// Statements are separated by an empty line, except the leading comment which sticks to the first statement.
fn join_stmts(stmts: Vec<String>) -> String {
    let mut out = String::new();
    for (i, s) in stmts.iter().enumerate() {
        if i == 1 && stmts[0].starts_with("--") {
            out.push('\n');
        } else if i > 0 {
            out.push_str("\n\n");
        }
        out.push_str(s);
    }
    out
}

/// Lower-cases the keywords of SQL the server wrote (`pg_get_constraintdef`, `pg_get_indexdef`, ...).
/// The server spells keywords in upper case and double-quotes every identifier that has an upper-case letter,
/// so a bare word without lower-case letters is a keyword. Quoted identifiers and string literals are kept.
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
            // numbers and identifier tails such as `t1`: copy the whole word
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

/// `CREATE INDEX i ON s.t USING btree (c)` -> `create index i\n    on s.t (c)` (`btree` is the default method).
fn index_def(def: &str) -> String {
    let d = lower_keywords(def.trim_end().trim_end_matches(';'));
    match d.split_once(" on ") {
        Some((head, rest)) => format!(
            "{head}\n    on {}",
            rest.replacen(" using btree (", " (", 1)
        ),
        None => d,
    }
}

/// `CREATE TRIGGER t BEFORE UPDATE ON s.x FOR EACH ROW EXECUTE FUNCTION f()` in DataGrip's layout:
/// `create trigger t`, the timing, `on` table and `for each` clauses indented, `execute ..` last.
fn trigger_def(def: &str) -> String {
    let d = lower_keywords(def.trim_end().trim_end_matches(';'));
    let (pre, exec) = match d.split_once(" execute ") {
        Some((a, b)) => (a.to_string(), Some(b.to_string())),
        None => (d.clone(), None),
    };
    let Some(after_create) = pre
        .strip_prefix("create constraint trigger ")
        .map(|r| ("create constraint trigger", r))
        .or_else(|| {
            pre.strip_prefix("create trigger ")
                .map(|r| ("create trigger", r))
        })
    else {
        return d;
    };
    let (kw, rest) = after_create;
    // trigger name (possibly double-quoted)
    let name_end = if let Some(quoted) = rest.strip_prefix('"') {
        quoted.find('"').map(|i| i + 2).unwrap_or(rest.len())
    } else {
        rest.find(' ').unwrap_or(rest.len())
    };
    let (name, rest) = rest.split_at(name_end);
    let Some((timing, rest)) = rest.trim_start().split_once(" on ") else {
        return d;
    };
    let (table, tail) = rest.split_once(' ').unwrap_or((rest, ""));
    let mut lines = vec![
        format!("{kw} {name}"),
        format!("    {timing}"),
        format!("    on {table}"),
    ];
    let tail = tail.trim();
    if let Some((before, when)) = tail.split_once(" when ") {
        if !before.is_empty() {
            lines.push(format!("    {before}"));
        }
        lines.push(format!("    when {when}"));
    } else if let Some(rest) = tail.strip_prefix("when ") {
        lines.push(format!("    when {rest}"));
    } else if !tail.is_empty() {
        lines.push(format!("    {tail}"));
    }
    if let Some(e) = exec {
        lines.push(format!("execute {e}"));
    }
    lines.join("\n")
}

// ================================================================= MySQL

fn mq(v: &str) -> String {
    quote_ident(Driver::MySql, v)
}

async fn my_ddl(live: &Live, o: &ObjectRef) -> Result<String> {
    let pool = &live.pool;
    let sc = match &o.schema {
        Some(s) => s.clone(),
        None => first_cell(pool, "select database()")
            .await?
            .unwrap_or_default(),
    };
    async fn show(pool: &Pool, sc: &str, what: &str, name: &str, col: usize) -> Result<String> {
        let sql = format!("show create {what} {}.{}", mq(sc), mq(name));
        let rows = pool.query_strings(&sql).await?;
        rows.first()
            .map(|r| end_stmt(g(r, col)))
            .ok_or_else(|| DbError::NotFound(format!("{name} not found")))
    }
    match o.kind {
        NodeKind::Table | NodeKind::Folder => show(pool, &sc, "table", &o.name, 1).await,
        NodeKind::View => show(pool, &sc, "view", &o.name, 1).await,
        NodeKind::Procedure => show(pool, &sc, "procedure", &o.name, 2).await,
        NodeKind::Function => show(pool, &sc, "function", &o.name, 2).await,
        NodeKind::Routine => match show(pool, &sc, "function", &o.name, 2).await {
            Ok(s) => Ok(s),
            Err(_) => show(pool, &sc, "procedure", &o.name, 2).await,
        },
        NodeKind::Trigger => show(pool, &sc, "trigger", &o.name, 2).await,
        NodeKind::Schema | NodeKind::Database => {
            let rows = pool
                .query_strings(&format!("show create database {}", mq(&o.name)))
                .await?;
            rows.first()
                .map(|r| end_stmt(g(r, 1)))
                .ok_or_else(|| DbError::NotFound(o.name.clone()))
        }
        NodeKind::Index => {
            let t = o
                .table
                .clone()
                .ok_or_else(|| DbError::InvalidArgument("index needs a table".into()))?;
            let rows = pool
                .query_strings(&format!(
                    "select max(non_unique), group_concat(concat('`', column_name, '`') order by seq_in_index separator ', ') \
                     from information_schema.statistics where table_schema = {} and table_name = {} and index_name = {}",
                    quote_literal(Driver::MySql, &sc),
                    quote_literal(Driver::MySql, &t),
                    quote_literal(Driver::MySql, &o.name)
                ))
                .await?;
            let r = rows
                .first()
                .ok_or_else(|| DbError::NotFound(o.name.clone()))?;
            if g(r, 1).is_empty() {
                return Err(DbError::NotFound(format!("Index {} not found", o.name)));
            }
            let unique = if g(r, 0) == "0" { "unique " } else { "" };
            Ok(format!(
                "create {unique}index {} on {}.{} ({});",
                mq(&o.name),
                mq(&sc),
                mq(&t),
                g(r, 1)
            ))
        }
        NodeKind::Column
        | NodeKind::PrimaryKey
        | NodeKind::ForeignKey
        | NodeKind::UniqueKey
        | NodeKind::Check => {
            let t = o
                .table
                .clone()
                .ok_or_else(|| DbError::InvalidArgument("object needs a table".into()))?;
            show(pool, &sc, "table", &t, 1).await
        }
        k => Err(DbError::Unsupported(format!("No DDL for {k:?}"))),
    }
}

// ================================================================ SQLite

async fn lite_ddl(live: &Live, o: &ObjectRef) -> Result<String> {
    let pool = &live.pool;
    let sc = o.schema.clone().unwrap_or_else(|| "main".into());
    let lookup = |ty: &str, name: &str| {
        format!(
            "select sql from {}.sqlite_master where type = '{ty}' and name = {}",
            quote_ident(Driver::Sqlite, &sc),
            quote_literal(Driver::Sqlite, name)
        )
    };
    let (ty, name) = match o.kind {
        NodeKind::Table | NodeKind::MaterializedView => ("table", o.name.clone()),
        NodeKind::View => ("view", o.name.clone()),
        NodeKind::Index => ("index", o.name.clone()),
        NodeKind::Trigger => ("trigger", o.name.clone()),
        NodeKind::Column
        | NodeKind::PrimaryKey
        | NodeKind::ForeignKey
        | NodeKind::UniqueKey
        | NodeKind::Check => (
            "table",
            o.table
                .clone()
                .ok_or_else(|| DbError::InvalidArgument("object needs a table".into()))?,
        ),
        NodeKind::Schema | NodeKind::Database => return Ok(format!("-- schema {}", o.name)),
        k => return Err(DbError::Unsupported(format!("No DDL for {k:?}"))),
    };
    let sql = first_cell(pool, &lookup(ty, &name)).await?;
    match sql {
        Some(s) => Ok(end_stmt(s)),
        None if ty == "index" => Ok(format!(
            "-- {} is created automatically by a UNIQUE / PRIMARY KEY constraint",
            o.name
        )),
        None => Err(DbError::NotFound(format!("{} {} not found", ty, name))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keywords_go_lower_case_but_quoted_text_does_not() {
        assert_eq!(
            lower_keywords("FOREIGN KEY (a) REFERENCES shop.categories(id) ON DELETE CASCADE"),
            "foreign key (a) references shop.categories(id) on delete cascade"
        );
        assert_eq!(
            lower_keywords(r#"CHECK (("Name" <> 'NOT NULL'::text))"#),
            r#"check (("Name" <> 'NOT NULL'::text))"#
        );
        assert_eq!(lower_keywords("CURRENT_TIMESTAMP"), "current_timestamp");
        assert_eq!(
            lower_keywords("t1 = 10 AND x IS NOT NULL"),
            "t1 = 10 and x is not null"
        );
        assert_eq!(lower_keywords("'it''s OK' AS x"), "'it''s OK' as x");
    }

    #[test]
    fn index_and_trigger_layout() {
        assert_eq!(
            index_def("CREATE INDEX idx_a ON shop.t USING btree (a)"),
            "create index idx_a\n    on shop.t (a)"
        );
        assert_eq!(
            index_def("CREATE UNIQUE INDEX u ON shop.t USING gin (a) WHERE (b < 5)"),
            "create unique index u\n    on shop.t using gin (a) where (b < 5)"
        );
        assert_eq!(
            trigger_def("CREATE TRIGGER trg BEFORE UPDATE ON shop.t FOR EACH ROW EXECUTE FUNCTION shop.f()"),
            "create trigger trg\n    before update\n    on shop.t\n    for each row\nexecute function shop.f()"
        );
        assert_eq!(
            trigger_def("CREATE TRIGGER trg AFTER INSERT OR UPDATE ON t FOR EACH ROW WHEN ((new.a > 1)) EXECUTE FUNCTION f()"),
            "create trigger trg\n    after insert or update\n    on t\n    for each row\n    when ((new.a > 1))\nexecute function f()"
        );
    }

    #[test]
    fn constraints_sit_under_their_column() {
        let pk = PgCon {
            name: "invoices_pkey".into(),
            kind: 'p',
            def: "primary key (id)".into(),
            cols: vec!["id".into()],
            ref_is_pk: false,
        };
        assert_eq!(pk.inline_clause().as_deref(), Some("primary key"));
        assert_eq!(
            pk.lines("invoices", "primary key", 8),
            "        primary key"
        );
        let fk = PgCon {
            name: "fk_client".into(),
            kind: 'f',
            def: "foreign key (client_id) references clients(id) on delete cascade".into(),
            cols: vec!["client_id".into()],
            ref_is_pk: true,
        };
        assert_eq!(
            fk.inline_clause().as_deref(),
            Some("references clients on delete cascade")
        );
        assert_eq!(
            fk.lines("invoices", "references clients", 8),
            "        constraint fk_client\n            references clients"
        );
        let fk2 = PgCon {
            name: "x".into(),
            kind: 'f',
            def: "foreign key (a) references t(b)".into(),
            cols: vec!["a".into()],
            ref_is_pk: false,
        };
        assert_eq!(fk2.inline_clause().as_deref(), Some("references t (b)"));
        let comp = PgCon {
            name: "t_pkey".into(),
            kind: 'p',
            def: "primary key (a, b)".into(),
            cols: vec!["a".into(), "b".into()],
            ref_is_pk: false,
        };
        assert_eq!(comp.inline_clause(), None);
        assert_eq!(comp.table_clause(), "primary key (a, b)");
    }

    #[test]
    fn statements_are_paragraphs_under_the_header() {
        assert_eq!(
            join_stmts(vec![
                AUTO_GENERATED.into(),
                "create a;".into(),
                "alter b;".into()
            ]),
            "-- auto-generated definition\ncreate a;\n\nalter b;"
        );
    }

    #[test]
    fn schema_prefix_is_removed_outside_literals_and_comments() {
        let sql = "create table sales.invoices\n(\n    client_id integer references sales.clients,\n    d text default nextval('sales.invoices_id_seq'::regclass)\n);\n-- sales.x\ncreate index i\n    on \"sales\".invoices (client_id);\nalter table other.t add x int; -- it's sales.y\nselect assales.z;";
        assert_eq!(
            unqualify_schema(sql, "sales"),
            "create table invoices\n(\n    client_id integer references clients,\n    d text default nextval('sales.invoices_id_seq'::regclass)\n);\n-- sales.x\ncreate index i\n    on invoices (client_id);\nalter table other.t add x int; -- it's sales.y\nselect assales.z;"
        );
    }
}
