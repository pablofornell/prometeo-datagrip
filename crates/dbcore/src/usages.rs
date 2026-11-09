//! Find Usages (Alt+F7): the objects that refer to a database object, and the lines of routine text that mention it.
//!
//! * Oracle: `ALL_DEPENDENCIES` (views, routines, packages, triggers, synonyms that depend on the object),
//!   `ALL_SYNONYMS`, `ALL_TRIGGERS`, the foreign keys of `ALL_CONSTRAINTS`; `ALL_SOURCE` gives the line of each
//!   PL/SQL unit that mentions the name, `ALL_VIEWS.TEXT_VC` the views that mention a column.
//! * PostgreSQL: `pg_depend` / `pg_rewrite` (views), `pg_constraint` (foreign keys), `pg_trigger`, `pg_index`,
//!   and the texts of the routines (`pg_proc.prosrc`).
//! * MySQL: `information_schema` `VIEWS`, `ROUTINES`, `KEY_COLUMN_USAGE`, `TRIGGERS`, `STATISTICS`.
//! * SQLite: `sqlite_master.sql` (views, triggers) and `pragma_foreign_key_list` of every table.
//!
//! Texts are matched on whole words ([`contains_word`]): `ORDER` does not match `ORDERS`. The match is textual, so a
//! name in a comment or a string literal counts too, and a column name is common: a column target lists more than the
//! real uses. Line numbers are lines of the stored text (routine bodies in PostgreSQL and MySQL start at line 1 of the
//! body, not of the `CREATE` statement).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::conn::Pool;
use crate::error::{DbError, Result};
use crate::manager::ConnectionManager;
use crate::model::{Driver, NodeKind, ObjectRef};
use crate::quote::{quote_ident, quote_literal};

/// What kind of object a usage is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageKind {
    View,
    MaterializedView,
    Function,
    Procedure,
    Package,
    PackageBody,
    Trigger,
    /// A foreign key: `name` / `table` is the table that holds it, `detail` names the constraint.
    ForeignKey,
    Synonym,
    Index,
}

/// One referring object, or one line of its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub schema: String,
    pub name: String,
    pub kind: UsageKind,
    /// What the usage is: the constraint of a foreign key, `references X`, `references column X`, or the text of the line.
    pub detail: String,
    /// 1-based line of the stored text (PL/SQL units, routine bodies); `None` for objects without text lines.
    pub line: Option<u32>,
    /// The table a trigger, a foreign key or an index sits on.
    pub table: Option<String>,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '$' | '#')
}

/// Does `text` contain `word` as a whole identifier? ASCII case-insensitive. A name next to a quote, a dot or a
/// parenthesis is a whole word; a name inside a longer identifier is not.
pub fn contains_word(text: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let hay = text.to_ascii_lowercase();
    let needle = word.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = hay[from..].find(&needle) {
        let start = from + i;
        let end = start + needle.len();
        let before = hay[..start].chars().next_back().is_some_and(is_word_char);
        let after = hay[end..].chars().next().is_some_and(is_word_char);
        if !before && !after {
            return true;
        }
        from = start + hay[start..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// The lines of `text` that contain `word` as a whole identifier, with their 1-based numbers.
pub fn word_lines<'a>(text: &'a str, word: &str) -> Vec<(u32, &'a str)> {
    text.lines()
        .enumerate()
        .filter(|(_, l)| contains_word(l, word))
        .map(|(i, l)| ((i + 1) as u32, l))
        .collect()
}

/// `text` cut to 200 characters: the detail of a line usage.
fn clip(text: &str) -> String {
    const MAX: usize = 200;
    match text.char_indices().nth(MAX) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_string(),
    }
}

/// Identifiers compare case-insensitively (Oracle and SQLite names are, quoted MySQL / PG names are close enough).
fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn has(list: &[String], column: &str) -> bool {
    list.iter().any(|c| same(c, column))
}

/// One column pair of a foreign key as the catalog returns it. `group` tells apart the constraints of a table
/// (SQLite has no constraint names: its `group` is the foreign key number); `constraint` is the name shown.
#[derive(Debug, Clone)]
struct FkCol {
    child_schema: String,
    child_table: String,
    group: String,
    constraint: String,
    child_col: String,
    parent_schema: String,
    parent_table: String,
    parent_col: String,
}

/// The object a search is about: its `column` when the target is a column.
struct Target {
    schema: String,
    name: String,
    column: Option<String>,
}

fn fk_detail(constraint: &str, cols: &[String], ptable: &str, pcols: &[String]) -> String {
    let head = if constraint.is_empty() {
        String::new()
    } else {
        format!("{constraint} ")
    };
    format!(
        "{head}({}) references {ptable} ({})",
        cols.join(", "),
        pcols.join(", ")
    )
}

/// Foreign keys that reference the target table (a table target), or that hold or are referenced by the target
/// column (a column target). Rows must come in constraint order.
fn fk_usages(rows: &[FkCol], t: &Target) -> Vec<Usage> {
    type Key = (String, String, String, String, String);
    let mut groups: BTreeMap<Key, (String, Vec<String>, Vec<String>)> = BTreeMap::new();
    for r in rows {
        let key = (
            r.child_schema.clone(),
            r.child_table.clone(),
            r.group.clone(),
            r.parent_schema.clone(),
            r.parent_table.clone(),
        );
        let g = groups
            .entry(key)
            .or_insert_with(|| (r.constraint.clone(), Vec::new(), Vec::new()));
        g.1.push(r.child_col.clone());
        g.2.push(r.parent_col.clone());
    }
    let mut out = Vec::new();
    for ((cs, ct, _, ps, pt), (constraint, cols, pcols)) in groups {
        let child = same(&cs, &t.schema) && same(&ct, &t.name);
        let parent = same(&ps, &t.schema) && same(&pt, &t.name);
        let keep = match &t.column {
            None => parent,
            Some(c) => (child && has(&cols, c)) || (parent && has(&pcols, c)),
        };
        if keep {
            out.push(Usage {
                schema: cs,
                name: ct.clone(),
                kind: UsageKind::ForeignKey,
                detail: fk_detail(&constraint, &cols, &pt, &pcols),
                line: None,
                table: Some(ct),
            });
        }
    }
    out
}

fn cell(r: &[Option<String>], i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
}

async fn first(pool: &Pool, sql: &str) -> Result<Option<String>> {
    Ok(pool
        .query_strings(sql)
        .await?
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next())
        .flatten())
}

