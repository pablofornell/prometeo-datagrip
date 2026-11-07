//! Import of delimited text files (CSV / TSV / custom delimiter) into a table.
//!
//! The file is streamed (never loaded whole): [`RecordReader`] parses records out of a rolling buffer, so memory
//! stays flat for any file size. [`preview`] reads the first rows and infers a column type from a sample;
//! [`ConnectionManager::import_file`] converts each row to the type of its target column, inserts the rows in
//! multi-row `INSERT`s of a single transaction (each batch in a savepoint, so one bad row does not lose the batch)
//! and reports the rows that failed. Values are embedded as SQL literals after conversion (numbers are re-printed
//! from their parsed form, text is quoted), so the server coerces `'12'` into an `integer` column the way
//! `INSERT ... VALUES ('12')` always does.

use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
pub use tokio_util::sync::CancellationToken;

use crate::conn::Conn;
use crate::error::{DbError, Result};
use crate::exec::open_stream;
use crate::fsutil;
use crate::manager::{cancel_target_of, interrupt, ConnectionManager};
use crate::model::Driver;
use crate::quote::{oracle_text_literal, parse_oracle_ts, qualified, quote_ident, quote_literal};

/// Rows examined to infer the type of each column.
pub const INFER_SAMPLE_ROWS: usize = 1000;
/// Errors kept in the [`ImportResult`] (the error file gets all of them).
const MAX_REPORTED_ERRORS: usize = 50;
/// A record longer than this means an unbalanced quote.
const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;

// ---------------------------------------------------------------- format

/// How to read the file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportFormat {
    /// `UTF-8` (default), `ISO-8859-1` or `US-ASCII`.
    pub encoding: String,
    /// Field separator (one or more characters).
    pub delimiter: String,
    /// Quote character; empty = fields are never quoted.
    pub quote: String,
    /// The first record holds the column names.
    pub header: bool,
    /// The first column holds row labels: it is dropped from every record.
    pub first_column_header: bool,
    /// Trim whitespace around every value.
    pub trim: bool,
    /// An unquoted value equal to this text is NULL (the empty default makes empty cells NULL).
    pub null_text: String,
}

impl Default for ImportFormat {
    fn default() -> Self {
        ImportFormat {
            encoding: "UTF-8".into(),
            delimiter: ",".into(),
            quote: "\"".into(),
            header: true,
            first_column_header: false,
            trim: false,
            null_text: String::new(),
        }
    }
}

// ---------------------------------------------------------------- streaming reader

/// Latin-1 bytes to UTF-8 on the fly.
struct Latin1<R> {
    inner: R,
    pending: Vec<u8>,
    pos: usize,
}

impl<R: Read> Read for Latin1<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.pending.len() {
            let mut tmp = [0u8; 8192];
            let n = self.inner.read(&mut tmp)?;
            if n == 0 {
                return Ok(0);
            }
            self.pending.clear();
            self.pos = 0;
            for &b in &tmp[..n] {
                let mut e = [0u8; 4];
                self.pending
                    .extend_from_slice((b as char).encode_utf8(&mut e).as_bytes());
            }
        }
        let n = out.len().min(self.pending.len() - self.pos);
        out[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// One field as it appeared in the file.
struct RawField {
    bytes: Vec<u8>,
    quoted: bool,
}

enum Parsed {
    Record(Vec<RawField>, usize),
    NeedMore,
    End,
}

/// Splits a byte stream into records of fields: quoted fields may contain the delimiter, line breaks and doubled
/// quotes; records end at `\n`, `\r\n` or `\r`.
pub struct RecordReader<R: Read> {
    src: R,
    buf: Vec<u8>,
    pos: usize,
    eof: bool,
    started: bool,
    /// Bytes handed to the parser so far (progress).
    fed: u64,
    delim: Vec<u8>,
    quote: Option<u8>,
    /// Checked before every read, so a huge file can be cancelled while it is scanned.
    cancel: Option<CancellationToken>,
}

impl<R: Read> RecordReader<R> {
    pub fn new(src: R, fmt: &ImportFormat) -> Result<Self> {
        if fmt.delimiter.is_empty() {
            return Err(DbError::InvalidArgument("The delimiter is empty".into()));
        }
        let quote = match fmt.quote.as_bytes() {
            [] => None,
            [q] if q.is_ascii() => Some(*q),
            _ => {
                return Err(DbError::InvalidArgument(
                    "The quote character must be a single ASCII character".into(),
                ))
            }
        };
        let delim = fmt.delimiter.as_bytes().to_vec();
        if delim.len() == 1 && (delim[0] == b'\n' || delim[0] == b'\r' || Some(delim[0]) == quote) {
            return Err(DbError::InvalidArgument(
                "The delimiter cannot be a line break or the quote character".into(),
            ));
        }
        Ok(RecordReader {
            src,
            buf: Vec::new(),
            pos: 0,
            eof: false,
            started: false,
            fed: 0,
            delim,
            quote,
            cancel: None,
        })
    }

    /// Makes reading fail with [`DbError::Cancelled`] once `token` is cancelled.
    pub fn set_cancel(&mut self, token: CancellationToken) {
        self.cancel = Some(token);
    }

    /// Bytes read from the source and already consumed by returned records.
    pub fn consumed(&self) -> u64 {
        self.fed - (self.buf.len() - self.pos) as u64
    }

    fn fill(&mut self) -> Result<()> {
        if self.cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
            return Err(DbError::Cancelled);
        }
        if self.pos > 0 && self.pos == self.buf.len() {
            self.buf.clear();
            self.pos = 0;
        } else if self.pos > 1 << 20 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        let at = self.buf.len();
        self.buf.resize(at + 64 * 1024, 0);
        let n = loop {
            match self.src.read(&mut self.buf[at..]) {
                Ok(n) => break n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            }
        };
        self.buf.truncate(at + n);
        self.fed += n as u64;
        if n == 0 {
            self.eof = true;
        }
        if !self.started && (self.buf.len() >= 3 || self.eof) {
            self.started = true;
            if self.buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
                self.pos = 3;
            }
        }
        Ok(())
    }

    /// The next record, `None` at the end of the file. A record that is just a line break is returned as one
    /// empty unquoted field (the caller skips blank lines).
    fn next_record(&mut self) -> Result<Option<Vec<RawField>>> {
        loop {
            if !self.started {
                self.fill()?;
                continue;
            }
            match self.try_parse() {
                Parsed::Record(fields, used) => {
                    self.pos += used;
                    return Ok(Some(fields));
                }
                Parsed::End => return Ok(None),
                Parsed::NeedMore => {
                    let have = self.buf.len() - self.pos;
                    if have > MAX_RECORD_BYTES {
                        return Err(DbError::InvalidArgument(
                            "A record is longer than 64 MB: is a quote character unbalanced?"
                                .into(),
                        ));
                    }
                    // The record is parsed again from its start after every read: read until the part
                    // buffered doubles (not one chunk at a time), so the total work stays linear in
                    // the size of the record instead of quadratic.
                    let target = (have * 2).clamp(have + 1, MAX_RECORD_BYTES + 1);
                    loop {
                        self.fill()?;
                        if self.eof || self.buf.len() - self.pos >= target {
                            break;
                        }
                    }
                }
            }
        }
    }

    fn try_parse(&self) -> Parsed {
        let input = &self.buf[self.pos..];
        let eof = self.eof;
        let d = &self.delim[..];
        let mut fields: Vec<RawField> = Vec::new();
        let mut cur: Vec<u8> = Vec::new();
        let mut quoted = false;
        let mut in_quote = false;
        let mut i = 0;
        loop {
            if i >= input.len() {
                if !eof {
                    return Parsed::NeedMore;
                }
                if input.is_empty() {
                    return Parsed::End;
                }
                fields.push(RawField { bytes: cur, quoted });
                return Parsed::Record(fields, i);
            }
            let b = input[i];
            if in_quote {
                if Some(b) == self.quote {
                    if i + 1 >= input.len() && !eof {
                        return Parsed::NeedMore;
                    }
                    if input.get(i + 1) == Some(&b) {
                        cur.push(b);
                        i += 2;
                    } else {
                        in_quote = false;
                        i += 1;
                    }
                } else {
                    cur.push(b);
                    i += 1;
                }
                continue;
            }
            if Some(b) == self.quote && cur.is_empty() && !quoted {
                in_quote = true;
                quoted = true;
                i += 1;
            } else if input[i..].starts_with(d) {
                fields.push(RawField {
                    bytes: std::mem::take(&mut cur),
                    quoted,
                });
                quoted = false;
                i += d.len();
            } else if !eof && input.len() - i < d.len() && d.starts_with(&input[i..]) {
                return Parsed::NeedMore;
            } else if b == b'\n' || b == b'\r' {
                let mut used = i + 1;
                if b == b'\r' {
                    if i + 1 >= input.len() && !eof {
                        return Parsed::NeedMore;
                    }
                    if input.get(i + 1) == Some(&b'\n') {
                        used += 1;
                    }
                }
                fields.push(RawField { bytes: cur, quoted });
                return Parsed::Record(fields, used);
            } else {
                cur.push(b);
                i += 1;
            }
        }
    }
}

