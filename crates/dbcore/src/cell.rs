//! Full value of one table cell, for the grid's value viewer.
//!
//! The grid shows a binary value as a preview (`{ "$bin": <first bytes>, "len", "truncated" }`, see
//! `value::bin_cell`). [`ConnectionManager::fetch_cell`] reads one column of one row by its primary key. The row
//! predicate is the one an edit uses (`table::key_predicate`), with bind parameters. Reads are capped at `max_bytes`
//! (never more than [`MAX_CELL_BYTES`]): PostgreSQL, MySQL and SQLite cut the value on the server, and so does Oracle
//! for a CLOB / NCLOB / BLOB (`DBMS_LOB.SUBSTR` pieces, see `read_ora_lob`). Oracle's other columns are read whole
//! (they are small, except LONG / LONG RAW, which the server cannot cut).

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use sqlx::Row;

use crate::conn::{Live, Pool};
use crate::error::{DbError, Result};
use crate::introspect::{table_columns, ColInfo};
use crate::manager::ConnectionManager;
use crate::model::{Driver, ObjectRef};
use crate::oracle::{OraBind, OraPool};
use crate::quote::{hex_decode, qualified, quote_ident};
use crate::table::{key_predicate, Bind};

/// Largest value returned whole, and largest file loaded into a cell: 32 MB.
pub const MAX_CELL_BYTES: u64 = 32 * 1024 * 1024;

/// How the value is handed to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CellKind {
    Text,
    Binary,
}

/// The value of one cell. `text` (text kind) or `base64` (binary kind) holds at most the cap; `len` is the size of
/// the whole value (UTF-8 bytes for text). The exception is an Oracle CLOB / NCLOB that was not read whole (its
/// pieces stopped at the cap): its `len` is its length in UTF-16 units, the size the server reports without reading
/// the rest of the LOB.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellContent {
    pub kind: CellKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Standard base64 with padding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    pub len: u64,
    pub truncated: bool,
}

/// The byte cap of a request: `0` asks for the largest allowed value.
pub fn cap_for(max_bytes: u64) -> usize {
    let n = if max_bytes == 0 {
        MAX_CELL_BYTES
    } else {
        max_bytes.min(MAX_CELL_BYTES)
    };
    n as usize
}

/// What a read returned: whether the value is binary, its size in bytes and its first bytes (all of them, or at
/// least `cap` of them).
struct Read {
    binary: bool,
    len: u64,
    bytes: Vec<u8>,
}

/// The reply for a read, cut to `cap` bytes. A text value is cut before a character, never inside one.
fn content(read: Read, cap: usize) -> CellContent {
    let Read {
        binary,
        len,
        mut bytes,
    } = read;
    let truncated = len > cap as u64;
    if binary {
        bytes.truncate(cap);
        CellContent {
            kind: CellKind::Binary,
            text: None,
            base64: Some(base64_encode(&bytes)),
            len,
            truncated,
        }
    } else {
        let mut end = bytes.len().min(cap);
        // a UTF-8 continuation byte starts inside a character: back up to where it starts
        while end > 0 && end < bytes.len() && bytes[end] & 0xC0 == 0x80 {
            end -= 1;
        }
        bytes.truncate(end);
        CellContent {
            kind: CellKind::Text,
            text: Some(String::from_utf8_lossy(&bytes).into_owned()),
            base64: None,
            len,
            truncated,
        }
    }
}

/// Is the column read as bytes? SQLite decides by the stored value (see [`read_lite`]).
fn is_binary(d: Driver, col: &ColInfo) -> bool {
    match d {
        Driver::Postgres => col.base_type == "bytea",
        Driver::MySql => {
            let t = col.type_name.to_ascii_lowercase();
            [
                "tinyblob",
                "blob",
                "mediumblob",
                "longblob",
                "binary",
                "varbinary",
            ]
            .iter()
            .any(|p| t.starts_with(p))
        }
        Driver::Oracle => matches!(col.base_type.as_str(), "BLOB" | "RAW" | "LONG RAW"),
        Driver::Sqlite => false,
    }
}

