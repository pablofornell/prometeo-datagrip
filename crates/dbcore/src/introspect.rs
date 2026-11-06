//! Lazy schema tree (`children`) and flat metadata helpers.
//!
//! Tree paths (relative to the data source, not including its id):
//!
//! * PostgreSQL: `[]` databases, `[db]` schemas, `[db, schema]` folders,
//!   `[db, schema, folder]` objects, `[db, schema, folder, object]` object folders,
//!   `[db, schema, folder, object, subfolder]` columns / keys / indexes / ...
//! * MySQL / SQLite: same without the leading database element (MySQL schema = database,
//!   SQLite schema = `main`, `temp` or an attached database).
//!
//! Folder keys: `tables views materialized_views routines sequences` (schema level) and
//! `columns keys foreign_keys indexes checks triggers` (object level). Folder hints are
//! the object counts (`"5"`), shown by the UI next to the folder name like DataGrip.

use serde_json::{json, Value};

use crate::conn::{Live, Pool};
use crate::error::{DbError, Result};
use crate::manager::ConnectionManager;
use crate::model::*;
use crate::quote::{quote_ident, quote_literal};

#[derive(Debug, Clone, Default)]
pub struct IntrospectOptions {
    /// Show `pg_catalog` / `information_schema` (PG), system databases (MySQL), `temp` (SQLite).
    pub show_system: bool,
}

type Row = Vec<Option<String>>;

fn s(r: &Row, i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
}
fn so(r: &Row, i: usize) -> Option<String> {
    r.get(i).cloned().flatten()
}
fn n(r: &Row, i: usize) -> i64 {
    s(r, i).parse().unwrap_or(0)
}
fn b(r: &Row, i: usize) -> bool {
    matches!(s(r, i).as_str(), "t" | "true" | "1" | "YES" | "yes" | "PRI")
}
fn nonempty(v: String) -> Option<String> {
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn node_id(ds: &str, path: &[String]) -> String {
    let mut id = ds.to_string();
    for p in path {
        id.push('/');
        id.push_str(&p.replace('%', "%25").replace('/', "%2F"));
    }
    id
}

fn mk(ds: &str, kind: NodeKind, name: &str, hint: Option<String>, path: Vec<String>, has_children: bool, extra: Value) -> TreeNode {
    TreeNode { id: node_id(ds, &path), kind, name: name.to_string(), hint, path, has_children, extra }
}

fn child_path(base: &[String], name: &str) -> Vec<String> {
    let mut p = base.to_vec();
    p.push(name.to_string());
    p
}

fn folder_label(key: &str) -> String {
    key.replace('_', " ")
}

fn folder(ds: &str, base: &[String], key: &str, count: i64, schema: Option<&str>, table: Option<&str>) -> TreeNode {
    mk(
        ds,
        NodeKind::Folder,
        &folder_label(key),
        Some(count.to_string()),
        child_path(base, key),
        count > 0,
        json!({ "folder": key, "count": count, "schema": schema, "table": table }),
    )
}

fn bad_path(path: &[String]) -> DbError {
    DbError::InvalidArgument(format!("Unknown tree path: /{}", path.join("/")))
}

fn short_type(t: &str) -> String {
    if let Some(r) = t.strip_prefix("character varying") {
        format!("varchar{r}")
    } else if let Some(r) = t.strip_prefix("character") {
        format!("char{r}")
    } else {
        t.to_string()
    }
}

impl ConnectionManager {
    /// Children of a tree node, with default options.
    pub async fn introspect(&self, ds_id: &str, path: &[String]) -> Result<Vec<TreeNode>> {
        self.introspect_with(ds_id, path, &IntrospectOptions::default()).await
    }

    pub async fn introspect_with(&self, ds_id: &str, path: &[String], opts: &IntrospectOptions) -> Result<Vec<TreeNode>> {
        let live = self.live(ds_id)?;
        match live.driver() {
            Driver::Postgres => pg_children(&live, ds_id, path, opts).await,
            Driver::MySql => my_children(&live, ds_id, path, opts).await,
            Driver::Sqlite => lite_children(&live, ds_id, path, opts).await,
        }
    }

    /// Flat list of tables / views with their columns, for completion and "go to object".
    /// `schema = None` returns every non-system schema.
    pub async fn schema_snapshot(&self, ds_id: &str, schema: Option<&str>) -> Result<Vec<SnapshotObject>> {
        let live = self.live(ds_id)?;
        snapshot(&live, schema).await
    }
}

// ============================================================ PostgreSQL

fn pg_rel(schema: &str, table: &str) -> String {
    format!(
        "(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = {} and c.relname = {})",
        quote_literal(Driver::Postgres, schema),
        quote_literal(Driver::Postgres, table)
    )
}

fn pg_trigger_hint(tgtype: i64) -> String {
    let timing = if tgtype & 64 != 0 {
        "INSTEAD OF"
    } else if tgtype & 2 != 0 {
        "BEFORE"
    } else {
        "AFTER"
    };
    let mut ev = Vec::new();
    if tgtype & 4 != 0 {
        ev.push("INSERT");
    }
    if tgtype & 8 != 0 {
        ev.push("DELETE");
    }
    if tgtype & 16 != 0 {
        ev.push("UPDATE");
    }
    if tgtype & 32 != 0 {
        ev.push("TRUNCATE");
    }
    format!("{timing} {}", ev.join(" OR "))
}

async fn pg_children(live: &Live, ds: &str, path: &[String], opts: &IntrospectOptions) -> Result<Vec<TreeNode>> {
    let pool = &live.pool;
    let lit = |v: &str| quote_literal(Driver::Postgres, v);
    match path.len() {
        0 => {
            let rows = pool
                .query_strings(
                    "select datname, (datname = current_database())::text, pg_encoding_to_char(encoding) \
                     from pg_database where not datistemplate and datallowconn order by (datname = current_database()) desc, datname",
                )
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    let current = b(r, 1);
                    mk(
                        ds,
                        NodeKind::Database,
                        &s(r, 0),
                        None,
                        vec![s(r, 0)],
                        current,
                        json!({ "current": current, "encoding": s(r, 2) }),
                    )
                })
                .collect())
        }
        1 => {
            pg_check_db(pool, &path[0]).await?;
            let sys = if opts.show_system { "" } else { " and nspname not in ('pg_catalog','information_schema')" };
            let rows = pool
                .query_strings(&format!(
                    "select nspname, coalesce(obj_description(oid, 'pg_namespace'), ''), pg_get_userbyid(nspowner) \
                     from pg_namespace where nspname !~ '^pg_toast' and nspname !~ '^pg_temp' and nspname !~ '^pg_toast_temp'{sys} \
                     order by (nspname = 'public') desc, nspname"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::Schema,
                        &s(r, 0),
                        nonempty(s(r, 1)),
                        child_path(path, &s(r, 0)),
                        true,
                        json!({ "schema": s(r, 0), "owner": s(r, 2), "system": matches!(s(r, 0).as_str(), "pg_catalog" | "information_schema") }),
                    )
                })
                .collect())
        }
        2 => {
            let sc = &path[1];
            let rows = pool
                .query_strings(&format!(
                    "select \
                     (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p','f')), \
                     (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind = 'v'), \
                     (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind = 'm'), \
                     (select count(*) from pg_proc p where p.pronamespace = n.oid and p.prokind in ('f','p') \
                        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')), \
                     (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind = 'S') \
                     from pg_namespace n where n.nspname = {}",
                    lit(sc)
                ))
                .await?;
            let r = rows.first().ok_or_else(|| DbError::NotFound(format!("Schema {sc} not found")))?;
            let keys = ["tables", "views", "materialized_views", "routines", "sequences"];
            Ok(keys
                .iter()
                .enumerate()
                .filter(|(i, _)| n(r, *i) > 0)
                .map(|(i, k)| folder(ds, path, k, n(r, i), Some(sc), None))
                .collect())
        }
        3 => pg_objects(pool, ds, path).await,
        4 => pg_object_folders(pool, ds, path).await,
        5 => pg_object_items(pool, ds, path).await,
        _ => Err(bad_path(path)),
    }
}

