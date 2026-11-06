//! Row decoding: server values -> [`Cell`] (JSON).
//!
//! PG and MySQL results are fetched with the text protocol (`raw_sql`), so every value
//! arrives in the server's canonical text form and is converted here by column type.
//! SQLite is dynamically typed: the runtime storage class of each value decides.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Number, Value};
use sqlx::mysql::MySqlRow;
use sqlx::postgres::PgRow;
use sqlx::sqlite::SqliteRow;
use sqlx::{Column, Row, TypeInfo, ValueRef};

use crate::conn::{Conn, Live};
use crate::error::Result;
use crate::model::{Cell, ColumnMeta};
use crate::quote::{hex_decode, hex_encode};

/// Largest integer that survives a round trip through a JS double.
const SAFE_INT: i64 = 9_007_199_254_740_992;

#[derive(Debug, Clone, Copy)]
pub struct DecodeOpts {
    /// Max bytes of binary values included in the `$bin` preview.
    pub bin_limit: usize,
}

impl Default for DecodeOpts {
    fn default() -> Self {
        DecodeOpts { bin_limit: 256 }
    }
}

pub fn int_cell(v: i64) -> Cell {
    if (-SAFE_INT..=SAFE_INT).contains(&v) {
        Value::from(v)
    } else {
        Value::String(v.to_string())
    }
}

pub fn uint_cell(v: u64) -> Cell {
    if v <= SAFE_INT as u64 {
        Value::from(v)
    } else {
        Value::String(v.to_string())
    }
}

pub fn float_cell(v: f64) -> Cell {
    match Number::from_f64(v) {
        Some(n) => Value::Number(n),
        None => Value::String(if v.is_nan() {
            "NaN".into()
        } else if v > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }),
    }
}

pub fn bin_cell(b: &[u8], opts: DecodeOpts) -> Cell {
    let shown = &b[..b.len().min(opts.bin_limit)];
    let mut m = serde_json::Map::new();
    m.insert("$bin".into(), Value::String(hex_encode(shown)));
    m.insert("len".into(), Value::from(b.len()));
    if shown.len() < b.len() {
        m.insert("truncated".into(), Value::Bool(true));
    }
    Value::Object(m)
}

// ---------------------------------------------------------------- PostgreSQL

#[derive(Debug, Clone)]
pub(crate) enum PgCat {
    Bool,
    Int,
    Int8,
    Float,
    Numeric,
    Bytea,
    Text,
    Array(u32),
    Domain(u32),
}

#[derive(Debug, Clone)]
pub(crate) struct PgTypeRow {
    pub name: String,
    pub cat: PgCat,
}

#[derive(Debug, Clone)]
pub(crate) enum PgKind {
    Bool,
    Int,
    Int8,
    Float,
    Numeric,
    Bytea,
    Text,
    Array(Box<PgKind>),
}

fn builtin(oid: u32) -> Option<(&'static str, PgCat)> {
    use PgCat::*;
    Some(match oid {
        16 => ("bool", Bool),
        17 => ("bytea", Bytea),
        18 => ("char", Text),
        19 => ("name", Text),
        20 => ("int8", Int8),
        21 => ("int2", Int),
        23 => ("int4", Int),
        25 => ("text", Text),
        26 => ("oid", Int),
        114 => ("json", Text),
        142 => ("xml", Text),
        650 => ("cidr", Text),
        700 => ("float4", Float),
        701 => ("float8", Float),
        790 => ("money", Numeric),
        829 => ("macaddr", Text),
        869 => ("inet", Text),
        1042 => ("bpchar", Text),
        1043 => ("varchar", Text),
        1082 => ("date", Text),
        1083 => ("time", Text),
        1114 => ("timestamp", Text),
        1184 => ("timestamptz", Text),
        1186 => ("interval", Text),
        1266 => ("timetz", Text),
        1560 => ("bit", Text),
        1562 => ("varbit", Text),
        1700 => ("numeric", Numeric),
        2950 => ("uuid", Text),
        3802 => ("jsonb", Text),
        // arrays
        199 => ("_json", Array(114)),
        1000 => ("_bool", Array(16)),
        1001 => ("_bytea", Array(17)),
        1005 => ("_int2", Array(21)),
        1007 => ("_int4", Array(23)),
        1009 => ("_text", Array(25)),
        1014 => ("_bpchar", Array(1042)),
        1015 => ("_varchar", Array(1043)),
        1016 => ("_int8", Array(20)),
        1021 => ("_float4", Array(700)),
        1022 => ("_float8", Array(701)),
        1028 => ("_oid", Array(26)),
        1115 => ("_timestamp", Array(1114)),
        1182 => ("_date", Array(1082)),
        1183 => ("_time", Array(1083)),
        1185 => ("_timestamptz", Array(1184)),
        1231 => ("_numeric", Array(1700)),
        2951 => ("_uuid", Array(2950)),
        3807 => ("_jsonb", Array(3802)),
        _ => return None,
    })
}

