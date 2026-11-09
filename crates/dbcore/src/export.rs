//! Export of result sets / queries: CSV (comma, semicolon, pipe), TSV, JSON, JSON lines, SQL INSERT / UPDATE, WHERE clause,
//! Markdown, HTML table, XML and an aligned text table.

use std::io::{self, Write};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{DbError, Result};
use crate::exec::query_cancellable;
use crate::import::CancellationToken;
use crate::manager::ConnectionManager;
use crate::model::*;
use crate::quote::{
    oracle_raw_literal, oracle_text_literal, oracle_time_kind, oracle_time_literal, quote_ident,
    quote_literal,
};
use crate::value::describe_columns_pool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    SqlInsert,
    Markdown,
    /// CSV with `|` as the field delimiter.
    CsvPipe,
    /// CSV with `;` as the field delimiter.
    CsvSemicolon,
    /// One JSON object per line.
    JsonLines,
    /// `update t set ... where <key> = ...;` (the key is the primary key columns, else every column).
    SqlUpdate,
    /// `where <key> in (...)` / `where (a = 1 and b = 2) or ...` over the rows (key as in `SqlUpdate`).
    WhereClause,
    Html,
    Xml,
    /// Aligned plain-text table.
    Pretty,
}

/// Encoding of the output file (applies in file-writing paths only; the clipboard / preview stay UTF-8).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportEncoding {
    #[default]
    Utf8,
    Utf8Bom,
    Windows1252,
    Utf16Le,
}

/// Progress of a running export (rows written; `total` is known only for in-memory result sets).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub rows_written: usize,
    pub total: Option<usize>,
}

/// Least time between two progress events of an export.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Rows after which a progress event is due even when [`PROGRESS_EVERY`] has not passed.
const PROGRESS_ROWS: usize = 1000;

/// Throttle of the progress events: one per [`PROGRESS_EVERY`] or [`PROGRESS_ROWS`] rows, whichever comes first (the
/// caller sends a last one at the end).
struct ProgressGate {
    last: Instant,
    last_rows: usize,
}

impl ProgressGate {
    fn new() -> Self {
        ProgressGate {
            last: Instant::now(),
            last_rows: 0,
        }
    }

    /// Did rows come after the last event (the final one is due)?
    fn unreported(&self, rows: usize) -> bool {
        rows != self.last_rows
    }

    /// Is an event due now that `rows` rows are written?
    fn due(&mut self, now: Instant, rows: usize) -> bool {
        if rows - self.last_rows >= PROGRESS_ROWS || now.duration_since(self.last) >= PROGRESS_EVERY
        {
            self.last = now;
            self.last_rows = rows;
            true
        } else {
            false
        }
    }
}

/// Result of an export: the rows written and how many characters the encoding could not represent
/// (written as `?`; only the Windows-1252 encoding is lossy).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub rows: usize,
    pub unmappable: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    pub format: ExportFormat,
    pub header: bool,
    /// Text written for SQL NULL in CSV / TSV / Markdown.
    pub null_text: String,
    /// CSV field delimiter (default `,`).
    pub delimiter: Option<char>,
    /// CSV quote character (default `"`).
    pub quote: char,
    /// Target table for SQL INSERT (`schema.table`, parts are quoted).
    pub table_name: Option<String>,
    /// SQL dialect for quoting and literals in SQL INSERT.
    pub dialect: Driver,
    /// Rows per INSERT statement (multi-row VALUES when > 1).
    pub rows_per_insert: usize,
    /// Write the result transposed: one output row per column (first cell: the column name), one output
    /// column per result row. The whole result is held in memory.
    pub transpose: bool,
    /// Add a first column with the row number (CSV / TSV / Markdown only; the header cell is empty).
    pub row_header: bool,
    /// Encoding of the output file (text-like formats; the clipboard / preview are always UTF-8).
    pub encoding: ExportEncoding,
    /// Names of the columns that identify a row for SQL UPDATE / WHERE. `None` (or no matching column)
    /// falls back to the primary key columns, then to every column.
    pub key_columns: Option<Vec<String>>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        ExportOptions {
            format: ExportFormat::Csv,
            header: true,
            null_text: String::new(),
            delimiter: None,
            quote: '"',
            table_name: None,
            dialect: Driver::Postgres,
            rows_per_insert: 1,
            transpose: false,
            row_header: false,
            encoding: ExportEncoding::Utf8,
            key_columns: None,
        }
    }
}

/// Encode `s` in Windows-1252, replacing every character the encoding cannot represent with `?`.
/// Returns the bytes and how many characters were replaced (`encoding_rs`' own `encode` writes HTML
/// numeric character references there, which is not what an export file wants).
fn windows1252(s: &str) -> (Vec<u8>, usize) {
    let mut encoder = encoding_rs::WINDOWS_1252.new_encoder();
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let mut unmappable = 0usize;
    for c in s.chars() {
        let mut ch_buf = [0u8; 4];
        let ch = c.encode_utf8(&mut ch_buf);
        let mut dst = [0u8; 4];
        match encoder.encode_from_utf8_without_replacement(ch, &mut dst, true) {
            (encoding_rs::EncoderResult::Unmappable(_), _, _) => {
                out.push(b'?');
                unmappable += 1;
            }
            (_, _, written) => out.extend_from_slice(&dst[..written]),
        }
    }
    (out, unmappable)
}

/// Wraps a writer and re-encodes the UTF-8 text written to it: `Utf8Bom` / `Utf16Le` prefix a byte-order
/// mark, `Windows1252` replaces the characters it cannot represent with `?` (counted in
/// [`EncodingWriter::unmappable`]). `Utf8` passes the bytes through unchanged.
pub struct EncodingWriter<W: Write> {
    inner: W,
    encoding: ExportEncoding,
    /// Whether the byte-order mark has been written already.
    started: bool,
    /// Characters the encoding could not represent.
    unmappable: usize,
}

impl<W: Write> EncodingWriter<W> {
    pub fn new(inner: W, encoding: ExportEncoding) -> Self {
        EncodingWriter {
            inner,
            encoding,
            started: false,
            unmappable: 0,
        }
    }

    /// How many characters the encoding could not represent (replaced with `?`).
    pub fn unmappable(&self) -> usize {
        self.unmappable
    }

    pub fn into_inner(self) -> W {
        self.inner
    }

    fn write_bom(&mut self) -> io::Result<()> {
        if self.started {
            return Ok(());
        }
        self.started = true;
        let bom: &[u8] = match self.encoding {
            ExportEncoding::Utf16Le => &[0xFF, 0xFE],
            ExportEncoding::Utf8Bom => &[0xEF, 0xBB, 0xBF],
            _ => &[],
        };
        if !bom.is_empty() {
            self.inner.write_all(bom)?;
        }
        Ok(())
    }

    /// Re-encodes one chunk of UTF-8 text in the target encoding.
    fn encode_str(&mut self, s: &str) -> io::Result<()> {
        match self.encoding {
            ExportEncoding::Utf8 | ExportEncoding::Utf8Bom => self.inner.write_all(s.as_bytes())?,
            ExportEncoding::Utf16Le => {
                // `encoding_rs` treats UTF-16 as an input-only encoding (its `output_encoding` is
                // UTF-8), so write the code units little-endian ourselves (surrogate pairs included).
                for unit in s.encode_utf16() {
                    self.inner.write_all(&unit.to_le_bytes())?;
                }
            }
            ExportEncoding::Windows1252 => {
                let (bytes, lost) = windows1252(s);
                self.unmappable += lost;
                self.inner.write_all(&bytes)?;
            }
        }
        Ok(())
    }
}

