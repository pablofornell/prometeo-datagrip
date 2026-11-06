//! DDL reconstruction for the "DDL" tab / "Go to DDL".
//!
//! * PostgreSQL: rebuilt from the catalogs (`pg_get_constraintdef`, `pg_get_indexdef`,
//!   `pg_get_viewdef`, `pg_get_functiondef`, `pg_get_triggerdef`).
//! * MySQL: `SHOW CREATE ...`.
//! * SQLite: `sqlite_master.sql`.

use crate::conn::{Live, Pool};
use crate::error::{DbError, Result};
use crate::manager::ConnectionManager;
use crate::model::*;
use crate::quote::{quote_ident, quote_literal};

fn g(r: &[Option<String>], i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
}

async fn first_cell(pool: &Pool, sql: &str) -> Result<Option<String>> {
    Ok(pool.query_strings(sql).await?.into_iter().next().and_then(|r| r.into_iter().next()).flatten())
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
        let live = self.live(ds_id)?;
        match live.driver() {
            Driver::Postgres => pg_ddl(&live, obj).await,
            Driver::MySql => my_ddl(&live, obj).await,
            Driver::Sqlite => lite_ddl(&live, obj).await,
        }
    }
}

// ============================================================ PostgreSQL

fn pl(v: &str) -> String {
    quote_literal(Driver::Postgres, v)
}

/// `quote_ident` evaluated by the server (exact PG rules for reserved words etc).
async fn pgq(pool: &Pool, ident: &str) -> Result<String> {
    Ok(first_cell(pool, &format!("select quote_ident({})", pl(ident))).await?.unwrap_or_else(|| ident.to_string()))
}

async fn pg_qname(pool: &Pool, schema: &str, name: &str) -> Result<String> {
    Ok(format!("{}.{}", pgq(pool, schema).await?, pgq(pool, name).await?))
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
            let mut out = format!("CREATE OR REPLACE VIEW {} AS\n{}", pg_qname(pool, &sc, &o.name).await?, end_stmt(def));
            out.push_str(&pg_extras(pool, &sc, &o.name, false, true).await?);
            Ok(out)
        }
        NodeKind::MaterializedView => {
            let def = first_cell(pool, &format!("select pg_get_viewdef({}, true)", pg_rel_expr(&sc, &o.name)))
                .await?
                .ok_or_else(|| DbError::NotFound(format!("Materialized view {sc}.{} not found", o.name)))?;
            let def = def.trim_end().trim_end_matches(';').to_string();
            let mut out = format!(
                "CREATE MATERIALIZED VIEW {} AS\n{}\nWITH DATA;",
                pg_qname(pool, &sc, &o.name).await?,
                def
            );
            out.push_str(&pg_extras(pool, &sc, &o.name, true, false).await?);
            Ok(out)
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
        NodeKind::Sequence => first_cell(
            pool,
            &format!(
                "select format('CREATE SEQUENCE %I.%I AS %s START WITH %s INCREMENT BY %s MINVALUE %s MAXVALUE %s CACHE %s%s;', \
                        schemaname, sequencename, data_type::text, start_value, increment_by, min_value, max_value, cache_size, \
                        case when cycle then ' CYCLE' else '' end) \
                 from pg_sequences where schemaname = {} and sequencename = {}",
                pl(&sc),
                pl(&o.name)
            ),
        )
        .await?
        .ok_or_else(|| DbError::NotFound(format!("Sequence {sc}.{} not found", o.name))),
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
        .map(end_stmt)
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
            .map(end_stmt)
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
                "ALTER TABLE {}\n    ADD CONSTRAINT {} {};",
                pg_qname(pool, &sc, &t).await?,
                pgq(pool, &o.name).await?,
                def
            ))
        }
        NodeKind::Column => {
            let t = o.table.clone().ok_or_else(|| DbError::InvalidArgument("column needs a table".into()))?;
            let rows = pool.query_strings(&pg_column_lines_sql(&sc, &t)).await?;
            let r = rows
                .iter()
                .find(|r| g(r, 8) == o.name)
                .ok_or_else(|| DbError::NotFound(format!("Column {} not found", o.name)))?;
            Ok(format!("ALTER TABLE {}\n    ADD {};", pg_qname(pool, &sc, &t).await?, pg_column_line(r)))
        }
        NodeKind::Schema => {
            let owner = first_cell(
                pool,
                &format!("select pg_get_userbyid(nspowner) from pg_namespace where nspname = {}", pl(&o.name)),
            )
            .await?;
            Ok(match owner {
                Some(ow) => format!("CREATE SCHEMA {} AUTHORIZATION {};", pgq(pool, &o.name).await?, pgq(pool, &ow).await?),
                None => format!("CREATE SCHEMA {};", pgq(pool, &o.name).await?),
            })
        }
        NodeKind::Database => Ok(format!("CREATE DATABASE {};", pgq(pool, &o.name).await?)),
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