fn pg_row_of(cache: &HashMap<u32, PgTypeRow>, oid: u32) -> Option<PgTypeRow> {
    if let Some((n, c)) = builtin(oid) {
        return Some(PgTypeRow {
            name: n.to_string(),
            cat: c,
        });
    }
    cache.get(&oid).cloned()
}

/// Resolve (name, kind) of a type, following arrays and domains.
fn pg_resolve(cache: &HashMap<u32, PgTypeRow>, oid: u32, depth: u8) -> (String, PgKind) {
    let Some(row) = pg_row_of(cache, oid) else {
        return (format!("oid:{oid}"), PgKind::Text);
    };
    if depth > 6 {
        return (row.name, PgKind::Text);
    }
    match row.cat {
        PgCat::Bool => (row.name, PgKind::Bool),
        PgCat::Int => (row.name, PgKind::Int),
        PgCat::Int8 => (row.name, PgKind::Int8),
        PgCat::Float => (row.name, PgKind::Float),
        PgCat::Numeric => (row.name, PgKind::Numeric),
        PgCat::Bytea => (row.name, PgKind::Bytea),
        PgCat::Text => (row.name, PgKind::Text),
        PgCat::Array(elem) => {
            let (en, ek) = pg_resolve(cache, elem, depth + 1);
            (format!("{en}[]"), PgKind::Array(Box::new(ek)))
        }
        PgCat::Domain(base) => {
            let (_, bk) = pg_resolve(cache, base, depth + 1);
            (row.name, bk)
        }
    }
}

/// Make sure every OID in `oids` (and the element / base types they reference) is known.
async fn pg_ensure_types(live: &Live, oids: &[u32]) -> Result<()> {
    let mut need: Vec<u32> = oids.to_vec();
    for _ in 0..4 {
        let missing: Vec<u32> = {
            let cache = live.pg_types.lock().unwrap();
            let mut m: Vec<u32> = need
                .iter()
                .copied()
                .filter(|o| builtin(*o).is_none() && !cache.contains_key(o))
                .collect();
            m.sort_unstable();
            m.dedup();
            m
        };
        if missing.is_empty() {
            return Ok(());
        }
        let list = missing
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let rows = live
            .pool
            .query_strings(&format!(
                "select oid::int8, typname::text, typtype::text, typcategory::text, typelem::int8, typbasetype::int8 \
                 from pg_type where oid in ({list})"
            ))
            .await?;
        let mut next = Vec::new();
        {
            let mut cache = live.pg_types.lock().unwrap();
            for r in rows {
                let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
                let oid: u32 = g(0).parse().unwrap_or(0);
                let typelem: u32 = g(4).parse().unwrap_or(0);
                let base: u32 = g(5).parse().unwrap_or(0);
                let cat = if g(2) == "d" && base != 0 {
                    next.push(base);
                    PgCat::Domain(base)
                } else if g(3) == "A" && typelem != 0 {
                    next.push(typelem);
                    PgCat::Array(typelem)
                } else {
                    PgCat::Text
                };
                cache.insert(oid, PgTypeRow { name: g(1), cat });
            }
            // anything the catalog did not return is marked as plain text so we do not loop
            for o in &missing {
                cache.entry(*o).or_insert(PgTypeRow {
                    name: format!("oid:{o}"),
                    cat: PgCat::Text,
                });
            }
        }
        need = next;
    }
    Ok(())
}