impl<W: Write> Write for EncodingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write_bom()?;
        // The exporter writes complete UTF-8 strings (the `write!` / `writeln!` macros), so every
        // buffer is valid UTF-8; a caller that splits a multi-byte sequence is an error.
        let text = std::str::from_utf8(buf).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the export produced invalid UTF-8",
            )
        })?;
        if !text.is_empty() {
            self.encode_str(text)?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.write_bom()?;
        self.inner.flush()
    }
}

/// Plain text of a cell (binary as `0x...`).
fn cell_text(c: &Cell, null: &str) -> String {
    match c {
        Value::Null => null.to_string(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Object(m) if m.contains_key("$bin") => {
            format!("0x{}", m["$bin"].as_str().unwrap_or(""))
        }
        other => other.to_string(),
    }
}

/// A float cell with no fractional part (`3.0`: SQLite REAL, PG / MySQL double). serde_json writes it as `3.0` but
/// the grid shows `3` (a JSON number has no int / float distinction in the browser).
fn is_integral_float(c: &Cell) -> bool {
    matches!(c, Value::Number(n) if n.is_f64() && n.as_f64().is_some_and(|f| f.fract() == 0.0 && f.abs() < 1e15))
}

/// The cell as the grid shows it: an integral float is written without `.0`.
fn integral_as_int(c: &Cell) -> Cell {
    match c {
        Value::Number(n) if is_integral_float(c) => {
            Value::from(n.as_f64().unwrap_or_default() as i64)
        }
        other => other.clone(),
    }
}

/// JSON value with binary cells replaced by `"0x..."` strings.
fn cell_json(c: &Cell) -> Value {
    match c {
        Value::Object(m) if m.contains_key("$bin") => Value::String(cell_text(c, "")),
        other => other.clone(),
    }
}

/// Is `ty` a number type whose values a driver may deliver as text (exact decimals, big integers)?
fn is_numeric_type(ty: &str) -> bool {
    let ty = ty.trim().to_ascii_lowercase();
    let base = ty
        .split(|c: char| c == '(' || c.is_whitespace())
        .next()
        .unwrap_or("");
    matches!(
        base,
        "numeric"
            | "decimal"
            | "dec"
            | "fixed"
            | "number"
            | "bigint"
            | "int8"
            | "int"
            | "integer"
            | "int4"
            | "int2"
            | "smallint"
            | "mediumint"
            | "tinyint"
            | "float"
            | "float4"
            | "float8"
            | "double"
            | "real"
    )
}

/// The text of a number cell that arrived as a string (`'1001.00'` of a DECIMAL column) when it can stand as a
/// numeric literal as it is (no precision lost by going through a float).
fn numeric_text<'a>(c: &'a Cell, ty: &str) -> Option<&'a str> {
    let Value::String(s) = c else {
        return None;
    };
    let t = s.trim();
    (is_numeric_type(ty)
        && t.bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
        && t.parse::<f64>().is_ok_and(f64::is_finite))
    .then_some(t)
}

/// `t` is written the way JSON writes numbers (`-?int[.frac][e[+-]exp]`).
fn is_json_number(t: &str) -> bool {
    let b = t.as_bytes();
    let digits = |mut i: usize| {
        let from = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        (i, i > from)
    };
    let mut i = usize::from(b.first() == Some(&b'-'));
    match b.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => i = digits(i).0,
        _ => return false,
    }
    if b.get(i) == Some(&b'.') {
        let (j, ok) = digits(i + 1);
        if !ok {
            return false;
        }
        i = j;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let (j, ok) = digits(i);
        if !ok {
            return false;
        }
        i = j;
    }
    i == b.len()
}

/// The JSON text of cell `c` of a column of declared type `ty`: a number cell that arrived as a string is written
/// as a JSON number with its digits unchanged.
fn json_text(c: &Cell, ty: &str) -> String {
    match numeric_text(c, ty) {
        Some(t) if is_json_number(t) => t.to_string(),
        _ => cell_json(c).to_string(),
    }
}

/// One element (or nested array) of a PG array literal `{..}`.
fn pg_array_element(c: &Cell) -> String {
    let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    match c {
        Value::Null => "NULL".into(),
        Value::Array(a) => format!(
            "{{{}}}",
            a.iter().map(pg_array_element).collect::<Vec<_>>().join(",")
        ),
        Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => quote(s),
        // bytea element: hex input form
        Value::Object(m) if m.contains_key("$bin") => {
            quote(&format!("\\x{}", m["$bin"].as_str().unwrap_or("")))
        }
        other => quote(&other.to_string()),
    }
}

/// [`sql_literal`] for a value of a column of declared type `ty`: Oracle writes dates, timestamps and long text with
/// conversion functions, the others only look at the value.
pub(crate) fn sql_literal_typed(d: Driver, c: &Cell, ty: &str) -> String {
    // a DECIMAL / BIGINT that arrived as text is a number, not a string
    if let Some(t) = numeric_text(c, ty) {
        return t.to_string();
    }
    if d != Driver::Oracle {
        return sql_literal(d, c);
    }
    match c {
        Value::String(s) => {
            if let Some(l) = oracle_time_kind(ty).and_then(|k| oracle_time_literal(k, s)) {
                l
            } else if ty.to_ascii_uppercase().starts_with("NUMBER")
                && s.trim().parse::<f64>().is_ok_and(f64::is_finite)
            {
                s.trim().to_string()
            } else {
                oracle_text_literal(s)
            }
        }
        _ => sql_literal(d, c),
    }
}

pub(crate) fn sql_literal(d: Driver, c: &Cell) -> String {
    match c {
        // PG arrays arrive as JSON arrays: write them back as an array literal ('{1,2}')
        Value::Array(_) if d == Driver::Postgres => quote_literal(d, &pg_array_element(c)),
        Value::Null => "NULL".into(),
        Value::Bool(b) => match d {
            Driver::Postgres => if *b { "true" } else { "false" }.into(),
            _ => if *b { "1" } else { "0" }.into(),
        },
        Value::Number(n) => n.to_string(),
        Value::String(s) if d == Driver::Oracle => oracle_text_literal(s),
        Value::String(s) => quote_literal(d, s),
        Value::Object(m) if m.contains_key("$bin") => {
            let hex = m["$bin"].as_str().unwrap_or("");
            match d {
                Driver::Postgres => format!("'\\x{hex}'::bytea"),
                Driver::Oracle => oracle_raw_literal(hex),
                _ => format!("X'{hex}'"),
            }
        }
        other if d == Driver::Oracle => oracle_text_literal(&other.to_string()),
        other => quote_literal(d, &other.to_string()),
    }
}

/// Streaming writer: `begin` once, `row` for each row, then `finish`.
pub struct Exporter<W: Write> {
    w: W,
    o: ExportOptions,
    /// Column names as written (with the row header column).
    cols: Vec<String>,
    /// Column names of the result being exported.
    src_cols: Vec<String>,
    /// Rows of the result seen so far.
    rows: usize,
    /// Rows written (differs from `rows` when transposed).
    emitted: usize,
    began: bool,
    batch: Vec<String>,
    /// Rows held back until `finish` (transposed export).
    held: Vec<Vec<Cell>>,
    /// Primary key flag of each column of the result (SQL UPDATE / WHERE key).
    src_pk: Vec<bool>,
    /// Declared type of each column of the result (literals of dates and the like).
    src_types: Vec<String>,
    /// Text rows of the `Pretty` table (needs every row to align the columns).
    text_rows: Vec<Vec<String>>,
}

