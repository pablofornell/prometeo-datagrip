//! Export of result sets / queries: CSV (comma, semicolon, pipe), TSV, JSON, JSON lines, SQL INSERT / UPDATE, WHERE clause,
//! Markdown, HTML table, XML, an aligned text table and an Excel workbook (file only, see [`ExportFormat::Xlsx`]).

use std::io::{self, Write};
use std::time::{Duration, Instant};

use rust_xlsxwriter::{Format, Workbook, Worksheet, XlsxError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{DbError, Result};
use crate::exec::query_cancellable;
use crate::import::CancellationToken;
use crate::manager::ConnectionManager;
use crate::model::*;
use crate::quote::{
    oracle_raw_literal, oracle_text_literal, oracle_time_kind, oracle_time_literal,
    parse_oracle_ts, quote_ident, quote_literal,
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
    /// Excel workbook (binary): written to a file only, never to the clipboard or a preview. The encoding does not
    /// apply. Header row bold, frozen and filtered; a new worksheet every 1,048,576 rows.
    Xlsx,
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
/// (written as `?`; only the Windows-1252 encoding is lossy), and how many Excel cells were cut to the length
/// a cell holds (xlsx only).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub rows: usize,
    pub unmappable: usize,
    pub truncated: usize,
}

/// Excel's limit of rows in a worksheet, the header included.
const XLSX_MAX_ROWS: usize = 1_048_576;
/// Excel's limit of columns in a worksheet.
const XLSX_MAX_COLS: usize = 16_384;
/// Excel's limit of the characters (UTF-16 units) of a cell.
const XLSX_MAX_CHARS: usize = 32_767;
/// The column widths are estimated from this many first rows.
const XLSX_WIDTH_ROWS: usize = 100;
/// The widest column the estimate gives, in characters.
const XLSX_MAX_WIDTH: f64 = 60.0;
/// Excel's serial number of 1900-03-01, the first date the workbook holds: Excel counts a 1900-02-29 that never
/// existed, so the earlier dates are written as text.
const XLSX_FIRST_SERIAL: f64 = 61.0;
/// Excel's serial number of 9999-12-31, the last date it holds.
const XLSX_LAST_SERIAL: f64 = 2_958_465.0;

const XLSX_NOT_TEXT: &str = "Excel (xlsx) is a binary file: export it to a file (it cannot be copied to the clipboard or shown as text)";

fn xlsx_err(e: XlsxError) -> DbError {
    match e {
        XlsxError::IoError(e) | XlsxError::TempFileError(_, e) => DbError::Io(e),
        other => DbError::InvalidArgument(format!("Excel export: {other}")),
    }
}

/// How the values of a column are written in an Excel workbook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum XlsxKind {
    /// Exact decimals, integers and floats: numbers (text when a number would lose digits).
    Number,
    /// A date without time (`yyyy-mm-dd`).
    Date,
    /// A date with time (`yyyy-mm-dd hh:mm:ss`). Oracle's DATE has a time, so it is this kind.
    DateTime,
    Text,
}

/// The kind of a column of declared type `ty` in a result of database `d`. Zoned times stay text: an Excel date has
/// no time zone, so the offset would be lost.
fn xlsx_kind(ty: &str, d: Driver) -> XlsxKind {
    let t = ty.trim().to_ascii_lowercase();
    let zoned = (t.contains("time zone") && !t.contains("without time zone"))
        || t.starts_with("timestamptz")
        || t.starts_with("timetz");
    if zoned {
        return XlsxKind::Text;
    }
    let base = t
        .split(|c: char| c == '(' || c.is_whitespace())
        .next()
        .unwrap_or("");
    match base {
        "date" if d == Driver::Oracle => XlsxKind::DateTime,
        "date" => XlsxKind::Date,
        "datetime" => XlsxKind::DateTime,
        b if b.starts_with("timestamp") => XlsxKind::DateTime,
        _ if is_numeric_type(ty) => XlsxKind::Number,
        _ => XlsxKind::Text,
    }
}

/// One cell of the workbook.
#[derive(Debug, Clone, PartialEq)]
enum XlsxVal {
    /// An empty cell.
    Blank,
    Number(f64),
    /// An Excel date serial; `time` tells whether the date-time format shows the time too.
    Date {
        serial: f64,
        time: bool,
    },
    Bool(bool),
    Text(String),
}

/// Excel's serial number of the date `y-m-d` plus `secs` seconds into the day; `None` outside the dates the
/// workbook holds (1900-03-01 to 9999-12-31).
fn excel_serial(y: i64, m: i64, d: i64, secs: f64) -> Option<f64> {
    // days since 1970-01-01 (proleptic Gregorian calendar, Howard Hinnant's algorithm)
    let days = |y: i64, m: i64, d: i64| {
        let y = if m <= 2 { y - 1 } else { y };
        let era = (if y >= 0 { y } else { y - 399 }) / 400;
        let yoe = y - era * 400;
        let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    };
    // 1899-12-30 is serial 0 (days since 1970-01-01 is -25569 there)
    let serial = (days(y, m, d) - days(1899, 12, 30)) as f64 + secs / 86_400.0;
    (XLSX_FIRST_SERIAL..=XLSX_LAST_SERIAL)
        .contains(&serial.floor())
        .then_some(serial)
}