// ---------------------------------------------------------------- source (header + rows)

/// A file opened for reading: column names and a row iterator.
pub struct Source {
    reader: RecordReader<Box<dyn Read + Send>>,
    fmt: ImportFormat,
    pub columns: Vec<String>,
    /// Record number of the last record read (1 = first line of the file).
    record_no: u64,
    /// The first data record, read while looking for the width of a file without header.
    first: Option<(u64, Vec<Option<String>>)>,
    pub size: u64,
}

impl Source {
    /// Makes reading rows fail with [`DbError::Cancelled`] once `token` is cancelled.
    pub fn set_cancel(&mut self, token: CancellationToken) {
        self.reader.set_cancel(token);
    }

    pub fn open(path: &Path, fmt: &ImportFormat) -> Result<Source> {
        let file = File::open(path).map_err(|e| {
            DbError::InvalidArgument(format!("Cannot read {}: {e}", path.display()))
        })?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let src: Box<dyn Read + Send> = match fmt.encoding.to_ascii_uppercase().as_str() {
            "UTF-8" | "UTF8" | "US-ASCII" | "ASCII" => Box::new(file),
            "ISO-8859-1" | "LATIN1" | "LATIN-1" => Box::new(Latin1 {
                inner: file,
                pending: Vec::new(),
                pos: 0,
            }),
            other => {
                return Err(DbError::InvalidArgument(format!(
                    "Unsupported encoding '{other}' (use UTF-8 or ISO-8859-1)"
                )))
            }
        };
        let mut s = Source {
            reader: RecordReader::new(src, fmt)?,
            fmt: fmt.clone(),
            columns: Vec::new(),
            record_no: 0,
            first: None,
            size,
        };
        let head = s.read_row()?;
        match head {
            None => {}
            Some((no, row)) if fmt.header => {
                let _ = no;
                s.columns =
                    header_names(row.iter().map(|v| v.clone().unwrap_or_default()).collect());
            }
            Some((no, row)) => {
                s.columns = (1..=row.len()).map(|i| format!("column{i}")).collect();
                s.first = Some((no, row));
            }
        }
        Ok(s)
    }

    fn read_row(&mut self) -> Result<Option<(u64, Vec<Option<String>>)>> {
        loop {
            let Some(fields) = self.reader.next_record()? else {
                return Ok(None);
            };
            self.record_no += 1;
            if fields.len() == 1 && fields[0].bytes.is_empty() && !fields[0].quoted {
                continue; // blank line
            }
            let mut row: Vec<Option<String>> = Vec::with_capacity(fields.len());
            for f in fields {
                let mut s = String::from_utf8_lossy(&f.bytes).into_owned();
                if self.fmt.trim {
                    s = s.trim().to_string();
                }
                row.push(if !f.quoted && s == self.fmt.null_text {
                    None
                } else {
                    Some(s)
                });
            }
            if self.fmt.first_column_header && !row.is_empty() {
                row.remove(0);
            }
            return Ok(Some((self.record_no, row)));
        }
    }

    /// The next data row with its record number (the first line of the file is record 1).
    pub fn next_row(&mut self) -> Result<Option<(u64, Vec<Option<String>>)>> {
        if let Some(r) = self.first.take() {
            return Ok(Some(r));
        }
        self.read_row()
    }

    /// Fraction of the file consumed, 0..=1.
    pub fn fraction(&self) -> f64 {
        if self.size == 0 {
            return 1.0;
        }
        (self.reader.consumed() as f64 / self.size as f64).min(1.0)
    }
}

/// Column names: blank ones become `columnN`, repeated ones get `_2`, `_3` ...
fn header_names(raw: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for (i, n) in raw.into_iter().enumerate() {
        let base = if n.trim().is_empty() {
            format!("column{}", i + 1)
        } else {
            n.trim().to_string()
        };
        let mut name = base.clone();
        let mut k = 2;
        while out.iter().any(|o| o.eq_ignore_ascii_case(&name)) {
            name = format!("{base}_{k}");
            k += 1;
        }
        out.push(name);
    }
    out
}

// ---------------------------------------------------------------- type inference

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InferredType {
    Boolean,
    Integer,
    Bigint,
    Double,
    Date,
    Timestamp,
    Text,
}

/// The SQL type to create a column of an inferred type with.
pub fn sql_type(d: Driver, t: InferredType) -> &'static str {
    use InferredType::*;
    match (d, t) {
        (Driver::Oracle, Integer) => "number(10)",
        (Driver::Oracle, Bigint) => "number(19)",
        (_, Integer) => "integer",
        (_, Bigint) => "bigint",
        (Driver::Oracle, Boolean) => "number(1)",
        (_, Boolean) => "boolean",
        (_, Date) => "date",
        (Driver::Oracle, Text) => "varchar2(4000)",
        (_, Text) => "text",
        (Driver::Postgres, Double) => "double precision",
        (Driver::Oracle, Double) => "binary_double",
        (_, Double) => "double",
        (Driver::MySql | Driver::Sqlite, Timestamp) => "datetime",
        (Driver::Postgres | Driver::Oracle, Timestamp) => "timestamp",
    }
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn no_leading_zero(s: &str) -> bool {
    let u = s.strip_prefix('-').unwrap_or(s);
    u.len() == 1
        || !u.starts_with('0')
        || u.starts_with("0.")
        || u.starts_with("0e")
        || u.starts_with("0E")
}