impl<W: Write> Exporter<W> {
    pub fn new(w: W, opts: ExportOptions) -> Self {
        Exporter {
            w,
            o: opts,
            cols: Vec::new(),
            src_cols: Vec::new(),
            rows: 0,
            emitted: 0,
            began: false,
            batch: Vec::new(),
            held: Vec::new(),
            src_pk: Vec::new(),
            src_types: Vec::new(),
            text_rows: Vec::new(),
        }
    }

    fn delim(&self) -> char {
        match self.o.format {
            ExportFormat::Tsv => '\t',
            ExportFormat::CsvPipe => '|',
            ExportFormat::CsvSemicolon => ';',
            _ => self.o.delimiter.unwrap_or(','),
        }
    }

    fn csv_field(&self, s: &str) -> String {
        let (d, q) = (self.delim(), self.o.quote);
        if s.contains(d) || s.contains(q) || s.contains('\n') || s.contains('\r') {
            let esc = s.replace(q, &format!("{q}{q}"));
            format!("{q}{esc}{q}")
        } else {
            s.to_string()
        }
    }

    fn tsv_field(s: &str) -> String {
        s.replace('\\', "\\\\")
            .replace('\t', "\\t")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    }

    fn md_field(s: &str) -> String {
        s.replace('|', "\\|")
            .replace('\r', "")
            .replace('\n', "<br>")
    }

    fn is_csv(&self) -> bool {
        matches!(
            self.o.format,
            ExportFormat::Csv | ExportFormat::CsvPipe | ExportFormat::CsvSemicolon
        )
    }

    /// Indexes (in the result) of the `key_columns` option, when every name is a column of the result (a key that
    /// matches only some of its columns would be a smaller key than the one asked for).
    fn option_key(&self) -> Option<Vec<usize>> {
        let names = self.o.key_columns.as_ref().filter(|n| !n.is_empty())?;
        names
            .iter()
            .map(|n| self.src_cols.iter().position(|c| c == n))
            .collect()
    }

    /// Indexes (in the result) of the columns that identify a row: the `key_columns` option, else the
    /// primary key, else every column.
    fn key_cols(&self) -> Vec<usize> {
        if let Some(idx) = self.option_key() {
            return idx;
        }
        let pk: Vec<usize> = (0..self.src_cols.len())
            .filter(|i| self.src_pk.get(*i).copied().unwrap_or(false))
            .collect();
        if pk.is_empty() {
            (0..self.src_cols.len()).collect()
        } else {
            pk
        }
    }

    /// The SQL literal of cell `c` of column `i` of the result.
    fn lit(&self, i: usize, c: &Cell) -> String {
        sql_literal_typed(
            self.o.dialect,
            c,
            self.src_types.get(i).map(String::as_str).unwrap_or(""),
        )
    }

    /// `"col" = literal` (`is null` for NULL).
    fn eq_pred(&self, i: usize, row: &[Cell]) -> String {
        let col = quote_ident(self.o.dialect, &self.src_cols[i]);
        match row.get(i) {
            None | Some(Value::Null) => format!("{col} is null"),
            Some(c) => format!("{col} = {}", self.lit(i, c)),
        }
    }

    fn xml_name(s: &str) -> String {
        let mut n: String = s
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || matches!(c, '_' | '-' | '.') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if n.is_empty() || !n.starts_with(|c: char| c.is_alphabetic() || c == '_') {
            n.insert(0, '_');
        }
        n
    }