async fn pg_check_db(pool: &Pool, db: &str) -> Result<()> {
    let r = pool.query_strings("select current_database()").await?;
    let cur = r.first().map(|r| s(r, 0)).unwrap_or_default();
    if cur != db {
        return Err(DbError::Unsupported(format!(
            "Database '{db}' is not the one this data source is connected to ('{cur}'). Create a data source for it."
        )));
    }
    Ok(())
}

async fn pg_objects(pool: &Pool, ds: &str, path: &[String]) -> Result<Vec<TreeNode>> {
    let sc = &path[1];
    let lit = |v: &str| quote_literal(Driver::Postgres, v);
    let key = path[2].as_str();
    match key {
        "tables" | "views" | "materialized_views" | "sequences" => {
            let (kinds, kind) = match key {
                "tables" => ("'r','p','f'", NodeKind::Table),
                "views" => ("'v'", NodeKind::View),
                "materialized_views" => ("'m'", NodeKind::MaterializedView),
                _ => ("'S'", NodeKind::Sequence),
            };
            let rows = pool
                .query_strings(&format!(
                    "select c.relname, c.relkind::text, c.reltuples::bigint::text, coalesce(obj_description(c.oid, 'pg_class'), ''), c.oid::text \
                     from pg_class c join pg_namespace n on n.oid = c.relnamespace \
                     where n.nspname = {} and c.relkind in ({kinds}) order by c.relname",
                    lit(sc)
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    let est = n(r, 2);
                    mk(
                        ds,
                        kind,
                        &s(r, 0),
                        nonempty(s(r, 3)),
                        child_path(path, &s(r, 0)),
                        kind != NodeKind::Sequence,
                        json!({ "schema": sc, "relkind": s(r, 1), "rowEstimate": if est >= 0 { Some(est) } else { None }, "oid": s(r, 4), "comment": s(r, 3) }),
                    )
                })
                .collect())
        }
        "routines" => {
            let rows = pool
                .query_strings(&format!(
                    "select p.proname, pg_get_function_identity_arguments(p.oid), coalesce(pg_get_function_result(p.oid), ''), p.prokind::text, p.oid::text \
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace \
                     where n.nspname = {} and p.prokind in ('f','p') \
                       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') \
                     order by p.proname, p.oid",
                    lit(sc)
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    let proc_ = s(r, 3) == "p";
                    let hint = if proc_ { format!("({})", s(r, 1)) } else { format!("({}): {}", s(r, 1), s(r, 2)) };
                    mk(
                        ds,
                        if proc_ { NodeKind::Procedure } else { NodeKind::Function },
                        &s(r, 0),
                        Some(hint),
                        child_path(path, &format!("{}({})", s(r, 0), s(r, 1))),
                        false,
                        json!({ "schema": sc, "signature": s(r, 1), "returns": s(r, 2), "oid": s(r, 4) }),
                    )
                })
                .collect())
        }
        _ => Err(bad_path(path)),
    }
}

async fn pg_object_folders(pool: &Pool, ds: &str, path: &[String]) -> Result<Vec<TreeNode>> {
    let (sc, key, t) = (&path[1], path[2].as_str(), &path[3]);
    if !matches!(key, "tables" | "views" | "materialized_views") {
        return Err(bad_path(path));
    }
    let rel = pg_rel(sc, t);
    let rows = pool
        .query_strings(&format!(
            "select \
             (select count(*) from pg_attribute a where a.attrelid = {rel} and a.attnum > 0 and not a.attisdropped), \
             (select count(*) from pg_constraint where conrelid = {rel} and contype in ('p','u')), \
             (select count(*) from pg_constraint where conrelid = {rel} and contype = 'f'), \
             (select count(*) from pg_index where indrelid = {rel}), \
             (select count(*) from pg_constraint where conrelid = {rel} and contype = 'c'), \
             (select count(*) from pg_trigger where tgrelid = {rel} and not tgisinternal)"
        ))
        .await?;
    let r = rows.first().ok_or_else(|| bad_path(path))?;
    let wanted: &[(&str, usize)] = match key {
        "tables" => &[("columns", 0), ("keys", 1), ("foreign_keys", 2), ("indexes", 3), ("checks", 4), ("triggers", 5)],
        "views" => &[("columns", 0), ("triggers", 5)],
        _ => &[("columns", 0), ("indexes", 3)],
    };
    Ok(wanted
        .iter()
        .filter(|(k, i)| *k == "columns" || n(r, *i) > 0)
        .map(|(k, i)| folder(ds, path, k, n(r, *i), Some(sc), Some(t)))
        .collect())
}