fn table_of(o: &ObjectRef) -> Result<String> {
    o.table
        .clone()
        .ok_or_else(|| DbError::InvalidArgument(format!("{} needs a table", o.name)))
}

fn pl(v: &str) -> String {
    quote_literal(Driver::Postgres, v)
}

fn ml(v: &str) -> String {
    quote_literal(Driver::MySql, v)
}

fn sl(v: &str) -> String {
    quote_literal(Driver::Sqlite, v)
}

fn ol(v: &str) -> String {
    quote_literal(Driver::Oracle, v)
}

impl ConnectionManager {
    /// Usages of a database object (see the module doc). Kinds that have no usages (schemas, keys, checks, triggers,
    /// indexes, ...) give an empty list. Sorted by kind, schema, name and line.
    pub async fn find_usages(&self, ds_id: &str, object: &ObjectRef) -> Result<Vec<Usage>> {
        let live = self.live(ds_id)?;
        let mut out = match live.driver() {
            Driver::Postgres => pg_usages(&live.pool, object).await?,
            Driver::MySql => my_usages(&live.pool, object).await?,
            Driver::Sqlite => lite_usages(&live.pool, object).await?,
            Driver::Oracle => ora_usages(&live.pool, object).await?,
        };
        out.sort_by(|a, b| {
            (a.kind, &a.schema, &a.name, a.line, &a.detail)
                .cmp(&(b.kind, &b.schema, &b.name, b.line, &b.detail))
        });
        out.dedup();
        Ok(out)
    }
}

// ============================================================ Oracle

/// Usage kind of an `ALL_DEPENDENCIES` / `ALL_SOURCE` unit type.
fn ora_kind(ty: &str) -> Option<UsageKind> {
    Some(match ty {
        "VIEW" => UsageKind::View,
        "MATERIALIZED VIEW" => UsageKind::MaterializedView,
        "FUNCTION" => UsageKind::Function,
        "PROCEDURE" => UsageKind::Procedure,
        "PACKAGE" => UsageKind::Package,
        "PACKAGE BODY" => UsageKind::PackageBody,
        "TRIGGER" => UsageKind::Trigger,
        "SYNONYM" => UsageKind::Synonym,
        _ => return None,
    })
}