    fn xml_text(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    fn table(&self) -> String {
        let name = self
            .o
            .table_name
            .clone()
            .unwrap_or_else(|| "table_name".into());
        name.split('.')
            .map(|p| quote_ident(self.o.dialect, p))
            .collect::<Vec<_>>()
            .join(".")
    }

    fn row_header(&self) -> bool {
        self.o.row_header
            && (self.is_csv()
                || matches!(self.o.format, ExportFormat::Tsv | ExportFormat::Markdown))
    }

    pub fn begin(&mut self, columns: &[ColumnMeta]) -> io::Result<()> {
        self.src_cols = columns.iter().map(|c| c.name.clone()).collect();
        self.src_pk = columns.iter().map(|c| c.is_pk).collect();
        self.src_types = columns.iter().map(|c| c.type_name.clone()).collect();
        self.began = true;
        if self.o.transpose {
            return Ok(());
        }
        let names = self.src_cols.clone();
        self.start(names)
    }

    /// Writes the header of the output (`names` are the columns of the output, without the row header).
    fn start(&mut self, names: Vec<String>) -> io::Result<()> {
        self.cols = names;
        if self.row_header() {
            self.cols.insert(0, String::new());
        }
        match self.o.format {
            ExportFormat::Csv
            | ExportFormat::CsvPipe
            | ExportFormat::CsvSemicolon
            | ExportFormat::Tsv => {
                if self.o.header {
                    let line: Vec<String> = self
                        .cols
                        .iter()
                        .map(|c| {
                            if self.o.format == ExportFormat::Tsv {
                                Self::tsv_field(c)
                            } else {
                                self.csv_field(c)
                            }
                        })
                        .collect();
                    writeln!(self.w, "{}", line.join(&self.delim().to_string()))?;
                }
            }
            ExportFormat::Json => write!(self.w, "[")?,
            ExportFormat::Markdown => {
                let head: Vec<String> = self.cols.iter().map(|c| Self::md_field(c)).collect();
                writeln!(self.w, "| {} |", head.join(" | "))?;
                writeln!(
                    self.w,
                    "|{}|",
                    self.cols
                        .iter()
                        .map(|_| " --- ")
                        .collect::<Vec<_>>()
                        .join("|")
                )?;
            }
            ExportFormat::Html => {
                writeln!(self.w, "<table>\n  <thead>\n    <tr>")?;
                for c in &self.cols {
                    writeln!(self.w, "      <th>{}</th>", Self::xml_text(c))?;
                }
                writeln!(self.w, "    </tr>\n  </thead>\n  <tbody>")?;
            }
            ExportFormat::Xml => {
                let enc = match self.o.encoding {
                    ExportEncoding::Utf8 | ExportEncoding::Utf8Bom => "UTF-8",
                    ExportEncoding::Windows1252 => "windows-1252",
                    ExportEncoding::Utf16Le => "UTF-16",
                };
                writeln!(
                    self.w,
                    "<?xml version=\"1.0\" encoding=\"{enc}\"?>\n<result>"
                )?;
            }
            ExportFormat::Pretty => {
                let head = self.cols.clone();
                self.text_rows.push(head);
            }
            ExportFormat::JsonLines
            | ExportFormat::SqlInsert
            | ExportFormat::SqlUpdate
            | ExportFormat::WhereClause => {}
        }
        Ok(())
    }

    pub fn row(&mut self, row: &[Cell]) -> io::Result<()> {
        self.rows += 1;
        if self.o.transpose {
            self.held.push(row.to_vec());
            return Ok(());
        }
        self.emit(row)
    }

    fn emit(&mut self, row: &[Cell]) -> io::Result<()> {
        let plain;
        let row = if row.iter().any(is_integral_float) {
            plain = row.iter().map(integral_as_int).collect::<Vec<_>>();
            &plain[..]
        } else {
            row
        };
        let with_header;
        let row = if self.row_header() {
            with_header = std::iter::once(Value::from(self.emitted + 1))
                .chain(row.iter().cloned())
                .collect::<Vec<_>>();
            &with_header[..]
        } else {
            row
        };
        match self.o.format {
            ExportFormat::Csv | ExportFormat::CsvPipe | ExportFormat::CsvSemicolon => {
                let line: Vec<String> = row
                    .iter()
                    .map(|c| self.csv_field(&cell_text(c, &self.o.null_text)))
                    .collect();
                writeln!(self.w, "{}", line.join(&self.delim().to_string()))?;
            }
            ExportFormat::Tsv => {
                let line: Vec<String> = row
                    .iter()
                    .map(|c| {
                        if c.is_null() {
                            self.o.null_text.clone()
                        } else {
                            Self::tsv_field(&cell_text(c, ""))
                        }
                    })
                    .collect();
                writeln!(self.w, "{}", line.join("\t"))?;
            }
            ExportFormat::Markdown => {
                let line: Vec<String> = row
                    .iter()
                    .map(|c| Self::md_field(&cell_text(c, &self.o.null_text)))
                    .collect();
                writeln!(self.w, "| {} |", line.join(" | "))?;
            }
            ExportFormat::Json | ExportFormat::JsonLines => {
                // (key, JSON text) in column order
                let mut obj: Vec<(String, String)> = Vec::with_capacity(row.len());
                for (i, c) in row.iter().enumerate() {
                    let mut key = self
                        .cols
                        .get(i)
                        .cloned()
                        .unwrap_or_else(|| format!("column{i}"));
                    while obj.iter().any(|(k, _)| *k == key) {
                        key.push('_');
                    }
                    let ty = self.src_types.get(i).map(String::as_str).unwrap_or("");
                    obj.push((key, json_text(c, ty)));
                }
                let text = format!(
                    "{{{}}}",
                    obj.iter()
                        .map(|(k, v)| format!("{}:{v}", Value::String(k.clone())))
                        .collect::<Vec<_>>()
                        .join(",")
                );
                if self.o.format == ExportFormat::JsonLines {
                    writeln!(self.w, "{text}")?;
                } else {
                    write!(
                        self.w,
                        "{}\n  {text}",
                        if self.emitted == 0 { "" } else { "," }
                    )?;
                }
            }
            ExportFormat::SqlUpdate => {
                let key = self.key_cols();
                let mut set: Vec<usize> = (0..self.src_cols.len())
                    .filter(|i| !key.contains(i) || key.len() == self.src_cols.len())
                    .collect();
                if set.is_empty() {
                    set = key.clone();
                }
                let sets: Vec<String> = set
                    .iter()
                    .map(|&i| {
                        format!(
                            "{} = {}",
                            quote_ident(self.o.dialect, &self.src_cols[i]),
                            row.get(i)
                                .map(|c| self.lit(i, c))
                                .unwrap_or_else(|| "NULL".into())
                        )
                    })
                    .collect();
                let wheres: Vec<String> = key.iter().map(|&i| self.eq_pred(i, row)).collect();
                writeln!(
                    self.w,
                    "update {} set {} where {};",
                    self.table(),
                    sets.join(", "),
                    wheres.join(" and ")
                )?;
            }
            ExportFormat::WhereClause => {
                let key = self.key_cols();
                if key.len() == 1 {
                    // one key column: a single `in (...)` list, written by `finish`
                    let c = row.get(key[0]).cloned().unwrap_or(Value::Null);
                    self.batch.push(self.lit(key[0], &c));
                } else {
                    let preds: Vec<String> = key.iter().map(|&i| self.eq_pred(i, row)).collect();
                    write!(
                        self.w,
                        "{}({})",
                        if self.emitted == 0 {
                            "where "
                        } else {
                            "\n   or "
                        },
                        preds.join(" and ")
                    )?;
                }
            }
            ExportFormat::Html => {
                writeln!(self.w, "    <tr>")?;
                for c in row {
                    writeln!(
                        self.w,
                        "      <td>{}</td>",
                        Self::xml_text(&cell_text(c, &self.o.null_text))
                    )?;
                }
                writeln!(self.w, "    </tr>")?;
            }
            ExportFormat::Xml => {
                writeln!(self.w, "  <row>")?;
                for (i, c) in row.iter().enumerate() {
                    let name = Self::xml_name(
                        &self
                            .cols
                            .get(i)
                            .cloned()
                            .unwrap_or_else(|| format!("column{i}")),
                    );
                    if c.is_null() {
                        writeln!(self.w, "    <{name} null=\"true\"/>")?;
                    } else {
                        writeln!(
                            self.w,
                            "    <{name}>{}</{name}>",
                            Self::xml_text(&cell_text(c, ""))
                        )?;
                    }
                }
                writeln!(self.w, "  </row>")?;
            }
            ExportFormat::Pretty => {
                let line: Vec<String> = row
                    .iter()
                    .map(|c| {
                        cell_text(c, &self.o.null_text)
                            .replace('\r', "")
                            .replace('\n', "\\n")
                    })
                    .collect();
                self.text_rows.push(line);
            }
            ExportFormat::SqlInsert => {
                let vals: Vec<String> = row
                    .iter()
                    .enumerate()
                    .map(|(i, c)| self.lit(i, c))
                    .collect();
                self.batch.push(format!("({})", vals.join(", ")));
                if self.batch.len() >= self.o.rows_per_insert.max(1) {
                    self.flush_batch()?;
                }
            }
        }
        self.emitted += 1;
        Ok(())
    }

    fn flush_batch(&mut self) -> io::Result<()> {
        if self.batch.is_empty() {
            return Ok(());
        }
        let cols: Vec<String> = self
            .cols
            .iter()
            .map(|c| quote_ident(self.o.dialect, c))
            .collect();
        if self.o.dialect == Driver::Oracle && self.batch.len() > 1 {
            // no multi-row VALUES before 23ai: one `insert all` with a target per row
            let into = format!("into {} ({}) values ", self.table(), cols.join(", "));
            writeln!(
                self.w,
                "insert all\n    {}\nselect 1 from dual;",
                self.batch
                    .iter()
                    .map(|t| format!("{into}{t}"))
                    .collect::<Vec<_>>()
                    .join("\n    ")
            )?;
        } else {
            writeln!(
                self.w,
                "insert into {} ({}) values {};",
                self.table(),
                cols.join(", "),
                self.batch.join(",\n    ")
            )?;
        }
        self.batch.clear();
        Ok(())
    }

    /// The aligned text table: header, a rule, the rows (numbers are not special: every cell is left aligned).
    fn write_pretty(&mut self) -> io::Result<()> {
        let rows = std::mem::take(&mut self.text_rows);
        let n = rows.iter().map(Vec::len).max().unwrap_or(0);
        let width = |i: usize| {
            rows.iter()
                .filter_map(|r| r.get(i))
                .map(|c| c.chars().count())
                .max()
                .unwrap_or(0)
        };
        let widths: Vec<usize> = (0..n).map(width).collect();
        let line = |r: &Vec<String>| {
            (0..n)
                .map(|i| {
                    let c = r.get(i).map(String::as_str).unwrap_or("");
                    format!("{c}{}", " ".repeat(widths[i] - c.chars().count()))
                })
                .collect::<Vec<_>>()
                .join(" | ")
                .trim_end()
                .to_string()
        };
        for (k, r) in rows.iter().enumerate() {
            writeln!(self.w, "{}", line(r))?;
            if k == 0 {
                let rule = widths
                    .iter()
                    .map(|w| "-".repeat(*w))
                    .collect::<Vec<_>>()
                    .join("-+-");
                writeln!(self.w, "{rule}")?;
            }
        }
        Ok(())
    }

    /// Flush and return the writer and the number of rows written.
    pub fn finish(mut self) -> io::Result<(W, usize)> {
        if self.o.transpose && self.began {
            let held = std::mem::take(&mut self.held);
            let mut names = vec!["column".to_string()];
            names.extend((1..=held.len()).map(|i| i.to_string()));
            self.start(names)?;
            for (i, name) in self.src_cols.clone().into_iter().enumerate() {
                let mut row = vec![Value::String(name)];
                row.extend(
                    held.iter()
                        .map(|r| r.get(i).cloned().unwrap_or(Value::Null)),
                );
                self.emit(&row)?;
            }
        }
        match self.o.format {
            ExportFormat::Json => {
                if self.emitted == 0 {
                    writeln!(self.w, "]")?;
                } else {
                    writeln!(self.w, "\n]")?;
                }
            }
            ExportFormat::SqlInsert => self.flush_batch()?,
            ExportFormat::WhereClause => {
                if !self.batch.is_empty() {
                    let key = self.key_cols();
                    let col = quote_ident(self.o.dialect, &self.src_cols[key[0]]);
                    writeln!(self.w, "where {col} in ({})", self.batch.join(", "))?;
                    self.batch.clear();
                } else if self.emitted > 0 {
                    writeln!(self.w)?;
                }
            }
            ExportFormat::Html => writeln!(self.w, "  </tbody>\n</table>")?,
            ExportFormat::Xml => writeln!(self.w, "</result>")?,
            ExportFormat::Pretty => self.write_pretty()?,
            _ => {}
        }
        self.w.flush()?;
        Ok((self.w, self.rows))
    }
}

/// Export an in-memory result set. Returns the number of rows written (always UTF-8).
pub fn export_result<W: Write>(rs: &ResultSet, opts: &ExportOptions, w: W) -> Result<usize> {
    let mut o = opts.clone();
    o.encoding = ExportEncoding::Utf8;
    Ok(export_result_with(rs, &o, w, &CancellationToken::new(), |_| {})?.rows)
}

/// Export an in-memory result set with a cancellation token, progress events and the output
/// encoding of `opts`. Returns the rows written and how many characters could not be encoded.
pub fn export_result_with<W: Write>(
    rs: &ResultSet,
    opts: &ExportOptions,
    w: W,
    cancel: &CancellationToken,
    mut progress: impl FnMut(ExportProgress),
) -> Result<ExportReport> {
    let mut ew = EncodingWriter::new(w, opts.encoding);
    let mut e = Exporter::new(&mut ew, opts.clone());
    e.begin(&rs.columns)?;
    let total = rs.rows.len();
    let mut gate = ProgressGate::new();
    for (i, r) in rs.rows.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        e.row(r)?;
        if gate.due(Instant::now(), i + 1) {
            progress(ExportProgress {
                rows_written: i + 1,
                total: Some(total),
            });
        }
    }
    // a cancel that arrives after the last row still cancels (an empty result has no row to notice it)
    if cancel.is_cancelled() {
        return Err(DbError::Cancelled);
    }
    let rows = e.finish()?.1;
    if gate.unreported(rows) {
        progress(ExportProgress {
            rows_written: rows,
            total: Some(total),
        });
    }
    Ok(ExportReport {
        rows,
        unmappable: ew.unmappable(),
    })
}

