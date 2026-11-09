//! Schema model for "Compare schemas" ([`ConnectionManager::schema_model`]): the objects of one schema (PostgreSQL
//! schema, MySQL database, SQLite schema, Oracle owner) reduced to what a comparison needs, with the type texts,
//! defaults and definitions normalized per dialect. The diff and the migration script are built on the TypeScript
//! side (`src/features/schema-diff`).
//!
//! One query per object kind (columns, constraints, indexes, views, sequences, routines), never one per table.
//! Oracle reads the `ALL_*` dictionary views, PostgreSQL the catalogs, MySQL `information_schema` and SQLite
//! `sqlite_master` with its `pragma_*` table-valued functions.
//!
//! Limits: SQLite CHECK constraints live only in the text of the `create table` and are not read; SQLite and
//! MySQL have no sequences here; routines are compared by a fingerprint of their text (MySQL: parameters and body,
//! NULL when the account may not read the body).

use std::collections::HashMap;
use std::hash::Hash;

use serde::{Deserialize, Serialize};

use crate::conn::Live;
use crate::error::Result;
use crate::introspect::{ora_table_filter, ora_type_expr};
use crate::manager::ConnectionManager;
use crate::model::Driver;
use crate::quote::{quote_ident, quote_literal};

// ---------------------------------------------------------------- model