fn pg_column_line(r: &[Option<String>]) -> String {
    let serial = !g(r, 9).is_empty() && g(r, 3).starts_with("nextval(");
    let ty = match (serial, g(r, 1).as_str()) {
        (true, "integer") => "serial".to_string(),
        (true, "bigint") => "bigserial".to_string(),
        (true, "smallint") => "smallserial".to_string(),
        _ => g(r, 1),
    };
    let mut l = format!("{} {}", g(r, 0), ty);
    if !g(r, 7).is_empty() {
        l.push_str(&format!(" COLLATE {}", g(r, 7)));
    }
    match g(r, 4).as_str() {
        "a" => l.push_str(" GENERATED ALWAYS AS IDENTITY"),
        "d" => l.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
        _ => {}
    }
    if g(r, 5) == "s" {
        l.push_str(&format!(" GENERATED ALWAYS AS ({}) STORED", g(r, 3)));
    } else if !g(r, 3).is_empty() && g(r, 4).is_empty() && !(serial && ty != g(r, 1)) {
        l.push_str(&format!(" DEFAULT {}", g(r, 3)));
    }
    if g(r, 2) == "true" {
        l.push_str(" NOT NULL");
    }
    l
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
                    coalesce(obj_description(c.oid, 'pg_class'), '') \
             from pg_class c where c.oid = {rel}"
        ))
        .await?;
    let h = head.first().ok_or_else(|| DbError::NotFound(format!("Table {sc}.{name} not found")))?;
    let qname = pg_qname(pool, sc, name).await?;
    let unlogged = if g(h, 1) == "u" { "UNLOGGED " } else { "" };

    let mut out;
    if g(h, 3) == "true" {
        out = format!("CREATE {unlogged}TABLE {qname}\n    PARTITION OF {} {};", g(h, 5), g(h, 4));
    } else {
        let cols = pool.query_strings(&pg_column_lines_sql(sc, name)).await?;
        let cons = pool
            .query_strings(&format!(
                "select quote_ident(conname), pg_get_constraintdef(oid) from pg_constraint \
                 where conrelid = {rel} and contype in ('p','u','c','f','x') and conparentid = 0 \
                 order by (contype = 'p') desc, (contype = 'u') desc, (contype = 'c') desc, (contype = 'f') desc, conname"
            ))
            .await?;
        let mut lines: Vec<String> = cols.iter().map(|r| format!("    {}", pg_column_line(r))).collect();
        lines.extend(cons.iter().map(|r| format!("    CONSTRAINT {} {}", g(r, 0), g(r, 1))));
        out = format!("CREATE {unlogged}TABLE {qname}\n(\n{}\n)", lines.join(",\n"));
        if !g(h, 2).is_empty() {
            out.push_str(&format!("\nPARTITION BY {}", g(h, 2)));
        }
        out.push(';');
        // comments
        let mut comments = String::new();
        if !g(h, 6).is_empty() {
            comments.push_str(&format!("\n\nCOMMENT ON TABLE {qname} IS {};", pl(&g(h, 6))));
        }
        for r in &cols {
            if !g(r, 6).is_empty() {
                comments.push_str(&format!("\nCOMMENT ON COLUMN {qname}.{} IS {};", g(r, 0), pl(&g(r, 6))));
            }
        }
        out.push_str(&comments);
    }
    out.push_str(&pg_extras(pool, sc, name, true, true).await?);
    Ok(out)
}

