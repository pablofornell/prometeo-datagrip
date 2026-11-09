//! `export_query_with` and its cancel token: a slow query that has not returned a row yet is stopped (on the server too),
//! and a cancelled export of an empty result is not a success. SQLite always runs; the other databases need their URL
//! (`PROMETEO_PG_URL`, `PROMETEO_MYSQL_URL`, `PROMETEO_ORACLE_URL`, see `script_db.rs`).

mod common;

use std::time::{Duration, Instant};

use common::*;
use dbcore::import::CancellationToken;
use dbcore::*;

/// Cancels `token` after `ms` milliseconds.
fn cancel_after(token: &CancellationToken, ms: u64) {
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        t.cancel();
    });
}

/// Exports `sql`, cancelled after 500 ms: must come back as `Cancelled` well before the query would end.
async fn cancelled_slow_export(mgr: &ConnectionManager, ds: &str, sql: &str) -> Duration {
    let token = CancellationToken::new();
    cancel_after(&token, 500);
    let started = Instant::now();
    let mut buf = Vec::new();
    let res = tokio::time::timeout(
        Duration::from_secs(30),
        mgr.export_query_with(ds, sql, &ExportOptions::default(), &mut buf, &token, |_| {}),
    )
    .await
    .expect("the cancel did not stop the export");
    assert!(matches!(res, Err(DbError::Cancelled)), "{res:?}");
    assert!(buf.is_empty(), "nothing was written before the first row");
    started.elapsed()
}

#[tokio::test]
async fn sqlite_a_query_without_a_first_row_is_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = ConnectionManager::new();
    mgr.connect(&lite_cfg(&dir.path().join("e.db")))
        .await
        .unwrap();
    // never ends on its own and returns no row until it does
    let took = cancelled_slow_export(
        &mgr,
        "lite",
        "with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c",
    )
    .await;
    assert!(took < Duration::from_secs(20), "{took:?}");
}

#[tokio::test]
async fn sqlite_a_cancelled_export_of_an_empty_result_is_not_a_success() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = ConnectionManager::new();
    mgr.connect(&lite_cfg(&dir.path().join("e.db")))
        .await
        .unwrap();
    let token = CancellationToken::new();
    token.cancel();
    let mut buf = Vec::new();
    let res = mgr
        .export_query_with(
            "lite",
            "select 1 as a where 0",
            &ExportOptions::default(),
            &mut buf,
            &token,
            |_| {},
        )
        .await;
    assert!(matches!(res, Err(DbError::Cancelled)), "{res:?}");
    // without the cancel the same export is fine and has its header
    let mut buf = Vec::new();
    let rep = mgr
        .export_query_with(
            "lite",
            "select 1 as a where 0",
            &ExportOptions::default(),
            &mut buf,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(rep.rows, 0);
    assert_eq!(String::from_utf8(buf).unwrap(), "a\n");
}

#[tokio::test]
async fn sqlite_progress_is_not_one_event_per_row() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = ConnectionManager::new();
    mgr.connect(&lite_cfg(&dir.path().join("e.db")))
        .await
        .unwrap();
    let events = std::sync::Mutex::new(Vec::new());
    let mut buf = Vec::new();
    let rep = mgr
        .export_query_with(
            "lite",
            "with recursive c(x) as (select 1 union all select x + 1 from c where x < 20000) select x from c",
            &ExportOptions::default(),
            &mut buf,
            &CancellationToken::new(),
            |p| events.lock().unwrap().push(p.rows_written),
        )
        .await
        .unwrap();
    assert_eq!(rep.rows, 20000);
    let events = events.into_inner().unwrap();
    assert!(events.len() < 200, "{} events for 20000 rows", events.len());
    assert_eq!(events.last(), Some(&20000));
    assert!(events.windows(2).all(|w| w[0] < w[1]));
}

#[tokio::test]
async fn pg_a_slow_query_is_cancelled_on_the_server_too() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("PROMETEO_PG_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let took = cancelled_slow_export(&mgr, "pg", "select pg_sleep(60), 4242001").await;
    assert!(took < Duration::from_secs(15), "{took:?}");
    // the server stopped it: no backend still runs that statement
    tokio::time::sleep(Duration::from_millis(500)).await;
    let s = mgr.open_session("pg").await.unwrap();
    let n = scalar(&run(&mgr, &s, "select count(*) from pg_stat_activity where query like '%4242001%' and state = 'active' and pid <> pg_backend_pid()").await);
    assert_eq!(n, serde_json::json!(0));
}

#[tokio::test]
async fn mysql_a_slow_query_is_cancelled_on_the_server_too() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("PROMETEO_MYSQL_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let took = cancelled_slow_export(&mgr, "my", "select sleep(60), 4242002").await;
    assert!(took < Duration::from_secs(15), "{took:?}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let s = mgr.open_session("my").await.unwrap();
    let n = scalar(&run(&mgr, &s, "select count(*) from information_schema.processlist where info like '%4242002%' and id <> connection_id()").await);
    assert_eq!(n, serde_json::json!(0));
}

#[tokio::test]
async fn oracle_a_slow_query_is_cancelled() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    // a cross join that runs for minutes and returns its single row at the end
    let took = cancelled_slow_export(
        &mgr,
        "ora",
        "select count(*) from all_objects a, all_objects b, all_objects c, all_objects d",
    )
    .await;
    assert!(took < Duration::from_secs(20), "{took:?}");
    // the connection pool still works afterwards
    let mut buf = Vec::new();
    let rep = mgr
        .export_query_with(
            "ora",
            "select 1 as a from dual",
            &ExportOptions::default(),
            &mut buf,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(rep.rows, 1);
}