fn is_int(s: &str) -> bool {
    let u = s.strip_prefix('-').unwrap_or(s);
    digits(u) && no_leading_zero(s) && s.parse::<i128>().is_ok()
}

fn is_double(s: &str) -> bool {
    if s.starts_with('+') || !s.bytes().any(|b| b.is_ascii_digit()) || !no_leading_zero(s) {
        return false;
    }
    s.parse::<f64>().is_ok_and(f64::is_finite)
}

fn is_bool_text(s: &str) -> bool {
    s.eq_ignore_ascii_case("true") || s.eq_ignore_ascii_case("false")
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (y, m, d) = (&s[0..4], &s[5..7], &s[8..10]);
    if !digits(y) || !digits(m) || !digits(d) {
        return false;
    }
    let (y, m, d): (u32, u32, u32) = (y.parse().unwrap(), m.parse().unwrap(), d.parse().unwrap());
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let max = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max).contains(&d)
}

/// `YYYY-MM-DD[ T]HH:MM[:SS[.fraction]][Z|+HH[:MM]|-HH[:MM]]`
fn is_timestamp(s: &str) -> bool {
    if s.len() < 16 || !is_date(&s[..10]) || !matches!(s.as_bytes()[10], b' ' | b'T') {
        return false;
    }
    let t = &s[11..];
    let (clock, zone) = match t.find(['Z', '+', '-']) {
        Some(i) => (&t[..i], &t[i..]),
        None => (t, ""),
    };
    let mut parts = clock.split(':');
    let (Some(h), Some(m)) = (parts.next(), parts.next()) else {
        return false;
    };
    let sec = parts.next();
    if parts.next().is_some() {
        return false;
    }
    let ok2 = |x: &str, max: u32| x.len() == 2 && digits(x) && x.parse::<u32>().unwrap() <= max;
    if !ok2(h, 23) || !ok2(m, 59) {
        return false;
    }
    if let Some(sec) = sec {
        let (whole, frac) = sec
            .split_once('.')
            .map_or((sec, None), |(a, b)| (a, Some(b)));
        if !ok2(whole, 60) || frac.is_some_and(|f| !digits(f) || f.len() > 9) {
            return false;
        }
    }
    match zone {
        "" | "Z" => true,
        z => {
            let r = &z[1..];
            let (hh, mm) = r.split_once(':').unwrap_or((r, "00"));
            z.starts_with(['+', '-']) && ok2(hh, 23) && ok2(mm, 59)
        }
    }
}

/// Collects the values of one column and decides the narrowest type that holds all of them.
#[derive(Debug, Clone)]
struct Infer {
    seen: bool,
    boolean: bool,
    int: bool,
    big: bool,
    double: bool,
    date: bool,
    ts: bool,
}

impl Infer {
    fn new() -> Self {
        Infer {
            seen: false,
            boolean: true,
            int: true,
            big: false,
            double: true,
            date: true,
            ts: true,
        }
    }

    fn add(&mut self, v: &str) {
        let v = v.trim();
        if v.is_empty() {
            return;
        }
        self.seen = true;
        self.boolean &= is_bool_text(v);
        let int = is_int(v);
        self.int &= int;
        if int && v.parse::<i64>().map_or(true, |n| i32::try_from(n).is_err()) {
            self.big = true;
        }
        self.double &= int || is_double(v);
        let date = is_date(v);
        self.date &= date;
        self.ts &= date || is_timestamp(v);
    }

    fn result(&self) -> InferredType {
        if !self.seen {
            InferredType::Text
        } else if self.boolean {
            InferredType::Boolean
        } else if self.int {
            if self.big {
                InferredType::Bigint
            } else {
                InferredType::Integer
            }
        } else if self.double {
            InferredType::Double
        } else if self.date {
            InferredType::Date
        } else if self.ts {
            InferredType::Timestamp
        } else {
            InferredType::Text
        }
    }
}

// ---------------------------------------------------------------- preview

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewColumn {
    pub name: String,
    pub inferred_type: InferredType,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub columns: Vec<PreviewColumn>,
    /// The first `limit` rows (`null` = NULL).
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows the column types were inferred from.
    pub sampled: usize,
    /// The file has more rows than were sampled.
    pub truncated: bool,
    pub file_size: u64,
}

/// Reads the head of a file: column names, the first `limit` rows and a type for every column inferred from the
/// first [`INFER_SAMPLE_ROWS`] rows.
pub fn preview(path: &Path, fmt: &ImportFormat, limit: usize) -> Result<ImportPreview> {
    let mut src = Source::open(path, fmt)?;
    let width = src.columns.len();
    let mut infer = vec![Infer::new(); width];
    let mut rows = Vec::new();
    let mut sampled = 0usize;
    let mut truncated = false;
    while let Some((_, mut row)) = src.next_row()? {
        if sampled >= INFER_SAMPLE_ROWS {
            truncated = true;
            break;
        }
        sampled += 1;
        row.resize(width, None);
        for (i, v) in row.iter().enumerate() {
            if let Some(v) = v {
                infer[i].add(v);
            }
        }
        if rows.len() < limit {
            rows.push(row);
        }
    }
    Ok(ImportPreview {
        columns: src
            .columns
            .iter()
            .zip(&infer)
            .map(|(n, i)| PreviewColumn {
                name: n.clone(),
                inferred_type: i.result(),
            })
            .collect(),
        rows,
        sampled,
        truncated,
        file_size: src.size,
    })
}

// ---------------------------------------------------------------- conversion to SQL literals

/// What the server will store a value as; decides how a text value is checked and written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Bool,
    Int,
    Float,
    Date,
    Timestamp,
    Text,
}

/// The category of a column from its declared type name (`integer`, `int4`, `numeric(10,2)`, `tinyint(1)` ...).
pub fn category(type_name: &str) -> Category {
    let t = type_name.trim().to_ascii_lowercase();
    if t == "bool"
        || t == "boolean"
        || t.starts_with("tinyint(1)")
        || t == "number(1)"
        || t == "number(1,0)"
    {
        return Category::Bool;
    }
    // exact names only: `point`, `int4range` or the arrays `integer[]` / `int4[]` are text
    let base = t.split(['(', ' ']).next().unwrap_or("");
    if matches!(
        base,
        "int"
            | "int2"
            | "int4"
            | "int8"
            | "integer"
            | "smallint"
            | "mediumint"
            | "bigint"
            | "tinyint"
            | "serial"
            | "serial2"
            | "serial4"
            | "serial8"
            | "smallserial"
            | "bigserial"
    ) || t.starts_with("unsigned big int")
    {
        Category::Int
    } else if matches!(
        base,
        "numeric"
            | "decimal"
            | "dec"
            | "real"
            | "float"
            | "float4"
            | "float8"
            | "double"
            | "number"
            | "binary_double"
            | "binary_float"
    ) {
        Category::Float
    } else if base == "date" {
        Category::Date
    } else if base == "timestamp" || base == "datetime" || base == "timestamptz" {
        Category::Timestamp
    } else {
        Category::Text
    }
}