async fn pg_object_items(pool: &Pool, ds: &str, path: &[String]) -> Result<Vec<TreeNode>> {
    let (sc, t, sub) = (&path[1], &path[3], path[4].as_str());
    let rel = pg_rel(sc, t);
    let ex = |v: Value| -> Value {
        let mut m = v.as_object().cloned().unwrap_or_default();
        m.insert("schema".into(), json!(sc));
        m.insert("table".into(), json!(t));
        Value::Object(m)
    };
    match sub {
        "columns" => {
            let rows = pool.query_strings(&pg_columns_sql(&rel)).await?;
            Ok(rows
                .iter()
                .map(|r| {
                    let ty = short_type(&s(r, 1));
                    let pk = b(r, 7);
                    mk(
                        ds,
                        NodeKind::Column,
                        &s(r, 0),
                        Some(ty.clone()),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({
                            "dataType": s(r, 1), "nullable": !b(r, 2), "default": nonempty(s(r, 3)),
                            "identity": nonempty(s(r, 4)), "generated": nonempty(s(r, 5)),
                            "comment": s(r, 6), "isPk": pk, "position": n(r, 8)
                        })),
                    )
                })
                .collect())
        }
        "keys" => {
            let rows = pool
                .query_strings(&format!(
                    "select c.conname, c.contype::text, pg_get_constraintdef(c.oid), {} from pg_constraint c \
                     where c.conrelid = {rel} and c.contype in ('p','u') order by c.contype, c.conname",
                    pg_conkey_cols("c.conkey", "c.conrelid")
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    let pk = s(r, 1) == "p";
                    mk(
                        ds,
                        if pk { NodeKind::PrimaryKey } else { NodeKind::UniqueKey },
                        &s(r, 0),
                        Some(format!("({})", s(r, 3))),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({ "columns": s(r, 3).split(", ").collect::<Vec<_>>(), "definition": s(r, 2) })),
                    )
                })
                .collect())
        }
        "foreign_keys" => {
            let rows = pool
                .query_strings(&format!(
                    "select c.conname, pg_get_constraintdef(c.oid), {}, c.confrelid::regclass::text, {}, \
                            (select nspname from pg_namespace where oid = (select relnamespace from pg_class where oid = c.confrelid)), \
                            (select relname from pg_class where oid = c.confrelid) \
                     from pg_constraint c where c.conrelid = {rel} and c.contype = 'f' order by c.conname",
                    pg_conkey_cols("c.conkey", "c.conrelid"),
                    pg_conkey_cols("c.confkey", "c.confrelid")
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::ForeignKey,
                        &s(r, 0),
                        Some(format!("({}) -> {}({})", s(r, 2), s(r, 3), s(r, 4))),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({
                            "columns": s(r, 2).split(", ").collect::<Vec<_>>(),
                            "refSchema": s(r, 5), "refTable": s(r, 6),
                            "refColumns": s(r, 4).split(", ").collect::<Vec<_>>(), "definition": s(r, 1)
                        })),
                    )
                })
                .collect())
        }
        "indexes" => {
            let rows = pool
                .query_strings(&format!(
                    "select i.relname, ix.indisunique::text, ix.indisprimary::text, pg_get_indexdef(ix.indexrelid), am.amname, \
                            (select string_agg(pg_get_indexdef(ix.indexrelid, k, true), ', ' order by k) from generate_series(1, ix.indnkeyatts) k) \
                     from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_am am on am.oid = i.relam \
                     where ix.indrelid = {rel} order by i.relname"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::Index,
                        &s(r, 0),
                        Some(format!("({})", s(r, 5))),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({ "unique": b(r, 1), "primary": b(r, 2), "definition": s(r, 3), "method": s(r, 4), "columns": s(r, 5) })),
                    )
                })
                .collect())
        }
        "checks" => {
            let rows = pool
                .query_strings(&format!(
                    "select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = {rel} and contype = 'c' order by conname"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    mk(ds, NodeKind::Check, &s(r, 0), Some(s(r, 1)), child_path(path, &s(r, 0)), false, ex(json!({ "definition": s(r, 1) })))
                })
                .collect())
        }
        "triggers" => {
            let rows = pool
                .query_strings(&format!(
                    "select tgname, pg_get_triggerdef(oid), tgtype::int::text, tgenabled::text from pg_trigger \
                     where tgrelid = {rel} and not tgisinternal order by tgname"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::Trigger,
                        &s(r, 0),
                        Some(pg_trigger_hint(n(r, 2))),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({ "definition": s(r, 1), "enabled": s(r, 3) != "D" })),
                    )
                })
                .collect())
        }
        _ => Err(bad_path(path)),
    }
}

fn pg_conkey_cols(keys: &str, rel: &str) -> String {
    format!(
        "(select string_agg(a.attname, ', ' order by k.ord) from unnest({keys}) with ordinality as k(attnum, ord) \
          join pg_attribute a on a.attrelid = {rel} and a.attnum = k.attnum)"
    )
}

fn pg_columns_sql(rel: &str) -> String {
    format!(
        "select a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull::text, coalesce(pg_get_expr(d.adbin, d.adrelid), ''), \
                a.attidentity::text, a.attgenerated::text, coalesce(col_description(a.attrelid, a.attnum), ''), \
                (exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary and a.attnum = any (i.indkey)))::text, \
                a.attnum::text, \
                coalesce((with recursive r(oid, dim, n) as (\
                              select a.atttypid, 0, 0 \
                              union all \
                              select case when t.typtype = 'd' then t.typbasetype else t.typelem end, \
                                     case when t.typtype = 'd' then r.dim else r.dim + 1 end, r.n + 1 \
                              from r join pg_type t on t.oid = r.oid \
                              where (t.typtype = 'd' or (t.typcategory = 'A' and t.typelem <> 0)) and r.n < 8) \
                          select format_type(oid, null) || repeat('[]', dim) from r order by n desc limit 1), \
                         format_type(a.atttypid, null)) \
         from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum \
         where a.attrelid = {rel} and a.attnum > 0 and not a.attisdropped order by a.attnum"
    )
}