/// The workbook value of a date / time text (`2024-02-29 13:45:10.5`) of a column of `kind`; `None` when the text is
/// no date the workbook holds (a zoned one included).
fn xlsx_date(text: &str, kind: XlsxKind) -> Option<XlsxVal> {
    let ts = parse_oracle_ts(text)?;
    if ts.tz.is_some() {
        return None;
    }
    let part = |s: &str, i: usize| s.split(':').nth(i)?.parse::<i64>().ok();
    let ymd: Vec<i64> = ts.date.split('-').filter_map(|p| p.parse().ok()).collect();
    let (y, m, d) = (*ymd.first()?, *ymd.get(1)?, *ymd.get(2)?);
    let (h, mi, s) = (part(&ts.time, 0)?, part(&ts.time, 1)?, part(&ts.time, 2)?);
    let frac: f64 = if ts.frac.is_empty() {
        0.0
    } else {
        format!("0.{}", ts.frac).parse().ok()?
    };
    let secs = (h * 3600 + mi * 60 + s) as f64 + frac;
    let serial = excel_serial(y, m, d, secs)?;
    Some(XlsxVal::Date {
        serial,
        time: kind == XlsxKind::DateTime || secs > 0.0,
    })
}

/// The number of a decimal text that a double holds exactly: at most 15 significant digits (a double prints back the
/// same digits). `None` for anything else (`NaN`, exponents, more digits).
fn decimal_value(s: &str) -> Option<f64> {
    let t = s.trim();
    let body = t.strip_prefix(['-', '+']).unwrap_or(t);
    let digits = body.bytes().filter(u8::is_ascii_digit).count();
    let shaped = digits > 0
        && digits <= 15
        && body.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && body.matches('.').count() <= 1;
    if !shaped {
        return None;
    }
    t.parse::<f64>().ok().filter(|f| f.is_finite())
}

/// `s` cut to the characters an Excel cell holds; `None` when it fits.
fn cut_for_cell(s: &str) -> Option<&str> {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > XLSX_MAX_CHARS {
            return Some(&s[..i]);
        }
    }
    None
}

/// Text of a cell, cut to the length a cell holds (`truncated` counts the cells cut).
fn text_value(s: &str, truncated: &mut usize) -> XlsxVal {
    match cut_for_cell(s) {
        Some(head) => {
            *truncated += 1;
            XlsxVal::Text(head.to_string())
        }
        None => XlsxVal::Text(s.to_string()),
    }
}

/// The workbook value of cell `c` of a column of `kind`. NULL is `null` (a blank cell when that is empty). Binary
/// values are their `0x...` text, arrays and objects their JSON text.
fn xlsx_value(c: &Cell, kind: XlsxKind, null: &str, truncated: &mut usize) -> XlsxVal {
    match c {
        Value::Null if null.is_empty() => XlsxVal::Blank,
        Value::Null => text_value(null, truncated),
        Value::Bool(b) => XlsxVal::Bool(*b),
        // a JSON number is written as a number unless it is an integer of more than 15 digits
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() || f.abs() < 1e15 => XlsxVal::Number(f),
            _ => text_value(&n.to_string(), truncated),
        },
        Value::String(s) => match kind {
            XlsxKind::Date | XlsxKind::DateTime => {
                xlsx_date(s, kind).unwrap_or_else(|| text_value(s, truncated))
            }
            XlsxKind::Number => decimal_value(s)
                .map(XlsxVal::Number)
                .unwrap_or_else(|| text_value(s, truncated)),
            XlsxKind::Text => text_value(s, truncated),
        },
        other => text_value(&cell_text(other, ""), truncated),
    }
}

/// The width a value takes on screen, for the column width estimate.
fn shown_len(v: &XlsxVal) -> usize {
    match v {
        XlsxVal::Blank => 0,
        XlsxVal::Number(_) => 12,
        XlsxVal::Date { time: true, .. } => 19,
        XlsxVal::Date { time: false, .. } => 10,
        XlsxVal::Bool(_) => 5,
        XlsxVal::Text(s) => s.chars().count(),
    }
}

/// Column width (in characters) of a column whose longest text is `longest` characters.
fn column_width(longest: usize) -> f64 {
    (longest as f64 + 2.0).clamp(8.0, XLSX_MAX_WIDTH)
}

/// Writes one cell (a blank cell is left out).
fn write_cell(
    ws: &mut Worksheet,
    row: u32,
    col: u16,
    v: &XlsxVal,
    date: &Format,
    date_time: &Format,
) -> std::result::Result<(), XlsxError> {
    match v {
        XlsxVal::Blank => Ok(()),
        XlsxVal::Number(n) => ws.write_number(row, col, *n).map(|_| ()),
        XlsxVal::Date { serial, time } => ws
            .write_number_with_format(row, col, *serial, if *time { date_time } else { date })
            .map(|_| ()),
        XlsxVal::Bool(b) => ws.write_boolean(row, col, *b).map(|_| ()),
        XlsxVal::Text(s) => ws.write_string(row, col, s.as_str()).map(|_| ()),
    }
}

