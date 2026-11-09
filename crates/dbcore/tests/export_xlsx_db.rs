//! Excel (xlsx) export of an Oracle query: NUMBER(38,10), DATE, TIMESTAMP, CLOB and NULL cells end up typed in the
//! sheet XML. The table is named `XLX_T` in the login schema and dropped at the start and at the end. Run with:
//!   PROMETEO_ORACLE_URL=oracle://demo:prometeo@127.0.0.1:15219/FREEPDB1 cargo test -p dbcore --test export_xlsx_db -- --nocapture

mod common;

use std::io::{Cursor, Read};

use common::*;
use dbcore::import::CancellationToken;
use dbcore::*;

/// The text of one worksheet part of the xlsx `bytes`.
fn sheet_xml(bytes: &[u8], name: &str) -> String {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("a zip file");
    let mut text = String::new();
    zip.by_name(name)
        .unwrap_or_else(|e| panic!("{name}: {e}"))
        .read_to_string(&mut text)
        .unwrap();
    text
}

/// The XML of cell `r` (`C2`) of a worksheet, `None` when the cell is not written.
fn cell<'a>(sheet: &'a str, r: &str) -> Option<&'a str> {
    let start = sheet.find(&format!("<c r=\"{r}\""))?;
    let end = sheet[start..].find("</c>")? + start;
    Some(&sheet[start..end])
}

/// The number of a cell (`<v>...</v>`).
fn number_of(sheet: &str, r: &str) -> f64 {
    let c = cell(sheet, r).unwrap_or_else(|| panic!("no cell {r} in {sheet}"));
    let v = c
        .split("<v>")
        .nth(1)
        .and_then(|s| s.split("</v>").next())
        .unwrap_or_else(|| panic!("no number in {c}"));
    v.parse().unwrap()
}

#[tokio::test]
async fn oracle_export_writes_the_typed_cells_of_a_query() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session("ora").await.unwrap();
    // the rows are committed: the export reads them on its own connection
    let _ = run(&mgr, &s, "drop table XLX_T purge").await;
    assert_ok(
        &run(
            &mgr,
            &s,
            "create table XLX_T (ID number(10) primary key, AMT number(38,10), D date, TS timestamp(6), C clob, NUL varchar2(10))",
        )
        .await,
    );
    for sql in [
        "insert into XLX_T values (1, 12.5, to_date('2024-02-29 13:45:10', 'YYYY-MM-DD HH24:MI:SS'), to_timestamp('2024-02-29 13:45:10.5', 'YYYY-MM-DD HH24:MI:SS.FF'), to_clob('clob text'), null)",
        "insert into XLX_T values (2, 12345678901234567890.1234567890, to_date('2024-02-29', 'YYYY-MM-DD'), null, null, 'x')",
        "insert into XLX_T values (3, null, null, null, null, null)",
        "commit",
    ] {
        assert_ok(&run(&mgr, &s, sql).await);
    }

    let opts = ExportOptions {
        format: ExportFormat::Xlsx,
        dialect: Driver::Oracle,
        ..Default::default()
    };
    let sql = "select ID, AMT, D, TS, C, NUL from XLX_T order by ID";
    let mut buf = Vec::new();
    let report = mgr
        .export_query_with(
            "ora",
            sql,
            &opts,
            &mut buf,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(report.rows, 3);
    assert_eq!(report.truncated, 0);

    let sheet = sheet_xml(&buf, "xl/worksheets/sheet1.xml");
    // header: the column names
    for (r, name) in [
        ("A1", "ID"),
        ("B1", "AMT"),
        ("C1", "D"),
        ("D1", "TS"),
        ("E1", "C"),
        ("F1", "NUL"),
    ] {
        assert!(
            cell(&sheet, r).unwrap().contains(&format!("<t>{name}</t>")),
            "{r}: {sheet}"
        );
    }
    // NUMBER(38,10) with 12.5: a number; with 20 integer digits: text (a double would lose them). The text is the
    // digits the driver hands over (the 10th decimal is not among them yet), so only the integer part is checked
    assert_eq!(number_of(&sheet, "B2"), 12.5);
    assert!(
        cell(&sheet, "B3")
            .unwrap()
            .contains("<t>12345678901234567890.1"),
        "{sheet}"
    );
    // DATE and TIMESTAMP: Excel date serials (2024-02-29 is 45351, 13:45:10 adds 13:45:10 / 24 h)
    let day = 45351.0;
    let clock = (13.0 * 3600.0 + 45.0 * 60.0 + 10.0) / 86_400.0;
    assert!(
        (number_of(&sheet, "C2") - (day + clock)).abs() < 1e-6,
        "{sheet}"
    );
    assert!(
        (number_of(&sheet, "D2") - (day + clock + 0.5 / 86_400.0)).abs() < 1e-6,
        "{sheet}"
    );
    // the date of row 2 has no time: a date format; the date-time format is in the styles
    assert!((number_of(&sheet, "C3") - day).abs() < 1e-6, "{sheet}");
    // CLOB is text, NULL is an empty cell
    assert!(
        cell(&sheet, "E2").unwrap().contains("<t>clob text</t>"),
        "{sheet}"
    );
    assert!(
        cell(&sheet, "F2").is_none(),
        "NULL is a blank cell: {sheet}"
    );
    assert!(
        cell(&sheet, "B4").is_none() && cell(&sheet, "A4").is_some(),
        "{sheet}"
    );
    assert!(sheet.contains("<autoFilter ref=\"A1:F4\""), "{sheet}");
    assert!(sheet.contains("state=\"frozen\""), "{sheet}");
    let styles = {
        let mut zip = zip::ZipArchive::new(Cursor::new(&buf)).unwrap();
        let mut t = String::new();
        zip.by_name("xl/styles.xml")
            .unwrap()
            .read_to_string(&mut t)
            .unwrap();
        t
    };
    assert!(
        styles.contains("yyyy-mm-dd hh:mm:ss") && styles.contains("yyyy-mm-dd"),
        "{styles}"
    );

    // the clipboard / to-string path refuses the workbook
    let mut text = Vec::new();
    let err = mgr
        .export_query("ora", sql, &opts, &mut text)
        .await
        .unwrap_err();
    assert!(matches!(err, DbError::Unsupported(_)), "{err:?}");
    assert!(text.is_empty());

    let _ = run(&mgr, &s, "drop table XLX_T purge").await;
    mgr.close_session(&s).await;
}