// ================================================================= MySQL

fn my_lit(v: &str) -> String {
    quote_literal(Driver::MySql, v)
}

const MY_SYSTEM: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

async fn my_children(live: &Live, ds: &str, path: &[String], opts: &IntrospectOptions) -> Result<Vec<TreeNode>> {
    let pool = &live.pool;
    match path.len() {
        0 => {
            let rows = pool
                .query_strings("select schema_name, default_character_set_name from information_schema.schemata order by schema_name")
                .await?;
            Ok(rows
                .iter()
                .filter(|r| opts.show_system || !MY_SYSTEM.contains(&s(r, 0).to_lowercase().as_str()))
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::Schema,
                        &s(r, 0),
                        None,
                        vec![s(r, 0)],
                        true,
                        json!({ "schema": s(r, 0), "charset": s(r, 1), "system": MY_SYSTEM.contains(&s(r, 0).to_lowercase().as_str()) }),
                    )
                })
                .collect())
        }
        1 => {
            let sc = &path[0];
            let rows = pool
                .query_strings(&format!(
                    "select \
                     (select count(*) from information_schema.tables where table_schema = {l} and table_type = 'BASE TABLE'), \
                     (select count(*) from information_schema.tables where table_schema = {l} and table_type in ('VIEW','SYSTEM VIEW')), \
                     (select count(*) from information_schema.routines where routine_schema = {l})",
                    l = my_lit(sc)
                ))
                .await?;
            let r = rows.first().cloned().unwrap_or_default();
            Ok(["tables", "views", "routines"]
                .iter()
                .enumerate()
                .filter(|(i, _)| n(&r, *i) > 0)
                .map(|(i, k)| folder(ds, path, k, n(&r, i), Some(sc), None))
                .collect())
        }
        2 => {
            let sc = &path[0];
            match path[1].as_str() {
                "tables" => {
                    let rows = pool
                        .query_strings(&format!(
                            "select table_name, table_comment, coalesce(table_rows, 0), coalesce(engine, '') from information_schema.tables \
                             where table_schema = {} and table_type = 'BASE TABLE' order by table_name",
                            my_lit(sc)
                        ))
                        .await?;
                    Ok(rows
                        .iter()
                        .map(|r| {
                            mk(
                                ds,
                                NodeKind::Table,
                                &s(r, 0),
                                nonempty(s(r, 1)),
                                child_path(path, &s(r, 0)),
                                true,
                                json!({ "schema": sc, "rowEstimate": n(r, 2), "engine": s(r, 3), "comment": s(r, 1) }),
                            )
                        })
                        .collect())
                }
                "views" => {
                    let rows = pool
                        .query_strings(&format!(
                            "select table_name from information_schema.tables where table_schema = {} \
                             and table_type in ('VIEW','SYSTEM VIEW') order by table_name",
                            my_lit(sc)
                        ))
                        .await?;
                    Ok(rows
                        .iter()
                        .map(|r| mk(ds, NodeKind::View, &s(r, 0), None, child_path(path, &s(r, 0)), true, json!({ "schema": sc })))
                        .collect())
                }
                "routines" => {
                    let rows = pool
                        .query_strings(&format!(
                            "select routine_name, routine_type, coalesce(dtd_identifier, '') from information_schema.routines \
                             where routine_schema = {} order by routine_name",
                            my_lit(sc)
                        ))
                        .await?;
                    Ok(rows
                        .iter()
                        .map(|r| {
                            let proc_ = s(r, 1) == "PROCEDURE";
                            mk(
                                ds,
                                if proc_ { NodeKind::Procedure } else { NodeKind::Function },
                                &s(r, 0),
                                if proc_ { None } else { nonempty(s(r, 2)) },
                                child_path(path, &s(r, 0)),
                                false,
                                json!({ "schema": sc, "routineType": s(r, 1) }),
                            )
                        })
                        .collect())
                }
                _ => Err(bad_path(path)),
            }
        }
        3 => {
            let (sc, key, t) = (&path[0], path[1].as_str(), &path[2]);
            let (l, tl) = (my_lit(sc), my_lit(t));
            if key == "views" {
                let rows = pool
                    .query_strings(&format!(
                        "select count(*) from information_schema.columns where table_schema = {l} and table_name = {tl}"
                    ))
                    .await?;
                return Ok(vec![folder(ds, path, "columns", rows.first().map(|r| n(r, 0)).unwrap_or(0), Some(sc), Some(t))]);
            }
            if key != "tables" {
                return Err(bad_path(path));
            }
            let tc = |ty: &str| {
                format!(
                    "(select count(*) from information_schema.table_constraints where table_schema = {l} and table_name = {tl} and constraint_type {ty})"
                )
            };
            let rows = pool
                .query_strings(&format!(
                    "select (select count(*) from information_schema.columns where table_schema = {l} and table_name = {tl}), \
                     {}, {}, \
                     (select count(distinct index_name) from information_schema.statistics where table_schema = {l} and table_name = {tl}), \
                     {}, \
                     (select count(*) from information_schema.triggers where event_object_schema = {l} and event_object_table = {tl})",
                    tc("in ('PRIMARY KEY','UNIQUE')"),
                    tc("= 'FOREIGN KEY'"),
                    tc("= 'CHECK'")
                ))
                .await?;
            let r = rows.first().cloned().unwrap_or_default();
            Ok([("columns", 0), ("keys", 1), ("foreign_keys", 2), ("indexes", 3), ("checks", 4), ("triggers", 5)]
                .iter()
                .filter(|(k, i)| *k == "columns" || n(&r, *i) > 0)
                .map(|(k, i)| folder(ds, path, k, n(&r, *i), Some(sc), Some(t)))
                .collect())
        }
        4 => my_object_items(&live.pool, ds, path).await,
        _ => Err(bad_path(path)),
    }
}