/// The key must name exactly the primary key, with a value for each column that is not a cut-off preview.
fn check_key(info: &[ColInfo], keys: &BTreeMap<String, Value>) -> Result<()> {
    let pk: Vec<&str> = info
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| c.name.as_str())
        .collect();
    if pk.is_empty() {
        return Err(DbError::InvalidArgument(
            "The table has no primary key: a single value cannot be read from it".into(),
        ));
    }
    if let Some(k) = keys.keys().find(|k| !pk.contains(&k.as_str())) {
        return Err(DbError::InvalidArgument(format!(
            "'{k}' is not a primary key column"
        )));
    }
    for name in &pk {
        match keys.get(*name) {
            None => {
                return Err(DbError::InvalidArgument(format!(
                    "The primary key value of '{name}' is missing"
                )))
            }
            Some(v) if v.get("truncated").and_then(Value::as_bool) == Some(true) => {
                return Err(DbError::InvalidArgument(format!(
                    "The primary key value of '{name}' is a cut-off preview"
                )))
            }
            Some(_) => {}
        }
    }
    Ok(())
}

fn ora_binds(binds: &[Bind]) -> Vec<OraBind> {
    binds
        .iter()
        .map(|b| match b {
            Bind::Null => OraBind::Null,
            Bind::Bool(v) => OraBind::Bool(*v),
            Bind::Int(v) => OraBind::Int(*v),
            Bind::UInt(v) => OraBind::UInt(*v),
            Bind::Float(v) => OraBind::Float(*v),
            Bind::Text(v) => OraBind::Text(v.clone()),
            Bind::Bytes(v) => OraBind::Bytes(v.clone()),
        })
        .collect()
}

/// `select <length>, <first cap bytes> <from>` on PostgreSQL. A text value is measured and cut as text: its
/// characters are at least as many bytes as the cut needs, so the reply always holds `min(len, cap)` bytes.
async fn read_pg(
    p: &sqlx::PgPool,
    col: &str,
    from: &str,
    binds: &[Bind],
    binary: bool,
    cap: usize,
) -> Result<Vec<Option<Read>>> {
    let sql = if binary {
        format!(
            "select cast(octet_length({col}) as bigint), substring({col} from 1 for {cap}) {from}"
        )
    } else {
        format!(
            "select cast(octet_length(cast({col} as text)) as bigint), \
             substring(cast({col} as text) from 1 for {cap}) {from}"
        )
    };
    let mut q = sqlx::query(&sql);
    for b in binds {
        q = match b {
            Bind::Null => q.bind(None::<String>),
            Bind::Bool(v) => q.bind(*v),
            Bind::Int(v) => q.bind(*v),
            Bind::UInt(v) => q.bind(v.to_string()),
            Bind::Float(v) => q.bind(*v),
            Bind::Text(v) => q.bind(v.clone()),
            Bind::Bytes(v) => q.bind(v.clone()),
        };
    }
    let rows = q.fetch_all(p).await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let Some(len) = r.try_get::<Option<i64>, _>(0)? else {
            out.push(None);
            continue;
        };
        let bytes = if binary {
            r.try_get::<Vec<u8>, _>(1)?
        } else {
            r.try_get::<String, _>(1)?.into_bytes()
        };
        out.push(Some(Read {
            binary,
            len: len as u64,
            bytes,
        }));
    }
    Ok(out)
}

/// `select <length>, <first cap bytes> <from>` on MySQL: `LENGTH` counts bytes, and `SUBSTRING` of a binary string
/// counts bytes too (of a text value characters, which is at least as many bytes as the cut needs).
async fn read_my(
    p: &sqlx::MySqlPool,
    col: &str,
    from: &str,
    binds: &[Bind],
    binary: bool,
    cap: usize,
) -> Result<Vec<Option<Read>>> {
    let sql = format!("select cast(length({col}) as signed), substring({col}, 1, {cap}) {from}");
    let mut q = sqlx::query(&sql);
    for b in binds {
        q = match b {
            Bind::Null => q.bind(None::<String>),
            Bind::Bool(v) => q.bind(*v),
            Bind::Int(v) => q.bind(*v),
            Bind::UInt(v) => q.bind(*v),
            Bind::Float(v) => q.bind(*v),
            Bind::Text(v) => q.bind(v.clone()),
            Bind::Bytes(v) => q.bind(v.clone()),
        };
    }
    let rows = q.fetch_all(p).await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let Some(len) = r.try_get::<Option<i64>, _>(0)? else {
            out.push(None);
            continue;
        };
        let bytes: Option<Vec<u8>> = r.try_get_unchecked(1)?;
        out.push(Some(Read {
            binary,
            len: len as u64,
            bytes: bytes.unwrap_or_default(),
        }));
    }
    Ok(out)
}