/// Indexes (not backing a constraint) and triggers appended to table / view DDL.
async fn pg_extras(pool: &Pool, sc: &str, name: &str, indexes: bool, triggers: bool) -> Result<String> {
    let rel = pg_rel_expr(sc, name);
    let mut out = String::new();
    if indexes {
        let rows = pool
            .query_strings(&format!(
                "select pg_get_indexdef(i.indexrelid) from pg_index i join pg_class ic on ic.oid = i.indexrelid \
                 where i.indrelid = {rel} \
                   and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid and c.contype in ('p','u','x')) \
                 order by ic.relname"
            ))
            .await?;
        if !rows.is_empty() {
            out.push('\n');
        }
        for r in rows {
            out.push_str(&format!("\n{};", g(&r, 0)));
        }
    }
    if triggers {
        let rows = pool
            .query_strings(&format!(
                "select pg_get_triggerdef(oid) from pg_trigger where tgrelid = {rel} and not tgisinternal order by tgname"
            ))
            .await?;
        if !rows.is_empty() {
            out.push('\n');
        }
        for r in rows {
            out.push_str(&format!("\n{};", g(&r, 0)));
        }
    }
    Ok(out)
}

// ================================================================= MySQL

fn mq(v: &str) -> String {
    quote_ident(Driver::MySql, v)
}

async fn my_ddl(live: &Live, o: &ObjectRef) -> Result<String> {
    let pool = &live.pool;
    let sc = match &o.schema {
        Some(s) => s.clone(),
        None => first_cell(pool, "select database()").await?.unwrap_or_default(),
    };
    async fn show(pool: &Pool, sc: &str, what: &str, name: &str, col: usize) -> Result<String> {
        let sql = format!("show create {what} {}.{}", mq(sc), mq(name));
        let rows = pool.query_strings(&sql).await?;
        rows.first().map(|r| end_stmt(g(r, col))).ok_or_else(|| DbError::NotFound(format!("{name} not found")))
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
            let rows = pool.query_strings(&format!("show create database {}", mq(&o.name))).await?;
            rows.first().map(|r| end_stmt(g(r, 1))).ok_or_else(|| DbError::NotFound(o.name.clone()))
        }
        NodeKind::Index => {
            let t = o.table.clone().ok_or_else(|| DbError::InvalidArgument("index needs a table".into()))?;
            let rows = pool
                .query_strings(&format!(
                    "select max(non_unique), group_concat(concat('`', column_name, '`') order by seq_in_index separator ', ') \
                     from information_schema.statistics where table_schema = {} and table_name = {} and index_name = {}",
                    quote_literal(Driver::MySql, &sc),
                    quote_literal(Driver::MySql, &t),
                    quote_literal(Driver::MySql, &o.name)
                ))
                .await?;
            let r = rows.first().ok_or_else(|| DbError::NotFound(o.name.clone()))?;
            if g(r, 1).is_empty() {
                return Err(DbError::NotFound(format!("Index {} not found", o.name)));
            }
            let unique = if g(r, 0) == "0" { "unique " } else { "" };
            Ok(format!("create {unique}index {} on {}.{} ({});", mq(&o.name), mq(&sc), mq(&t), g(r, 1)))
        }
        NodeKind::Column | NodeKind::PrimaryKey | NodeKind::ForeignKey | NodeKind::UniqueKey | NodeKind::Check => {
            let t = o.table.clone().ok_or_else(|| DbError::InvalidArgument("object needs a table".into()))?;
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
        NodeKind::Column | NodeKind::PrimaryKey | NodeKind::ForeignKey | NodeKind::UniqueKey | NodeKind::Check => (
            "table",
            o.table.clone().ok_or_else(|| DbError::InvalidArgument("object needs a table".into()))?,
        ),
        NodeKind::Schema | NodeKind::Database => return Ok(format!("-- schema {}", o.name)),
        k => return Err(DbError::Unsupported(format!("No DDL for {k:?}"))),
    };
    let sql = first_cell(pool, &lookup(ty, &name)).await?;
    match sql {
        Some(s) => Ok(end_stmt(s)),
        None if ty == "index" => Ok(format!("-- {} is created automatically by a UNIQUE / PRIMARY KEY constraint", o.name)),
        None => Err(DbError::NotFound(format!("{} {} not found", ty, name))),
    }
}