async fn my_object_items(pool: &Pool, ds: &str, path: &[String]) -> Result<Vec<TreeNode>> {
    let (sc, t, sub) = (&path[0], &path[2], path[3].as_str());
    let (l, tl) = (my_lit(sc), my_lit(t));
    let ex = |v: Value| -> Value {
        let mut m = v.as_object().cloned().unwrap_or_default();
        m.insert("schema".into(), json!(sc));
        m.insert("table".into(), json!(t));
        Value::Object(m)
    };
    match sub {
        "columns" => {
            let rows = pool
                .query_strings(&format!(
                    "select column_name, column_type, is_nullable, column_default, column_key, extra, column_comment, ordinal_position \
                     from information_schema.columns where table_schema = {l} and table_name = {tl} order by ordinal_position"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::Column,
                        &s(r, 0),
                        Some(s(r, 1)),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({
                            "dataType": s(r, 1), "nullable": s(r, 2) == "YES", "default": so(r, 3), "isPk": s(r, 4) == "PRI",
                            "extra": s(r, 5), "comment": s(r, 6), "position": n(r, 7)
                        })),
                    )
                })
                .collect())
        }
        "keys" => {
            let rows = pool
                .query_strings(&format!(
                    "select tc.constraint_name, tc.constraint_type, \
                       (select group_concat(k.column_name order by k.ordinal_position separator ', ') from information_schema.key_column_usage k \
                        where k.constraint_schema = tc.constraint_schema and k.table_schema = tc.table_schema \
                          and k.table_name = tc.table_name and k.constraint_name = tc.constraint_name) \
                     from information_schema.table_constraints tc \
                     where tc.table_schema = {l} and tc.table_name = {tl} and tc.constraint_type in ('PRIMARY KEY','UNIQUE') \
                     order by tc.constraint_type, tc.constraint_name"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    let pk = s(r, 1) == "PRIMARY KEY";
                    mk(
                        ds,
                        if pk { NodeKind::PrimaryKey } else { NodeKind::UniqueKey },
                        &s(r, 0),
                        Some(format!("({})", s(r, 2))),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({ "columns": s(r, 2).split(", ").collect::<Vec<_>>() })),
                    )
                })
                .collect())
        }
        "foreign_keys" => {
            let rows = pool
                .query_strings(&format!(
                    "select k.constraint_name, group_concat(k.column_name order by k.ordinal_position separator ', '), \
                            max(k.referenced_table_schema), max(k.referenced_table_name), \
                            group_concat(k.referenced_column_name order by k.ordinal_position separator ', '), \
                            max(rc.update_rule), max(rc.delete_rule) \
                     from information_schema.key_column_usage k \
                     join information_schema.referential_constraints rc \
                       on rc.constraint_schema = k.constraint_schema and rc.constraint_name = k.constraint_name \
                     where k.table_schema = {l} and k.table_name = {tl} and k.referenced_table_name is not null \
                     group by k.constraint_name order by k.constraint_name"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::ForeignKey,
                        &s(r, 0),
                        Some(format!("({}) -> {}({})", s(r, 1), s(r, 3), s(r, 4))),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({
                            "columns": s(r, 1).split(", ").collect::<Vec<_>>(), "refSchema": s(r, 2), "refTable": s(r, 3),
                            "refColumns": s(r, 4).split(", ").collect::<Vec<_>>(), "onUpdate": s(r, 5), "onDelete": s(r, 6)
                        })),
                    )
                })
                .collect())
        }
        "indexes" => {
            let rows = pool
                .query_strings(&format!(
                    "select index_name, max(non_unique), group_concat(column_name order by seq_in_index separator ', '), max(index_type) \
                     from information_schema.statistics where table_schema = {l} and table_name = {tl} \
                     group by index_name order by (index_name = 'PRIMARY') desc, index_name"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::Index,
                        &s(r, 0),
                        Some(format!("({})", s(r, 2))),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({ "unique": s(r, 1) == "0", "primary": s(r, 0) == "PRIMARY", "method": s(r, 3), "columns": s(r, 2) })),
                    )
                })
                .collect())
        }
        "checks" => {
            let rows = pool
                .query_strings(&format!(
                    "select cc.constraint_name, cc.check_clause from information_schema.check_constraints cc \
                     join information_schema.table_constraints tc on tc.constraint_schema = cc.constraint_schema and tc.constraint_name = cc.constraint_name \
                     where tc.table_schema = {l} and tc.table_name = {tl} and tc.constraint_type = 'CHECK' order by cc.constraint_name"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| mk(ds, NodeKind::Check, &s(r, 0), Some(s(r, 1)), child_path(path, &s(r, 0)), false, ex(json!({ "definition": s(r, 1) }))))
                .collect())
        }
        "triggers" => {
            let rows = pool
                .query_strings(&format!(
                    "select trigger_name, action_timing, event_manipulation from information_schema.triggers \
                     where event_object_schema = {l} and event_object_table = {tl} order by trigger_name"
                ))
                .await?;
            Ok(rows
                .iter()
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::Trigger,
                        &s(r, 0),
                        Some(format!("{} {}", s(r, 1), s(r, 2))),
                        child_path(path, &s(r, 0)),
                        false,
                        ex(json!({})),
                    )
                })
                .collect())
        }
        _ => Err(bad_path(path)),
    }
}

// ================================================================ SQLite

fn lq(v: &str) -> String {
    quote_ident(Driver::Sqlite, v)
}
fn ll(v: &str) -> String {
    quote_literal(Driver::Sqlite, v)
}