/// The Excel workbook of an export. A worksheet holds `max_rows` rows (the header row included, repeated on each
/// worksheet). Rows are written in constant memory mode: the sheet data goes to a temporary file as the rows come,
/// so a million rows do not sit in memory.
struct XlsxBook {
    wb: Workbook,
    head: Format,
    date: Format,
    date_time: Format,
    /// Column names of the result (the shape check of the query exports).
    src_cols: Vec<String>,
    /// Header names of the output columns (the row number column first when asked), and their kinds.
    names: Vec<String>,
    kinds: Vec<XlsxKind>,
    /// The first column is the row number (`row_header`).
    numbered: bool,
    header: bool,
    null_text: String,
    max_rows: usize,
    /// Rows of each worksheet written so far, the header included (the last one is the open worksheet).
    sheet_rows: Vec<usize>,
    /// Data rows written.
    rows: usize,
    /// The longest text per output column over the first rows (the header included).
    widths: Vec<usize>,
    truncated: usize,
}

impl XlsxBook {
    /// A workbook for the result `columns` written with `opts` (`max_rows` per worksheet, at least 2).
    fn new(opts: &ExportOptions, columns: &[ColumnMeta], max_rows: usize) -> Result<Self> {
        if opts.transpose {
            return Err(DbError::InvalidArgument(
                "Transpose is not available for Excel (xlsx)".into(),
            ));
        }
        let mut truncated = 0;
        let mut names = Vec::new();
        let mut kinds = Vec::new();
        if opts.row_header {
            names.push(String::new());
            kinds.push(XlsxKind::Number);
        }
        for c in columns {
            names.push(match cut_for_cell(&c.name) {
                Some(head) => {
                    truncated += 1;
                    head.to_string()
                }
                None => c.name.clone(),
            });
            kinds.push(xlsx_kind(&c.type_name, opts.dialect));
        }
        if names.len() > XLSX_MAX_COLS {
            return Err(DbError::InvalidArgument(format!(
                "Excel holds {XLSX_MAX_COLS} columns; the result has {}",
                names.len()
            )));
        }
        let mut book = XlsxBook {
            wb: Workbook::new(),
            head: Format::new().set_bold(),
            date: Format::new().set_num_format("yyyy-mm-dd"),
            date_time: Format::new().set_num_format("yyyy-mm-dd hh:mm:ss"),
            src_cols: columns.iter().map(|c| c.name.clone()).collect(),
            widths: names.iter().map(|n| n.chars().count()).collect(),
            names,
            kinds,
            numbered: opts.row_header,
            header: opts.header,
            null_text: opts.null_text.clone(),
            max_rows: max_rows.max(2),
            sheet_rows: Vec::new(),
            rows: 0,
            truncated,
        };
        book.start_sheet()?;
        Ok(book)
    }

    /// Does the result have the columns `columns` (the rows of a later result set of the same call are skipped
    /// otherwise, as in the text exports)?
    fn same_columns(&self, columns: &[ColumnMeta]) -> bool {
        columns.iter().map(|c| &c.name).eq(self.src_cols.iter())
    }

    /// Data rows written so far.
    fn rows(&self) -> usize {
        self.rows
    }

    /// Adds a worksheet (`Sheet1`, `Sheet2`...) with the header row.
    fn start_sheet(&mut self) -> Result<()> {
        let ws = self
            .wb
            .add_worksheet_with_constant_memory()
            .map_err(xlsx_err)?;
        let mut used = 0;
        if self.header {
            ws.set_freeze_panes(1, 0).map_err(xlsx_err)?;
            for (c, name) in self.names.iter().enumerate() {
                ws.write_string_with_format(0, c as u16, name.as_str(), &self.head)
                    .map_err(xlsx_err)?;
            }
            used = 1;
        }
        self.sheet_rows.push(used);
        Ok(())
    }

    /// Writes one row of the result (the next row of the open worksheet, or of a new one when it is full).
    fn row(&mut self, row: &[Cell]) -> Result<()> {
        if self.sheet_rows.last().copied().unwrap_or(0) >= self.max_rows {
            self.start_sheet()?;
        }
        let at = self.sheet_rows.last().copied().unwrap_or(0);
        let skip = usize::from(self.numbered);
        let mut vals = Vec::with_capacity(self.names.len());
        if self.numbered {
            vals.push(XlsxVal::Number((self.rows + 1) as f64));
        }
        let null = Value::Null;
        for i in 0..self.names.len() - skip {
            let c = row.get(i).unwrap_or(&null);
            vals.push(xlsx_value(
                c,
                self.kinds[i + skip],
                &self.null_text,
                &mut self.truncated,
            ));
        }
        if self.rows < XLSX_WIDTH_ROWS {
            for (w, v) in self.widths.iter_mut().zip(&vals) {
                *w = (*w).max(shown_len(v));
            }
        }
        let ws = self
            .wb
            .worksheets_mut()
            .last_mut()
            .ok_or_else(|| DbError::InvalidArgument("the workbook has no worksheet".into()))?;
        for (c, v) in vals.iter().enumerate() {
            write_cell(ws, at as u32, c as u16, v, &self.date, &self.date_time)
                .map_err(xlsx_err)?;
        }
        if let Some(n) = self.sheet_rows.last_mut() {
            *n += 1;
        }
        self.rows += 1;
        Ok(())
    }