fn type_label(c: Category) -> &'static str {
    match c {
        Category::Bool => "boolean",
        Category::Int => "integer",
        Category::Float => "number",
        Category::Date => "date",
        Category::Timestamp => "timestamp",
        Category::Text => "text",
    }
}

/// The SQL literal of `v` for a column of category `cat`, or why it does not fit. Empty values are NULL in every
/// category but text.
fn to_literal(d: Driver, cat: Category, v: Option<&str>) -> std::result::Result<String, String> {
    let Some(v) = v else {
        return Ok("NULL".into());
    };
    if cat == Category::Text {
        if v.contains('\0') && d != Driver::MySql {
            return Err(format!(
                "'{}' contains a NUL character, which {} cannot store in text",
                clip(&v.replace('\0', "\\0")),
                match d {
                    Driver::Postgres => "PostgreSQL",
                    Driver::Oracle => "Oracle",
                    _ => "SQLite",
                }
            ));
        }
        return Ok(if d == Driver::Oracle {
            oracle_text_literal(v)
        } else {
            quote_literal(d, v)
        });
    }
    let t = v.trim();
    if t.is_empty() {
        return Ok("NULL".into());
    }
    let bad = || Err(format!("'{}' is not a valid {}", clip(v), type_label(cat)));
    match cat {
        Category::Int => match t.parse::<i128>() {
            Ok(n) => Ok(n.to_string()),
            Err(_) => bad(),
        },
        Category::Float => {
            if t.parse::<f64>().is_ok_and(f64::is_finite) && t.bytes().any(|b| b.is_ascii_digit()) {
                Ok(t.to_string())
            } else {
                bad()
            }
        }
        Category::Bool => {
            let truth = match t.to_ascii_lowercase().as_str() {
                "true" | "t" | "yes" | "y" | "1" | "on" => true,
                "false" | "f" | "no" | "n" | "0" | "off" => false,
                _ => return bad(),
            };
            Ok(match (d, truth) {
                (Driver::Postgres, true) => "true".into(),
                (Driver::Postgres, false) => "false".into(),
                (_, true) => "1".into(),
                (_, false) => "0".into(),
            })
        }
        // an Oracle DATE also holds a time of day; the texts are converted with fixed formats, whatever NLS says
        Category::Date if d == Driver::Oracle => {
            match (is_date(t) || is_timestamp(t), parse_oracle_ts(t)) {
                (true, Some(ts)) => Ok(format!(
                    "TO_DATE('{}', 'YYYY-MM-DD HH24:MI:SS')",
                    ts.date_text()
                )),
                _ => bad(),
            }
        }
        Category::Timestamp if d == Driver::Oracle => {
            match (is_date(t) || is_timestamp(t), parse_oracle_ts(t)) {
                (true, Some(ts)) if ts.tz.is_some() => Ok(format!(
                    "TO_TIMESTAMP_TZ('{}', '{}')",
                    ts.timestamp_tz_text(),
                    ts.tz_format()
                )),
                (true, Some(ts)) => Ok(format!(
                    "TO_TIMESTAMP('{}', 'YYYY-MM-DD HH24:MI:SS.FF9')",
                    ts.timestamp_text()
                )),
                _ => bad(),
            }
        }
        Category::Date => {
            if is_date(t) {
                Ok(quote_literal(d, t))
            } else {
                bad()
            }
        }
        Category::Timestamp => {
            if is_date(t) || is_timestamp(t) {
                Ok(quote_literal(d, t))
            } else {
                bad()
            }
        }
        Category::Text => unreachable!(),
    }
}

fn clip(s: &str) -> String {
    if s.chars().count() > 40 {
        format!("{}…", s.chars().take(40).collect::<String>())
    } else {
        s.to_string()
    }
}

// ---------------------------------------------------------------- request / result

/// One column of the target table.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumn {
    /// Column name in the target table.
    pub name: String,
    /// Index of the file column (after the first-column-header drop); `null` leaves the column to its default.
    pub source: Option<usize>,
    /// Declared type: the type to create a new column with, the real one of an existing table (decides how a
    /// value is checked and written).
    #[serde(rename = "type")]
    pub type_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOptions {
    /// A value that does not fit its column becomes NULL instead of failing the row.
    pub insert_inconvertible_as_null: bool,
    /// The first failing row rolls everything back (default: failing rows are skipped and reported).
    pub abort_on_error: bool,
    /// Where to write the failing rows; nothing is written when no row fails.
    pub error_file: Option<PathBuf>,
    /// `error_file` is a place the user picked in a save dialog (which asked before replacing): an existing file
    /// is replaced. Otherwise an existing file is never touched: the rows go to `name-2.ext`, `name-3.ext`...
    /// Set by the backend only, never read from the request.
    #[serde(skip)]
    pub error_file_replace: bool,
    /// Rows per `INSERT` (default 500).
    pub batch_size: usize,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions {
            insert_inconvertible_as_null: false,
            abort_on_error: false,
            error_file: None,
            error_file_replace: false,
            batch_size: 500,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub path: PathBuf,
    #[serde(default)]
    pub format: ImportFormat,
    pub schema: Option<String>,
    pub table: String,
    /// Create the table first (`create table` with the `columns`).
    pub create_table: bool,
    pub columns: Vec<ImportColumn>,
    #[serde(default)]
    pub options: ImportOptions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowError {
    /// Record number in the file (the first line is 1, the header counts).
    pub row: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// Rows processed so far (inserted + failed).
    pub rows: u64,
    pub failed: u64,
    /// Share of the file read, 0..=1.
    pub fraction: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Rows inserted and committed.
    pub imported: u64,
    /// Rows that did not fit (skipped, or the reason for the rollback).
    pub failed: u64,
    /// The first failing rows; the error file has all of them.
    pub errors: Vec<ImportRowError>,
    pub error_file: Option<String>,
    /// Why the error file could not be written.
    pub error_file_error: Option<String>,
    pub cancelled: bool,
    /// Nothing was kept: cancelled, or `abortOnError` hit a failing row.
    pub rolled_back: bool,
    pub created_table: bool,
    pub elapsed_ms: u64,
}

/// `create table "schema"."name" (...)`; the types come from the caller, so only plain type syntax is accepted.
pub fn create_table_sql(
    d: Driver,
    schema: Option<&str>,
    table: &str,
    cols: &[(&str, &str)],
) -> Result<String> {
    let mut lines = Vec::with_capacity(cols.len());
    for (name, ty) in cols {
        let ty = ty.trim();
        if ty.is_empty()
            || !ty.chars().all(|c| {
                c.is_alphanumeric()
                    || matches!(c, ' ' | '_' | '(' | ')' | ',' | '.' | '[' | ']' | '"')
            })
        {
            return Err(DbError::InvalidArgument(format!(
                "Invalid type '{ty}' for column {name}"
            )));
        }
        lines.push(format!("    {} {}", quote_ident(d, name), ty));
    }
    Ok(format!(
        "create table {} (\n{}\n)",
        qualified(d, schema, table),
        lines.join(",\n")
    ))
}

// ---------------------------------------------------------------- the import

async fn run(conn: &mut Conn, sql: &str) -> Result<()> {
    let mut stream = open_stream(conn, sql);
    while let Some(item) = stream.next().await {
        item?;
    }
    Ok(())
}

/// Ends the import savepoint. Oracle has no `RELEASE SAVEPOINT`: the savepoint just stays, and the next
/// `SAVEPOINT` of the same name moves it.
async fn release(conn: &mut Conn, d: Driver, cancel: &CancellationToken) -> Result<()> {
    if d == Driver::Oracle {
        return Ok(());
    }
    run_c(conn, "release savepoint prometeo_import", cancel).await
}

/// `drop table if exists` (Oracle: an anonymous block that ignores the error, `IF EXISTS` is 23ai only).
fn drop_if_exists(d: Driver, table: &str) -> String {
    if d == Driver::Oracle {
        format!(
            "begin execute immediate {}; exception when others then null; end;",
            quote_literal(d, &format!("drop table {table} purge"))
        )
    } else {
        format!("drop table if exists {table}")
    }
}

/// [`run`], abandoned with [`DbError::Cancelled`] as soon as `cancel` fires (a statement blocked on a lock does
/// not return by itself). The connection is in an unknown state then: the caller interrupts the server and
/// closes it.
async fn run_c(conn: &mut Conn, sql: &str, cancel: &CancellationToken) -> Result<()> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(DbError::Cancelled),
        r = run(conn, sql) => r,
    }
}