async fn lite_children(live: &Live, ds: &str, path: &[String], opts: &IntrospectOptions) -> Result<Vec<TreeNode>> {
    let pool = &live.pool;
    match path.len() {
        0 => {
            let rows = pool.query_strings("pragma database_list").await?;
            Ok(rows
                .iter()
                .filter(|r| opts.show_system || s(r, 1) != "temp")
                .map(|r| {
                    mk(
                        ds,
                        NodeKind::Schema,
                        &s(r, 1),
                        nonempty(s(r, 2)),
                        vec![s(r, 1)],
                        true,
                        json!({ "schema": s(r, 1), "file": s(r, 2), "system": s(r, 1) == "temp" }),
                    )
                })
                .collect())
        }
        1 => {
            let sc = &path[0];
            let rows = pool
                .query_strings(&format!(
                    "select type, count(*) from {}.sqlite_master where type in ('table','view') \
                     and name not like 'sqlite\\_%' escape '\\' group by type",
                    lq(sc)
                ))
                .await?;
            let cnt = |ty: &str| rows.iter().find(|r| s(r, 0) == ty).map(|r| n(r, 1)).unwrap_or(0);
            let mut out = Vec::new();
            for (k, ty) in [("tables", "table"), ("views", "view")] {
                if cnt(ty) > 0 {
                    out.push(folder(ds, path, k, cnt(ty), Some(sc), None));
                }
            }
            Ok(out)
        }
        2 => {
            let sc = &path[0];
            let (ty, kind) = match path[1].as_str() {
                "tables" => ("table", NodeKind::Table),
                "views" => ("view", NodeKind::View),
                _ => return Err(bad_path(path)),
            };
            let sys = if opts.show_system { "" } else { " and name not like 'sqlite\\_%' escape '\\'" };
            let rows = pool
                .query_strings(&format!("select name from {}.sqlite_master where type = '{ty}'{sys} order by name", lq(sc)))
                .await?;
            Ok(rows
                .iter()
                .map(|r| mk(ds, kind, &s(r, 0), None, child_path(path, &s(r, 0)), true, json!({ "schema": sc })))
                .collect())
        }
        3 => {
            let (sc, key, t) = (&path[0], path[1].as_str(), &path[2]);
            let cols = lite_columns(pool, sc, t).await?;
            let mut out = vec![folder(ds, path, "columns", cols.len() as i64, Some(sc), Some(t))];
            if key == "tables" {
                let has_pk = cols.iter().any(|c| c.is_pk);
                let idx = lite_index_list(pool, sc, t).await?;
                let uniq = idx.iter().filter(|i| i.origin == "u").count() as i64;
                let keys = has_pk as i64 + uniq;
                let fks = lite_fks(pool, sc, t).await?.len() as i64;
                let user_idx = idx.iter().filter(|i| i.origin == "c").count() as i64;
                let trig = pool
                    .query_strings(&format!(
                        "select count(*) from {}.sqlite_master where type = 'trigger' and tbl_name = {}",
                        lq(sc),
                        ll(t)
                    ))
                    .await?
                    .first()
                    .map(|r| n(r, 0))
                    .unwrap_or(0);
                for (k, c) in [("keys", keys), ("foreign_keys", fks), ("indexes", user_idx), ("triggers", trig)] {
                    if c > 0 {
                        out.push(folder(ds, path, k, c, Some(sc), Some(t)));
                    }
                }
            }
            Ok(out)
        }
        4 => {
            let (sc, t, sub) = (&path[0], &path[2], path[3].as_str());
            let ex = |v: Value| -> Value {
                let mut m = v.as_object().cloned().unwrap_or_default();
                m.insert("schema".into(), json!(sc));
                m.insert("table".into(), json!(t));
                Value::Object(m)
            };
            match sub {
                "columns" => Ok(lite_columns(pool, sc, t)
                    .await?
                    .into_iter()
                    .map(|c| {
                        mk(
                            ds,
                            NodeKind::Column,
                            &c.name,
                            Some(c.type_name.clone()),
                            child_path(path, &c.name),
                            false,
                            ex(json!({ "dataType": c.type_name, "nullable": c.nullable, "default": c.default, "isPk": c.is_pk, "generated": c.generated })),
                        )
                    })
                    .collect()),
                "keys" => {
                    let cols = lite_columns(pool, sc, t).await?;
                    let mut pk: Vec<_> = cols.iter().filter(|c| c.is_pk).collect();
                    pk.sort_by_key(|c| c.pk_pos);
                    let mut out = Vec::new();
                    if !pk.is_empty() {
                        let names: Vec<_> = pk.iter().map(|c| c.name.clone()).collect();
                        let name = format!("{t}_pk");
                        out.push(mk(
                            ds,
                            NodeKind::PrimaryKey,
                            &name,
                            Some(format!("({})", names.join(", "))),
                            child_path(path, &name),
                            false,
                            ex(json!({ "columns": names })),
                        ));
                    }
                    for i in lite_index_list(pool, sc, t).await?.into_iter().filter(|i| i.origin == "u") {
                        let names = lite_index_columns(pool, sc, &i.name).await?;
                        out.push(mk(
                            ds,
                            NodeKind::UniqueKey,
                            &i.name,
                            Some(format!("({})", names.join(", "))),
                            child_path(path, &i.name),
                            false,
                            ex(json!({ "columns": names })),
                        ));
                    }
                    Ok(out)
                }
                "foreign_keys" => Ok(lite_fks(pool, sc, t)
                    .await?
                    .into_iter()
                    .map(|f| {
                        let name = format!("{t}_{}_fk", f.from.join("_"));
                        mk(
                            ds,
                            NodeKind::ForeignKey,
                            &name,
                            Some(format!("({}) -> {}({})", f.from.join(", "), f.table, f.to.join(", "))),
                            child_path(path, &name),
                            false,
                            ex(json!({ "columns": f.from, "refTable": f.table, "refColumns": f.to, "onUpdate": f.on_update, "onDelete": f.on_delete })),
                        )
                    })
                    .collect()),
                "indexes" => {
                    let mut out = Vec::new();
                    for i in lite_index_list(pool, sc, t).await?.into_iter().filter(|i| i.origin == "c") {
                        let names = lite_index_columns(pool, sc, &i.name).await?;
                        out.push(mk(
                            ds,
                            NodeKind::Index,
                            &i.name,
                            Some(format!("({})", names.join(", "))),
                            child_path(path, &i.name),
                            false,
                            ex(json!({ "unique": i.unique, "columns": names.join(", "), "partial": i.partial })),
                        ));
                    }
                    Ok(out)
                }
                "triggers" => {
                    let rows = pool
                        .query_strings(&format!(
                            "select name, sql from {}.sqlite_master where type = 'trigger' and tbl_name = {} order by name",
                            lq(sc),
                            ll(t)
                        ))
                        .await?;
                    Ok(rows
                        .iter()
                        .map(|r| {
                            let sql = s(r, 1);
                            mk(ds, NodeKind::Trigger, &s(r, 0), nonempty(lite_trigger_hint(&sql)), child_path(path, &s(r, 0)), false, ex(json!({ "definition": sql })))
                        })
                        .collect())
                }
                _ => Err(bad_path(path)),
            }
        }
        _ => Err(bad_path(path)),
    }
}