/// `schema.table` of every column that is a plain reference to a table column (`None` for expressions).
async fn pg_table_refs(live: &Live, cols: &[sqlx::postgres::PgColumn]) -> Vec<Option<String>> {
    let rels: Vec<u32> = cols
        .iter()
        .map(|c| {
            if c.relation_attribute_no().is_some_and(|n| n > 0) {
                c.relation_id().map(|o| o.0).unwrap_or(0)
            } else {
                0
            }
        })
        .collect();
    pg_ensure_rels(live, &rels).await;
    let cache = live.pg_rels.lock().unwrap_or_else(|e| e.into_inner());
    rels.iter().map(|o| cache.get(o).cloned()).collect()
}

/// Resolve the table OIDs a result set reports (`RowDescription`) to `schema.table`, once per OID.
/// Best effort: a failed lookup (or a table the catalog cannot see yet) just leaves `table_ref` empty.
async fn pg_ensure_rels(live: &Live, rels: &[u32]) {
    let missing: Vec<u32> = {
        let cache = live.pg_rels.lock().unwrap_or_else(|e| e.into_inner());
        let mut m: Vec<u32> = rels
            .iter()
            .copied()
            .filter(|o| *o != 0 && !cache.contains_key(o))
            .collect();
        m.sort_unstable();
        m.dedup();
        m
    };
    if missing.is_empty() {
        return;
    }
    let list = missing
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let Ok(rows) = live
        .pool
        .query_strings(&format!(
            "select c.oid::int8, n.nspname::text, c.relname::text from pg_class c \
             join pg_namespace n on n.oid = c.relnamespace where c.oid in ({list})"
        ))
        .await
    else {
        return;
    };
    let mut cache = live.pg_rels.lock().unwrap_or_else(|e| e.into_inner());
    for r in rows {
        let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
        let oid: u32 = g(0).parse().unwrap_or(0);
        // temp tables live in a per-session schema: not a name the user can open
        if oid != 0 && !g(1).starts_with("pg_temp") && !g(1).starts_with("pg_toast") {
            cache.insert(oid, format!("{}.{}", g(1), g(2)));
        }
    }
}

pub(crate) fn pg_text_cell(kind: &PgKind, s: &str, opts: DecodeOpts) -> Cell {
    match kind {
        PgKind::Bool => match s {
            "t" | "true" => Value::Bool(true),
            "f" | "false" => Value::Bool(false),
            _ => Value::String(s.to_string()),
        },
        PgKind::Int => s
            .parse::<i64>()
            .map(int_cell)
            .unwrap_or_else(|_| Value::String(s.to_string())),
        PgKind::Int8 => s
            .parse::<i64>()
            .map(int_cell)
            .unwrap_or_else(|_| Value::String(s.to_string())),
        PgKind::Float => match s.parse::<f64>() {
            Ok(v) if v.is_finite() => float_cell(v),
            _ => Value::String(s.to_string()),
        },
        PgKind::Numeric | PgKind::Text => Value::String(s.to_string()),
        PgKind::Bytea => match s.strip_prefix("\\x").and_then(hex_decode) {
            Some(b) => bin_cell(&b, opts),
            None => Value::String(s.to_string()),
        },
        PgKind::Array(elem) => parse_pg_array(s, elem, opts),
    }
}