/// The file path the app takes (a `BufWriter` over a real file, flushed and closed before it is read back). SQLite
/// runs without a server.
#[tokio::test]
async fn sqlite_export_writes_a_workbook_file() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = connected(&lite_cfg(&dir.path().join("xlsx.db"))).await;
    let s = mgr.open_session("lite").await.unwrap();
    for sql in [
        "create table t (id integer, price real, name text)",
        "insert into t values (1, 2.5, 'a')",
        "insert into t values (2, null, null)",
    ] {
        assert_ok(&run(&mgr, &s, sql).await);
    }
    let path = dir.path().join("out.xlsx");
    let file = std::fs::File::create(&path).unwrap();
    let mut w = std::io::BufWriter::new(file);
    let opts = ExportOptions {
        format: ExportFormat::Xlsx,
        ..Default::default()
    };
    let report = mgr
        .export_query_with(
            "lite",
            "select id, price, name from t order by id",
            &opts,
            &mut w,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
    std::io::Write::flush(&mut w).unwrap();
    drop(w);
    assert_eq!(report.rows, 2);

    let bytes = std::fs::read(&path).unwrap();
    assert!(bytes.starts_with(b"PK"), "a zip file");
    let sheet = sheet_xml(&bytes, "xl/worksheets/sheet1.xml");
    assert!(cell(&sheet, "A1").unwrap().contains("<t>id</t>"), "{sheet}");
    assert_eq!(number_of(&sheet, "A2"), 1.0);
    assert_eq!(number_of(&sheet, "B2"), 2.5);
    assert!(cell(&sheet, "C2").unwrap().contains("<t>a</t>"), "{sheet}");
    assert!(
        cell(&sheet, "B3").is_none() && cell(&sheet, "C3").is_none(),
        "NULLs are blank: {sheet}"
    );
    mgr.close_session(&s).await;
}
