//! Export of result sets / queries: CSV, TSV, JSON, SQL INSERT, Markdown table.

use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::exec::query_pool;
use crate::manager::ConnectionManager;
use crate::model::*;
use crate::quote::{quote_ident, quote_literal};
use crate::value::describe_columns_pool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    SqlInsert,
    Markdown,
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
        }
    }
}

/// Plain text of a cell (binary as `0x...`).
fn cell_text(c: &Cell, null: &str) -> String {
    match c {
        Value::Null => null.to_string(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Object(m) if m.contains_key("$bin") => format!("0x{}", m["$bin"].as_str().unwrap_or("")),
        other => other.to_string(),
    }
}

/// JSON value with binary cells replaced by `"0x..."` strings.
fn cell_json(c: &Cell) -> Value {
    match c {
        Value::Object(m) if m.contains_key("$bin") => Value::String(cell_text(c, "")),
        other => other.clone(),
    }
}

/// One element (or nested array) of a PG array literal `{..}`.
fn pg_array_element(c: &Cell) -> String {
    let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    match c {
        Value::Null => "NULL".into(),
        Value::Array(a) => format!("{{{}}}", a.iter().map(pg_array_element).collect::<Vec<_>>().join(",")),
        Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => quote(s),
        // bytea element: hex input form
        Value::Object(m) if m.contains_key("$bin") => quote(&format!("\\x{}", m["$bin"].as_str().unwrap_or(""))),
        other => quote(&other.to_string()),
    }
}

fn sql_literal(d: Driver, c: &Cell) -> String {
    match c {
        // PG arrays arrive as JSON arrays: write them back as an array literal ('{1,2}')
        Value::Array(_) if d == Driver::Postgres => quote_literal(d, &pg_array_element(c)),
        Value::Null => "NULL".into(),
        Value::Bool(b) => match d {
            Driver::Postgres => if *b { "true" } else { "false" }.into(),
            _ => if *b { "1" } else { "0" }.into(),
        },
        Value::Number(n) => n.to_string(),
        Value::String(s) => quote_literal(d, s),
        Value::Object(m) if m.contains_key("$bin") => {
            let hex = m["$bin"].as_str().unwrap_or("");
            match d {
                Driver::Postgres => format!("'\\x{hex}'::bytea"),
                _ => format!("X'{hex}'"),
            }
        }
        other => quote_literal(d, &other.to_string()),
    }
}

/// Streaming writer: `begin` once, `row` for each row, then `finish`.
pub struct Exporter<W: Write> {
    w: W,
    o: ExportOptions,
    cols: Vec<String>,
    rows: usize,
    began: bool,
    batch: Vec<String>,
}

impl<W: Write> Exporter<W> {
    pub fn new(w: W, opts: ExportOptions) -> Self {
        Exporter { w, o: opts, cols: Vec::new(), rows: 0, began: false, batch: Vec::new() }
    }

    fn delim(&self) -> char {
        match self.o.format {
            ExportFormat::Tsv => '\t',
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
        s.replace('\\', "\\\\").replace('\t', "\\t").replace('\n', "\\n").replace('\r', "\\r")
    }

    fn md_field(s: &str) -> String {
        s.replace('|', "\\|").replace('\r', "").replace('\n', "<br>")
    }

    fn table(&self) -> String {
        let name = self.o.table_name.clone().unwrap_or_else(|| "table_name".into());
        name.split('.').map(|p| quote_ident(self.o.dialect, p)).collect::<Vec<_>>().join(".")
    }

    pub fn begin(&mut self, columns: &[ColumnMeta]) -> io::Result<()> {
        self.cols = columns.iter().map(|c| c.name.clone()).collect();
        self.began = true;
        match self.o.format {
            ExportFormat::Csv | ExportFormat::Tsv => {
                if self.o.header {
                    let line: Vec<String> = self
                        .cols
                        .iter()
                        .map(|c| if self.o.format == ExportFormat::Tsv { Self::tsv_field(c) } else { self.csv_field(c) })
                        .collect();
                    writeln!(self.w, "{}", line.join(&self.delim().to_string()))?;
                }
            }
            ExportFormat::Json => write!(self.w, "[")?,
            ExportFormat::Markdown => {
                let head: Vec<String> = self.cols.iter().map(|c| Self::md_field(c)).collect();
                writeln!(self.w, "| {} |", head.join(" | "))?;
                writeln!(self.w, "|{}|", self.cols.iter().map(|_| " --- ").collect::<Vec<_>>().join("|"))?;
            }
            ExportFormat::SqlInsert => {}
        }
        Ok(())
    }

    pub fn row(&mut self, row: &[Cell]) -> io::Result<()> {
        match self.o.format {
            ExportFormat::Csv => {
                let line: Vec<String> = row.iter().map(|c| self.csv_field(&cell_text(c, &self.o.null_text))).collect();
                writeln!(self.w, "{}", line.join(&self.delim().to_string()))?;
            }
            ExportFormat::Tsv => {
                let line: Vec<String> = row
                    .iter()
                    .map(|c| if c.is_null() { self.o.null_text.clone() } else { Self::tsv_field(&cell_text(c, "")) })
                    .collect();
                writeln!(self.w, "{}", line.join("\t"))?;
            }
            ExportFormat::Markdown => {
                let line: Vec<String> = row.iter().map(|c| Self::md_field(&cell_text(c, &self.o.null_text))).collect();
                writeln!(self.w, "| {} |", line.join(" | "))?;
            }
            ExportFormat::Json => {
                let mut obj = serde_json::Map::new();
                for (i, c) in row.iter().enumerate() {
                    let mut key = self.cols.get(i).cloned().unwrap_or_else(|| format!("column{i}"));
                    while obj.contains_key(&key) {
                        key.push('_');
                    }
                    obj.insert(key, cell_json(c));
                }
                write!(self.w, "{}\n  ", if self.rows == 0 { "" } else { "," })?;
                serde_json::to_writer(&mut self.w, &Value::Object(obj))?;
            }
            ExportFormat::SqlInsert => {
                let vals: Vec<String> = row.iter().map(|c| sql_literal(self.o.dialect, c)).collect();
                self.batch.push(format!("({})", vals.join(", ")));
                if self.batch.len() >= self.o.rows_per_insert.max(1) {
                    self.flush_batch()?;
                }
            }
        }
        self.rows += 1;
        Ok(())
    }

    fn flush_batch(&mut self) -> io::Result<()> {
        if self.batch.is_empty() {
            return Ok(());
        }
        let cols: Vec<String> = self.cols.iter().map(|c| quote_ident(self.o.dialect, c)).collect();
        writeln!(self.w, "insert into {} ({}) values {};", self.table(), cols.join(", "), self.batch.join(",\n    "))?;
        self.batch.clear();
        Ok(())
    }

    /// Flush and return the writer and the number of rows written.
    pub fn finish(mut self) -> io::Result<(W, usize)> {
        match self.o.format {
            ExportFormat::Json => {
                if self.rows == 0 {
                    writeln!(self.w, "]")?;
                } else {
                    writeln!(self.w, "\n]")?;
                }
            }
            ExportFormat::SqlInsert => self.flush_batch()?,
            _ => {}
        }
        self.w.flush()?;
        Ok((self.w, self.rows))
    }
}

/// Export an in-memory result set. Returns the number of rows written.
pub fn export_result<W: Write>(rs: &ResultSet, opts: &ExportOptions, w: W) -> Result<usize> {
    let mut e = Exporter::new(w, opts.clone());
    e.begin(&rs.columns)?;
    for r in &rs.rows {
        e.row(r)?;
    }
    Ok(e.finish()?.1)
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
    pub async fn export_query<W: Write + Send>(&self, ds_id: &str, sql: &str, opts: &ExportOptions, w: W) -> Result<usize> {
        let live = self.live(ds_id)?;
        let mut e = Exporter::new(w, opts.clone());
        let cols = query_pool(&live, sql, usize::MAX, |cols, row| {
            if !e.began {
                e.begin(cols)?;
            } else if !cols.iter().map(|c| &c.name).eq(e.cols.iter()) {
                // a later result set of the same call with other columns: only the first
                // shape is exported (rows of equally shaped result sets are appended)
                return Ok(());
            }
            e.row(&row)?;
            Ok(())
        })
        .await;
        let cols = cols?;
        if cols.is_none() {
            let c = describe_columns_pool(&live.pool, sql).await;
            e.begin(&c)?;
        }
        Ok(e.finish()?.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rs() -> ResultSet {
        let col = |n: &str| ColumnMeta { name: n.into(), type_name: "text".into(), nullable: true, is_pk: false, table_ref: None };
        ResultSet {
            columns: vec![col("id"), col("name"), col("data")],
            rows: vec![
                vec![json!(1), json!("a,b \"q\""), json!({"$bin": "ff00", "len": 2})],
                vec![json!(2), Value::Null, json!(true)],
                vec![json!("9007199254740993"), json!("l1\nl2|x"), json!([1, 2])],
            ],
            has_more: false,
            total_hint: None,
            row_locators: None,
        }
    }

    fn run(f: ExportFormat, tweak: impl FnOnce(&mut ExportOptions)) -> String {
        let mut o = ExportOptions { format: f, ..Default::default() };
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
        assert!(out.starts_with("1;a,b \"\"q\"\" ") || out.starts_with("1;\"a,b"), "{out}");
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
    fn json() {
        let out = run(ExportFormat::Json, |_| {});
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v[0], json!({"id": 1, "name": "a,b \"q\"", "data": "0xff00"}));
        assert_eq!(v[1]["name"], Value::Null);
        assert_eq!(v.as_array().unwrap().len(), 3);
        let empty = export_to_string(&ResultSet::default(), &ExportOptions { format: ExportFormat::Json, ..Default::default() }).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&empty).unwrap(), json!([]));
    }

    #[test]
    fn sql_insert_pg_arrays_are_array_literals() {
        let lit = |c: Value| sql_literal(Driver::Postgres, &c);
        assert_eq!(lit(json!([1, 2])), "'{1,2}'");
        assert_eq!(lit(json!([])), "'{}'");
        assert_eq!(lit(json!([1, null, "a"])), "'{1,NULL,\"a\"}'");
        assert_eq!(lit(json!([[1, 2], [3, 4]])), "'{{1,2},{3,4}}'");
        assert_eq!(lit(json!([true, false])), "'{true,false}'");
        assert_eq!(lit(json!(["", "NULL", "x,y", "{b}", "q\"t", "back\\slash", "it's"])), "E'{\"\",\"NULL\",\"x,y\",\"{b}\",\"q\\\\\"t\",\"back\\\\\\\\slash\",\"it''s\"}'");
        assert_eq!(lit(json!([{"$bin": "00ff", "len": 2}, null])), r#"E'{"\\\\x00ff",NULL}'"#);
        // other dialects have no array type: JSON text as before
        assert_eq!(sql_literal(Driver::MySql, &json!([1, 2])), "'[1,2]'");
    }

    #[test]
    fn sql_insert() {
        let out = run(ExportFormat::SqlInsert, |o| o.table_name = Some("public.t".into()));
        let first = out.lines().next().unwrap();
        assert_eq!(first, "insert into \"public\".\"t\" (\"id\", \"name\", \"data\") values (1, 'a,b \"q\"', '\\xff00'::bytea);");
        assert!(out.contains("(2, NULL, true)"));
        let out = run(ExportFormat::SqlInsert, |o| {
            o.dialect = Driver::MySql;
            o.rows_per_insert = 2;
        });
        assert!(out.starts_with("insert into `table_name` (`id`, `name`, `data`) values (1, 'a,b \"q\"', X'ff00'),\n    (2, NULL, 1);"), "{out}");
    }
}