/// Parse a PG array literal (`{1,2,NULL,"a b"}`, nested for multi-dimensional) into JSON.
pub(crate) fn parse_pg_array(s: &str, elem: &PgKind, opts: DecodeOpts) -> Cell {
    let b = s.as_bytes();
    let mut i = 0;
    if b.first() == Some(&b'[') {
        // dimension decoration: [0:2]={...}
        match s.find('=') {
            Some(p) => i = p + 1,
            None => return Value::String(s.to_string()),
        }
    }
    if b.get(i) != Some(&b'{') {
        return Value::String(s.to_string());
    }
    parse_array_level(s, &mut i, elem, opts).unwrap_or_else(|| Value::String(s.to_string()))
}

fn parse_array_level(s: &str, i: &mut usize, elem: &PgKind, opts: DecodeOpts) -> Option<Value> {
    let b = s.as_bytes();
    *i += 1; // '{'
    let mut items = Vec::new();
    loop {
        match *b.get(*i)? {
            b'}' => {
                *i += 1;
                return Some(Value::Array(items));
            }
            b',' => *i += 1,
            b'{' => items.push(parse_array_level(s, i, elem, opts)?),
            b'"' => {
                *i += 1;
                let mut buf = Vec::new();
                loop {
                    match *b.get(*i)? {
                        b'\\' => {
                            buf.push(*b.get(*i + 1)?);
                            *i += 2;
                        }
                        b'"' => {
                            *i += 1;
                            break;
                        }
                        c => {
                            buf.push(c);
                            *i += 1;
                        }
                    }
                }
                items.push(pg_text_cell(elem, &String::from_utf8_lossy(&buf), opts));
            }
            _ => {
                let st = *i;
                while *i < b.len() && b[*i] != b',' && b[*i] != b'}' {
                    *i += 1;
                }
                let tok = s[st..*i].trim();
                if tok.eq_ignore_ascii_case("NULL") {
                    items.push(Value::Null);
                } else {
                    items.push(pg_text_cell(elem, tok, opts));
                }
            }
        }
    }
}

// --------------------------------------------------------------------- MySQL

#[derive(Debug, Clone, Copy)]
pub(crate) enum MyKind {
    Int,
    UInt,
    Float,
    Text,
    Bin,
    Bit,
}

fn my_kind(name: &str) -> MyKind {
    match name {
        // sqlx reports every TINYINT(1) as BOOLEAN, but MySQL keeps any value -128..127 there
        // (BOOL is just an alias): show the integer, not `true`
        "BOOLEAN" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => MyKind::Int,
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" => MyKind::UInt,
        "FLOAT" | "DOUBLE" => MyKind::Float,
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "GEOMETRY" => {
            MyKind::Bin
        }
        "BIT" => MyKind::Bit,
        // DECIMAL stays text on purpose (precision)
        _ => MyKind::Text,
    }
}

fn my_cell(kind: MyKind, bytes: &[u8], opts: DecodeOpts) -> Cell {
    match kind {
        MyKind::Bin => bin_cell(bytes, opts),
        MyKind::Bit => {
            if bytes.len() <= 6 {
                Value::from(bytes.iter().fold(0u64, |a, b| (a << 8) | *b as u64))
            } else {
                bin_cell(bytes, opts)
            }
        }
        _ => {
            let s = String::from_utf8_lossy(bytes);
            match kind {
                MyKind::Int => s
                    .parse::<i64>()
                    .map(int_cell)
                    .unwrap_or_else(|_| Value::String(s.into_owned())),
                MyKind::UInt => s
                    .parse::<u64>()
                    .map(uint_cell)
                    .unwrap_or_else(|_| Value::String(s.into_owned())),
                MyKind::Float => match s.parse::<f64>() {
                    Ok(v) if v.is_finite() => float_cell(v),
                    _ => Value::String(s.into_owned()),
                },
                _ => Value::String(s.into_owned()),
            }
        }
    }
}

// -------------------------------------------------------------------- SQLite