    /// Sets the filter of the header rows and the column widths of every worksheet, then writes the file to `w`.
    fn finish<W: Write + Send>(mut self, w: W) -> Result<ExportReport> {
        let cols = self.names.len();
        for (ws, used) in self.wb.worksheets_mut().iter_mut().zip(&self.sheet_rows) {
            if self.header && cols > 0 && *used >= 2 {
                ws.autofilter(0, 0, (*used - 1) as u32, (cols - 1) as u16)
                    .map_err(xlsx_err)?;
            }
            for (c, longest) in self.widths.iter().enumerate() {
                ws.set_column_width(c as u16, column_width(*longest))
                    .map_err(xlsx_err)?;
            }
        }
        self.wb.save_to_writer(w).map_err(xlsx_err)?;
        Ok(ExportReport {
            rows: self.rows,
            unmappable: 0,
            truncated: self.truncated,
        })
    }
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
        if self.o.format == ExportFormat::Xlsx {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, XLSX_NOT_TEXT));
        }
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
            ExportFormat::Xlsx => {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, XLSX_NOT_TEXT))
            }
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
            ExportFormat::Xlsx => {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, XLSX_NOT_TEXT))
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

/// Export an in-memory result set. Returns the number of rows written (always UTF-8). Not for Excel (xlsx), which
/// is a file only: see [`export_result_with`].
pub fn export_result<W: Write + Send>(rs: &ResultSet, opts: &ExportOptions, w: W) -> Result<usize> {
    if opts.format == ExportFormat::Xlsx {
        return Err(DbError::Unsupported(XLSX_NOT_TEXT.into()));
    }
    let mut o = opts.clone();
    o.encoding = ExportEncoding::Utf8;
    Ok(export_result_with(rs, &o, w, &CancellationToken::new(), |_| {})?.rows)
}

/// Export an in-memory result set with a cancellation token, progress events and the output
/// encoding of `opts`. Returns the rows written and how many characters could not be encoded. An Excel
/// (xlsx) export writes the workbook to `w` (the encoding does not apply).
pub fn export_result_with<W: Write + Send>(
    rs: &ResultSet,
    opts: &ExportOptions,
    w: W,
    cancel: &CancellationToken,
    mut progress: impl FnMut(ExportProgress),
) -> Result<ExportReport> {
    if opts.format == ExportFormat::Xlsx {
        return export_result_xlsx(rs, opts, w, cancel, progress);
    }
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
        truncated: 0,
    })
}