/// `select typeof, <length in bytes>, <first cap bytes> <from>` on SQLite. A `BLOB` is read as bytes; any other
/// storage class as its text (`substr` of a number is text, and at least `cap` bytes once cut at `cap` characters).
async fn read_lite(
    p: &sqlx::SqlitePool,
    col: &str,
    from: &str,
    binds: &[Bind],
    cap: usize,
) -> Result<Vec<Option<Read>>> {
    let sql = format!(
        "select typeof({col}), cast(length(cast({col} as blob)) as integer), substr({col}, 1, {cap}) {from}"
    );
    let mut q = sqlx::query(&sql);
    for b in binds {
        q = match b {
            Bind::Null => q.bind(None::<String>),
            Bind::Bool(v) => q.bind(*v),
            Bind::Int(v) => q.bind(*v),
            Bind::UInt(v) => q.bind(v.to_string()),
            Bind::Float(v) => q.bind(*v),
            Bind::Text(v) => q.bind(v.clone()),
            Bind::Bytes(v) => q.bind(v.clone()),
        };
    }
    let rows = q.fetch_all(p).await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let ty: String = r.try_get(0)?;
        if ty == "null" {
            out.push(None);
            continue;
        }
        let len: i64 = r.try_get(1)?;
        let bytes: Option<Vec<u8>> = r.try_get_unchecked(2)?;
        out.push(Some(Read {
            binary: ty == "blob",
            len: len as u64,
            bytes: bytes.unwrap_or_default(),
        }));
    }
    Ok(out)
}

/// `select <column> <from>` on Oracle, for the columns that are not LOBs (see [`read_ora_lob`]). The thin driver
/// returns the whole value (as text, or hex for binary), so the cut happens in [`content`].
async fn read_ora(
    p: &OraPool,
    col: &str,
    from: &str,
    binds: &[Bind],
    binary: bool,
) -> Result<Vec<Option<Read>>> {
    let rows = p
        .query_binds(&format!("select {col} {from}"), &ora_binds(binds))
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let Some(text) = r.into_iter().next().flatten() else {
            out.push(None);
            continue;
        };
        let bytes = if binary {
            // the server's RAW text is hex (upper case)
            hex_decode(&text).ok_or_else(|| {
                DbError::InvalidArgument("The binary value could not be read".into())
            })?
        } else {
            text.into_bytes()
        };
        out.push(Some(Read {
            binary,
            len: bytes.len() as u64,
            bytes,
        }));
    }
    Ok(out)
}

/// Pieces of a LOB read by one statement, in the units the server counts: 2000 bytes of a BLOB (a RAW of SQL is at
/// most 2000 bytes, and its hex text fits in 4000), 1000 UTF-16 units of a CLOB / NCLOB (a VARCHAR2 of SQL is at most
/// 4000 bytes, and a unit is at most 3 bytes of UTF-8).
const ORA_BLOB_PIECE: u64 = 2000;
const ORA_TEXT_PIECE: u64 = 1000;
/// The server refuses a text piece that starts inside a surrogate pair.
const ORA_SPLIT_PAIR: &str = "ORA-22831";

/// UTF-16 units of `s`: what the server counts in the offsets and lengths of a CLOB / NCLOB (a character outside the
/// Basic Multilingual Plane is two).
fn utf16_units(s: &str) -> u64 {
    s.encode_utf16().count() as u64
}

/// A length the server returned as text (`DBMS_LOB.GETLENGTH`); `None` for a NULL value.
fn ora_len(v: Option<String>) -> Result<Option<u64>> {
    v.map(|s| {
        s.trim()
            .parse::<u64>()
            .map_err(|_| DbError::InvalidArgument(format!("Invalid LOB length: {s}")))
    })
    .transpose()
}