fn lite_cell(row: &SqliteRow, i: usize, opts: DecodeOpts) -> Cell {
    let Ok(raw) = row.try_get_raw(i) else {
        return Value::Null;
    };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info().name().to_string();
    match ty.as_str() {
        "INTEGER" | "INT" | "INT8" | "BOOLEAN" => row
            .try_get_unchecked::<i64, _>(i)
            .map(int_cell)
            .unwrap_or(Value::Null),
        "REAL" | "NUMERIC" => row
            .try_get_unchecked::<f64, _>(i)
            .map(float_cell)
            .unwrap_or(Value::Null),
        "BLOB" => row
            .try_get_unchecked::<Vec<u8>, _>(i)
            .map(|b| bin_cell(&b, opts))
            .unwrap_or(Value::Null),
        _ => row
            .try_get_unchecked::<String, _>(i)
            .map(Value::String)
            .unwrap_or_else(|_| Value::String("<unsupported type>".into())),
    }
}

// ---------------------------------------------------------------- generic API

pub(crate) enum RawRow {
    Pg(PgRow),
    My(MySqlRow),
    Lite(SqliteRow),
}

/// Converts raw rows of one result set to cells; built from the first row.
///
/// The last field is the column signature (name, type) the decoder was built for: a call
/// can return several result sets with different columns (`select 1; select 1, 2`, MySQL
/// `CALL`), see [`RowDecoder::fits`].
pub(crate) enum RowDecoder {
    Pg(Arc<Vec<PgKind>>, DecodeOpts, Vec<(String, u32)>),
    My(Arc<Vec<MyKind>>, DecodeOpts, Vec<(String, String)>),
    Lite(DecodeOpts, Vec<String>),
}

impl RowDecoder {
    pub async fn build(
        live: &Live,
        first: &RawRow,
        opts: DecodeOpts,
    ) -> Result<(RowDecoder, Vec<ColumnMeta>)> {
        match first {
            RawRow::Pg(r) => {
                let oids: Vec<u32> = r
                    .columns()
                    .iter()
                    .map(|c| c.type_info().oid().map(|o| o.0).unwrap_or(0))
                    .collect();
                pg_ensure_types(live, &oids).await?;
                let rels = pg_table_refs(live, r.columns()).await;
                let cache = live.pg_types.lock().unwrap_or_else(|e| e.into_inner());
                let mut kinds = Vec::new();
                let mut metas = Vec::new();
                let mut sig = Vec::new();
                for ((c, oid), rel) in r.columns().iter().zip(oids).zip(rels) {
                    let (name, kind) = pg_resolve(&cache, oid, 0);
                    kinds.push(kind);
                    metas.push(ColumnMeta {
                        table_ref: rel,
                        ..meta(c.name(), name)
                    });
                    sig.push((c.name().to_string(), oid));
                }
                Ok((RowDecoder::Pg(Arc::new(kinds), opts, sig), metas))
            }
            RawRow::My(r) => {
                let mut kinds = Vec::new();
                let mut metas = Vec::new();
                let mut sig = Vec::new();
                for c in r.columns() {
                    let tn = c.type_info().name().to_string();
                    kinds.push(my_kind(&tn));
                    let shown = if tn == "BOOLEAN" {
                        "tinyint(1)".to_string()
                    } else {
                        tn.to_lowercase()
                    };
                    metas.push(meta(c.name(), shown));
                    sig.push((c.name().to_string(), tn));
                }
                Ok((RowDecoder::My(Arc::new(kinds), opts, sig), metas))
            }
            RawRow::Lite(r) => {
                let metas = r
                    .columns()
                    .iter()
                    .map(|c| {
                        let tn = c.type_info().name().to_string();
                        meta(
                            c.name(),
                            if tn == "NULL" {
                                String::new()
                            } else {
                                tn.to_lowercase()
                            },
                        )
                    })
                    .collect();
                let sig = r.columns().iter().map(|c| c.name().to_string()).collect();
                Ok((RowDecoder::Lite(opts, sig), metas))
            }
        }
    }