/// How long closing an abandoned connection may take.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Writes the failing rows lazily (no file unless something fails).
struct ErrorLog {
    path: Option<PathBuf>,
    /// Replace an existing file at `path` (see [`ImportOptions::error_file_replace`]).
    replace: bool,
    /// Where the rows really went (`path`, or the free name next to it).
    written_to: Option<PathBuf>,
    out: Option<BufWriter<File>>,
    failed_to_open: Option<String>,
    first: Vec<ImportRowError>,
    count: u64,
}

impl ErrorLog {
    fn add(&mut self, row: u64, message: &str, values: &[Option<String>], delim: &str) {
        self.count += 1;
        if self.first.len() < MAX_REPORTED_ERRORS {
            self.first.push(ImportRowError {
                row,
                message: message.to_string(),
            });
        }
        if self.out.is_none() && self.failed_to_open.is_none() {
            if let Some(p) = &self.path {
                let opened = if self.replace {
                    fsutil::create_or_truncate_nofollow(p).map(|f| (f, p.clone()))
                } else {
                    fsutil::create_new_unique(p)
                };
                match opened {
                    Ok((f, at)) => {
                        self.out = Some(BufWriter::new(f));
                        self.written_to = Some(at);
                    }
                    Err(e) => {
                        self.failed_to_open = Some(format!("Cannot create {}: {e}", p.display()))
                    }
                }
            }
        }
        if let Some(w) = self.out.as_mut() {
            let vals: Vec<&str> = values.iter().map(|v| v.as_deref().unwrap_or("")).collect();
            let _ = writeln!(
                w,
                "row {row}: {}\t{}",
                message.replace('\n', " "),
                vals.join(delim)
            );
        }
    }

    fn finish(&mut self) {
        if let Some(w) = self.out.as_mut() {
            if let Err(e) = w.flush() {
                self.failed_to_open = Some(format!("Cannot write the error file: {e}"));
            }
        }
    }
}

struct Pending {
    row: u64,
    tuple: String,
    values: Vec<Option<String>>,
}

fn first_line(e: &DbError) -> String {
    e.to_string().lines().next().unwrap_or("").to_string()
}