/// The text of a CLOB / NCLOB from its pieces, in order, when they cover the first `min(total, cap)` units. The size
/// is the UTF-8 size when the whole value is here; a cut value reports its `total` units. `None`: the pieces stop
/// short, because a piece ended inside a surrogate pair and the server dropped its first half.
fn text_from_pieces(total: u64, cap: usize, pieces: &[String]) -> Option<Read> {
    let units: u64 = pieces.iter().map(|p| utf16_units(p)).sum();
    if units < total.min(cap as u64) {
        return None;
    }
    let bytes = pieces.concat().into_bytes();
    let len = if units >= total {
        bytes.len() as u64
    } else {
        total
    };
    Some(Read {
        binary: false,
        len,
        bytes,
    })
}

/// A CLOB / NCLOB / BLOB column: its length and the first `cap` of it, in pieces of one statement, so the rest of
/// the LOB stays on the server (the thin driver would hand the whole value over). The pieces are cut by
/// `DBMS_LOB.SUBSTR`. A text piece that starts inside a surrogate pair is refused by the server (ORA-22831): such a
/// value is read piece by piece, see [`read_ora_text_walk`].
async fn read_ora_lob(
    p: &OraPool,
    col: &str,
    from: &str,
    binds: &[Bind],
    binary: bool,
    cap: usize,
) -> Result<Vec<Option<Read>>> {
    let (size, piece) = if binary {
        (
            ORA_BLOB_PIECE,
            format!(
                "rawtohex(dbms_lob.substr(x.v, {ORA_BLOB_PIECE}, (c.lv - 1) * {ORA_BLOB_PIECE} + 1))"
            ),
        )
    } else {
        (
            ORA_TEXT_PIECE,
            format!("dbms_lob.substr(x.v, {ORA_TEXT_PIECE}, (c.lv - 1) * {ORA_TEXT_PIECE} + 1)"),
        )
    };
    // a row per piece up to the cap, with the length on each; at least one row, so that a NULL or an empty value
    // comes back too
    let sql = format!(
        "select x.len, {piece} from (select {col} v, dbms_lob.getlength({col}) len {from}) x \
         cross apply (select level lv from dual connect by level <= greatest(1, ceil(least(nvl(x.len, 0), :{}) / {size}))) c \
         order by c.lv",
        binds.len() + 1
    );
    let mut params = ora_binds(binds);
    params.push(OraBind::Int(cap as i64));
    let rows = match p.query_binds(&sql, &params).await {
        Ok(rows) => rows,
        Err(DbError::Server(s)) if !binary && s.code == ORA_SPLIT_PAIR => {
            return read_ora_text_walk(p, col, from, binds, cap).await;
        }
        Err(e) => return Err(e),
    };
    let Some(first) = rows.first() else {
        return Ok(Vec::new());
    };
    let Some(total) = ora_len(first.first().cloned().flatten())? else {
        return Ok(vec![None]);
    };
    let pieces: Vec<String> = rows
        .iter()
        .filter_map(|r| r.get(1).cloned().flatten())
        .collect();
    if binary {
        let mut bytes = Vec::new();
        for h in &pieces {
            let b = hex_decode(h).ok_or_else(|| {
                DbError::InvalidArgument("The binary value could not be read".into())
            })?;
            bytes.extend(b);
        }
        return Ok(vec![Some(Read {
            binary: true,
            len: total,
            bytes,
        })]);
    }
    match text_from_pieces(total, cap, &pieces) {
        Some(read) => Ok(vec![Some(read)]),
        None => read_ora_text_walk(p, col, from, binds, cap).await,
    }
}

/// A CLOB / NCLOB read one piece per statement, each starting where the last one ended. A piece that ends inside a
/// surrogate pair comes back without its first half (the server drops it), so the next piece starts on that half.
/// Used when [`read_ora_lob`] cannot read the text in one statement.
async fn read_ora_text_walk(
    p: &OraPool,
    col: &str,
    from: &str,
    binds: &[Bind],
    cap: usize,
) -> Result<Vec<Option<Read>>> {
    let sql = format!(
        "select x.len, dbms_lob.substr(x.v, {ORA_TEXT_PIECE}, c.off) \
         from (select {col} v, dbms_lob.getlength({col}) len {from}) x, (select :{} off from dual) c",
        binds.len() + 1
    );
    let mut pieces: Vec<String> = Vec::new();
    let mut units = 0u64;
    let total = loop {
        let mut params = ora_binds(binds);
        params.push(OraBind::Int(units as i64 + 1));
        let rows = p.query_binds(&sql, &params).await?;
        let Some(first) = rows.first() else {
            return Ok(Vec::new());
        };
        let Some(total) = ora_len(first.first().cloned().flatten())? else {
            return Ok(vec![None]);
        };
        let piece = first.get(1).cloned().flatten().unwrap_or_default();
        if piece.is_empty() {
            break total;
        }
        units += utf16_units(&piece);
        pieces.push(piece);
        if units >= total.min(cap as u64) {
            break total;
        }
    };
    match text_from_pieces(total, cap, &pieces) {
        Some(read) => Ok(vec![Some(read)]),
        None => Err(DbError::NotFound(
            "The value changed while it was read".into(),
        )),
    }
}