/// The objects of one schema, normalized. `name_prefix` (when set) limits every list to the objects whose name starts
/// with it: a comparison of two name sets of one schema, as the tests use it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaModel {
    pub driver: Driver,
    pub schema: String,
    pub name_prefix: Option<String>,
    pub tables: Vec<TableModel>,
    pub views: Vec<ViewModel>,
    pub sequences: Vec<SequenceModel>,
    /// Procedures, functions, packages and triggers (`kind` as the dictionary names it).
    pub routines: Vec<RoutineModel>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableModel {
    pub name: String,
    pub columns: Vec<ColumnModel>,
    pub primary_key: Option<KeyModel>,
    pub unique: Vec<KeyModel>,
    pub checks: Vec<CheckModel>,
    pub foreign_keys: Vec<ForeignKeyModel>,
    pub indexes: Vec<IndexModel>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnModel {
    pub name: String,
    /// 1-based position in the table.
    pub position: u32,
    /// Type text, normalized for the dialect (lower case, synonyms folded; Oracle as `DATA_TYPE(length)`).
    pub data_type: String,
    pub nullable: bool,
    /// Default value, or the expression of a generated column.
    pub default: Option<String>,
    /// `identity always`, `identity by default`, `generated`, `auto_increment`, ...
    pub extra: Option<String>,
}

/// A primary key or a unique constraint. `name` is empty for unnamed SQLite constraints.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyModel {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckModel {
    pub name: String,
    pub expression: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyModel {
    pub name: String,
    pub columns: Vec<String>,
    /// The referenced schema when it is not the compared one.
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    /// `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL` or `SET DEFAULT`.
    pub on_delete: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexModel {
    pub name: String,
    /// Column names; expressions as text.
    pub columns: Vec<String>,
    pub unique: bool,
    /// Access method in lower case (`btree`, `normal`, `bitmap`, ...); empty when the dialect has none.
    pub method: String,
    /// Partial index condition.
    pub predicate: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewModel {
    pub name: String,
    /// The select text: schema names of the compared schema removed, white space collapsed, no trailing `;`.
    pub definition: String,
    pub materialized: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SequenceModel {
    pub name: String,
    pub increment_by: String,
    pub min_value: String,
    pub max_value: String,
    pub cycle: bool,
    pub cache_size: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineModel {
    pub name: String,
    /// `FUNCTION`, `PROCEDURE`, `PACKAGE`, `PACKAGE BODY`, `TRIGGER`, ...
    pub kind: String,
    /// PostgreSQL identity arguments (overloads), or the table of a trigger; empty otherwise.
    pub signature: String,
    /// Fingerprint (FNV-1a, hex) of the normalized text.
    pub source_hash: String,
}

impl SchemaModel {
    fn new(driver: Driver, schema: &str, name_prefix: Option<&str>) -> Self {
        SchemaModel {
            driver,
            schema: schema.to_string(),
            name_prefix: name_prefix.map(str::to_string),
            ..Default::default()
        }
    }
}

// ---------------------------------------------------------------- helpers

type Row = Vec<Option<String>>;

/// Separator of the lists a catalog query returns as one text (unit separator: not a name character).
const SEP: char = '\u{1f}';

fn s(r: &Row, i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
}

/// The text of a column, trimmed; `None` when it is NULL or blank.
fn text(r: &Row, i: usize) -> Option<String> {
    let v = s(r, i);
    let v = v.trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// `t`, `true`, `YES` or `Y`.
fn flag(r: &Row, i: usize) -> bool {
    matches!(s(r, i).as_str(), "t" | "true" | "YES" | "Y")
}

/// A `SEP`-joined list (empty text: no items).
fn list(v: &str) -> Vec<String> {
    if v.is_empty() {
        Vec::new()
    } else {
        v.split(SEP).map(str::to_string).collect()
    }
}

/// White space runs become one space; both ends trimmed.
fn squash(t: &str) -> String {
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Removes the schema qualifier `schema.` (also `"schema".` and `` `schema`. ``) in front of names, so that the same
/// definition in two schemas reads the same. A qualifier glued to a name (`myschema.x` with schema `schema`) is kept.
fn strip_schema(text: &str, schema: &str) -> String {
    if schema.is_empty() {
        return text.to_string();
    }
    let forms = [
        format!("\"{schema}\"."),
        format!("`{schema}`."),
        format!("{schema}."),
    ];
    let mut out = String::with_capacity(text.len());
    let mut prev: Option<char> = None;
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        let glued = prev
            .is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '$' | '#' | '"' | '`' | '.'));
        if !glued {
            if let Some(f) = forms.iter().find(|f| rest.starts_with(f.as_str())) {
                i += f.len();
                continue;
            }
        }
        let ch = rest.chars().next().unwrap_or_default();
        out.push(ch);
        prev = Some(ch);
        i += ch.len_utf8();
    }
    out
}

/// A view or routine text as it is compared: schema names removed, white space collapsed, no trailing `;`.
fn definition(text: &str, schema: &str) -> String {
    squash(strip_schema(text, schema).trim().trim_end_matches(';'))
}

/// 64-bit FNV-1a of `text` in hex: a stable fingerprint of a routine text (not for security).
fn fingerprint(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Rows grouped by `key`, the groups in first-seen order (the queries sort the rows).
fn group_rows<T, K: Eq + Hash + Clone>(rows: Vec<T>, key: impl Fn(&T) -> K) -> Vec<Vec<T>> {
    let mut at: HashMap<K, usize> = HashMap::new();
    let mut out: Vec<Vec<T>> = Vec::new();
    for r in rows {
        let k = key(&r);
        match at.get(&k) {
            Some(&i) => out[i].push(r),
            None => {
                at.insert(k, out.len());
                out.push(vec![r]);
            }
        }
    }
    out
}

/// `and substr(col, 1, n) = 'prefix'` for a name prefix; empty without one. `substr` works on every dialect.
fn prefix_sql(d: Driver, col: &str, prefix: Option<&str>) -> String {
    match prefix.filter(|p| !p.is_empty()) {
        Some(p) => format!(
            " and substr({col}, 1, {}) = {}",
            p.chars().count(),
            quote_literal(d, p)
        ),
        None => String::new(),
    }
}

/// The tables of the model, in the order of the dictionary; rows of other tables are dropped.
struct Tables {
    order: Vec<String>,
    by_name: HashMap<String, TableModel>,
}

impl Tables {
    fn new(names: Vec<String>) -> Self {
        let by_name = names
            .iter()
            .map(|n| {
                (
                    n.clone(),
                    TableModel {
                        name: n.clone(),
                        ..Default::default()
                    },
                )
            })
            .collect();
        Tables {
            order: names,
            by_name,
        }
    }

    fn get(&mut self, name: &str) -> Option<&mut TableModel> {
        self.by_name.get_mut(name)
    }

    fn into_vec(self) -> Vec<TableModel> {
        let Tables { order, mut by_name } = self;
        order.iter().filter_map(|n| by_name.remove(n)).collect()
    }
}

/// One column of one constraint, as the dialects' rows give it. `kind`: P primary key, U unique, C check,
/// F foreign key. Rows of one constraint share `key`.
#[derive(Debug, Clone, Default)]
struct ConRow {
    table: String,
    key: String,
    name: String,
    kind: char,
    column: String,
    ref_column: String,
    check: String,
    ref_schema: Option<String>,
    ref_table: String,
    on_delete: String,
}

/// Adds the constraints of `rows` to their tables (the columns of a constraint in the order of the rows).
fn add_constraints(tables: &mut Tables, rows: Vec<ConRow>) {
    for group in group_rows(rows, |r| (r.table.clone(), r.key.clone())) {
        let first = &group[0];
        let Some(t) = tables.get(&first.table) else {
            continue;
        };
        let columns: Vec<String> = group
            .iter()
            .filter(|r| !r.column.is_empty())
            .map(|r| r.column.clone())
            .collect();
        let name = first.name.clone();
        match first.kind {
            'P' => t.primary_key = Some(KeyModel { name, columns }),
            'U' => t.unique.push(KeyModel { name, columns }),
            'C' => t.checks.push(CheckModel {
                name,
                expression: first.check.clone(),
            }),
            'F' => t.foreign_keys.push(ForeignKeyModel {
                name,
                columns,
                ref_schema: first.ref_schema.clone(),
                ref_table: first.ref_table.clone(),
                ref_columns: group
                    .iter()
                    .filter(|r| !r.ref_column.is_empty())
                    .map(|r| r.ref_column.clone())
                    .collect(),
                on_delete: first.on_delete.clone(),
            }),
            _ => {}
        }
    }
}

/// Column attributes of one table row, in the order they were read.
fn push_column(
    t: &mut TableModel,
    name: String,
    data_type: String,
    nullable: bool,
    default: Option<String>,
    extra: Option<String>,
) {
    let position = t.columns.len() as u32 + 1;
    t.columns.push(ColumnModel {
        name,
        position,
        data_type,
        nullable,
        default,
        extra,
    });
}

/// `NOT NULL` written as a check (`"COL" IS NOT NULL`, Oracle): the column carries it already.
fn is_not_null_check(cond: &str) -> bool {
    let c = cond.trim();
    let tail = " IS NOT NULL";
    c.starts_with('"') && c.ends_with(tail) && c[1..c.len() - tail.len()].matches('"').count() == 1
}

/// Oracle `ALL_CONSTRAINTS.DELETE_RULE`, PostgreSQL `confdeltype` as text.
fn delete_rule(rule: &str) -> String {
    match rule {
        "" | "a" | "NO ACTION" => "NO ACTION".into(),
        "r" => "RESTRICT".into(),
        "c" => "CASCADE".into(),
        "n" => "SET NULL".into(),
        "d" => "SET DEFAULT".into(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------- type texts

/// PostgreSQL `format_type` text in one spelling (`character varying(20)` -> `varchar(20)`, `timestamp(3) without time
/// zone` -> `timestamp(3)`). Every result is still valid SQL: the migration script uses it as the column type.
fn pg_type(t: &str) -> String {
    let mut t = squash(t).to_ascii_lowercase();
    for (from, to) in [
        ("character varying", "varchar"),
        ("character(", "char("),
        ("bit varying", "varbit"),
        (" without time zone", ""),
    ] {
        t = t.replace(from, to);
    }
    match t.as_str() {
        "character" => "char".into(),
        "int4" => "integer".into(),
        "int8" => "bigint".into(),
        "int2" => "smallint".into(),
        "float8" => "double precision".into(),
        "float4" => "real".into(),
        "bool" => "boolean".into(),
        "decimal" => "numeric".into(),
        _ => t,
    }
}

/// MySQL column type in one spelling: lower case, `integer` is `int`, `bool` is `tinyint(1)`, the display width of
/// integer types dropped (MySQL 8.0.19+ does not report it; `tinyint(1)` stays, it is the boolean).
fn my_type(t: &str) -> String {
    let mut t = squash(t).to_ascii_lowercase();
    if t == "bool" || t == "boolean" {
        return "tinyint(1)".into();
    }
    if let Some(rest) = t.strip_prefix("integer") {
        t = format!("int{rest}");
    }
    for base in ["tinyint", "smallint", "mediumint", "int", "bigint"] {
        if let Some(rest) = t.strip_prefix(base) {
            if let Some(close) = rest.find(')') {
                let width = &rest[1..close];
                if rest.starts_with('(') && !(base == "tinyint" && width == "1") {
                    t = format!("{base}{}", &rest[close + 1..]);
                }
            }
            break;
        }
    }
    t
}

/// MySQL `COLUMN_DEFAULT`: the value without the quotes some servers add.
fn my_default(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

/// SQLite view text: the select after the first `AS` of `CREATE VIEW name [(cols)] AS select ...`.
fn sqlite_view_body(sql: &str) -> &str {
    let lower = sql.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while let Some(p) = lower[i..].find("as") {
        let at = i + p;
        let before = at == 0 || bytes[at - 1].is_ascii_whitespace() || bytes[at - 1] == b')';
        let after = at + 2 >= bytes.len() || bytes[at + 2].is_ascii_whitespace();
        if before && after {
            return sql[at + 2..].trim_start();
        }
        i = at + 2;
    }
    sql
}

// ---------------------------------------------------------------- entry point

impl ConnectionManager {
    /// Normalized model of `schema` (PostgreSQL schema, MySQL database, SQLite schema — `main` when empty — or Oracle
    /// owner). `name_prefix` keeps only the objects whose name starts with it (case as stored).
    pub async fn schema_model(
        &self,
        ds_id: &str,
        schema: &str,
        name_prefix: Option<&str>,
    ) -> Result<SchemaModel> {
        let live = self.live(ds_id)?;
        let prefix = name_prefix.filter(|p| !p.is_empty());
        match live.driver() {
            Driver::Postgres => pg_model(&live, schema, prefix).await,
            Driver::MySql => my_model(&live, schema, prefix).await,
            Driver::Sqlite => {
                let sc = if schema.trim().is_empty() {
                    "main"
                } else {
                    schema
                };
                lite_model(&live, sc, prefix).await
            }
            Driver::Oracle => ora_model(&live, schema, prefix).await,
        }
    }
}

// ---------------------------------------------------------------- Oracle

async fn ora_model(live: &Live, schema: &str, prefix: Option<&str>) -> Result<SchemaModel> {
    let pool = &live.pool;
    let d = Driver::Oracle;
    let o = quote_literal(d, schema);
    let mut m = SchemaModel::new(d, schema, prefix);

    let names = pool
        .query_strings(&format!(
            "select t.table_name from all_tables t where t.owner = {o} and {} \
               and t.table_name not like 'BIN$%' and t.table_name not like 'SYS\\_%' escape '\\' \
               and t.table_name not like 'MLOG$\\_%' escape '\\' and t.table_name not like 'RUPD$\\_%' escape '\\' {} \
             order by t.table_name",
            ora_table_filter("t"),
            prefix_sql(d, "t.table_name", prefix)
        ))
        .await?;
    let mut tables = Tables::new(names.iter().map(|r| s(r, 0)).collect());

    // ---- columns
    let cols = pool
        .query_strings(&format!(
            "select c.table_name, c.column_name, {ty}, c.nullable, c.data_default_vc, c.identity_column, c.virtual_column \
             from all_tab_cols c where c.owner = {o} and c.user_generated = 'YES' {p} \
             order by c.table_name, c.internal_column_id",
            ty = ora_type_expr("c"),
            p = prefix_sql(d, "c.table_name", prefix)
        ))
        .await?;
    for r in &cols {
        let Some(t) = tables.get(&s(r, 0)) else {
            continue;
        };
        let identity = s(r, 5) == "YES";
        let (default, extra) = if identity {
            (None, Some("identity".to_string()))
        } else if s(r, 6) == "YES" {
            (text(r, 4), Some("generated".to_string()))
        } else {
            (text(r, 4).map(|v| squash(&v)), None)
        };
        push_column(t, s(r, 1), s(r, 2), s(r, 3) != "N", default, extra);
    }

    // ---- primary key, unique, check and foreign key constraints (one row per column)
    let con = pool
        .query_strings(&format!(
            "select c.table_name, c.constraint_name, c.constraint_type, c.search_condition_vc, c.delete_rule, cc.column_name, \
                    r.owner, r.table_name, rc.column_name \
             from all_constraints c \
             left join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name \
             left join all_constraints r on r.owner = c.r_owner and r.constraint_name = c.r_constraint_name \
             left join all_cons_columns rc on rc.owner = r.owner and rc.constraint_name = r.constraint_name \
                                          and rc.position = cc.position \
             where c.owner = {o} and c.constraint_type in ('P', 'U', 'C', 'R') {p} \
             order by c.table_name, c.constraint_name, cc.position",
            p = prefix_sql(d, "c.table_name", prefix)
        ))
        .await?;
    let mut con_rows = Vec::new();
    for r in &con {
        let kind = s(r, 2).chars().next().unwrap_or('C');
        let check = squash(&s(r, 3));
        if kind == 'C' && (check.is_empty() || is_not_null_check(&check)) {
            continue;
        }
        let owner = s(r, 6);
        let name = s(r, 1);
        con_rows.push(ConRow {
            table: s(r, 0),
            key: name.clone(),
            name,
            kind: if kind == 'R' { 'F' } else { kind },
            column: s(r, 5),
            ref_column: s(r, 8),
            check,
            ref_schema: (!owner.is_empty() && owner != schema).then(|| owner.clone()),
            ref_table: s(r, 7),
            on_delete: delete_rule(&s(r, 4)),
        });
    }
    add_constraints(&mut tables, con_rows);

    // ---- indexes that no constraint owns (one row per column, expressions for function-based ones)
    let idx = pool
        .query_strings(&format!(
            "select i.table_name, i.index_name, i.uniqueness, i.index_type, ic.column_name, e.column_expression \
             from all_indexes i \
             join all_ind_columns ic on ic.index_owner = i.owner and ic.index_name = i.index_name \
             left join all_ind_expressions e on e.index_owner = i.owner and e.index_name = i.index_name \
                                            and e.column_position = ic.column_position \
             where i.table_owner = {o} and i.owner = {o} and i.generated = 'N' \
               and i.index_type not in ('LOB', 'IOT - TOP', 'DOMAIN', 'CLUSTER') \
               and not exists (select 1 from all_constraints k where k.owner = i.owner and k.index_name = i.index_name) {p} \
             order by i.table_name, i.index_name, ic.column_position",
            p = prefix_sql(d, "i.table_name", prefix)
        ))
        .await?;
    for g in group_rows(idx, |r| (s(r, 0), s(r, 1))) {
        let first = &g[0];
        let Some(t) = tables.get(&s(first, 0)) else {
            continue;
        };
        t.indexes.push(IndexModel {
            name: s(first, 1),
            columns: g
                .iter()
                .map(|r| {
                    let e = squash(&s(r, 5));
                    if e.is_empty() {
                        s(r, 4)
                    } else {
                        e
                    }
                })
                .collect(),
            unique: s(first, 2) == "UNIQUE",
            method: s(first, 3).to_ascii_lowercase(),
            predicate: None,
        });
    }

    // ---- views
    let views = pool
        .query_strings(&format!(
            "select v.view_name, v.text from all_views v where v.owner = {o} {} order by v.view_name",
            prefix_sql(d, "v.view_name", prefix)
        ))
        .await?;
    m.views = views
        .iter()
        .map(|r| ViewModel {
            name: s(r, 0),
            definition: definition(&s(r, 1), schema),
            materialized: false,
        })
        .collect();

    // ---- sequences (the identity ones belong to their table)
    let seqs = pool
        .query_strings(&format!(
            "select q.sequence_name, q.min_value, q.max_value, q.increment_by, q.cycle_flag, q.cache_size \
             from all_sequences q where q.sequence_owner = {o} \
               and q.sequence_name not like 'ISEQ$$\\_%' escape '\\' and q.sequence_name not like 'SYS\\_%' escape '\\' {} \
             order by q.sequence_name",
            prefix_sql(d, "q.sequence_name", prefix)
        ))
        .await?;
    m.sequences = seqs
        .iter()
        .map(|r| SequenceModel {
            name: s(r, 0),
            min_value: s(r, 1),
            max_value: s(r, 2),
            increment_by: s(r, 3),
            cycle: flag(r, 4),
            cache_size: s(r, 5),
        })
        .collect();

    // ---- stored code: one fingerprint per (name, type) of ALL_SOURCE
    let src = pool
        .query_strings(&format!(
            "select s.name, s.type, s.line, s.text from all_source s where s.owner = {o} \
               and s.type in ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'TYPE', 'TYPE BODY', 'TRIGGER') {} \
             order by s.name, s.type, s.line",
            prefix_sql(d, "s.name", prefix)
        ))
        .await?;
    for g in group_rows(src, |r| (s(r, 0), s(r, 1))) {
        let body = g
            .iter()
            .map(|r| s(r, 3).trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        m.routines.push(RoutineModel {
            name: s(&g[0], 0),
            kind: s(&g[0], 1),
            signature: String::new(),
            source_hash: fingerprint(&body),
        });
    }

    m.tables = tables.into_vec();
    Ok(m)
}

// ---------------------------------------------------------------- PostgreSQL

async fn pg_model(live: &Live, schema: &str, prefix: Option<&str>) -> Result<SchemaModel> {
    let pool = &live.pool;
    let d = Driver::Postgres;
    let lit = quote_literal(d, schema);
    let mut m = SchemaModel::new(d, schema, prefix);

    let names = pool
        .query_strings(&format!(
            "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace \
             where c.relkind in ('r', 'p') and not c.relispartition and n.nspname = {lit} {} order by c.relname",
            prefix_sql(d, "c.relname", prefix)
        ))
        .await?;
    let mut tables = Tables::new(names.iter().map(|r| s(r, 0)).collect());

    // ---- columns
    let cols = pool
        .query_strings(&format!(
            "select c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull::text, \
                    coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''), a.attidentity::text, a.attgenerated::text \
             from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace \
             left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum \
             where n.nspname = {lit} and c.relkind in ('r', 'p') and not c.relispartition \
               and a.attnum > 0 and not a.attisdropped {} \
             order by c.relname, a.attnum",
            prefix_sql(d, "c.relname", prefix)
        ))
        .await?;
    for r in &cols {
        let Some(t) = tables.get(&s(r, 0)) else {
            continue;
        };
        let (default, extra) = match (s(r, 5).as_str(), s(r, 6).as_str()) {
            ("a", _) => (None, Some("identity always".to_string())),
            ("d", _) => (None, Some("identity by default".to_string())),
            (_, "s") => (
                text(r, 4).map(|v| definition(&v, schema)),
                Some("generated stored".to_string()),
            ),
            _ => (text(r, 4).map(|v| definition(&v, schema)), None),
        };
        push_column(
            t,
            s(r, 1),
            pg_type(&s(r, 2)),
            s(r, 3) != "true",
            default,
            extra,
        );
    }

    // ---- constraints: columns and referenced columns are lists joined by SEP
    let cons = pool
        .query_strings(&format!(
            "select cl.relname, c.conname, c.contype::text, pg_get_constraintdef(c.oid), \
                    coalesce((select string_agg(a.attname, chr(31) order by k.ord) from unnest(c.conkey) with ordinality as k(attnum, ord) \
                              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum), ''), \
                    coalesce(rc.relname, ''), coalesce(rn.nspname, ''), \
                    coalesce((select string_agg(a.attname, chr(31) order by k.ord) from unnest(c.confkey) with ordinality as k(attnum, ord) \
                              join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum), ''), \
                    c.confdeltype::text \
             from pg_constraint c \
             join pg_class cl on cl.oid = c.conrelid \
             join pg_namespace n on n.oid = cl.relnamespace \
             left join pg_class rc on rc.oid = c.confrelid \
             left join pg_namespace rn on rn.oid = rc.relnamespace \
             where n.nspname = {lit} and c.contype in ('p', 'u', 'c', 'f') and c.conparentid = 0 {} \
             order by cl.relname, c.conname",
            prefix_sql(d, "cl.relname", prefix)
        ))
        .await?;
    let mut con_rows = Vec::new();
    for r in &cons {
        let kind = match s(r, 2).as_str() {
            "p" => 'P',
            "u" => 'U',
            "c" => 'C',
            _ => 'F',
        };
        let name = s(r, 1);
        let local = list(&s(r, 4));
        let refs = list(&s(r, 7));
        let ref_schema = s(r, 6);
        let check = if kind == 'C' {
            let def = s(r, 3);
            definition(def.strip_prefix("CHECK ").unwrap_or(&def), schema)
        } else {
            String::new()
        };
        let base = ConRow {
            table: s(r, 0),
            key: name.clone(),
            name,
            kind,
            check,
            ref_schema: (!ref_schema.is_empty() && ref_schema != schema)
                .then(|| ref_schema.clone()),
            ref_table: s(r, 5),
            on_delete: if kind == 'F' {
                delete_rule(&s(r, 8))
            } else {
                String::new()
            },
            ..Default::default()
        };
        if local.is_empty() {
            con_rows.push(base.clone());
        }
        for (i, c) in local.iter().enumerate() {
            con_rows.push(ConRow {
                column: c.clone(),
                ref_column: refs.get(i).cloned().unwrap_or_default(),
                ..base.clone()
            });
        }
    }
    add_constraints(&mut tables, con_rows);

    // ---- indexes that no constraint owns
    let idx = pool
        .query_strings(&format!(
            "select cl.relname, ic.relname, i.indisunique::text, am.amname::text, \
                    coalesce(pg_get_expr(i.indpred, i.indrelid), ''), \
                    (select string_agg(pg_get_indexdef(i.indexrelid, k.n, true), chr(31) order by k.n) \
                       from generate_series(1, i.indnkeyatts) as k(n)) \
             from pg_index i \
             join pg_class cl on cl.oid = i.indrelid \
             join pg_class ic on ic.oid = i.indexrelid \
             join pg_am am on am.oid = ic.relam \
             join pg_namespace n on n.oid = cl.relnamespace \
             where n.nspname = {lit} and cl.relkind in ('r', 'p') and not cl.relispartition \
               and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid and c.contype in ('p', 'u', 'x')) {} \
             order by cl.relname, ic.relname",
            prefix_sql(d, "cl.relname", prefix)
        ))
        .await?;
    for r in &idx {
        let Some(t) = tables.get(&s(r, 0)) else {
            continue;
        };
        t.indexes.push(IndexModel {
            name: s(r, 1),
            unique: flag(r, 2),
            method: s(r, 3),
            predicate: text(r, 4).map(|p| definition(&p, schema)),
            columns: list(&s(r, 5)).iter().map(|c| squash(c)).collect(),
        });
    }

    // ---- views and materialized views
    let views = pool
        .query_strings(&format!(
            "select c.relname, c.relkind::text, pg_get_viewdef(c.oid, true) \
             from pg_class c join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = {lit} and c.relkind in ('v', 'm') {} order by c.relname",
            prefix_sql(d, "c.relname", prefix)
        ))
        .await?;
    m.views = views
        .iter()
        .map(|r| ViewModel {
            name: s(r, 0),
            definition: definition(&s(r, 2), schema),
            materialized: s(r, 1) == "m",
        })
        .collect();

    // ---- standalone sequences (serial and identity sequences belong to their column)
    let seqs = pool
        .query_strings(&format!(
            "select c.relname, s.increment_by::text, s.min_value::text, s.max_value::text, s.cycle::text, s.cache_size::text \
             from pg_class c join pg_namespace n on n.oid = c.relnamespace \
             join pg_sequences s on s.schemaname = n.nspname and s.sequencename = c.relname \
             where c.relkind = 'S' and n.nspname = {lit} \
               and not exists (select 1 from pg_depend de where de.objid = c.oid and de.deptype in ('a', 'i')) {} \
             order by c.relname",
            prefix_sql(d, "c.relname", prefix)
        ))
        .await?;
    m.sequences = seqs
        .iter()
        .map(|r| SequenceModel {
            name: s(r, 0),
            increment_by: s(r, 1),
            min_value: s(r, 2),
            max_value: s(r, 3),
            cycle: flag(r, 4),
            cache_size: s(r, 5),
        })
        .collect();

    // ---- functions and procedures (aggregates have no definition text), then triggers
    let routines = pool
        .query_strings(&format!(
            "select p.proname, p.prokind::text, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid) \
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace \
             where n.nspname = {lit} and p.prokind in ('f', 'p', 'w') {} order by p.proname, 3",
            prefix_sql(d, "p.proname", prefix)
        ))
        .await?;
    for r in &routines {
        m.routines.push(RoutineModel {
            name: s(r, 0),
            kind: match s(r, 1).as_str() {
                "p" => "PROCEDURE",
                _ => "FUNCTION",
            }
            .into(),
            signature: s(r, 2),
            source_hash: fingerprint(&definition(&s(r, 3), schema)),
        });
    }
    let triggers = pool
        .query_strings(&format!(
            "select c.relname, t.tgname, pg_get_triggerdef(t.oid) \
             from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace \
             where n.nspname = {lit} and not t.tgisinternal {} order by c.relname, t.tgname",
            prefix_sql(d, "t.tgname", prefix)
        ))
        .await?;
    for r in &triggers {
        m.routines.push(RoutineModel {
            name: s(r, 1),
            kind: "TRIGGER".into(),
            signature: s(r, 0),
            source_hash: fingerprint(&definition(&s(r, 2), schema)),
        });
    }

    m.tables = tables.into_vec();
    Ok(m)
}

// ---------------------------------------------------------------- MySQL

async fn my_model(live: &Live, schema: &str, prefix: Option<&str>) -> Result<SchemaModel> {
    let pool = &live.pool;
    let d = Driver::MySql;
    let lit = quote_literal(d, schema);
    let mut m = SchemaModel::new(d, schema, prefix);

    let names = pool
        .query_strings(&format!(
            "select t.table_name from information_schema.tables t \
             where t.table_schema = {lit} and t.table_type = 'BASE TABLE' {} order by t.table_name",
            prefix_sql(d, "t.table_name", prefix)
        ))
        .await?;
    let mut tables = Tables::new(names.iter().map(|r| s(r, 0)).collect());

    // ---- columns
    let cols = pool
        .query_strings(&format!(
            "select c.table_name, c.column_name, c.column_type, c.is_nullable, c.column_default, c.extra, c.generation_expression \
             from information_schema.columns c \
             join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name \
                                             and t.table_type = 'BASE TABLE' \
             where c.table_schema = {lit} {} order by c.table_name, c.ordinal_position",
            prefix_sql(d, "c.table_name", prefix)
        ))
        .await?;
    for r in &cols {
        let Some(t) = tables.get(&s(r, 0)) else {
            continue;
        };
        let extra = s(r, 5)
            .to_ascii_lowercase()
            .replace("default_generated", "");
        let extra = squash(&extra);
        let generated = extra.contains("generated");
        let (default, extra) = if generated {
            (text(r, 6), Some("generated".to_string()))
        } else if extra.contains("auto_increment") {
            (
                text(r, 4).map(|v| my_default(&v)),
                Some("auto_increment".to_string()),
            )
        } else {
            (
                text(r, 4).map(|v| my_default(&v)),
                (!extra.is_empty()).then_some(extra),
            )
        };
        push_column(
            t,
            s(r, 1),
            my_type(&s(r, 2)),
            s(r, 3) == "YES",
            default,
            extra,
        );
    }

    // ---- primary key, unique and foreign key constraints (one row per column)
    let cons = pool
        .query_strings(&format!(
            "select tc.table_name, tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.referenced_table_schema, \
                    kcu.referenced_table_name, kcu.referenced_column_name, rc.delete_rule \
             from information_schema.table_constraints tc \
             left join information_schema.key_column_usage kcu on kcu.constraint_schema = tc.constraint_schema \
                   and kcu.constraint_name = tc.constraint_name and kcu.table_name = tc.table_name \
             left join information_schema.referential_constraints rc on rc.constraint_schema = tc.constraint_schema \
                   and rc.constraint_name = tc.constraint_name and rc.table_name = tc.table_name \
             where tc.table_schema = {lit} and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY') {} \
             order by tc.table_name, tc.constraint_name, kcu.ordinal_position",
            prefix_sql(d, "tc.table_name", prefix)
        ))
        .await?;
    let mut con_rows = Vec::new();
    for r in &cons {
        let kind = match s(r, 2).as_str() {
            "PRIMARY KEY" => 'P',
            "UNIQUE" => 'U',
            _ => 'F',
        };
        let ref_schema = s(r, 4);
        con_rows.push(ConRow {
            table: s(r, 0),
            key: s(r, 1),
            name: s(r, 1),
            kind,
            column: s(r, 3),
            ref_column: s(r, 6),
            ref_schema: (kind == 'F' && !ref_schema.is_empty() && ref_schema != schema)
                .then_some(ref_schema),
            ref_table: s(r, 5),
            on_delete: if kind == 'F' {
                delete_rule(&s(r, 7))
            } else {
                String::new()
            },
            ..Default::default()
        });
    }
    // CHECK constraints (MySQL 8.0.16+ and MariaDB)
    let checks = pool
        .query_strings(&format!(
            "select tc.table_name, cc.constraint_name, cc.check_clause \
             from information_schema.check_constraints cc \
             join information_schema.table_constraints tc on tc.constraint_schema = cc.constraint_schema \
                   and tc.constraint_name = cc.constraint_name and tc.constraint_type = 'CHECK' \
             where cc.constraint_schema = {lit} {} order by tc.table_name, cc.constraint_name",
            prefix_sql(d, "tc.table_name", prefix)
        ))
        .await?;
    for r in &checks {
        con_rows.push(ConRow {
            table: s(r, 0),
            key: s(r, 1),
            name: s(r, 1),
            kind: 'C',
            check: squash(&s(r, 2)),
            ..Default::default()
        });
    }
    // names of the constraints: their indexes are not indexes of their own
    let constraint_names: Vec<(String, String)> = con_rows
        .iter()
        .map(|c| (c.table.clone(), c.name.clone()))
        .collect();
    add_constraints(&mut tables, con_rows);

    // ---- indexes (the primary key, unique and foreign key indexes are constraints)
    let idx = pool
        .query_strings(&format!(
            "select st.table_name, st.index_name, st.non_unique, st.index_type, st.column_name, st.expression \
             from information_schema.statistics st where st.table_schema = {lit} {} \
             order by st.table_name, st.index_name, st.seq_in_index",
            prefix_sql(d, "st.table_name", prefix)
        ))
        .await?;
    for g in group_rows(idx, |r| (s(r, 0), s(r, 1))) {
        let first = &g[0];
        if s(first, 1) == "PRIMARY" || constraint_names.contains(&(s(first, 0), s(first, 1))) {
            continue;
        }
        let Some(t) = tables.get(&s(first, 0)) else {
            continue;
        };
        t.indexes.push(IndexModel {
            name: s(first, 1),
            columns: g
                .iter()
                .map(|r| {
                    let e = squash(&s(r, 5));
                    if e.is_empty() {
                        s(r, 4)
                    } else {
                        e
                    }
                })
                .collect(),
            unique: s(first, 2) == "0",
            method: s(first, 3).to_ascii_lowercase(),
            predicate: None,
        });
    }

    // ---- views
    let views = pool
        .query_strings(&format!(
            "select v.table_name, v.view_definition from information_schema.views v \
             where v.table_schema = {lit} {} order by v.table_name",
            prefix_sql(d, "v.table_name", prefix)
        ))
        .await?;
    m.views = views
        .iter()
        .map(|r| ViewModel {
            name: s(r, 0),
            definition: definition(&s(r, 1), schema),
            materialized: false,
        })
        .collect();

    // ---- stored routines, with their parameters (one query each)
    let params = pool
        .query_strings(&format!(
            "select p.specific_name, p.routine_type, p.parameter_mode, p.parameter_name, p.dtd_identifier \
             from information_schema.parameters p where p.specific_schema = {lit} and p.parameter_name is not null {} \
             order by p.specific_name, p.routine_type, p.ordinal_position",
            prefix_sql(d, "p.specific_name", prefix)
        ))
        .await?;
    let mut params_of: HashMap<(String, String), String> = HashMap::new();
    for g in group_rows(params, |r| (s(r, 0), s(r, 1))) {
        let text = g
            .iter()
            .map(|r| format!("{} {} {}", s(r, 2), s(r, 3), s(r, 4)))
            .collect::<Vec<_>>()
            .join(", ");
        params_of.insert((s(&g[0], 0), s(&g[0], 1)), text);
    }
    let routines = pool
        .query_strings(&format!(
            "select r.routine_name, r.routine_type, r.dtd_identifier, r.routine_definition \
             from information_schema.routines r where r.routine_schema = {lit} {} \
             order by r.routine_name, r.routine_type",
            prefix_sql(d, "r.routine_name", prefix)
        ))
        .await?;
    for r in &routines {
        let params = params_of
            .get(&(s(r, 0), s(r, 1)))
            .cloned()
            .unwrap_or_default();
        m.routines.push(RoutineModel {
            name: s(r, 0),
            kind: s(r, 1).to_ascii_uppercase(),
            signature: String::new(),
            source_hash: fingerprint(&format!("({params}) returns {}\n{}", s(r, 2), s(r, 3))),
        });
    }
    // ---- triggers
    let triggers = pool
        .query_strings(&format!(
            "select t.trigger_name, t.event_object_table, t.action_timing, t.event_manipulation, t.action_statement \
             from information_schema.triggers t where t.trigger_schema = {lit} {} order by t.trigger_name",
            prefix_sql(d, "t.trigger_name", prefix)
        ))
        .await?;
    for r in &triggers {
        m.routines.push(RoutineModel {
            name: s(r, 0),
            kind: "TRIGGER".into(),
            signature: s(r, 1),
            source_hash: fingerprint(&format!(
                "{} {} {}",
                s(r, 2),
                s(r, 3),
                definition(&s(r, 4), schema)
            )),
        });
    }

    m.tables = tables.into_vec();
    Ok(m)
}

// ---------------------------------------------------------------- SQLite

async fn lite_model(live: &Live, sc: &str, prefix: Option<&str>) -> Result<SchemaModel> {
    let pool = &live.pool;
    let d = Driver::Sqlite;
    let sq = quote_ident(d, sc);
    let lit = quote_literal(d, sc);
    let mut m = SchemaModel::new(d, sc, prefix);

    let names = pool
        .query_strings(&format!(
            "select m.name from {sq}.sqlite_master m where m.type = 'table' and m.name not like 'sqlite_%' {} order by m.name",
            prefix_sql(d, "m.name", prefix)
        ))
        .await?;
    let mut tables = Tables::new(names.iter().map(|r| s(r, 0)).collect());

    // ---- columns and the primary key (`pk` is the 1-based place in the key, 0 for the others)
    let cols = pool
        .query_strings(&format!(
            "select m.name, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk \
             from {sq}.sqlite_master m join pragma_table_info(m.name, {lit}) p \
             where m.type = 'table' and m.name not like 'sqlite_%' {} order by m.name, p.cid",
            prefix_sql(d, "m.name", prefix)
        ))
        .await?;
    let mut pk_of: HashMap<String, Vec<(i64, String)>> = HashMap::new();
    for r in &cols {
        let table = s(r, 0);
        let Some(t) = tables.get(&table) else {
            continue;
        };
        let place: i64 = s(r, 5).parse().unwrap_or(0);
        if place > 0 {
            pk_of.entry(table).or_default().push((place, s(r, 1)));
        }
        push_column(
            t,
            s(r, 1),
            s(r, 2).trim().to_ascii_lowercase(),
            s(r, 3) != "1",
            text(r, 4),
            None,
        );
    }
    for t in tables.by_name.values_mut() {
        if let Some(mut key) = pk_of.remove(&t.name) {
            key.sort();
            t.primary_key = Some(KeyModel {
                name: String::new(),
                columns: key.into_iter().map(|(_, c)| c).collect(),
            });
        }
    }

    // ---- foreign keys: one id per key, unnamed in SQLite
    let fks = pool
        .query_strings(&format!(
            "select m.name, f.id, f.\"from\", f.\"table\", f.\"to\", f.on_delete \
             from {sq}.sqlite_master m join pragma_foreign_key_list(m.name, {lit}) f \
             where m.type = 'table' and m.name not like 'sqlite_%' {} order by m.name, f.id, f.seq",
            prefix_sql(d, "m.name", prefix)
        ))
        .await?;
    let con_rows = fks
        .iter()
        .map(|r| ConRow {
            table: s(r, 0),
            key: format!("#{}", s(r, 1)),
            kind: 'F',
            column: s(r, 2),
            ref_table: s(r, 3),
            ref_column: s(r, 4),
            on_delete: delete_rule(&s(r, 5)),
            ..Default::default()
        })
        .collect();
    add_constraints(&mut tables, con_rows);

    // ---- indexes: `origin` c = CREATE INDEX, u = UNIQUE constraint (pk = the primary key, read above)
    let idx = pool
        .query_strings(&format!(
            "select m.name, il.name, il.\"unique\", il.origin, ii.name, ii.seqno \
             from {sq}.sqlite_master m \
             join pragma_index_list(m.name, {lit}) il \
             join pragma_index_info(il.name, {lit}) ii \
             where m.type = 'table' and m.name not like 'sqlite_%' and il.origin <> 'pk' {} \
             order by m.name, il.name, ii.seqno",
            prefix_sql(d, "m.name", prefix)
        ))
        .await?;
    let mut unique_rows = Vec::new();
    for g in group_rows(idx, |r| (s(r, 0), s(r, 1))) {
        let first = &g[0];
        let columns = g.iter().map(|r| {
            let c = s(r, 4);
            if c.is_empty() {
                "(expression)".to_string()
            } else {
                c
            }
        });
        if s(first, 3) == "u" {
            unique_rows.extend(columns.map(|c| ConRow {
                table: s(first, 0),
                key: s(first, 1),
                name: s(first, 1),
                kind: 'U',
                column: c,
                ..Default::default()
            }));
            continue;
        }
        let Some(t) = tables.get(&s(first, 0)) else {
            continue;
        };
        t.indexes.push(IndexModel {
            name: s(first, 1),
            columns: columns.collect(),
            unique: s(first, 2) == "1",
            method: String::new(),
            predicate: None,
        });
    }
    add_constraints(&mut tables, unique_rows);

    // ---- views
    let views = pool
        .query_strings(&format!(
            "select v.name, v.sql from {sq}.sqlite_master v where v.type = 'view' {} order by v.name",
            prefix_sql(d, "v.name", prefix)
        ))
        .await?;
    m.views = views
        .iter()
        .map(|r| ViewModel {
            name: s(r, 0),
            definition: definition(sqlite_view_body(&s(r, 1)), sc),
            materialized: false,
        })
        .collect();

    // ---- triggers (the table is the signature)
    let triggers = pool
        .query_strings(&format!(
            "select t.name, t.tbl_name, t.sql from {sq}.sqlite_master t where t.type = 'trigger' {} order by t.name",
            prefix_sql(d, "t.name", prefix)
        ))
        .await?;
    for r in &triggers {
        m.routines.push(RoutineModel {
            name: s(r, 0),
            kind: "TRIGGER".into(),
            signature: s(r, 1),
            source_hash: fingerprint(&definition(&s(r, 2), sc)),
        });
    }

    m.tables = tables.into_vec();
    Ok(m)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_schema_qualifier_only_in_front_of_names() {
        assert_eq!(
            strip_schema("select * from sales.orders", "sales"),
            "select * from orders"
        );
        assert_eq!(strip_schema("\"SALES\".\"T\"", "SALES"), "\"T\"");
        assert_eq!(strip_schema("`sales`.`t`", "sales"), "`t`");
        assert_eq!(
            strip_schema("nextval('sales.seq'::regclass)", "sales"),
            "nextval('seq'::regclass)"
        );
        // glued to another identifier: not the schema
        assert_eq!(strip_schema("mysales.orders", "sales"), "mysales.orders");
        assert_eq!(strip_schema("x.sales.t", "sales"), "x.sales.t");
    }

    #[test]
    fn definitions_collapse_white_space_and_drop_the_semicolon() {
        assert_eq!(
            definition("select  a,\n  b\nfrom sales.t ;\n", "sales"),
            "select a, b from t"
        );
        assert_eq!(definition("", "sales"), "");
    }

    #[test]
    fn fingerprint_is_stable_and_sensitive() {
        assert_eq!(fingerprint("abc"), fingerprint("abc"));
        assert_ne!(fingerprint("abc"), fingerprint("abd"));
        assert_eq!(fingerprint(""), "cbf29ce484222325");
        assert_eq!(fingerprint("a").len(), 16);
    }

    #[test]
    fn prefix_predicate_counts_characters_and_escapes_quotes() {
        assert_eq!(prefix_sql(Driver::Oracle, "t.name", None), "");
        assert_eq!(prefix_sql(Driver::Oracle, "t.name", Some("")), "");
        assert_eq!(
            prefix_sql(Driver::Oracle, "t.name", Some("CMP_A")),
            " and substr(t.name, 1, 5) = 'CMP_A'"
        );
        assert_eq!(
            prefix_sql(Driver::Postgres, "c.relname", Some("o'x")),
            " and substr(c.relname, 1, 3) = 'o''x'"
        );
    }

    #[test]
    fn groups_keep_first_seen_order() {
        let rows = vec![("b", 1), ("a", 2), ("b", 3)];
        let g = group_rows(rows, |r| r.0);
        assert_eq!(g, vec![vec![("b", 1), ("b", 3)], vec![("a", 2)]]);
    }

    #[test]
    fn list_splits_on_the_separator_only() {
        assert!(list("").is_empty());
        assert_eq!(
            list(&format!("a{SEP}b c")),
            vec!["a".to_string(), "b c".to_string()]
        );
    }

    #[test]
    fn postgres_type_texts_are_one_spelling() {
        assert_eq!(pg_type("character varying(20)"), "varchar(20)");
        assert_eq!(pg_type("timestamp without time zone"), "timestamp");
        assert_eq!(
            pg_type("timestamp(3) with time zone"),
            "timestamp(3) with time zone"
        );
        assert_eq!(pg_type("timestamp(3) without time zone"), "timestamp(3)");
        assert_eq!(pg_type("character(3)"), "char(3)");
        assert_eq!(pg_type("int4"), "integer");
        assert_eq!(pg_type("integer"), "integer");
        assert_eq!(pg_type("numeric(10,2)"), "numeric(10,2)");
    }

    #[test]
    fn mysql_type_texts_drop_integer_widths_but_keep_boolean() {
        assert_eq!(my_type("int(11)"), "int");
        assert_eq!(my_type("int(11) unsigned"), "int unsigned");
        assert_eq!(my_type("bigint(20)"), "bigint");
        assert_eq!(my_type("tinyint(1)"), "tinyint(1)");
        assert_eq!(my_type("tinyint(4)"), "tinyint");
        assert_eq!(my_type("INTEGER"), "int");
        assert_eq!(my_type("bool"), "tinyint(1)");
        assert_eq!(my_type("VARCHAR(50)"), "varchar(50)");
        assert_eq!(my_type("decimal(10,2)"), "decimal(10,2)");
    }

    #[test]
    fn mysql_defaults_lose_their_quotes() {
        assert_eq!(my_default("'abc'"), "abc");
        assert_eq!(my_default("CURRENT_TIMESTAMP"), "CURRENT_TIMESTAMP");
        assert_eq!(my_default("''"), "");
    }

    #[test]
    fn sqlite_view_body_follows_the_first_as() {
        assert_eq!(sqlite_view_body("CREATE VIEW v AS select 1"), "select 1");
        assert_eq!(
            sqlite_view_body("CREATE VIEW v (a) AS\nselect 1"),
            "select 1"
        );
        assert_eq!(sqlite_view_body("select 1"), "select 1");
        assert_eq!(
            sqlite_view_body("CREATE VIEW alias AS select 1"),
            "select 1"
        );
    }

    #[test]
    fn oracle_not_null_checks_are_recognised() {
        assert!(is_not_null_check("\"EMP_ID\" IS NOT NULL"));
        assert!(!is_not_null_check("\"A\" > 0"));
        assert!(!is_not_null_check(
            "\"A\" IS NOT NULL AND \"B\" IS NOT NULL"
        ));
        assert!(!is_not_null_check("A IS NOT NULL"));
    }

    #[test]
    fn delete_rules_are_named_as_in_sql() {
        assert_eq!(delete_rule(""), "NO ACTION");
        assert_eq!(delete_rule("a"), "NO ACTION");
        assert_eq!(delete_rule("c"), "CASCADE");
        assert_eq!(delete_rule("SET NULL"), "SET NULL");
        assert_eq!(delete_rule("n"), "SET NULL");
    }
}