fn lite_trigger_hint(sql: &str) -> String {
    let up: Vec<String> = sql.split_whitespace().map(|w| w.to_ascii_uppercase()).collect();
    let mut timing = String::new();
    let mut event = String::new();
    for (i, w) in up.iter().enumerate() {
        match w.as_str() {
            "BEFORE" | "AFTER" if timing.is_empty() => timing = w.clone(),
            "INSTEAD" if timing.is_empty() => timing = "INSTEAD OF".into(),
            "INSERT" | "DELETE" | "UPDATE" if event.is_empty() && i > 0 => event = w.clone(),
            _ => {}
        }
    }
    format!("{timing} {event}").trim().to_string()
}

struct LiteIndex {
    name: String,
    unique: bool,
    origin: String,
    partial: bool,
}

struct LiteFk {
    from: Vec<String>,
    table: String,
    to: Vec<String>,
    on_update: String,
    on_delete: String,
}

async fn lite_index_list(pool: &Pool, schema: &str, table: &str) -> Result<Vec<LiteIndex>> {
    let rows = pool.query_strings(&format!("pragma {}.index_list({})", lq(schema), ll(table))).await?;
    Ok(rows
        .iter()
        .map(|r| LiteIndex { name: s(r, 1), unique: b(r, 2), origin: s(r, 3), partial: b(r, 4) })
        .collect())
}

async fn lite_index_columns(pool: &Pool, schema: &str, index: &str) -> Result<Vec<String>> {
    let rows = pool.query_strings(&format!("pragma {}.index_info({})", lq(schema), ll(index))).await?;
    Ok(rows.iter().map(|r| s(r, 2)).collect())
}

async fn lite_fks(pool: &Pool, schema: &str, table: &str) -> Result<Vec<LiteFk>> {
    let rows = pool.query_strings(&format!("pragma {}.foreign_key_list({})", lq(schema), ll(table))).await?;
    // columns: id, seq, table, from, to, on_update, on_delete, match
    let mut out: Vec<(i64, LiteFk)> = Vec::new();
    for r in &rows {
        let id = n(r, 0);
        match out.iter_mut().find(|(i, _)| *i == id) {
            Some((_, f)) => {
                f.from.push(s(r, 3));
                f.to.push(s(r, 4));
            }
            None => out.push((
                id,
                LiteFk { from: vec![s(r, 3)], table: s(r, 2), to: vec![s(r, 4)], on_update: s(r, 5), on_delete: s(r, 6) },
            )),
        }
    }
    Ok(out.into_iter().map(|(_, f)| f).collect())
}

// ------------------------------------------------------ column metadata (shared)

#[derive(Debug, Clone)]
pub(crate) struct ColInfo {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub pk_pos: i64,
    pub default: Option<String>,
    pub generated: bool,
    /// Type to `cast(.. as T)` bound values to, **without** length / precision modifiers (PG:
    /// domains resolved to their base type, `character` -> `bpchar`, `bit` -> `bit varying`),
    /// so the assignment to the column performs the length check instead of an explicit cast
    /// that truncates silently. Same as `type_name` for the other drivers.
    pub base_type: String,
}

async fn lite_columns(pool: &Pool, schema: &str, table: &str) -> Result<Vec<ColInfo>> {
    // table_xinfo: cid, name, type, notnull, dflt_value, pk, hidden
    let rows = pool.query_strings(&format!("pragma {}.table_xinfo({})", lq(schema), ll(table))).await?;
    Ok(rows
        .iter()
        .filter(|r| n(r, 6) != 1)
        .map(|r| ColInfo {
            name: s(r, 1),
            type_name: s(r, 2),
            nullable: n(r, 3) == 0,
            is_pk: n(r, 5) > 0,
            pk_pos: n(r, 5),
            default: so(r, 4),
            generated: n(r, 6) >= 2,
            base_type: s(r, 2),
        })
        .collect())
}

/// Columns of a table / view with PK flags, for the data editor and DDL.
pub(crate) async fn table_columns(live: &Live, schema: Option<&str>, table: &str) -> Result<Vec<ColInfo>> {
    let pool = &live.pool;
    let cols: Vec<ColInfo> = match live.driver() {
        Driver::Postgres => {
            let sc = schema.unwrap_or("public");
            let rows = pool.query_strings(&pg_columns_sql(&pg_rel(sc, table))).await?;
            rows.iter()
                .map(|r| ColInfo {
                    name: s(r, 0),
                    type_name: s(r, 1),
                    nullable: !b(r, 2),
                    is_pk: b(r, 7),
                    pk_pos: 0,
                    default: nonempty(s(r, 3)),
                    generated: !s(r, 5).is_empty() || !s(r, 4).is_empty(),
                    base_type: crate::table::pg_cast_type(&s(r, 9)),
                })
                .collect()
        }
        Driver::MySql => {
            let sc = match schema {
                Some(sc) => sc.to_string(),
                None => pool.query_strings("select database()").await?.first().map(|r| s(r, 0)).unwrap_or_default(),
            };
            let rows = pool
                .query_strings(&format!(
                    "select column_name, column_type, is_nullable, column_default, column_key, extra \
                     from information_schema.columns where table_schema = {} and table_name = {} order by ordinal_position",
                    my_lit(&sc),
                    my_lit(table)
                ))
                .await?;
            rows.iter()
                .map(|r| ColInfo {
                    name: s(r, 0),
                    type_name: s(r, 1),
                    nullable: s(r, 2) == "YES",
                    is_pk: s(r, 4) == "PRI",
                    pk_pos: 0,
                    default: so(r, 3),
                    generated: s(r, 5).contains("GENERATED") || s(r, 5).contains("auto_increment"),
                    base_type: s(r, 1),
                })
                .collect()
        }
        Driver::Sqlite => lite_columns(pool, schema.unwrap_or("main"), table).await?,
    };
    if cols.is_empty() {
        return Err(DbError::NotFound(format!("Table {} not found", table)));
    }
    Ok(cols)
}