impl ConnectionManager {
    /// The value of `column` of the row whose primary key is `keys` (column -> value), read in full up to
    /// `max_bytes` (`0`, or more than [`MAX_CELL_BYTES`], means the cap). The result says when the value is longer.
    /// Reads the pool, not a session: rows changed in an open transaction of a session are not seen.
    pub async fn fetch_cell(
        &self,
        ds_id: &str,
        table: &ObjectRef,
        keys: &BTreeMap<String, Value>,
        column: &str,
        max_bytes: u64,
    ) -> Result<CellContent> {
        let live = self.live(ds_id)?;
        fetch_cell_with(&live, table, keys, column, cap_for(max_bytes)).await
    }
}

async fn fetch_cell_with(
    live: &Live,
    table: &ObjectRef,
    keys: &BTreeMap<String, Value>,
    column: &str,
    cap: usize,
) -> Result<CellContent> {
    let d = live.driver();
    let schema = table.schema.as_deref();
    let info = table_columns(live, schema, &table.name).await?;
    let col = info
        .iter()
        .find(|c| c.name == column)
        .ok_or_else(|| DbError::InvalidArgument(format!("Unknown column '{column}'")))?;
    check_key(&info, keys)?;
    let binary = is_binary(d, col);

    let q = qualified(d, schema, &table.name);
    // the predicate of an edit of this row (the key is the primary key, so no LIMIT / ROWNUM is needed)
    let mut binds = Vec::new();
    let pred = key_predicate(d, &info, keys, &mut binds)?;
    let from = format!("from {q} where {pred}");
    let col_q = quote_ident(d, column);

    let reads = match &live.pool {
        Pool::Pg(p) => read_pg(p, &col_q, &from, &binds, binary, cap).await?,
        Pool::My(p) => read_my(p, &col_q, &from, &binds, binary, cap).await?,
        Pool::Lite(p) => read_lite(p, &col_q, &from, &binds, cap).await?,
        Pool::Ora(p) if matches!(col.base_type.as_str(), "BLOB" | "CLOB" | "NCLOB") => {
            read_ora_lob(p, &col_q, &from, &binds, binary, cap).await?
        }
        Pool::Ora(p) => read_ora(p, &col_q, &from, &binds, binary).await?,
    };
    match reads.into_iter().next() {
        None => Err(DbError::NotFound(
            "The row no longer exists: it was changed or deleted by someone else".into(),
        )),
        Some(None) => Err(DbError::InvalidArgument("The value is NULL".into())),
        Some(Some(read)) => Ok(content(read, cap)),
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (RFC 4648).
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn b64_value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decodes standard base64 with padding; `None` for anything else (length, alphabet, misplaced `=`).
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let quads = bytes.len() / 4;
    for (i, quad) in bytes.chunks(4).enumerate() {
        let pad = quad.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && i + 1 != quads) {
            return None;
        }
        let mut n = 0u32;
        for &c in &quad[..4 - pad] {
            n = (n << 6) | b64_value(c)?;
        }
        n <<= 6 * pad as u32;
        let full = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&full[..3 - pad]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base64_matches_rfc4648() {
        let cases = [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ];
        for (raw, enc) in cases {
            assert_eq!(base64_encode(raw.as_bytes()), enc);
            assert_eq!(base64_decode(enc).unwrap(), raw.as_bytes());
        }
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(base64_decode(&base64_encode(&all)).unwrap(), all);
        for bad in ["Zg=", "Z===", "Zm=v", "Zm9v====", "Zm9*", "Zg==Zg=="] {
            assert!(base64_decode(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn cap_is_the_request_within_the_limit() {
        assert_eq!(cap_for(0), MAX_CELL_BYTES as usize);
        assert_eq!(cap_for(100), 100);
        assert_eq!(cap_for(u64::MAX), MAX_CELL_BYTES as usize);
    }

    #[test]
    fn binary_is_cut_to_the_cap_and_says_so() {
        let c = content(
            Read {
                binary: true,
                len: 5,
                bytes: vec![1, 2, 3, 4, 5],
            },
            3,
        );
        assert_eq!(c.kind, CellKind::Binary);
        assert_eq!(c.base64.as_deref(), Some("AQID"));
        assert_eq!((c.len, c.truncated), (5, true));
        let whole = content(
            Read {
                binary: true,
                len: 3,
                bytes: vec![1, 2, 3],
            },
            3,
        );
        assert!(!whole.truncated);
    }

    #[test]
    fn text_is_cut_before_a_character() {
        // "é" is two bytes: a cut at byte 1 must drop it
        let read = || Read {
            binary: false,
            len: 4,
            bytes: "aéb".as_bytes().to_vec(),
        };
        let c = content(read(), 2);
        assert_eq!(c.text.as_deref(), Some("a"));
        assert!(c.truncated);
        assert_eq!(content(read(), 3).text.as_deref(), Some("aé"));
        let whole = content(read(), 10);
        assert_eq!(whole.text.as_deref(), Some("aéb"));
        assert!(!whole.truncated);
        assert_eq!(whole.base64, None);
    }

    #[test]
    fn utf16_units_count_a_character_outside_the_bmp_as_two() {
        assert_eq!(utf16_units("aé€😀"), 5);
        assert_eq!(utf16_units(""), 0);
    }

    #[test]
    fn oracle_lengths_are_numbers_or_null() {
        assert_eq!(ora_len(Some("42".into())).unwrap(), Some(42));
        assert_eq!(ora_len(None).unwrap(), None);
        assert!(ora_len(Some("4x".into())).is_err());
    }

    #[test]
    fn text_pieces_must_cover_the_cap_or_the_whole_value() {
        let pieces = |v: &[&str]| -> Vec<String> { v.iter().map(|s| s.to_string()).collect() };
        // whole: the size is the UTF-8 size ("a" 1 byte, "é" 2, "€" 3)
        let whole = text_from_pieces(3, 10, &pieces(&["aé", "€"])).unwrap();
        assert_eq!((whole.len, whole.bytes.as_slice()), (6, "aé€".as_bytes()));
        assert!(!content(whole, 10).truncated);
        // cut: the pieces cover the cap, the size is the units of the whole value
        let cut = text_from_pieces(6, 3, &pieces(&["aé", "€"])).unwrap();
        assert_eq!(cut.len, 6);
        let c = content(cut, 3);
        assert_eq!(
            (c.text.as_deref(), c.truncated),
            (Some("aé"), true),
            "3 bytes: '€' does not fit"
        );
        // a piece that ends inside a pair is not covered: the caller reads piece by piece
        assert!(text_from_pieces(6, 3, &pieces(&["aé"])).is_none());
        assert!(text_from_pieces(2, 2, &pieces(&["a"])).is_none());
        // an empty value is whole
        let empty = text_from_pieces(0, 3, &[]).unwrap();
        assert_eq!((empty.len, empty.bytes.len()), (0, 0));
    }

    #[test]
    fn primary_key_must_be_named_exactly() {
        let col = |name: &str, pk: bool| ColInfo {
            name: name.into(),
            type_name: "int".into(),
            nullable: false,
            is_pk: pk,
            pk_pos: 0,
            default: None,
            generated: false,
            base_type: "int".into(),
        };
        let info = vec![col("id", true), col("b", false)];
        let mut keys = BTreeMap::new();
        assert!(check_key(&info, &keys).is_err(), "no key value");
        keys.insert("id".to_string(), json!(1));
        assert!(check_key(&info, &keys).is_ok());
        keys.insert("b".to_string(), json!(2));
        assert!(check_key(&info, &keys).is_err(), "not a key column");
        keys.remove("b");
        keys.insert(
            "id".to_string(),
            json!({"$bin": "00", "len": 9, "truncated": true}),
        );
        assert!(check_key(&info, &keys).is_err(), "cut-off preview");
        let no_pk = vec![col("id", false)];
        assert!(check_key(&no_pk, &BTreeMap::new()).is_err());
    }
}