/// Export a result set to a string.
pub fn export_to_string(rs: &ResultSet, opts: &ExportOptions) -> Result<String> {
    let mut buf = Vec::new();
    export_result(rs, opts, &mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

impl ConnectionManager {
    /// Run `sql` on the data source and stream **all** rows (not limited by the grid page
    /// size, binary values in full) into `w`. Returns the number of rows written. When the
    /// call produces several result sets, rows of those with a different column list than
    /// the first are skipped.
    pub async fn export_query<W: Write + Send>(
        &self,
        ds_id: &str,
        sql: &str,
        opts: &ExportOptions,
        w: W,
    ) -> Result<usize> {
        let mut o = opts.clone();
        o.encoding = ExportEncoding::Utf8;
        Ok(self
            .export_query_with(ds_id, sql, &o, w, &CancellationToken::new(), |_| {})
            .await?
            .rows)
    }

    /// `export_query` with a cancellation token, progress events and the output encoding of `opts`.
    pub async fn export_query_with<W: Write + Send>(
        &self,
        ds_id: &str,
        sql: &str,
        opts: &ExportOptions,
        w: W,
        cancel: &CancellationToken,
        progress: impl Fn(ExportProgress) + Send + Sync,
    ) -> Result<ExportReport> {
        let live = self.live(ds_id)?;
        let mut ew = EncodingWriter::new(w, opts.encoding);
        let mut e = Exporter::new(&mut ew, opts.clone());
        let mut written: usize = 0;
        let mut gate = ProgressGate::new();
        let cols = query_cancellable(&live, sql, usize::MAX, cancel, |cols, row| {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            if !e.began {
                e.begin(cols)?;
            } else if !cols.iter().map(|c| &c.name).eq(e.src_cols.iter()) {
                // a later result set of the same call with other columns: only the first
                // shape is exported (rows of equally shaped result sets are appended)
                return Ok(());
            }
            e.row(&row)?;
            written += 1;
            if gate.due(Instant::now(), written) {
                progress(ExportProgress {
                    rows_written: written,
                    total: None,
                });
            }
            Ok(())
        })
        .await;
        let cols = cols?;
        if cols.is_none() {
            // a result without rows: the cancel may come while its columns are described
            let c = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(DbError::Cancelled),
                c = describe_columns_pool(&live.pool, sql) => c,
            };
            e.begin(&c)?;
        }
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        let rows = e.finish()?.1;
        if gate.unreported(rows) {
            progress(ExportProgress {
                rows_written: rows,
                total: None,
            });
        }
        Ok(ExportReport {
            rows,
            unmappable: ew.unmappable(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rs() -> ResultSet {
        let col = |n: &str| ColumnMeta {
            name: n.into(),
            type_name: "text".into(),
            nullable: true,
            is_pk: false,
            table_ref: None,
        };
        ResultSet {
            columns: vec![col("id"), col("name"), col("data")],
            rows: vec![
                vec![
                    json!(1),
                    json!("a,b \"q\""),
                    json!({"$bin": "ff00", "len": 2}),
                ],
                vec![json!(2), Value::Null, json!(true)],
                vec![json!("9007199254740993"), json!("l1\nl2|x"), json!([1, 2])],
            ],
            has_more: false,
            total_hint: None,
            row_locators: None,
        }
    }

    fn run(f: ExportFormat, tweak: impl FnOnce(&mut ExportOptions)) -> String {
        let mut o = ExportOptions {
            format: f,
            ..Default::default()
        };
        tweak(&mut o);
        export_to_string(&rs(), &o).unwrap()
    }

    #[test]
    fn csv() {
        let out = run(ExportFormat::Csv, |_| {});
        assert_eq!(out, "id,name,data\n1,\"a,b \"\"q\"\"\",0xff00\n2,,true\n9007199254740993,\"l1\nl2|x\",\"[1,2]\"\n");
        let out = run(ExportFormat::Csv, |o| {
            o.delimiter = Some(';');
            o.header = false;
            o.null_text = "NULL".into();
        });
        assert!(
            out.starts_with("1;a,b \"\"q\"\" ") || out.starts_with("1;\"a,b"),
            "{out}"
        );
        assert!(out.contains("2;NULL;true"));
    }

    #[test]
    fn tsv_and_markdown() {
        let out = run(ExportFormat::Tsv, |o| o.null_text = "\\N".into());
        assert_eq!(out.lines().nth(2).unwrap(), "2\t\\N\ttrue");
        assert!(out.contains("l1\\nl2|x"));
        let md = run(ExportFormat::Markdown, |_| {});
        assert!(md.starts_with("| id | name | data |\n| --- | --- | --- |\n"));
        assert!(md.contains("l1<br>l2\\|x"));
    }

    #[test]
    fn row_header_and_transpose() {
        let out = run(ExportFormat::Csv, |o| o.row_header = true);
        assert_eq!(out.lines().next().unwrap(), ",id,name,data");
        assert!(
            out.lines().nth(2).unwrap().starts_with("2,2,,true"),
            "{out}"
        );
        let md = run(ExportFormat::Markdown, |o| o.row_header = true);
        assert!(md.starts_with("|  | id | name | data |\n"), "{md}");
        // not for formats that have no such column
        let sql = run(ExportFormat::SqlInsert, |o| o.row_header = true);
        assert!(
            sql.starts_with("insert into \"table_name\" (\"id\", \"name\", \"data\") values (1,"),
            "{sql}"
        );
        let t = run(ExportFormat::Csv, |o| o.transpose = true);
        let lines: Vec<&str> = t.lines().collect();
        assert_eq!(lines[0], "column,1,2,3");
        assert_eq!(lines[1], "id,1,2,9007199254740993");
        assert_eq!(lines[2], "name,\"a,b \"\"q\"\"\",,\"l1");
        let t = run(ExportFormat::Csv, |o| {
            o.transpose = true;
            o.header = false;
            o.row_header = true;
        });
        assert!(t.starts_with("1,id,1,2,9007199254740993\n2,name,"), "{t}");
        // the row count is the number of result rows
        let mut buf = Vec::new();
        let o = ExportOptions {
            transpose: true,
            ..Default::default()
        };
        assert_eq!(export_result(&rs(), &o, &mut buf).unwrap(), 3);
    }

    #[test]
    fn integral_floats_are_written_like_the_grid_shows_them() {
        let rs = ResultSet {
            columns: vec![
                ColumnMeta {
                    name: "r".into(),
                    type_name: "REAL".into(),
                    nullable: true,
                    is_pk: false,
                    table_ref: None,
                },
                ColumnMeta {
                    name: "a".into(),
                    type_name: "REAL".into(),
                    nullable: true,
                    is_pk: false,
                    table_ref: None,
                },
            ],
            rows: vec![vec![json!(3.0), json!(2.5)], vec![json!(-4.0), json!(7)]],
            ..Default::default()
        };
        let o = |format| ExportOptions {
            format,
            table_name: Some("t".into()),
            ..Default::default()
        };
        let csv = export_to_string(&rs, &o(ExportFormat::Csv)).unwrap();
        assert!(csv.contains("3,2.5") && csv.contains("-4,7"), "{csv}");
        let j = export_to_string(&rs, &o(ExportFormat::Json)).unwrap();
        assert!(
            j.contains(r#"{"r":3,"a":2.5}"#) && j.contains(r#"{"r":-4,"a":7}"#),
            "{j}"
        );
        let sql = export_to_string(&rs, &o(ExportFormat::SqlInsert)).unwrap();
        assert!(sql.contains("(3, 2.5)"), "{sql}");
    }

    #[test]
    fn json() {
        let out = run(ExportFormat::Json, |_| {});
        // keys keep the column order (not alphabetical: `name` is after `id`, `data` last)
        assert!(
            out.contains(r#"{"id":1,"name":"a,b \"q\"","data":"0xff00"}"#),
            "{out}"
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v[0],
            json!({"id": 1, "name": "a,b \"q\"", "data": "0xff00"})
        );
        assert_eq!(v[1]["name"], Value::Null);
        assert_eq!(v.as_array().unwrap().len(), 3);
        let empty = export_to_string(
            &ResultSet::default(),
            &ExportOptions {
                format: ExportFormat::Json,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&empty).unwrap(), json!([]));
    }

    /// A DECIMAL column of the result: values arrive as strings (`"1001.00"`) but are numbers.
    fn decimals() -> ResultSet {
        let col = |n: &str, t: &str| ColumnMeta {
            name: n.into(),
            type_name: t.into(),
            nullable: true,
            is_pk: false,
            table_ref: None,
        };
        ResultSet {
            columns: vec![
                col("amount", "NUMERIC(10,2)"),
                col("label", "text"),
                col("big", "bigint"),
            ],
            rows: vec![
                vec![
                    json!("1001.00"),
                    json!("1001.00"),
                    json!("9007199254740993"),
                ],
                vec![json!("-0.50"), json!("NaN"), json!("+5")],
                vec![json!("NaN"), json!("x"), Value::Null],
            ],
            ..Default::default()
        }
    }

    #[test]
    fn decimals_are_numbers_in_sql_and_json() {
        let o = |format| ExportOptions {
            format,
            table_name: Some("t".into()),
            ..Default::default()
        };
        let sql = export_to_string(&decimals(), &o(ExportFormat::SqlInsert)).unwrap();
        assert!(
            sql.contains("values (1001.00, '1001.00', 9007199254740993)"),
            "{sql}"
        );
        assert!(sql.contains("(-0.50, 'NaN', +5)"), "{sql}");
        // NaN is not a literal number: it stays a string
        assert!(sql.contains("('NaN', 'x', NULL)"), "{sql}");
        let json = export_to_string(&decimals(), &o(ExportFormat::Json)).unwrap();
        // the digits are kept as they are (no float round trip); "+5" is no JSON number, so it stays a string
        assert!(
            json.contains(r#"{"amount":1001.00,"label":"1001.00","big":9007199254740993}"#),
            "{json}"
        );
        assert!(
            json.contains(r#"{"amount":-0.50,"label":"NaN","big":"+5"}"#),
            "{json}"
        );
        assert!(
            json.contains(r#"{"amount":"NaN","label":"x","big":null}"#),
            "{json}"
        );
        assert!(serde_json::from_str::<Value>(&json).is_ok());
    }

    #[test]
    fn sql_insert_pg_arrays_are_array_literals() {
        let lit = |c: Value| sql_literal(Driver::Postgres, &c);
        assert_eq!(lit(json!([1, 2])), "'{1,2}'");
        assert_eq!(lit(json!([])), "'{}'");
        assert_eq!(lit(json!([1, null, "a"])), "'{1,NULL,\"a\"}'");
        assert_eq!(lit(json!([[1, 2], [3, 4]])), "'{{1,2},{3,4}}'");
        assert_eq!(lit(json!([true, false])), "'{true,false}'");
        assert_eq!(
            lit(json!([
                "",
                "NULL",
                "x,y",
                "{b}",
                "q\"t",
                "back\\slash",
                "it's"
            ])),
            "E'{\"\",\"NULL\",\"x,y\",\"{b}\",\"q\\\\\"t\",\"back\\\\\\\\slash\",\"it''s\"}'"
        );
        assert_eq!(
            lit(json!([{"$bin": "00ff", "len": 2}, null])),
            r#"E'{"\\\\x00ff",NULL}'"#
        );
        // other dialects have no array type: JSON text as before
        assert_eq!(sql_literal(Driver::MySql, &json!([1, 2])), "'[1,2]'");
    }

    #[test]
    fn sql_insert() {
        let out = run(ExportFormat::SqlInsert, |o| {
            o.table_name = Some("public.t".into())
        });
        let first = out.lines().next().unwrap();
        assert_eq!(first, "insert into \"public\".\"t\" (\"id\", \"name\", \"data\") values (1, 'a,b \"q\"', '\\xff00'::bytea);");
        assert!(out.contains("(2, NULL, true)"));
        let out = run(ExportFormat::SqlInsert, |o| {
            o.dialect = Driver::MySql;
            o.rows_per_insert = 2;
        });
        assert!(out.starts_with("insert into `table_name` (`id`, `name`, `data`) values (1, 'a,b \"q\"', X'ff00'),\n    (2, NULL, 1);"), "{out}");
    }

    /// A result with a primary key column (`id`), for the key based formats.
    #[test]
    fn sql_insert_oracle() {
        let col = |n: &str, t: &str, pk: bool| ColumnMeta {
            name: n.into(),
            type_name: t.into(),
            nullable: true,
            is_pk: pk,
            table_ref: None,
        };
        let rs = ResultSet {
            columns: vec![
                col("ID", "NUMBER", true),
                col("name", "VARCHAR2(20)", false),
                col("D", "DATE", false),
                col("TS", "TIMESTAMP(6)", false),
                col("TZ", "TIMESTAMP(6) WITH TIME ZONE", false),
                col("B", "BLOB", false),
                col("N", "NUMBER(30,10)", false),
            ],
            rows: vec![
                vec![
                    json!("1"),
                    json!("it's"),
                    json!("2024-02-29 13:45:10"),
                    json!("2024-02-29 13:45:10.5"),
                    json!("2024-02-29 13:45:10.5 +02:00"),
                    json!({"$bin": "cafe"}),
                    json!("12345678901234567890.1234567890"),
                ],
                vec![
                    json!(2),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    json!(true),
                ],
            ],
            has_more: false,
            total_hint: None,
            row_locators: None,
        };
        let opts = |n: usize| ExportOptions {
            format: ExportFormat::SqlInsert,
            dialect: Driver::Oracle,
            table_name: Some("DEMO.T".into()),
            rows_per_insert: n,
            ..Default::default()
        };
        let one = export_to_string(&rs, &opts(1)).unwrap();
        assert_eq!(
            one.lines().next().unwrap(),
            "insert into DEMO.T (ID, \"name\", D, TS, TZ, B, N) values (1, 'it''s', \
             TO_DATE('2024-02-29 13:45:10', 'YYYY-MM-DD HH24:MI:SS'), \
             TO_TIMESTAMP('2024-02-29 13:45:10.500000000', 'YYYY-MM-DD HH24:MI:SS.FF9'), \
             TO_TIMESTAMP_TZ('2024-02-29 13:45:10.500000000 +02:00', 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM'), \
             HEXTORAW('cafe'), 12345678901234567890.1234567890);"
        );
        assert!(
            one.contains("values (2, NULL, NULL, NULL, NULL, NULL, 1);"),
            "{one}"
        );
        // no multi-row VALUES: one `insert all`
        let all = export_to_string(&rs, &opts(10)).unwrap();
        assert!(
            all.starts_with("insert all\n    into DEMO.T (ID, "),
            "{all}"
        );
        assert!(all.ends_with("select 1 from dual;\n"), "{all}");
        assert_eq!(all.matches("\n    into DEMO.T").count(), 2, "{all}");
        assert_eq!(all.matches("into DEMO.T").count(), 2, "{all}");
        // update / where use the same literals
        let upd = export_to_string(
            &rs,
            &ExportOptions {
                format: ExportFormat::SqlUpdate,
                ..opts(1)
            },
        )
        .unwrap();
        assert!(
            upd.starts_with("update DEMO.T set \"name\" = 'it''s', D = TO_DATE("),
            "{upd}"
        );
        assert!(
            upd.lines().next().unwrap().ends_with("where ID = 1;"),
            "{upd}"
        );
    }

    fn rs_pk() -> ResultSet {
        let mut r = rs();
        r.columns[0].is_pk = true;
        r
    }

    fn run_pk(f: ExportFormat, tweak: impl FnOnce(&mut ExportOptions)) -> String {
        let mut o = ExportOptions {
            format: f,
            table_name: Some("public.t".into()),
            ..Default::default()
        };
        tweak(&mut o);
        export_to_string(&rs_pk(), &o).unwrap()
    }

    #[test]
    fn csv_variants_and_json_lines() {
        let pipe = run(ExportFormat::CsvPipe, |_| {});
        assert_eq!(pipe.lines().next().unwrap(), "id|name|data");
        assert!(pipe.contains("1|\"a,b \"\"q\"\"\"|0xff00"), "{pipe}");
        let semi = run(ExportFormat::CsvSemicolon, |_| {});
        assert_eq!(semi.lines().nth(2).unwrap(), "2;;true");
        let jl = run(ExportFormat::JsonLines, |_| {});
        let lines: Vec<&str> = jl.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(
            serde_json::from_str::<Value>(lines[0]).unwrap(),
            json!({"id": 1, "name": "a,b \"q\"", "data": "0xff00"})
        );
    }

    #[test]
    fn sql_update_and_where_clause() {
        let up = run_pk(ExportFormat::SqlUpdate, |_| {});
        assert_eq!(
            up.lines().next().unwrap(),
            "update \"public\".\"t\" set \"name\" = 'a,b \"q\"', \"data\" = '\\xff00'::bytea where \"id\" = 1;"
        );
        assert!(
            up.contains("set \"name\" = NULL, \"data\" = true where \"id\" = 2;"),
            "{up}"
        );
        // without a primary key every column identifies the row (NULL as `is null`)
        let all = run(ExportFormat::SqlUpdate, |o| o.dialect = Driver::MySql);
        assert!(
            all.contains("where `id` = 2 and `name` is null and `data` = 1;"),
            "{all}"
        );
        let w = run_pk(ExportFormat::WhereClause, |_| {});
        assert_eq!(w, "where \"id\" in (1, 2, '9007199254740993')\n");
        let w2 = run(ExportFormat::WhereClause, |_| {});
        // no key: every column identifies the row (no comment line: the text also goes to the clipboard)
        assert!(
            w2.starts_with("where (\"id\" = 1 and \"name\" = 'a,b \"q\"'"),
            "{w2}"
        );
        assert!(
            w2.contains("\n   or (\"id\" = 2 and \"name\" is null"),
            "{w2}"
        );
    }

    #[test]
    fn html_xml_and_pretty() {
        let h = run(ExportFormat::Html, |o| o.null_text = "NULL".into());
        assert!(
            h.starts_with("<table>\n  <thead>\n    <tr>\n      <th>id</th>"),
            "{h}"
        );
        assert!(
            h.contains("<td>NULL</td>") && h.ends_with("  </tbody>\n</table>\n"),
            "{h}"
        );
        let x = run(ExportFormat::Xml, |_| {});
        assert!(
            x.starts_with(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<result>\n  <row>\n    <id>1</id>"
            ),
            "{x}"
        );
        assert!(
            x.contains("<name null=\"true\"/>") && x.ends_with("</row>\n</result>\n"),
            "{x}"
        );
        assert_eq!(ExportFormat::Xml, ExportFormat::Xml);
        let p = run(ExportFormat::Pretty, |o| o.null_text = "-".into());
        let l: Vec<&str> = p.lines().collect();
        assert_eq!(l[0], "id               | name     | data");
        assert!(l[1].starts_with("-----------------+-"), "{p}");
        assert_eq!(l[3], "2                | -        | true");
    }

    // ---------------------------------------------------------------- encoding

    /// The bytes of a one-row CSV in `enc`.
    fn csv_bytes(enc: ExportEncoding, text: &str) -> Vec<u8> {
        let rs = ResultSet {
            columns: vec![ColumnMeta {
                name: "v".into(),
                type_name: "text".into(),
                nullable: true,
                is_pk: false,
                table_ref: None,
            }],
            rows: vec![vec![Value::String(text.into())]],
            ..Default::default()
        };
        let o = ExportOptions {
            encoding: enc,
            ..Default::default()
        };
        let mut buf = Vec::new();
        export_result_with(&rs, &o, &mut buf, &CancellationToken::new(), |_| {}).unwrap();
        buf
    }

    #[test]
    fn encoding_boms_and_utf16le() {
        // UTF-8: no BOM
        assert_eq!(csv_bytes(ExportEncoding::Utf8, "a"), b"v\na\n".to_vec());
        // UTF-8 with BOM
        assert_eq!(
            csv_bytes(ExportEncoding::Utf8Bom, "a"),
            b"\xEF\xBB\xBFv\na\n".to_vec()
        );
        // UTF-16LE: BOM FF FE, then each code unit little-endian (no BOM characters inside)
        let utf16 = csv_bytes(ExportEncoding::Utf16Le, "a");
        assert_eq!(&utf16[..2], &[0xFF, 0xFE]);
        assert_eq!(utf16.len(), 2 + 8, "{utf16:?}"); // BOM + "v\na\n" = 4 chars * 2
        assert_eq!(&utf16[2..4], &[b'v', 0]);
        assert_eq!(&utf16[4..6], &[b'\n', 0]);
        assert_eq!(&utf16[6..8], &[b'a', 0]);
        assert_eq!(&utf16[8..10], &[b'\n', 0]);
    }

    #[test]
    fn windows1252_replaces_unmappable_and_counts_them() {
        // 'é' (0xE9) is representable, '中' is not; a literal '?' stays a '?' (not counted)
        let out = csv_bytes(ExportEncoding::Windows1252, "café 中 ?");
        assert_eq!(out, b"v\ncaf\xE9 ? ?\n".to_vec(), "{out:?}");
        let report = {
            let rs = ResultSet {
                columns: vec![ColumnMeta {
                    name: "v".into(),
                    type_name: "text".into(),
                    nullable: true,
                    is_pk: false,
                    table_ref: None,
                }],
                rows: vec![vec![Value::String("café 中 ?".into())]],
                ..Default::default()
            };
            let o = ExportOptions {
                encoding: ExportEncoding::Windows1252,
                ..Default::default()
            };
            let mut buf = Vec::new();
            export_result_with(&rs, &o, &mut buf, &CancellationToken::new(), |_| {}).unwrap()
        };
        assert_eq!(report.unmappable, 1, "only the CJK character was lost");
        assert_eq!(report.rows, 1);
    }

    #[test]
    fn export_result_with_reports_progress_and_total() {
        let mut seen: Vec<(usize, Option<usize>)> = Vec::new();
        let o = ExportOptions::default();
        let mut buf = Vec::new();
        let report = export_result_with(&rs(), &o, &mut buf, &CancellationToken::new(), |p| {
            seen.push((p.rows_written, p.total));
        })
        .unwrap();
        assert_eq!(report.rows, 3);
        assert_eq!(report.unmappable, 0);
        // throttled: three quick rows give the final event only
        assert_eq!(seen, vec![(3, Some(3))]);
    }

    #[test]
    fn progress_is_throttled_and_ends_with_the_total() {
        let mut big = rs();
        let row = big.rows[0].clone();
        big.rows = vec![row; 5000];
        let mut seen: Vec<usize> = Vec::new();
        let mut buf = Vec::new();
        export_result_with(
            &big,
            &ExportOptions::default(),
            &mut buf,
            &CancellationToken::new(),
            |p| seen.push(p.rows_written),
        )
        .unwrap();
        // at most one event per 1000 rows (or 100 ms) plus the final one: nowhere near one per row
        assert!(seen.len() <= 5 + 1 + 40, "{} events", seen.len());
        assert!(seen.windows(2).all(|w| w[0] < w[1]), "{seen:?}");
        assert_eq!(*seen.last().unwrap(), 5000);
    }

    #[test]
    fn the_progress_gate_fires_per_rows_or_per_time() {
        let t0 = Instant::now();
        let mut g = ProgressGate {
            last: t0,
            last_rows: 0,
        };
        assert!(!g.due(t0, 1));
        assert!(!g.due(t0 + Duration::from_millis(99), 999));
        assert!(g.due(t0 + Duration::from_millis(99), 1000), "1000 rows");
        assert!(!g.due(t0 + Duration::from_millis(150), 1001));
        assert!(
            g.due(t0 + Duration::from_millis(200), 1001),
            "100 ms since the last event"
        );
        assert!(!g.due(t0 + Duration::from_millis(201), 1002));
    }

    #[test]
    fn a_cancel_of_an_empty_result_is_not_a_success() {
        let token = CancellationToken::new();
        token.cancel();
        let mut empty = rs();
        empty.rows.clear();
        let mut buf = Vec::new();
        let err = export_result_with(&empty, &ExportOptions::default(), &mut buf, &token, |_| {})
            .unwrap_err();
        assert!(matches!(err, DbError::Cancelled));
    }

    #[test]
    fn xml_declares_the_encoding_of_the_file() {
        let decl = |enc| {
            let rs = ResultSet {
                columns: rs().columns[..1].to_vec(),
                ..Default::default()
            };
            let o = ExportOptions {
                format: ExportFormat::Xml,
                encoding: enc,
                ..Default::default()
            };
            let mut buf = Vec::new();
            export_result_with(&rs, &o, &mut buf, &CancellationToken::new(), |_| {}).unwrap();
            buf
        };
        let utf8 = String::from_utf8(decl(ExportEncoding::Utf8)).unwrap();
        assert!(
            utf8.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"),
            "{utf8}"
        );
        let bom = decl(ExportEncoding::Utf8Bom);
        assert!(String::from_utf8_lossy(&bom).contains("encoding=\"UTF-8\""));
        let w = String::from_utf8(decl(ExportEncoding::Windows1252)).unwrap();
        assert!(
            w.starts_with("<?xml version=\"1.0\" encoding=\"windows-1252\"?>"),
            "{w}"
        );
        let u16: Vec<u16> = decl(ExportEncoding::Utf16Le)[2..]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let u16 = String::from_utf16(&u16).unwrap();
        assert!(
            u16.starts_with("<?xml version=\"1.0\" encoding=\"UTF-16\"?>"),
            "{u16}"
        );
    }

    #[test]
    fn export_result_with_cancel_returns_cancelled() {
        let token = CancellationToken::new();
        token.cancel();
        let mut buf = Vec::new();
        let err = export_result_with(&rs(), &ExportOptions::default(), &mut buf, &token, |_| {})
            .unwrap_err();
        assert!(matches!(err, DbError::Cancelled));
    }

    // ---------------------------------------------------------------- key columns

    #[test]
    fn key_columns_override_the_primary_key() {
        // `name` is declared the key although `id` is the primary key
        let mut r = rs_pk();
        r.columns[0].is_pk = true;
        let o = ExportOptions {
            format: ExportFormat::SqlUpdate,
            table_name: Some("public.t".into()),
            key_columns: Some(vec!["name".into()]),
            ..Default::default()
        };
        let up = export_to_string(&r, &o).unwrap();
        assert!(
            up.starts_with("update \"public\".\"t\" set \"id\" = 1, \"data\" = '\\xff00'::bytea where \"name\" = 'a,b \"q\"';"),
            "{up}"
        );
    }

    #[test]
    fn key_columns_matching_only_some_columns_fall_back_to_the_primary_key() {
        // `nope` is not a column: the key is not `name` alone but the primary key, as when nothing matches
        let o = ExportOptions {
            format: ExportFormat::WhereClause,
            key_columns: Some(vec!["name".into(), "nope".into()]),
            ..Default::default()
        };
        let w = export_to_string(&rs_pk(), &o).unwrap();
        assert_eq!(w, "where \"id\" in (1, 2, '9007199254740993')\n", "{w}");
    }

    #[test]
    fn key_columns_that_match_nothing_fall_back_to_the_primary_key() {
        let o = ExportOptions {
            format: ExportFormat::WhereClause,
            key_columns: Some(vec!["nope".into()]),
            ..Default::default()
        };
        let w = export_to_string(&rs_pk(), &o).unwrap();
        assert_eq!(w, "where \"id\" in (1, 2, '9007199254740993')\n", "{w}");
    }
}