/// How the rows of a table can be addressed physically when it has no primary key.
pub(crate) async fn row_addr(live: &Live, schema: Option<&str>, table: &str, info: &[ColInfo]) -> Result<crate::table::RowAddr> {
    use crate::table::RowAddr;
    if info.iter().any(|c| c.is_pk) {
        return Ok(RowAddr::None);
    }
    match live.driver() {
        Driver::Postgres => {
            let rel = pg_rel(schema.unwrap_or("public"), table);
            let rows = live.pool.query_strings(&format!("select relkind::text from pg_class where oid = {rel}")).await?;
            // ordinary and partitioned tables have ctid / tableoid; views, foreign tables, ... do not
            Ok(match rows.first().map(|r| s(r, 0)).as_deref() {
                Some("r") | Some("p") => RowAddr::PgCtid,
                _ => RowAddr::None,
            })
        }
        Driver::Sqlite => {
            let sc = schema.unwrap_or("main");
            // table_list: schema, name, type, ncol, wr (WITHOUT ROWID), strict
            let rows = match live.pool.query_strings(&format!("pragma {}.table_list({})", lq(sc), ll(table))).await {
                Ok(r) => r,
                Err(_) => return Ok(RowAddr::None),
            };
            let is_rowid_table = rows.iter().any(|r| s(r, 1).eq_ignore_ascii_case(table) && s(r, 2) == "table" && n(r, 4) == 0);
            if !is_rowid_table {
                return Ok(RowAddr::None);
            }
            // a user column named rowid shadows the alias: use the next free one
            let alias = ["rowid", "_rowid_", "oid"].into_iter().find(|a| !info.iter().any(|c| c.name.eq_ignore_ascii_case(a)));
            Ok(alias.map(|a| RowAddr::SqliteRowid(a.to_string())).unwrap_or(RowAddr::None))
        }
        Driver::MySql => Ok(RowAddr::None),
    }
}

// ------------------------------------------------------------------ snapshot

async fn snapshot(live: &Live, schema: Option<&str>) -> Result<Vec<SnapshotObject>> {
    let pool = &live.pool;
    let mut out: Vec<SnapshotObject> = Vec::new();
    let mut push = |schema: String, name: String, kind: NodeKind, col: Option<SnapshotColumn>| {
        if out.last().map(|o| o.schema != schema || o.name != name).unwrap_or(true) {
            out.push(SnapshotObject { schema, name, kind, columns: Vec::new() });
        }
        if let (Some(c), Some(o)) = (col, out.last_mut()) {
            o.columns.push(c);
        }
    };
    match live.driver() {
        Driver::Postgres => {
            let filter = match schema {
                Some(sc) => format!("n.nspname = {}", quote_literal(Driver::Postgres, sc)),
                None => "n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_toast' and n.nspname !~ '^pg_temp'".into(),
            };
            let rows = pool
                .query_strings(&format!(
                    "select n.nspname, c.relname, c.relkind::text, a.attname, format_type(a.atttypid, a.atttypmod), \
                            (coalesce(a.attnum = any (i.indkey), false))::text \
                     from pg_class c join pg_namespace n on n.oid = c.relnamespace \
                     left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped \
                     left join pg_index i on i.indrelid = c.oid and i.indisprimary \
                     where c.relkind in ('r','p','v','m','f') and {filter} order by n.nspname, c.relname, a.attnum"
                ))
                .await?;
            for r in rows {
                let kind = match s(&r, 2).as_str() {
                    "v" => NodeKind::View,
                    "m" => NodeKind::MaterializedView,
                    _ => NodeKind::Table,
                };
                let col = so(&r, 3).map(|name| SnapshotColumn { name, type_name: short_type(&s(&r, 4)), is_pk: b(&r, 5) });
                push(s(&r, 0), s(&r, 1), kind, col);
            }
        }
        Driver::MySql => {
            let filter = match schema {
                Some(sc) => format!("t.table_schema = {}", my_lit(sc)),
                None => "t.table_schema not in ('information_schema','mysql','performance_schema','sys')".into(),
            };
            let rows = pool
                .query_strings(&format!(
                    "select t.table_schema, t.table_name, t.table_type, c.column_name, c.column_type, c.column_key \
                     from information_schema.tables t left join information_schema.columns c \
                       on c.table_schema = t.table_schema and c.table_name = t.table_name \
                     where {filter} order by t.table_schema, t.table_name, c.ordinal_position"
                ))
                .await?;
            for r in rows {
                let kind = if s(&r, 2).contains("VIEW") { NodeKind::View } else { NodeKind::Table };
                let col = so(&r, 3).map(|name| SnapshotColumn { name, type_name: s(&r, 4), is_pk: s(&r, 5) == "PRI" });
                push(s(&r, 0), s(&r, 1), kind, col);
            }
        }
        Driver::Sqlite => {
            let schemas: Vec<String> = match schema {
                Some(sc) => vec![sc.to_string()],
                None => pool.query_strings("pragma database_list").await?.iter().map(|r| s(r, 1)).filter(|n| n != "temp").collect(),
            };
            for sc in schemas {
                let objs = pool
                    .query_strings(&format!(
                        "select name, type from {}.sqlite_master where type in ('table','view') and name not like 'sqlite\\_%' escape '\\' order by name",
                        lq(&sc)
                    ))
                    .await?;
                for o in objs {
                    let kind = if s(&o, 1) == "view" { NodeKind::View } else { NodeKind::Table };
                    let cols = lite_columns(pool, &sc, &s(&o, 0)).await?;
                    push(sc.clone(), s(&o, 0), kind, None);
                    for c in cols {
                        push(sc.clone(), s(&o, 0), kind, Some(SnapshotColumn { name: c.name, type_name: c.type_name, is_pk: c.is_pk }));
                    }
                }
            }
        }
    }
    Ok(out)
}