    /// Does `row` have the columns this decoder was built for? When not (the next result
    /// set of a multi-result call started) a new decoder must be built from this row.
    pub fn fits(&self, row: &RawRow) -> bool {
        match (self, row) {
            (RowDecoder::Pg(_, _, sig), RawRow::Pg(r)) => {
                let cols = r.columns();
                cols.len() == sig.len()
                    && cols.iter().zip(sig).all(|(c, (n, oid))| {
                        c.name() == n && c.type_info().oid().map(|o| o.0).unwrap_or(0) == *oid
                    })
            }
            (RowDecoder::My(_, _, sig), RawRow::My(r)) => {
                let cols = r.columns();
                cols.len() == sig.len()
                    && cols
                        .iter()
                        .zip(sig)
                        .all(|(c, (n, t))| c.name() == n && c.type_info().name() == t)
            }
            (RowDecoder::Lite(_, sig), RawRow::Lite(r)) => {
                let cols = r.columns();
                cols.len() == sig.len() && cols.iter().zip(sig).all(|(c, n)| c.name() == n)
            }
            _ => false,
        }
    }

    /// Never panics: a row with more columns than the decoder knows is decoded as text.
    pub fn decode(&self, row: &RawRow) -> Vec<Cell> {
        match (self, row) {
            (RowDecoder::Pg(kinds, opts, _), RawRow::Pg(r)) => (0..r.len())
                .map(|i| match r.try_get_unchecked::<Option<String>, _>(i) {
                    Ok(Some(s)) => pg_text_cell(kinds.get(i).unwrap_or(&PgKind::Text), &s, *opts),
                    Ok(None) => Value::Null,
                    Err(_) => Value::String("<unsupported type>".into()),
                })
                .collect(),
            (RowDecoder::My(kinds, opts, _), RawRow::My(r)) => (0..r.len())
                .map(|i| match r.try_get_unchecked::<Option<Vec<u8>>, _>(i) {
                    Ok(Some(b)) => {
                        my_cell(kinds.get(i).copied().unwrap_or(MyKind::Text), &b, *opts)
                    }
                    Ok(None) => Value::Null,
                    Err(_) => Value::String("<unsupported type>".into()),
                })
                .collect(),
            (RowDecoder::Lite(opts, _), RawRow::Lite(r)) => {
                (0..r.len()).map(|i| lite_cell(r, i, *opts)).collect()
            }
            _ => Vec::new(),
        }
    }
}

fn meta(name: &str, type_name: String) -> ColumnMeta {
    ColumnMeta {
        name: name.to_string(),
        type_name,
        nullable: true,
        is_pk: false,
        table_ref: None,
    }
}

/// Column metadata of a statement without running it (`describe`). Used to show the
/// columns of a query that returned zero rows.
pub(crate) async fn describe_columns(live: &Live, conn: &mut Conn, sql: &str) -> Vec<ColumnMeta> {
    use sqlx::Executor;
    fn conv<C: Column>(cols: &[C]) -> Vec<ColumnMeta> {
        cols.iter()
            .map(|c| meta(c.name(), c.type_info().name().to_lowercase()))
            .collect()
    }
    match conn {
        Conn::Pg(c) => match c.describe(sql).await {
            Ok(d) => {
                let refs = pg_table_refs(live, d.columns()).await;
                conv(d.columns())
                    .into_iter()
                    .zip(refs)
                    .map(|(m, table_ref)| ColumnMeta { table_ref, ..m })
                    .collect()
            }
            Err(_) => Vec::new(),
        },
        Conn::My(c) => c
            .describe(sql)
            .await
            .map(|d| conv(d.columns()))
            .unwrap_or_default(),
        Conn::Lite(c) => c
            .describe(sql)
            .await
            .map(|d| conv(d.columns()))
            .unwrap_or_default(),
    }
}