/// The Excel workbook of an in-memory result set (see [`ExportFormat::Xlsx`]).
fn export_result_xlsx<W: Write + Send>(
    rs: &ResultSet,
    opts: &ExportOptions,
    w: W,
    cancel: &CancellationToken,
    mut progress: impl FnMut(ExportProgress),
) -> Result<ExportReport> {
    let mut book = XlsxBook::new(opts, &rs.columns, XLSX_MAX_ROWS)?;
    let total = rs.rows.len();
    let mut gate = ProgressGate::new();
    for (i, r) in rs.rows.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        book.row(r)?;
        if gate.due(Instant::now(), i + 1) {
            progress(ExportProgress {
                rows_written: i + 1,
                total: Some(total),
            });
        }
    }
    // a cancel that arrives after the last row still cancels (as in the text exports)
    if cancel.is_cancelled() {
        return Err(DbError::Cancelled);
    }
    let report = book.finish(w)?;
    if gate.unreported(report.rows) {
        progress(ExportProgress {
            rows_written: report.rows,
            total: Some(total),
        });
    }
    Ok(report)
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
        if opts.format == ExportFormat::Xlsx {
            return Err(DbError::Unsupported(XLSX_NOT_TEXT.into()));
        }
        let mut o = opts.clone();
        o.encoding = ExportEncoding::Utf8;
        Ok(self
            .export_query_with(ds_id, sql, &o, w, &CancellationToken::new(), |_| {})
            .await?
            .rows)
    }

    /// `export_query` with a cancellation token, progress events and the output encoding of `opts`. An Excel
    /// (xlsx) export writes the workbook to `w` (the encoding does not apply).
    pub async fn export_query_with<W: Write + Send>(
        &self,
        ds_id: &str,
        sql: &str,
        opts: &ExportOptions,
        w: W,
        cancel: &CancellationToken,
        progress: impl Fn(ExportProgress) + Send + Sync,
    ) -> Result<ExportReport> {
        if opts.format == ExportFormat::Xlsx {
            return self
                .export_query_xlsx(ds_id, sql, opts, w, cancel, progress)
                .await;
        }
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
            truncated: 0,
        })
    }

    /// `export_query_with` for an Excel workbook: the rows of the first result shape, as the text exports write them.
    async fn export_query_xlsx<W: Write + Send>(
        &self,
        ds_id: &str,
        sql: &str,
        opts: &ExportOptions,
        w: W,
        cancel: &CancellationToken,
        progress: impl Fn(ExportProgress) + Send + Sync,
    ) -> Result<ExportReport> {
        let live = self.live(ds_id)?;
        let mut book: Option<XlsxBook> = None;
        let mut gate = ProgressGate::new();
        let cols = query_cancellable(&live, sql, usize::MAX, cancel, |cols, row| {
            if cancel.is_cancelled() {
                return Err(DbError::Cancelled);
            }
            if book.is_none() {
                book = Some(XlsxBook::new(opts, cols, XLSX_MAX_ROWS)?);
            }
            let Some(b) = book.as_mut() else {
                return Ok(());
            };
            // a later result set of the same call with other columns: only the first shape is exported
            if !b.same_columns(cols) {
                return Ok(());
            }
            b.row(&row)?;
            let n = b.rows();
            if gate.due(Instant::now(), n) {
                progress(ExportProgress {
                    rows_written: n,
                    total: None,
                });
            }
            Ok(())
        })
        .await;
        cols?;
        let book = match book {
            Some(b) => b,
            None => {
                // a result without rows: the cancel may come while its columns are described
                let c = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(DbError::Cancelled),
                    c = describe_columns_pool(&live.pool, sql) => c,
                };
                XlsxBook::new(opts, &c, XLSX_MAX_ROWS)?
            }
        };
        if cancel.is_cancelled() {
            return Err(DbError::Cancelled);
        }
        let report = book.finish(w)?;
        if gate.unreported(report.rows) {
            progress(ExportProgress {
                rows_written: report.rows,
                total: None,
            });
        }
        Ok(report)
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

    // ---------------------------------------------------------------- Excel (xlsx)

    fn col_of(name: &str, ty: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            type_name: ty.into(),
            nullable: true,
            is_pk: false,
            table_ref: None,
        }
    }

    fn xlsx_opts() -> ExportOptions {
        ExportOptions {
            format: ExportFormat::Xlsx,
            dialect: Driver::Oracle,
            ..Default::default()
        }
    }

    /// Part `name` of the xlsx `bytes`, as text.
    fn xlsx_part(bytes: &[u8], name: &str) -> String {
        use std::io::Read;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut text = String::new();
        zip.by_name(name)
            .unwrap_or_else(|e| panic!("{name}: {e}"))
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    /// An Oracle-shaped result: NUMBER(38,10), DATE, TIMESTAMP, a zoned TIMESTAMP, a text and NULLs.
    fn xlsx_rs() -> ResultSet {
        ResultSet {
            columns: vec![
                col_of("N", "NUMBER(38,10)"),
                col_of("D", "DATE"),
                col_of("TS", "TIMESTAMP(6)"),
                col_of("TZ", "TIMESTAMP(6) WITH TIME ZONE"),
                col_of("NAME", "VARCHAR2(20)"),
            ],
            rows: vec![
                vec![
                    json!("12345678901234567890.1234567890"),
                    json!("2024-02-29 13:45:10"),
                    json!("2024-02-29 13:45:10.5"),
                    json!("2024-02-29 13:45:10.5 +00:00"),
                    json!("a & <b>"),
                ],
                vec![
                    json!("1001.50"),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Null,
                ],
            ],
            ..Default::default()
        }
    }

    fn book_bytes(rs: &ResultSet, opts: &ExportOptions) -> (Vec<u8>, ExportReport) {
        let mut buf = Vec::new();
        let report =
            export_result_with(rs, opts, &mut buf, &CancellationToken::new(), |_| {}).unwrap();
        (buf, report)
    }

    #[test]
    fn excel_serial_numbers_of_dates() {
        // 2024-01-01 is 45292; 1900-03-01 is 61 (the 1900 leap day Excel counts is not a date here)
        assert_eq!(excel_serial(2024, 1, 1, 0.0), Some(45292.0));
        assert_eq!(excel_serial(2024, 2, 29, 0.0), Some(45351.0));
        assert_eq!(excel_serial(2024, 2, 29, 12.0 * 3600.0), Some(45351.5));
        assert_eq!(excel_serial(1900, 3, 1, 0.0), Some(61.0));
        assert_eq!(excel_serial(9999, 12, 31, 0.0), Some(2_958_465.0));
        assert_eq!(excel_serial(1900, 2, 28, 0.0), None);
        assert_eq!(excel_serial(10000, 1, 1, 0.0), None);
    }

    #[test]
    fn excel_dates_and_times_of_the_text_of_a_column() {
        let secs = 13.0 * 3600.0 + 45.0 * 60.0 + 10.0;
        assert_eq!(
            xlsx_date("2024-02-29 13:45:10", XlsxKind::DateTime),
            Some(XlsxVal::Date {
                serial: 45351.0 + secs / 86_400.0,
                time: true
            })
        );
        // a DATE column with no time is written without one; a time of day makes it a date-time
        assert_eq!(
            xlsx_date("2024-02-29", XlsxKind::Date),
            Some(XlsxVal::Date {
                serial: 45351.0,
                time: false
            })
        );
        assert!(matches!(
            xlsx_date("2024-02-29 00:00:01", XlsxKind::Date),
            Some(XlsxVal::Date { time: true, .. })
        ));
        // the fraction of a second is kept
        let Some(XlsxVal::Date { serial, .. }) =
            xlsx_date("2024-02-29 00:00:00.5", XlsxKind::DateTime)
        else {
            panic!("a date");
        };
        assert!(
            (serial - (45351.0 + 0.5 / 86_400.0)).abs() < 1e-9,
            "{serial}"
        );
        // zoned, not a date, or outside the workbook: no date
        assert_eq!(
            xlsx_date("2024-02-29 13:45:10 +02:00", XlsxKind::DateTime),
            None
        );
        assert_eq!(xlsx_date("not a date", XlsxKind::DateTime), None);
        assert_eq!(xlsx_date("1800-01-01 00:00:00", XlsxKind::DateTime), None);
    }

    #[test]
    fn excel_kind_of_a_column_follows_its_declared_type() {
        let o = Driver::Oracle;
        assert_eq!(xlsx_kind("NUMBER(38,10)", o), XlsxKind::Number);
        assert_eq!(
            xlsx_kind("NUMERIC(10,2)", Driver::Postgres),
            XlsxKind::Number
        );
        assert_eq!(xlsx_kind("bigint", Driver::MySql), XlsxKind::Number);
        assert_eq!(
            xlsx_kind("DATE", o),
            XlsxKind::DateTime,
            "Oracle DATE has a time"
        );
        assert_eq!(xlsx_kind("date", Driver::Postgres), XlsxKind::Date);
        assert_eq!(xlsx_kind("DATETIME", Driver::MySql), XlsxKind::DateTime);
        assert_eq!(xlsx_kind("TIMESTAMP(6)", o), XlsxKind::DateTime);
        assert_eq!(
            xlsx_kind("timestamp without time zone", Driver::Postgres),
            XlsxKind::DateTime
        );
        assert_eq!(xlsx_kind("TIMESTAMP(6) WITH TIME ZONE", o), XlsxKind::Text);
        assert_eq!(
            xlsx_kind("TIMESTAMP(6) WITH LOCAL TIME ZONE", o),
            XlsxKind::Text
        );
        assert_eq!(xlsx_kind("timestamptz", Driver::Postgres), XlsxKind::Text);
        assert_eq!(xlsx_kind("VARCHAR2(20)", o), XlsxKind::Text);
        assert_eq!(xlsx_kind("CLOB", o), XlsxKind::Text);
        assert_eq!(xlsx_kind("", Driver::Sqlite), XlsxKind::Text);
    }

    #[test]
    fn excel_numbers_are_numbers_only_when_they_hold_exactly() {
        assert_eq!(decimal_value("1001.50"), Some(1001.5));
        assert_eq!(decimal_value("-0.5"), Some(-0.5));
        assert_eq!(
            decimal_value("123456789012345"),
            Some(123_456_789_012_345.0),
            "15 digits"
        );
        // 16 digits: a double could not print them back
        assert_eq!(decimal_value("1234567890123456"), None);
        assert_eq!(decimal_value("12345678901234567890.1234567890"), None);
        assert_eq!(decimal_value("NaN"), None);
        assert_eq!(decimal_value("Infinity"), None);
        assert_eq!(decimal_value("1e5"), None);
        assert_eq!(decimal_value(""), None);
        assert_eq!(decimal_value("1.2.3"), None);

        let cell = |v: Value| xlsx_value(&v, XlsxKind::Number, "", &mut 0);
        assert_eq!(cell(json!("1001.00")), XlsxVal::Number(1001.0));
        assert_eq!(
            cell(json!("12345678901234567890.1234567890")),
            XlsxVal::Text("12345678901234567890.1234567890".into())
        );
        assert_eq!(cell(json!(2.5)), XlsxVal::Number(2.5));
        assert_eq!(cell(json!(3.0)), XlsxVal::Number(3.0));
        assert_eq!(cell(json!(42)), XlsxVal::Number(42.0));
        // a 16-digit integer that arrives as a JSON number is text too
        assert_eq!(
            cell(json!(9007199254740993_i64)),
            XlsxVal::Text("9007199254740993".into())
        );
    }

    #[test]
    fn excel_cell_values_by_kind() {
        let mut t = 0;
        let mut v = |c: Value, k: XlsxKind, null: &str| xlsx_value(&c, k, null, &mut t);
        assert_eq!(v(Value::Null, XlsxKind::Text, ""), XlsxVal::Blank);
        assert_eq!(
            v(Value::Null, XlsxKind::Text, "NULL"),
            XlsxVal::Text("NULL".into())
        );
        assert_eq!(v(json!(true), XlsxKind::Text, ""), XlsxVal::Bool(true));
        // a text that looks like a number stays text (zip codes, codes)
        assert_eq!(
            v(json!("007"), XlsxKind::Text, ""),
            XlsxVal::Text("007".into())
        );
        // binary as hex text, arrays as JSON text
        assert_eq!(
            v(json!({"$bin": "ff00", "len": 2}), XlsxKind::Text, ""),
            XlsxVal::Text("0xff00".into())
        );
        assert_eq!(
            v(json!([1, 2]), XlsxKind::Text, ""),
            XlsxVal::Text("[1,2]".into())
        );
        // a date that does not parse is shown as it is
        assert_eq!(
            v(json!("soon"), XlsxKind::DateTime, ""),
            XlsxVal::Text("soon".into())
        );
        assert!(matches!(
            v(json!("2024-02-29 13:45:10"), XlsxKind::DateTime, ""),
            XlsxVal::Date { time: true, .. }
        ));
    }

    #[test]
    fn excel_text_is_cut_to_the_length_a_cell_holds() {
        assert_eq!(cut_for_cell("abc"), None);
        let max = "a".repeat(XLSX_MAX_CHARS);
        assert_eq!(cut_for_cell(&max), None, "exactly the limit fits");
        let over = format!("{max}b");
        assert_eq!(cut_for_cell(&over), Some(max.as_str()));
        // a character outside the BMP counts two units: it is cut as a whole, never in half
        let emoji_edge = format!("{}\u{1F600}", "a".repeat(XLSX_MAX_CHARS - 1));
        assert_eq!(
            cut_for_cell(&emoji_edge),
            Some(&emoji_edge[..XLSX_MAX_CHARS - 1])
        );
        let mut truncated = 0;
        assert_eq!(
            text_value(&over, &mut truncated),
            XlsxVal::Text(max.clone())
        );
        assert_eq!(truncated, 1);
    }

    #[test]
    fn excel_widths_are_estimated_and_capped() {
        assert_eq!(column_width(0), 8.0);
        assert_eq!(column_width(10), 12.0);
        assert_eq!(column_width(500), XLSX_MAX_WIDTH);
    }

    #[test]
    fn excel_workbook_holds_the_typed_cells_and_the_header_formats() {
        let (bytes, report) = book_bytes(&xlsx_rs(), &xlsx_opts());
        assert_eq!(report.rows, 2);
        assert_eq!(report.unmappable, 0);
        assert_eq!(report.truncated, 0);
        let sheet = xlsx_part(&bytes, "xl/worksheets/sheet1.xml");
        // header names as text
        for text in ["N", "D", "TS", "TZ", "NAME"] {
            assert!(
                sheet.contains(&format!("<t>{text}</t>")),
                "{text} in {sheet}"
            );
        }
        assert!(sheet.contains("<t>a &amp; &lt;b&gt;</t>"), "{sheet}");
        // the NUMBER of 20 digits is text, the 1001.50 is a number
        assert!(
            sheet.contains("<t>12345678901234567890.1234567890</t>"),
            "{sheet}"
        );
        assert!(sheet.contains("<v>1001.5</v>"), "{sheet}");
        // the zoned timestamp keeps its offset as text
        assert!(
            sheet.contains("<t>2024-02-29 13:45:10.5 +00:00</t>"),
            "{sheet}"
        );
        // the header is frozen and filtered over the used range
        assert!(sheet.contains("state=\"frozen\""), "{sheet}");
        assert!(sheet.contains("<autoFilter ref=\"A1:E3\""), "{sheet}");
        let styles = xlsx_part(&bytes, "xl/styles.xml");
        assert!(styles.contains("yyyy-mm-dd hh:mm:ss"), "{styles}");
        assert!(styles.contains("<b/>"), "the bold header: {styles}");
    }

    #[test]
    fn excel_row_header_null_text_and_no_header() {
        let rs = xlsx_rs();
        let o = ExportOptions {
            row_header: true,
            null_text: "NULL".into(),
            ..xlsx_opts()
        };
        let (bytes, _) = book_bytes(&rs, &o);
        let sheet = xlsx_part(&bytes, "xl/worksheets/sheet1.xml");
        // the row number column comes first, the NULLs are the null text
        assert!(
            sheet.contains("<c r=\"A2\"") && sheet.contains("<v>1</v>"),
            "{sheet}"
        );
        assert!(sheet.contains("<t>NULL</t>"), "{sheet}");
        assert!(sheet.contains("<autoFilter ref=\"A1:F3\""), "{sheet}");
        let o = ExportOptions {
            header: false,
            ..xlsx_opts()
        };
        let (bytes, _) = book_bytes(&rs, &o);
        let sheet = xlsx_part(&bytes, "xl/worksheets/sheet1.xml");
        assert!(!sheet.contains("<t>N</t>"), "no header row: {sheet}");
        assert!(!sheet.contains("state=\"frozen\""), "{sheet}");
        assert!(!sheet.contains("<autoFilter"), "{sheet}");
    }

    #[test]
    fn excel_rows_split_into_worksheets_with_the_header_repeated() {
        // three rows per worksheet, the header row included: two data rows each, then one
        let cols = xlsx_rs().columns;
        let mut book = XlsxBook::new(&xlsx_opts(), &cols, 3).unwrap();
        let row = |i: i64| {
            vec![
                json!(i),
                Value::Null,
                Value::Null,
                Value::Null,
                json!(format!("r{i}")),
            ]
        };
        for i in 1..=5 {
            book.row(&row(i)).unwrap();
        }
        let mut buf = Vec::new();
        let report = book.finish(&mut buf).unwrap();
        assert_eq!(report.rows, 5, "data rows only");
        let sheet1 = xlsx_part(&buf, "xl/worksheets/sheet1.xml");
        let sheet2 = xlsx_part(&buf, "xl/worksheets/sheet2.xml");
        let sheet3 = xlsx_part(&buf, "xl/worksheets/sheet3.xml");
        assert!(
            sheet1.contains("<t>r2</t>") && !sheet1.contains("<t>r3</t>"),
            "{sheet1}"
        );
        assert!(sheet2.contains("<t>N</t>"), "the header again: {sheet2}");
        assert!(
            sheet2.contains("<t>r3</t>") && sheet2.contains("<t>r4</t>"),
            "{sheet2}"
        );
        assert!(
            sheet3.contains("<t>r5</t>") && sheet3.contains("<t>N</t>"),
            "{sheet3}"
        );
        assert!(zip::ZipArchive::new(std::io::Cursor::new(&buf))
            .unwrap()
            .by_name("xl/worksheets/sheet4.xml")
            .is_err());
    }

    /// The real limit: 1,048,575 data rows fill the first worksheet with its header, the last row goes to `Sheet2`.
    #[test]
    #[ignore = "writes 1,048,576 rows: run with --ignored (slow in a debug build)"]
    fn excel_real_row_limit_starts_sheet2() {
        let mut book =
            XlsxBook::new(&xlsx_opts(), &[col_of("N", "NUMBER")], XLSX_MAX_ROWS).unwrap();
        for i in 0..XLSX_MAX_ROWS {
            book.row(&[json!(i)]).unwrap();
        }
        let mut buf = Vec::new();
        let report = book.finish(&mut buf).unwrap();
        assert_eq!(report.rows, XLSX_MAX_ROWS);
        let sheet1 = xlsx_part(&buf, "xl/worksheets/sheet1.xml");
        assert!(
            sheet1.contains("<autoFilter ref=\"A1:A1048576\""),
            "last row of Sheet1"
        );
        let sheet2 = xlsx_part(&buf, "xl/worksheets/sheet2.xml");
        assert!(
            sheet2.contains("<t>N</t>") && sheet2.contains("<autoFilter ref=\"A1:A2\""),
            "{sheet2}"
        );
    }

    #[test]
    fn excel_is_a_file_only_format() {
        // the clipboard and the preview are text: they refuse it with the reason
        let err = export_to_string(&xlsx_rs(), &xlsx_opts()).unwrap_err();
        assert!(
            matches!(err, DbError::Unsupported(ref m) if m.contains("binary")),
            "{err:?}"
        );
        let mut buf = Vec::new();
        let err = export_result(&xlsx_rs(), &xlsx_opts(), &mut buf).unwrap_err();
        assert!(matches!(err, DbError::Unsupported(_)));
        assert!(buf.is_empty());
        // the text writer refuses it if it is reached some other way
        let mut e = Exporter::new(Vec::new(), xlsx_opts());
        assert!(e.begin(&xlsx_rs().columns).is_err());
        // transpose cannot be laid out in a workbook
        let o = ExportOptions {
            transpose: true,
            ..xlsx_opts()
        };
        assert!(matches!(
            export_result_with(
                &xlsx_rs(),
                &o,
                Vec::new(),
                &CancellationToken::new(),
                |_| {}
            ),
            Err(DbError::InvalidArgument(_))
        ));
    }

    #[test]
    fn excel_export_stops_on_cancel() {
        let token = CancellationToken::new();
        token.cancel();
        let err =
            export_result_with(&xlsx_rs(), &xlsx_opts(), Vec::new(), &token, |_| {}).unwrap_err();
        assert!(matches!(err, DbError::Cancelled));
    }

    #[test]
    fn excel_text_cells_past_the_limit_are_counted_in_the_report() {
        let rs = ResultSet {
            columns: vec![col_of("T", "CLOB")],
            rows: vec![
                vec![json!("x".repeat(XLSX_MAX_CHARS + 10))],
                vec![json!("short")],
            ],
            ..Default::default()
        };
        let (bytes, report) = book_bytes(&rs, &xlsx_opts());
        assert_eq!(report.truncated, 1);
        assert_eq!(report.rows, 2);
        let sheet = xlsx_part(&bytes, "xl/worksheets/sheet1.xml");
        assert!(
            sheet.contains(&format!("<t>{}</t>", "x".repeat(XLSX_MAX_CHARS))),
            "the cut text"
        );
        assert!(!sheet.contains(&"x".repeat(XLSX_MAX_CHARS + 1)));
    }
}