async fn ora_usages(pool: &Pool, o: &ObjectRef) -> Result<Vec<Usage>> {
    let sc = match &o.schema {
        Some(s) => s.clone(),
        None => crate::introspect::ora_current_schema(pool).await?,
    };
    // `dep`: the object the dependents refer to (the table of a column, the package of a routine that is a package
    // member); `word`: the name searched for in the text; `text_only`: only units with a text hit count (a column,
    // a package member: depending on the package is not using the member).
    let (dep, dep_types, word, column, text_only): (
        String,
        Vec<&str>,
        String,
        Option<String>,
        bool,
    ) = match o.kind {
        NodeKind::Table => (o.name.clone(), vec!["TABLE"], o.name.clone(), None, false),
        NodeKind::View => (o.name.clone(), vec!["VIEW"], o.name.clone(), None, false),
        NodeKind::MaterializedView => (
            o.name.clone(),
            vec!["MATERIALIZED VIEW"],
            o.name.clone(),
            None,
            false,
        ),
        NodeKind::Sequence => (
            o.name.clone(),
            vec!["SEQUENCE"],
            o.name.clone(),
            None,
            false,
        ),
        NodeKind::Synonym => (o.name.clone(), vec!["SYNONYM"], o.name.clone(), None, false),
        NodeKind::Package => (o.name.clone(), vec!["PACKAGE"], o.name.clone(), None, false),
        // the table of a column may be a view: its dependents are on the view
        NodeKind::Column => (
            table_of(o)?,
            vec!["TABLE", "VIEW", "MATERIALIZED VIEW"],
            o.name.clone(),
            Some(o.name.clone()),
            true,
        ),
        NodeKind::Function | NodeKind::Procedure | NodeKind::Routine => match &o.table {
            Some(pkg) => (pkg.clone(), vec!["PACKAGE"], o.name.clone(), None, true),
            None => (
                o.name.clone(),
                vec!["PROCEDURE", "FUNCTION"],
                o.name.clone(),
                None,
                false,
            ),
        },
        _ => return Ok(Vec::new()),
    };
    let is_column = column.is_some();
    let in_types = dep_types
        .iter()
        .map(|t| ol(t))
        .collect::<Vec<_>>()
        .join(", ");
    let mut out = Vec::new();

    // units that depend on the object; their detail says so unless the trigger list below describes them
    let mut units: BTreeMap<(String, String, UsageKind), (String, Option<String>)> =
        BTreeMap::new();
    for r in pool
        .query_strings(&format!(
            "select d.owner, d.name, d.type from all_dependencies d \
             where d.referenced_owner = {} and d.referenced_name = {} and d.referenced_type in ({in_types}) \
               and not (d.owner = {} and d.name = {})",
            ol(&sc),
            ol(&dep),
            ol(&sc),
            ol(&dep)
        ))
        .await?
    {
        // synonyms come from `ALL_SYNONYMS` below, the dependency row of a synonym would list them twice
        let k = ora_kind(&cell(&r, 2));
        if let Some(k) = k.filter(|k| *k != UsageKind::Synonym) {
            units
                .entry((cell(&r, 0), cell(&r, 1), k))
                .or_insert_with(|| (format!("references {dep}"), None));
        }
    }
    if !is_column
        && matches!(
            o.kind,
            NodeKind::Table | NodeKind::View | NodeKind::MaterializedView
        )
    {
        for r in pool
            .query_strings(&format!(
                "select owner, trigger_name, table_name, triggering_event from all_triggers \
                 where table_owner = {} and table_name = {}",
                ol(&sc),
                ol(&dep)
            ))
            .await?
        {
            let table = cell(&r, 2);
            units.insert(
                (cell(&r, 0), cell(&r, 1), UsageKind::Trigger),
                (format!("{} on {table}", cell(&r, 3)), Some(table)),
            );
        }
    }
    // synonyms of the object (a synonym of a synonym is not one)
    if !text_only && o.kind != NodeKind::Synonym {
        for r in pool
            .query_strings(&format!(
                "select owner, synonym_name from all_synonyms where table_owner = {} and table_name = {}",
                ol(&sc),
                ol(&dep)
            ))
            .await?
        {
            out.push(Usage {
                schema: cell(&r, 0),
                name: cell(&r, 1),
                kind: UsageKind::Synonym,
                detail: format!("synonym for {dep}"),
                line: None,
                table: None,
            });
        }
    }
    // foreign keys referencing the table; for a column, the ones on it or referencing it
    if matches!(o.kind, NodeKind::Table | NodeKind::Column) {
        let rows = pool
            .query_strings(&format!(
                "select c.owner, c.table_name, c.constraint_name, cc.column_name, r.owner, r.table_name, rc.column_name \
                 from all_constraints c \
                 join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name \
                 join all_constraints r on r.owner = c.r_owner and r.constraint_name = c.r_constraint_name \
                 join all_cons_columns rc on rc.owner = r.owner and rc.constraint_name = r.constraint_name \
                   and rc.position = cc.position \
                 where c.constraint_type = 'R' \
                   and ((c.owner = {s} and c.table_name = {t}) or (r.owner = {s} and r.table_name = {t})) \
                 order by c.owner, c.table_name, c.constraint_name, cc.position",
                s = ol(&sc),
                t = ol(&dep)
            ))
            .await?;
        let fks: Vec<FkCol> = rows
            .iter()
            .map(|r| FkCol {
                child_schema: cell(r, 0),
                child_table: cell(r, 1),
                group: cell(r, 2),
                constraint: cell(r, 2),
                child_col: cell(r, 3),
                parent_schema: cell(r, 4),
                parent_table: cell(r, 5),
                parent_col: cell(r, 6),
            })
            .collect();
        let t = Target {
            schema: sc.clone(),
            name: dep.clone(),
            column: column.clone(),
        };
        out.extend(fk_usages(&fks, &t));
    }

    // text hits per unit: the PL/SQL lines that mention the name, a view whose text mentions the column
    let mut hits: BTreeMap<(String, String, UsageKind), Vec<Usage>> = BTreeMap::new();
    let like = format!("%{}%", word.to_uppercase());
    for r in pool
        .query_strings(&format!(
            "select owner, name, type, line, text from all_source \
             where upper(text) like {} and type in ('FUNCTION', 'PROCEDURE', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER')",
            ol(&like)
        ))
        .await?
    {
        let Some(k) = ora_kind(&cell(&r, 2)) else { continue };
        let key = (cell(&r, 0), cell(&r, 1), k);
        let text = cell(&r, 4);
        let Some((_, table)) = units.get(&key) else { continue };
        if !contains_word(&text, &word) {
            continue;
        }
        hits.entry(key.clone()).or_default().push(Usage {
            schema: key.0.clone(),
            name: key.1.clone(),
            kind: k,
            detail: clip(text.trim()),
            line: cell(&r, 3).parse().ok(),
            table: table.clone(),
        });
    }
    if is_column {
        for r in pool
            .query_strings(&format!(
                "select owner, view_name, text_vc from all_views where upper(text_vc) like {}",
                ol(&like)
            ))
            .await?
        {
            let key = (cell(&r, 0), cell(&r, 1), UsageKind::View);
            if units.contains_key(&key) && contains_word(&cell(&r, 2), &word) {
                hits.entry(key.clone()).or_default().push(Usage {
                    schema: key.0.clone(),
                    name: key.1.clone(),
                    kind: UsageKind::View,
                    detail: format!("references column {word}"),
                    line: None,
                    table: None,
                });
            }
        }
    }

    for (key, (detail, table)) in units {
        match hits.remove(&key) {
            Some(lines) => out.extend(lines),
            None if !text_only => out.push(Usage {
                schema: key.0,
                name: key.1,
                kind: key.2,
                detail,
                line: None,
                table,
            }),
            None => {}
        }
    }
    Ok(out)
}