pub(crate) async fn describe_columns_pool(pool: &crate::conn::Pool, sql: &str) -> Vec<ColumnMeta> {
    use sqlx::Executor;
    fn conv<C: Column>(cols: &[C]) -> Vec<ColumnMeta> {
        cols.iter()
            .map(|c| meta(c.name(), c.type_info().name().to_lowercase()))
            .collect()
    }
    match pool {
        crate::conn::Pool::Pg(p) => p
            .describe(sql)
            .await
            .map(|d| conv(d.columns()))
            .unwrap_or_default(),
        crate::conn::Pool::My(p) => p
            .describe(sql)
            .await
            .map(|d| conv(d.columns()))
            .unwrap_or_default(),
        crate::conn::Pool::Lite(p) => p
            .describe(sql)
            .await
            .map(|d| conv(d.columns()))
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn arr(s: &str, k: PgKind) -> Value {
        parse_pg_array(s, &k, DecodeOpts::default())
    }

    #[test]
    fn pg_arrays() {
        assert_eq!(arr("{1,2,NULL,4}", PgKind::Int), json!([1, 2, null, 4]));
        assert_eq!(arr("{}", PgKind::Int), json!([]));
        assert_eq!(
            arr(r#"{a,"b c","d\"e","NULL",NULL}"#, PgKind::Text),
            json!(["a", "b c", "d\"e", "NULL", null])
        );
        assert_eq!(arr("{{1,2},{3,4}}", PgKind::Int), json!([[1, 2], [3, 4]]));
        assert_eq!(arr("[0:1]={5,6}", PgKind::Int), json!([5, 6]));
        assert_eq!(arr("{t,f}", PgKind::Bool), json!([true, false]));
        assert_eq!(arr("{1.50,2}", PgKind::Numeric), json!(["1.50", "2"]));
        assert_eq!(
            arr("{9007199254740993}", PgKind::Int8),
            json!(["9007199254740993"])
        );
    }

    #[test]
    fn pg_scalars() {
        let o = DecodeOpts::default();
        assert_eq!(pg_text_cell(&PgKind::Float, "NaN", o), json!("NaN"));
        assert_eq!(pg_text_cell(&PgKind::Float, "1.5", o), json!(1.5));
        assert_eq!(
            pg_text_cell(&PgKind::Numeric, "12345678901234567890.123", o),
            json!("12345678901234567890.123")
        );
        assert_eq!(
            pg_text_cell(&PgKind::Int8, "9223372036854775807", o),
            json!("9223372036854775807")
        );
        assert_eq!(
            pg_text_cell(&PgKind::Bytea, "\\xdeadbeef", o),
            json!({"$bin": "deadbeef", "len": 4})
        );
        let small = DecodeOpts { bin_limit: 2 };
        assert_eq!(
            pg_text_cell(&PgKind::Bytea, "\\xdeadbeef", small),
            json!({"$bin": "dead", "len": 4, "truncated": true})
        );
    }

    #[test]
    fn mysql_cells() {
        let o = DecodeOpts::default();
        assert_eq!(
            my_cell(MyKind::UInt, b"18446744073709551615", o),
            json!("18446744073709551615")
        );
        assert_eq!(my_cell(MyKind::Int, b"-5", o), json!(-5));
        // TINYINT(1) (sqlx name BOOLEAN) holds any tinyint: 0 / 1 / 5 stay integers
        for (v, want) in [(&b"0"[..], 0), (b"1", 1), (b"5", 5), (b"-3", -3)] {
            assert_eq!(my_cell(my_kind("BOOLEAN"), v, o), json!(want));
        }
        assert_eq!(my_cell(my_kind("TINYINT"), b"5", o), json!(5));
        assert_eq!(my_cell(MyKind::Bit, &[0, 5], o), json!(5));
        assert_eq!(
            my_cell(MyKind::Bin, &[1, 2], o),
            json!({"$bin": "0102", "len": 2})
        );
    }
}