impl ConnectionManager {
    /// Imports `req.path` into the table in ONE transaction on a connection of its own. Rows that fail (a value
    /// that does not fit its column, a constraint) are skipped and listed in the result and the error file, unless
    /// `abortOnError`. `cancel` rolls everything back. With `createTable` the table is created first and dropped
    /// again if nothing is kept. `progress` is called after every batch.
    pub async fn import_file(
        &self,
        ds_id: &str,
        req: &ImportRequest,
        cancel: &CancellationToken,
        progress: &(dyn Fn(ImportProgress) + Send + Sync),
    ) -> Result<ImportResult> {
        let started = Instant::now();
        let live = self.live(ds_id)?;
        let d = live.driver();
        if live.cfg.read_only {
            return Err(DbError::InvalidArgument(
                "The data source is read-only: the data cannot be imported".into(),
            ));
        }
        if req.table.trim().is_empty() {
            return Err(DbError::InvalidArgument("The table name is empty".into()));
        }
        if req.table.contains('\0')
            || req.schema.as_deref().is_some_and(|s| s.contains('\0'))
            || req.columns.iter().any(|c| c.name.contains('\0'))
        {
            return Err(DbError::InvalidArgument(
                "A name contains a NUL character".into(),
            ));
        }
        let active: Vec<&ImportColumn> =
            req.columns.iter().filter(|c| c.source.is_some()).collect();
        if active.is_empty() {
            return Err(DbError::InvalidArgument(
                "No column is mapped to a column of the file".into(),
            ));
        }
        for (i, c) in req.columns.iter().enumerate() {
            if c.name.trim().is_empty() {
                return Err(DbError::InvalidArgument(
                    "A column of the table has no name".into(),
                ));
            }
            if req.columns[..i]
                .iter()
                .any(|o| o.name.eq_ignore_ascii_case(&c.name))
            {
                return Err(DbError::InvalidArgument(format!(
                    "Column {} appears twice",
                    c.name
                )));
            }
        }
        let cats: Vec<Category> = active.iter().map(|c| category(&c.type_name)).collect();
        let create_sql = if req.create_table {
            let cols: Vec<(&str, &str)> = req
                .columns
                .iter()
                .map(|c| (c.name.as_str(), c.type_name.as_str()))
                .collect();
            Some(create_table_sql(
                d,
                req.schema.as_deref(),
                &req.table,
                &cols,
            )?)
        } else {
            None
        };
        let mut src = Source::open(&req.path, &req.format)?;
        src.set_cancel(cancel.clone());
        let width = src.columns.len();
        let table = qualified(d, req.schema.as_deref(), &req.table);
        // Oracle has no multi-row VALUES before 23ai: a batch is `insert .. select .. from dual union all select ..`
        let oracle = d == Driver::Oracle;
        let head = format!(
            "insert into {table} ({}) {}",
            active
                .iter()
                .map(|c| quote_ident(d, &c.name))
                .collect::<Vec<_>>()
                .join(", "),
            if oracle { "" } else { "values " }
        );
        let tuple_sep = if oracle { " union all " } else { ", " };
        let batch_rows = req
            .options
            .batch_size
            .clamp(1, if oracle { 200 } else { 5000 });

        let mut conn = live.new_conn().await?;
        let cancel_target = cancel_target_of(&mut conn).await?;
        let mut res = ImportResult::default();
        // MySQL and Oracle commit DDL at once, so the table is created before the transaction; PostgreSQL and SQLite
        // create it inside, where a rollback takes it away again
        let ddl_in_tx = !matches!(d, Driver::MySql | Driver::Oracle);
        if let (Some(sql), false) = (&create_sql, ddl_in_tx) {
            run(&mut conn, sql).await?;
            res.created_table = true;
        }
        let begin = match d {
            Driver::MySql => "start transaction",
            // a transaction starts with its first statement; this one only makes it explicit
            Driver::Oracle => "set transaction read write",
            _ => "begin",
        };
        let mut log = ErrorLog {
            path: req.options.error_file.clone(),
            replace: req.options.error_file_replace,
            written_to: None,
            out: None,
            failed_to_open: None,
            first: Vec::new(),
            count: 0,
        };
        let outcome = async {
            run_c(&mut conn, begin, cancel).await?;
            if let (Some(sql), true) = (&create_sql, ddl_in_tx) {
                run_c(&mut conn, sql, cancel).await?;
                res.created_table = true;
            }
            let mut batch: Vec<Pending> = Vec::new();
            let mut aborted = false;
            let mut ended = false;
            while !ended && !aborted {
                // ---- fill a batch
                batch.clear();
                let mut bytes = 0usize;
                while batch.len() < batch_rows && bytes < (1 << 20) {
                    let Some((no, row)) = src.next_row()? else {
                        ended = true;
                        break;
                    };
                    if row.len() > width {
                        log.add(
                            no,
                            &format!("Expected {width} columns, found {}", row.len()),
                            &row,
                            &req.format.delimiter,
                        );
                        res.failed += 1;
                        aborted |= req.options.abort_on_error;
                        if aborted {
                            break;
                        }
                        continue;
                    }
                    let mut parts = Vec::with_capacity(active.len());
                    let mut bad: Option<String> = None;
                    for (c, cat) in active.iter().zip(&cats) {
                        let v = c.source.and_then(|i| row.get(i)).and_then(|v| v.as_deref());
                        match to_literal(d, *cat, v) {
                            Ok(l) => parts.push(l),
                            Err(_) if req.options.insert_inconvertible_as_null => {
                                parts.push("NULL".into())
                            }
                            Err(m) => {
                                bad = Some(format!("Column {}: {m}", c.name));
                                break;
                            }
                        }
                    }
                    if let Some(m) = bad {
                        log.add(no, &m, &row, &req.format.delimiter);
                        res.failed += 1;
                        aborted |= req.options.abort_on_error;
                        if aborted {
                            break;
                        }
                        continue;
                    }
                    let tuple = if oracle {
                        format!("select {} from dual", parts.join(", "))
                    } else {
                        format!("({})", parts.join(", "))
                    };
                    bytes += tuple.len();
                    batch.push(Pending {
                        row: no,
                        tuple,
                        values: row,
                    });
                }
                if cancel.is_cancelled() {
                    res.cancelled = true;
                    return Ok::<(), DbError>(());
                }
                if aborted || batch.is_empty() {
                    break;
                }
                // ---- insert it: whole batch in a savepoint, row by row when it fails
                run_c(&mut conn, "savepoint prometeo_import", cancel).await?;
                let sql = format!(
                    "{head}{}",
                    batch
                        .iter()
                        .map(|p| p.tuple.as_str())
                        .collect::<Vec<_>>()
                        .join(tuple_sep)
                );
                match run_c(&mut conn, &sql, cancel).await {
                    Ok(()) => {
                        release(&mut conn, d, cancel).await?;
                        res.imported += batch.len() as u64;
                    }
                    Err(e) if e.is_connection_lost() || matches!(e, DbError::Cancelled) => {
                        return Err(e)
                    }
                    Err(_) => {
                        run_c(&mut conn, "rollback to savepoint prometeo_import", cancel).await?;
                        release(&mut conn, d, cancel).await?;
                        for p in &batch {
                            run_c(&mut conn, "savepoint prometeo_import", cancel).await?;
                            match run_c(&mut conn, &format!("{head}{}", p.tuple), cancel).await {
                                Ok(()) => {
                                    release(&mut conn, d, cancel).await?;
                                    res.imported += 1;
                                }
                                Err(e)
                                    if e.is_connection_lost()
                                        || matches!(e, DbError::Cancelled) =>
                                {
                                    return Err(e)
                                }
                                Err(e) => {
                                    run_c(
                                        &mut conn,
                                        "rollback to savepoint prometeo_import",
                                        cancel,
                                    )
                                    .await?;
                                    release(&mut conn, d, cancel).await?;
                                    log.add(
                                        p.row,
                                        &first_line(&e),
                                        &p.values,
                                        &req.format.delimiter,
                                    );
                                    res.failed += 1;
                                    if req.options.abort_on_error {
                                        aborted = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                progress(ImportProgress {
                    rows: res.imported + res.failed,
                    failed: res.failed,
                    fraction: src.fraction(),
                });
            }
            Ok(())
        }
        .await;

        log.finish();
        res.errors = std::mem::take(&mut log.first);
        res.error_file = log
            .out
            .is_some()
            .then(|| log.written_to.as_ref().map(|p| p.display().to_string()))
            .flatten();
        res.error_file_error = log.failed_to_open.take();

        // cancelled while reading the file or in the middle of a statement: the connection is not used again
        let interrupted = matches!(outcome, Err(DbError::Cancelled));
        if interrupted {
            res.cancelled = true;
            // stop what the server is running (a statement waiting for a lock), then drop the connection: the
            // server rolls the open transaction back
            interrupt(&live.pool, &cancel_target).await;
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.close()).await;
            if res.created_table && !ddl_in_tx {
                let _ = tokio::time::timeout(
                    CLOSE_TIMEOUT * 2,
                    live.pool.exec(&drop_if_exists(d, &table)),
                )
                .await;
            }
            res.rolled_back = true;
            res.created_table = false;
            res.imported = 0;
            res.elapsed_ms = started.elapsed().as_millis() as u64;
            return Ok(res);
        }
        let keep =
            outcome.is_ok() && !res.cancelled && !(req.options.abort_on_error && res.failed > 0);
        if keep {
            let commit = run(&mut conn, "commit").await;
            if let Err(e) = commit {
                let _ = run(&mut conn, "rollback").await;
                if res.created_table {
                    let _ = run(&mut conn, &format!("drop table {table}")).await;
                }
                conn.close().await;
                return Err(e);
            }
        } else {
            let _ = run(&mut conn, "rollback").await;
            if res.created_table {
                // MySQL commits DDL at once, the others rolled the table back already: a missing table is fine
                let _ = run(&mut conn, &drop_if_exists(d, &table)).await;
            }
            res.rolled_back = true;
            res.imported = 0;
        }
        conn.close().await;
        outcome?;
        if res.rolled_back {
            res.created_table = false;
        }
        res.elapsed_ms = started.elapsed().as_millis() as u64;
        Ok(res)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(text: &str, fmt: &ImportFormat) -> Vec<Vec<Option<String>>> {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        std::fs::write(&p, text).unwrap();
        let mut s = Source::open(&p, fmt).unwrap();
        let mut out = Vec::new();
        while let Some((_, r)) = s.next_row().unwrap() {
            out.push(r);
        }
        out
    }

    fn some(v: &[&str]) -> Vec<Option<String>> {
        v.iter().map(|s| Some(s.to_string())).collect()
    }

    #[test]
    fn parses_quotes_multiline_and_line_endings() {
        let f = ImportFormat::default();
        let r = rows(
            "a,b,c\r\n1,\"x,y\",\"he said \"\"hi\"\"\"\n2,\"line1\nline2\",z\r3,,\n",
            &f,
        );
        assert_eq!(r.len(), 3);
        assert_eq!(r[0], some(&["1", "x,y", "he said \"hi\""]));
        assert_eq!(r[1], some(&["2", "line1\nline2", "z"]));
        assert_eq!(r[2], vec![Some("3".into()), None, None]);
    }

    #[test]
    fn skips_blank_lines_strips_bom_and_handles_missing_final_newline() {
        let r = rows("\u{feff}h1,h2\n\n1,2\n\n3,4", &ImportFormat::default());
        assert_eq!(r, vec![some(&["1", "2"]), some(&["3", "4"])]);
    }

    #[test]
    fn quoted_empty_is_not_null_and_null_text_applies() {
        let r = rows(
            "a,b\n\"\",NULL\n",
            &ImportFormat {
                null_text: "NULL".into(),
                ..Default::default()
            },
        );
        assert_eq!(r[0], vec![Some(String::new()), None]);
    }

    #[test]
    fn custom_delimiter_trim_and_first_column_header() {
        let f = ImportFormat {
            delimiter: ";".into(),
            trim: true,
            first_column_header: true,
            ..Default::default()
        };
        let r = rows("label;a;b\nr1; 1 ; two \n", &f);
        assert_eq!(r, vec![some(&["1", "two"])]);
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        std::fs::write(&p, "label;a;b\nr1; 1 ; two \n").unwrap();
        assert_eq!(Source::open(&p, &f).unwrap().columns, vec!["a", "b"]);
        let tab = ImportFormat {
            delimiter: "\t".into(),
            ..Default::default()
        };
        assert_eq!(rows("a\tb\n1\t2\n", &tab), vec![some(&["1", "2"])]);
        let multi = ImportFormat {
            delimiter: "||".into(),
            ..Default::default()
        };
        assert_eq!(rows("a||b\n1||2|3\n", &multi), vec![some(&["1", "2|3"])]);
    }

    #[test]
    fn no_header_names_columns_and_keeps_the_first_row() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        std::fs::write(&p, "1,2\n3,4\n").unwrap();
        let f = ImportFormat {
            header: false,
            ..Default::default()
        };
        let mut s = Source::open(&p, &f).unwrap();
        assert_eq!(s.columns, vec!["column1", "column2"]);
        assert_eq!(s.next_row().unwrap().unwrap().1, some(&["1", "2"]));
        assert_eq!(s.next_row().unwrap().unwrap().0, 2);
    }

    #[test]
    fn header_names_are_made_unique() {
        assert_eq!(
            header_names(vec!["a".into(), "".into(), "A".into(), " b ".into()]),
            vec!["a", "column2", "A_2", "b"]
        );
    }

    #[test]
    fn latin1_is_transcoded() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        std::fs::write(&p, b"n\ncaf\xe9\n").unwrap();
        let f = ImportFormat {
            encoding: "ISO-8859-1".into(),
            ..Default::default()
        };
        let mut s = Source::open(&p, &f).unwrap();
        assert_eq!(s.next_row().unwrap().unwrap().1, some(&["café"]));
    }

    #[test]
    fn records_larger_than_the_read_chunk_are_complete() {
        let big = "x".repeat(300_000);
        let r = rows(
            &format!("a,b\n\"{big}\n{big}\",2\n"),
            &ImportFormat::default(),
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0][0].as_ref().unwrap().len(), 600_001);
    }

    #[test]
    fn infers_types() {
        let t = |vals: &[&str]| {
            let mut i = Infer::new();
            vals.iter().for_each(|v| i.add(v));
            i.result()
        };
        assert_eq!(t(&["1", "-20", ""]), InferredType::Integer);
        assert_eq!(t(&["1", "3000000000"]), InferredType::Bigint);
        assert_eq!(t(&["1", "2.5", "1e3"]), InferredType::Double);
        assert_eq!(t(&["true", "FALSE"]), InferredType::Boolean);
        assert_eq!(t(&["2024-02-29", "2024-03-01"]), InferredType::Date);
        assert_eq!(t(&["2024-02-30"]), InferredType::Text);
        assert_eq!(
            t(&["2024-01-01", "2024-01-01 10:20:30.5"]),
            InferredType::Timestamp
        );
        assert_eq!(t(&["2024-01-01T10:20:30+02:00"]), InferredType::Timestamp);
        assert_eq!(t(&["007", "12"]), InferredType::Text);
        assert_eq!(t(&["1", "x"]), InferredType::Text);
        assert_eq!(t(&["nan"]), InferredType::Text);
        assert_eq!(t(&["", ""]), InferredType::Text);
    }

    #[test]
    fn categories_of_declared_types() {
        assert_eq!(category("integer"), Category::Int);
        assert_eq!(category("INT UNSIGNED"), Category::Int);
        assert_eq!(category("bigint"), Category::Int);
        assert_eq!(category("smallserial"), Category::Int);
        assert_eq!(category("interval"), Category::Text);
        assert_eq!(category("numeric(10,2)"), Category::Float);
        assert_eq!(category("double precision"), Category::Float);
        assert_eq!(category("boolean"), Category::Bool);
        assert_eq!(category("tinyint(1)"), Category::Bool);
        assert_eq!(category("tinyint(4)"), Category::Int);
        assert_eq!(category("timestamp without time zone"), Category::Timestamp);
        assert_eq!(category("datetime"), Category::Timestamp);
        assert_eq!(category("date"), Category::Date);
        assert_eq!(category("character varying(20)"), Category::Text);
        assert_eq!(category("uuid"), Category::Text);
        // exact names: no suffix / prefix guessing
        assert_eq!(category("point"), Category::Text);
        assert_eq!(category("int4range"), Category::Text);
        assert_eq!(category("integer[]"), Category::Text);
        assert_eq!(category("int4[]"), Category::Text);
        assert_eq!(category("_int4"), Category::Text);
        assert_eq!(category("bigint[]"), Category::Text);
        assert_eq!(category("mediumint unsigned"), Category::Int);
        assert_eq!(category("int8"), Category::Int);
        assert_eq!(category("bigserial"), Category::Int);
    }

    #[test]
    fn nul_in_text_is_a_row_error_except_on_mysql() {
        let v = Some("a\0b");
        for d in [Driver::Postgres, Driver::Sqlite] {
            let e = to_literal(d, Category::Text, v).unwrap_err();
            assert!(e.contains("NUL"), "{e}");
        }
        assert!(to_literal(Driver::MySql, Category::Text, v).is_ok());
        assert!(to_literal(Driver::Postgres, Category::Date, v).is_err());
    }

    #[test]
    fn an_unbalanced_quote_in_a_huge_file_fails_fast() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        let mut f = File::create(&p).unwrap();
        f.write_all(b"a,b\n1,\"open\n").unwrap();
        let chunk = vec![b'x'; 1 << 20];
        for _ in 0..70 {
            f.write_all(&chunk).unwrap();
        }
        drop(f);
        let mut s = Source::open(&p, &ImportFormat::default()).unwrap();
        let t = Instant::now();
        let e = s.next_row().unwrap_err();
        assert!(e.to_string().contains("longer than"), "{e}");
        // a rescan after every 64 KB read took minutes
        assert!(t.elapsed() < Duration::from_secs(30), "{:?}", t.elapsed());
    }

    #[test]
    fn reading_stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        std::fs::write(&p, format!("a\n{}", "123456\n".repeat(50_000))).unwrap();
        let mut s = Source::open(&p, &ImportFormat::default()).unwrap();
        let token = CancellationToken::new();
        s.set_cancel(token.clone());
        assert!(s.next_row().unwrap().is_some());
        token.cancel();
        // the rows already buffered are still returned; the next read of the file fails
        let mut n = 1;
        let e = loop {
            match s.next_row() {
                Ok(Some(_)) => n += 1,
                Ok(None) => panic!("the whole file was read after the cancel"),
                Err(e) => break e,
            }
        };
        assert!(matches!(e, DbError::Cancelled), "{e}");
        assert!(n < 50_000);
    }

    #[test]
    fn converts_values_to_literals() {
        let pg = Driver::Postgres;
        assert_eq!(to_literal(pg, Category::Int, Some(" +12 ")).unwrap(), "12");
        assert!(to_literal(pg, Category::Int, Some("1.5")).is_err());
        assert_eq!(to_literal(pg, Category::Int, Some("")).unwrap(), "NULL");
        assert_eq!(to_literal(pg, Category::Int, None).unwrap(), "NULL");
        assert_eq!(
            to_literal(pg, Category::Float, Some("3.25")).unwrap(),
            "3.25"
        );
        assert!(to_literal(pg, Category::Float, Some("inf")).is_err());
        assert_eq!(to_literal(pg, Category::Bool, Some("Yes")).unwrap(), "true");
        assert_eq!(
            to_literal(Driver::MySql, Category::Bool, Some("no")).unwrap(),
            "0"
        );
        assert!(to_literal(pg, Category::Bool, Some("maybe")).is_err());
        assert_eq!(
            to_literal(pg, Category::Text, Some("it's")).unwrap(),
            "'it''s'"
        );
        assert_eq!(
            to_literal(Driver::MySql, Category::Text, Some("a\\b")).unwrap(),
            "'a\\\\b'"
        );
        assert_eq!(
            to_literal(pg, Category::Date, Some("2024-01-31")).unwrap(),
            "'2024-01-31'"
        );
        assert!(to_literal(pg, Category::Date, Some("31/01/2024")).is_err());
        // a value that could break out of the statement never reaches the SQL as a number
        assert!(to_literal(pg, Category::Int, Some("1); drop table t; --")).is_err());
        assert!(to_literal(pg, Category::Float, Some("1); drop")).is_err());
    }

    #[test]
    fn oracle_literals_use_conversion_functions() {
        let o = Driver::Oracle;
        assert_eq!(category("NUMBER(10,2)"), Category::Float);
        assert_eq!(category("NUMBER(1)"), Category::Bool);
        assert_eq!(category("DATE"), Category::Date);
        assert_eq!(category("TIMESTAMP(6) WITH TIME ZONE"), Category::Timestamp);
        assert_eq!(category("VARCHAR2(20 CHAR)"), Category::Text);
        assert_eq!(
            to_literal(o, Category::Date, Some("2024-02-29 13:45:10")).unwrap(),
            "TO_DATE('2024-02-29 13:45:10', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(
            to_literal(o, Category::Date, Some("2024-02-29")).unwrap(),
            "TO_DATE('2024-02-29 00:00:00', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(
            to_literal(o, Category::Timestamp, Some("2024-02-29 13:45:10.25")).unwrap(),
            "TO_TIMESTAMP('2024-02-29 13:45:10.250000000', 'YYYY-MM-DD HH24:MI:SS.FF9')"
        );
        assert!(to_literal(o, Category::Date, Some("29/02/2024")).is_err());
        assert_eq!(to_literal(o, Category::Bool, Some("yes")).unwrap(), "1");
        assert_eq!(
            to_literal(o, Category::Text, Some("it's")).unwrap(),
            "'it''s'"
        );
        assert!(to_literal(o, Category::Text, Some("a\0b")).is_err());
        assert!(to_literal(o, Category::Text, Some(&"x".repeat(5000)))
            .unwrap()
            .starts_with("TO_CLOB("));
        assert_eq!(sql_type(o, InferredType::Text), "varchar2(4000)");
        assert_eq!(sql_type(o, InferredType::Timestamp), "timestamp");
        assert_eq!(
            create_table_sql(
                o,
                Some("DEMO"),
                "T",
                &[("A", "number(10)"), ("b c", "varchar2(4000)")]
            )
            .unwrap(),
            "create table DEMO.T (\n    A number(10),\n    \"b c\" varchar2(4000)\n)"
        );
        assert_eq!(
            drop_if_exists(o, "DEMO.T"),
            "begin execute immediate 'drop table DEMO.T purge'; exception when others then null; end;"
        );
        assert_eq!(
            drop_if_exists(Driver::Postgres, "t"),
            "drop table if exists t"
        );
    }

    #[test]
    fn builds_create_table() {
        let sql = create_table_sql(
            Driver::Postgres,
            Some("public"),
            "t",
            &[("id", "integer"), ("na\"me", "varchar(20)")],
        )
        .unwrap();
        assert_eq!(
            sql,
            "create table \"public\".\"t\" (\n    \"id\" integer,\n    \"na\"\"me\" varchar(20)\n)"
        );
        assert!(create_table_sql(
            Driver::Sqlite,
            None,
            "t",
            &[("a", "int); drop table x; --")]
        )
        .is_err());
        assert!(create_table_sql(Driver::Sqlite, None, "t", &[("a", "")]).is_err());
    }

    #[test]
    fn preview_samples_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        let mut text = String::from("id,name,price\n");
        for i in 1..=25 {
            text.push_str(&format!("{i},n{i},{i}.5\n"));
        }
        std::fs::write(&p, text).unwrap();
        let pv = preview(&p, &ImportFormat::default(), 10).unwrap();
        assert_eq!(pv.rows.len(), 10);
        assert_eq!(pv.sampled, 25);
        assert!(!pv.truncated);
        let types: Vec<_> = pv.columns.iter().map(|c| c.inferred_type).collect();
        assert_eq!(
            types,
            vec![
                InferredType::Integer,
                InferredType::Text,
                InferredType::Double
            ]
        );
    }
}