// ============================================================ PostgreSQL

fn pg_rel(schema: &str, name: &str) -> String {
    format!(
        "(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = {} and c.relname = {})",
        pl(schema),
        pl(name)
    )
}

/// A `pg_class` row (`nspname`, `relname`, `relkind`) as a view usage; other relation kinds give nothing.
fn pg_rel_usage(r: &[Option<String>], detail: String) -> Option<Usage> {
    let kind = match cell(r, 2).as_str() {
        "v" => UsageKind::View,
        "m" => UsageKind::MaterializedView,
        _ => return None,
    };
    Some(Usage {
        schema: cell(r, 0),
        name: cell(r, 1),
        kind,
        detail,
        line: None,
        table: None,
    })
}

async fn pg_usages(pool: &Pool, o: &ObjectRef) -> Result<Vec<Usage>> {
    let sc = o.schema.clone().unwrap_or_else(|| "public".into());
    match o.kind {
        NodeKind::Table | NodeKind::View | NodeKind::MaterializedView | NodeKind::Column => {
            pg_relation(pool, &sc, o).await
        }
        NodeKind::Sequence => pg_routine_text(pool, &o.name, None, None).await,
        NodeKind::Function | NodeKind::Procedure | NodeKind::Routine => {
            let mut out =
                pg_routine_text(pool, &o.name, None, Some((sc.as_str(), o.name.as_str()))).await?;
            for r in pool
                .query_strings(&format!(
                    "select distinct n.nspname::text, c.relname::text, c.relkind::text from pg_depend d \
                     join pg_rewrite r on r.oid = d.objid join pg_class c on c.oid = r.ev_class \
                     join pg_namespace n on n.oid = c.relnamespace \
                     where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_proc'::regclass \
                       and d.refobjid in (select p.oid from pg_proc p join pg_namespace pn on pn.oid = p.pronamespace \
                                          where p.proname = {} and pn.nspname = {})",
                    pl(&o.name),
                    pl(&sc)
                ))
                .await?
            {
                out.extend(pg_rel_usage(&r, format!("references {}", o.name)));
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

/// Views, foreign keys, triggers, indexes and routine texts that use a table, or a column of it.
async fn pg_relation(pool: &Pool, sc: &str, o: &ObjectRef) -> Result<Vec<Usage>> {
    let (table, column) = match o.kind {
        NodeKind::Column => (table_of(o)?, Some(o.name.clone())),
        _ => (o.name.clone(), None),
    };
    let rel = pg_rel(sc, &table);
    // the attribute number of the column (NULL for a missing column: no rows)
    let attnum = column.as_ref().map(|c| {
        format!(
            "(select a.attnum from pg_attribute a where a.attrelid = {rel} and a.attname = {})",
            pl(c)
        )
    });
    let mut out = Vec::new();

    let by_column = attnum
        .as_ref()
        .map(|a| format!(" and d.refobjsubid = {a}"))
        .unwrap_or_default();
    for r in pool
        .query_strings(&format!(
            "select distinct n.nspname::text, c.relname::text, c.relkind::text from pg_depend d \
             join pg_rewrite r on r.oid = d.objid join pg_class c on c.oid = r.ev_class \
             join pg_namespace n on n.oid = c.relnamespace \
             where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass \
               and d.refobjid = {rel} and c.oid <> {rel}{by_column}"
        ))
        .await?
    {
        let detail = match &column {
            Some(c) => format!("references column {c}"),
            None => format!("references {table}"),
        };
        out.extend(pg_rel_usage(&r, detail));
    }

    let fk_on = match &attnum {
        None => format!("k.confrelid = {rel}"),
        Some(a) => format!(
            "(k.conrelid = {rel} and {a} = any(k.conkey)) or (k.confrelid = {rel} and {a} = any(k.confkey))"
        ),
    };
    for r in pool
        .query_strings(&format!(
            "select n.nspname::text, c.relname::text, k.conname::text, pg_get_constraintdef(k.oid) \
             from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace \
             where k.contype = 'f' and ({fk_on}) order by 1, 2, 3"
        ))
        .await?
    {
        out.push(Usage {
            schema: cell(&r, 0),
            name: cell(&r, 1),
            kind: UsageKind::ForeignKey,
            detail: format!("{}: {}", cell(&r, 2), cell(&r, 3)),
            line: None,
            table: Some(cell(&r, 1)),
        });
    }

    if column.is_none() {
        for r in pool
            .query_strings(&format!(
                "select n.nspname::text, c.relname::text, t.tgname::text from pg_trigger t \
                 join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace \
                 where t.tgrelid = {rel} and not t.tgisinternal order by 3"
            ))
            .await?
        {
            out.push(Usage {
                schema: cell(&r, 0),
                name: cell(&r, 2),
                kind: UsageKind::Trigger,
                detail: format!("on {}", cell(&r, 1)),
                line: None,
                table: Some(cell(&r, 1)),
            });
        }
    }

    if let Some(a) = &attnum {
        for r in pool
            .query_strings(&format!(
                "select n.nspname::text, ic.relname::text, c.relname::text, pg_get_indexdef(i.indexrelid) \
                 from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class c on c.oid = i.indrelid \
                 join pg_namespace n on n.oid = c.relnamespace \
                 where i.indrelid = {rel} and {a} = any(i.indkey) order by 2"
            ))
            .await?
        {
            out.push(Usage {
                schema: cell(&r, 0),
                name: cell(&r, 1),
                kind: UsageKind::Index,
                detail: cell(&r, 3),
                line: None,
                table: Some(cell(&r, 2)),
            });
        }
    }

    // a column is used by the routines that name it and the table (the catalog does not track routine bodies)
    let (word, must) = match &column {
        Some(c) => (c.as_str(), Some(table.as_str())),
        None => (table.as_str(), None),
    };
    out.extend(pg_routine_text(pool, word, must, None).await?);
    Ok(out)
}

/// Routines whose text mentions `word`, one usage per line. `must` is a second word the text needs as well (the
/// table of a column); `skip` is the routine the search is about.
async fn pg_routine_text(
    pool: &Pool,
    word: &str,
    must: Option<&str>,
    skip: Option<(&str, &str)>,
) -> Result<Vec<Usage>> {
    let mut out = Vec::new();
    for r in pool
        .query_strings(&format!(
            "select n.nspname::text, p.proname::text, p.prokind::text, p.prosrc::text from pg_proc p \
             join pg_namespace n on n.oid = p.pronamespace \
             where p.prosrc ilike {} and n.nspname not in ('pg_catalog', 'information_schema')",
            pl(&format!("%{word}%"))
        ))
        .await?
    {
        let (schema, name, text) = (cell(&r, 0), cell(&r, 1), cell(&r, 3));
        if skip.is_some_and(|(s, n)| s == schema && n == name) {
            continue;
        }
        if must.is_some_and(|m| !contains_word(&text, m)) {
            continue;
        }
        let kind = if cell(&r, 2) == "p" {
            UsageKind::Procedure
        } else {
            UsageKind::Function
        };
        for (line, l) in word_lines(&text, word) {
            out.push(Usage {
                schema: schema.clone(),
                name: name.clone(),
                kind,
                detail: clip(l.trim()),
                line: Some(line),
                table: None,
            });
        }
    }
    Ok(out)
}

// ============================================================ MySQL

async fn my_usages(pool: &Pool, o: &ObjectRef) -> Result<Vec<Usage>> {
    let sc = match &o.schema {
        Some(s) => s.clone(),
        None => first(pool, "select database()").await?.unwrap_or_default(),
    };
    // `table`: the table (a column's), `word`: the name searched for, `column`: the column of a column target
    let (table, column) = match o.kind {
        NodeKind::Table | NodeKind::View | NodeKind::MaterializedView => (o.name.clone(), None),
        NodeKind::Column => (table_of(o)?, Some(o.name.clone())),
        NodeKind::Function | NodeKind::Procedure | NodeKind::Routine => (o.name.clone(), None),
        _ => return Ok(Vec::new()),
    };
    let word = column.clone().unwrap_or_else(|| table.clone());
    let is_routine = matches!(
        o.kind,
        NodeKind::Function | NodeKind::Procedure | NodeKind::Routine
    );
    let what = column
        .as_ref()
        .map_or_else(|| word.clone(), |c| format!("column {c}"));
    // a column's text must name the table as well
    let mentions = |text: &str| {
        contains_word(text, &word)
            && column
                .as_deref()
                .is_none_or(|_| contains_word(text, &table))
    };
    let mut out = Vec::new();

    for r in pool
        .query_strings(&format!(
            "select table_schema, table_name, view_definition from information_schema.VIEWS \
             where view_definition like {}",
            ml(&format!("%{word}%"))
        ))
        .await?
    {
        if mentions(&cell(&r, 2)) {
            out.push(Usage {
                schema: cell(&r, 0),
                name: cell(&r, 1),
                kind: UsageKind::View,
                detail: format!("references {what}"),
                line: None,
                table: None,
            });
        }
    }

    for r in pool
        .query_strings(&format!(
            "select routine_schema, routine_name, routine_type, routine_definition from information_schema.ROUTINES \
             where routine_definition like {} \
               and routine_schema not in ('mysql', 'sys', 'information_schema', 'performance_schema')",
            ml(&format!("%{word}%"))
        ))
        .await?
    {
        let (schema, name, text) = (cell(&r, 0), cell(&r, 1), cell(&r, 3));
        if is_routine && schema == sc && name == o.name {
            continue;
        }
        if !mentions(&text) {
            continue;
        }
        let kind = if cell(&r, 2) == "PROCEDURE" {
            UsageKind::Procedure
        } else {
            UsageKind::Function
        };
        for (line, l) in word_lines(&text, &word) {
            out.push(Usage {
                schema: schema.clone(),
                name: name.clone(),
                kind,
                detail: clip(l.trim()),
                line: Some(line),
                table: None,
            });
        }
    }

    if matches!(o.kind, NodeKind::Table | NodeKind::Column) {
        let rows = pool
            .query_strings(&format!(
                "select table_schema, table_name, constraint_name, column_name, referenced_table_schema, \
                        referenced_table_name, referenced_column_name \
                 from information_schema.KEY_COLUMN_USAGE where referenced_table_name is not null \
                   and ((referenced_table_schema = {s} and referenced_table_name = {t}) \
                        or (table_schema = {s} and table_name = {t})) \
                 order by table_schema, table_name, constraint_name, ordinal_position",
                s = ml(&sc),
                t = ml(&table)
            ))
            .await?;
        let fks: Vec<FkCol> = rows
            .iter()
            .map(|r| FkCol {
                child_schema: cell(r, 0),
                child_table: cell(r, 1),
                group: cell(r, 2),
                constraint: cell(r, 2),
                child_col: cell(r, 3),
                parent_schema: cell(r, 4),
                parent_table: cell(r, 5),
                parent_col: cell(r, 6),
            })
            .collect();
        let t = Target {
            schema: sc.clone(),
            name: table.clone(),
            column: column.clone(),
        };
        out.extend(fk_usages(&fks, &t));
    }

    if o.kind == NodeKind::Table {
        for r in pool
            .query_strings(&format!(
                "select trigger_schema, trigger_name, event_manipulation from information_schema.TRIGGERS \
                 where event_object_schema = {} and event_object_table = {} order by 2",
                ml(&sc),
                ml(&table)
            ))
            .await?
        {
            out.push(Usage {
                schema: cell(&r, 0),
                name: cell(&r, 1),
                kind: UsageKind::Trigger,
                detail: format!("{} on {table}", cell(&r, 2)),
                line: None,
                table: Some(table.clone()),
            });
        }
    }

    if column.is_some() {
        for r in pool
            .query_strings(&format!(
                "select distinct table_schema, index_name from information_schema.STATISTICS \
                 where table_schema = {} and table_name = {} and column_name = {} order by 2",
                ml(&sc),
                ml(&table),
                ml(&word)
            ))
            .await?
        {
            out.push(Usage {
                schema: cell(&r, 0),
                name: cell(&r, 1),
                kind: UsageKind::Index,
                detail: format!("index on column {word}"),
                line: None,
                table: Some(table.clone()),
            });
        }
    }
    Ok(out)
}

// ============================================================ SQLite

async fn lite_usages(pool: &Pool, o: &ObjectRef) -> Result<Vec<Usage>> {
    let sc = o.schema.clone().unwrap_or_else(|| "main".into());
    let (table, column) = match o.kind {
        NodeKind::Table | NodeKind::View => (o.name.clone(), None),
        NodeKind::Column => (table_of(o)?, Some(o.name.clone())),
        _ => return Ok(Vec::new()),
    };
    let word = column.clone().unwrap_or_else(|| table.clone());
    let what = column
        .as_ref()
        .map_or_else(|| word.clone(), |c| format!("column {c}"));
    let mentions = |text: &str| {
        contains_word(text, &word)
            && column
                .as_deref()
                .is_none_or(|_| contains_word(text, &table))
    };
    let master = format!("{}.sqlite_master", quote_ident(Driver::Sqlite, &sc));
    let mut out = Vec::new();

    for r in pool
        .query_strings(&format!(
            "select type, name, tbl_name, sql from {master} where type in ('view', 'trigger') and sql like {}",
            sl(&format!("%{word}%"))
        ))
        .await?
    {
        let (kind_text, name, on, sql) = (cell(&r, 0), cell(&r, 1), cell(&r, 2), cell(&r, 3));
        if kind_text == "view" && o.kind == NodeKind::View && same(&name, &o.name) {
            continue;
        }
        if !mentions(&sql) {
            continue;
        }
        out.push(if kind_text == "trigger" {
            Usage {
                schema: sc.clone(),
                name,
                kind: UsageKind::Trigger,
                detail: format!("on {on}"),
                line: None,
                table: Some(on),
            }
        } else {
            Usage {
                schema: sc.clone(),
                name,
                kind: UsageKind::View,
                detail: format!("references {what}"),
                line: None,
                table: None,
            }
        });
    }

    if matches!(o.kind, NodeKind::Table | NodeKind::Column) {
        // SQLite foreign keys have no names: the number of the key tells them apart within the table
        let rows = pool
            .query_strings(&format!(
                "select m.name, f.id, f.seq, f.\"from\", f.\"table\", f.\"to\" \
                 from {master} m, pragma_foreign_key_list(m.name, {}) f \
                 where m.type = 'table' order by m.name, f.id, f.seq",
                sl(&sc)
            ))
            .await?;
        let fks: Vec<FkCol> = rows
            .iter()
            .map(|r| {
                let parent = cell(r, 4);
                FkCol {
                    child_schema: sc.clone(),
                    child_table: cell(r, 0),
                    group: cell(r, 1),
                    constraint: String::new(),
                    child_col: cell(r, 3),
                    parent_schema: sc.clone(),
                    parent_table: parent,
                    // `to` is NULL when the key references the primary key of the parent
                    parent_col: match cell(r, 5).as_str() {
                        "" => "primary key".to_string(),
                        c => c.to_string(),
                    },
                }
            })
            .collect();
        let t = Target {
            schema: sc.clone(),
            name: table.clone(),
            column: column.clone(),
        };
        out.extend(fk_usages(&fks, &t));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_words_only() {
        assert!(contains_word("select * from invoices", "invoices"));
        assert!(contains_word("SELECT * FROM INVOICES;", "invoices"));
        assert!(!contains_word("select * from invoices_archive", "invoices"));
        assert!(!contains_word("select * from my_invoices", "invoices"));
        assert!(!contains_word("select * from invoices2", "invoices"));
        assert!(!contains_word("select * from orders", ""));
    }

    #[test]
    fn punctuation_and_quotes_end_a_word() {
        assert!(contains_word("from shop.invoices i", "invoices"));
        assert!(contains_word("from \"invoices\"", "invoices"));
        assert!(contains_word("(invoices)", "invoices"));
        assert!(contains_word("x:=invoices.id", "invoices"));
        assert!(!contains_word(":new.invoices$x", "invoices"));
        assert!(!contains_word("#invoices", "invoices"));
    }

    #[test]
    fn non_ascii_text_is_handled_without_panics() {
        assert!(contains_word("-- café invoices ✓", "invoices"));
        assert!(!contains_word("éinvoices", "invoices"));
        assert!(!contains_word("invoicesé", "invoices"));
        assert!(contains_word("año = invoices", "invoices"));
    }

    #[test]
    fn word_lines_are_numbered_from_one() {
        let text = "begin\n  select 1 from dual;\n  insert into invoices values (1);\nend;";
        assert_eq!(
            word_lines(text, "invoices"),
            vec![(3, "  insert into invoices values (1);")]
        );
        assert_eq!(word_lines(text, "dual"), vec![(2, "  select 1 from dual;")]);
        assert!(word_lines(text, "nothing").is_empty());
    }

    #[test]
    fn long_lines_are_clipped_on_a_character_boundary() {
        let long = "é".repeat(300);
        let c = clip(&long);
        assert_eq!(c.chars().count(), 201);
        assert!(c.ends_with('…'));
        assert_eq!(clip("short"), "short");
    }

    fn fk(
        child: &str,
        group: &str,
        constraint: &str,
        col: &str,
        parent: &str,
        pcol: &str,
    ) -> FkCol {
        FkCol {
            child_schema: "shop".into(),
            child_table: child.into(),
            group: group.into(),
            constraint: constraint.into(),
            child_col: col.into(),
            parent_schema: "shop".into(),
            parent_table: parent.into(),
            parent_col: pcol.into(),
        }
    }

    fn target(name: &str, column: Option<&str>) -> Target {
        Target {
            schema: "shop".into(),
            name: name.into(),
            column: column.map(str::to_string),
        }
    }

    #[test]
    fn table_target_lists_the_foreign_keys_that_reference_it() {
        let rows = vec![
            fk(
                "orders",
                "fk_orders_customer",
                "fk_orders_customer",
                "customer_id",
                "customers",
                "id",
            ),
            fk(
                "addresses",
                "fk_addr",
                "fk_addr",
                "customer_id",
                "customers",
                "id",
            ),
            // a key of the other way round: `customers` holds the reference to `orders`: not a usage of `customers`
            fk(
                "customers",
                "fk_back",
                "fk_back",
                "last_order",
                "orders",
                "id",
            ),
        ];
        let got = fk_usages(&rows, &target("customers", None));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].kind, UsageKind::ForeignKey);
        assert_eq!(
            (got[0].schema.as_str(), got[0].name.as_str()),
            ("shop", "addresses")
        );
        assert_eq!(
            got[0].detail,
            "fk_addr (customer_id) references customers (id)"
        );
        assert_eq!(got[0].table.as_deref(), Some("addresses"));
        assert_eq!(got[1].name, "orders");
    }

    #[test]
    fn column_target_lists_the_keys_on_it_and_the_ones_it_is_referenced_by() {
        let rows = vec![
            fk("orders", "fk_o", "fk_o", "customer_id", "customers", "id"),
            fk("orders", "fk_o2", "fk_o2", "note_id", "notes", "id"),
            fk("customers", "fk_c", "fk_c", "parent_id", "customers", "id"),
        ];
        let got = fk_usages(&rows, &target("customers", Some("id")));
        let names: Vec<_> = got
            .iter()
            .map(|u| (u.name.as_str(), u.detail.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("customers", "fk_c (parent_id) references customers (id)"),
                ("orders", "fk_o (customer_id) references customers (id)"),
            ]
        );
        assert!(fk_usages(&rows, &target("customers", Some("email"))).is_empty());
    }

    #[test]
    fn unnamed_keys_and_composite_keys_are_grouped_by_their_number() {
        let rows = vec![
            fk("items", "0", "", "order_id", "orders", "id"),
            fk("items", "0", "", "line", "orders", "line_no"),
            fk("items", "1", "", "sku", "products", "sku"),
        ];
        let got = fk_usages(&rows, &target("orders", None));
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].detail,
            "(order_id, line) references orders (id, line_no)"
        );
    }

    #[test]
    fn kinds_of_oracle_units() {
        assert_eq!(ora_kind("PACKAGE BODY"), Some(UsageKind::PackageBody));
        assert_eq!(
            ora_kind("MATERIALIZED VIEW"),
            Some(UsageKind::MaterializedView)
        );
        assert_eq!(ora_kind("TYPE"), None);
    }
}
