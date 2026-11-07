//! Import of delimited files into SQLite (always), PostgreSQL and MySQL (with their URLs in the environment).

mod common;

use common::*;
use dbcore::import::CancellationToken;
use dbcore::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

fn column(name: &str, source: Option<usize>, ty: &str) -> serde_json::Value {
    json!({ "name": name, "source": source, "type": ty })
}

fn request(
    path: &std::path::Path,
    table: &str,
    create: bool,
    columns: Vec<serde_json::Value>,
    options: serde_json::Value,
) -> ImportRequest {
    serde_json::from_value(json!({
        "path": path,
        "table": table,
        "createTable": create,
        "columns": columns,
        "options": options,
    }))
    .unwrap()
}

async fn count(mgr: &ConnectionManager, sess: &SessionId, table: &str) -> String {
    let ev = run(mgr, sess, &format!("select count(*) from {table}")).await;
    scalar(&ev).to_string().trim_matches('"').to_string()
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// The whole scenario on one data source. `schema` qualifies the tables (PostgreSQL), `bool_ty` is the boolean
/// column type of the dialect.
async fn scenario(cfg: DataSourceConfig, schema: Option<&str>) {
    let mgr = connected(&cfg).await;
    let sess = mgr.open_session(&cfg.id).await.unwrap();
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = tempfile::tempdir().unwrap();
    let q = |t: &str| match schema {
        Some(s) => format!("{s}.{t}"),
        None => t.to_string(),
    };
    let fresh = format!("imp_new_{n}");
    let exist = format!("imp_exist_{n}");
    let drop_all = format!(
        "drop table if exists {}; drop table if exists {};",
        q(&fresh),
        q(&exist)
    );
    assert_ok(&run(&mgr, &sess, &drop_all).await);

    // ---- 1. new table, types inferred by the caller, quoted multi-line text, empty cells, NULL, booleans
    let csv = dir.path().join("fresh.csv");
    std::fs::write(
        &csv,
        "id,name,price,active,day\r\n1,\"Widget, large\",9.99,true,2024-01-31\r\n2,\"two\nlines\",,false,\r\n3,Doohickey,3.25,yes,2024-02-29\r\n",
    )
    .unwrap();
    let mut req = request(
        &csv,
        &fresh,
        true,
        vec![
            column("id", Some(0), "integer"),
            column("name", Some(1), "text"),
            column(
                "price",
                Some(2),
                if cfg.driver == Driver::Postgres {
                    "double precision"
                } else {
                    "double"
                },
            ),
            column("active", Some(3), "boolean"),
            column("day", Some(4), "date"),
        ],
        json!({}),
    );
    req.schema = schema.map(str::to_string);
    let progress = std::sync::Mutex::new(Vec::new());
    let res = mgr
        .import_file(&cfg.id, &req, &CancellationToken::new(), &|p| {
            progress.lock().unwrap().push(p.rows)
        })
        .await
        .unwrap();
    assert_eq!(
        (res.imported, res.failed, res.created_table),
        (3, 0, true),
        "{res:?}"
    );
    assert_eq!(progress.lock().unwrap().last(), Some(&3));
    assert_eq!(count(&mgr, &sess, &q(&fresh)).await, "3");
    let ev = run(
        &mgr,
        &sess,
        &format!(
            "select name, price, active, day from {} where id = 2",
            q(&fresh)
        ),
    )
    .await;
    assert_ok(&ev);
    let row = first_rs(&ev).1[0].clone();
    assert_eq!(row[0], json!("two\nlines"));
    assert!(row[1].is_null() && row[3].is_null(), "{row:?}");
    assert!(row[2] == json!(false) || row[2] == json!(0), "{row:?}");

    // ---- 2. existing table: bad rows are skipped and reported, the rest is kept
    assert_ok(
        &run(
            &mgr,
            &sess,
            &format!(
                "create table {} (id integer primary key, name varchar(20) not null, qty integer)",
                q(&exist)
            ),
        )
        .await,
    );
    let csv = dir.path().join("exist.csv");
    std::fs::write(
        &csv,
        "id,name,qty\n1,a,10\n2,b,notanumber\n3,,5\n1,dup,7\n4,d,40\n",
    )
    .unwrap();
    let err_file = dir.path().join("errors.txt");
    let mut req = request(
        &csv,
        &exist,
        false,
        vec![
            column("id", Some(0), "integer"),
            column("name", Some(1), "varchar(20)"),
            column("qty", Some(2), "integer"),
        ],
        json!({ "errorFile": err_file }),
    );
    req.schema = schema.map(str::to_string);
    let res = mgr
        .import_file(&cfg.id, &req, &CancellationToken::new(), &|_| {})
        .await
        .unwrap();
    // row 3 (record 4) has an empty NOT NULL name (NULL), row 4 duplicates id 1, row 2 is not a number
    assert_eq!((res.imported, res.failed), (2, 3), "{res:?}");
    assert_eq!(
        res.errors.iter().map(|e| e.row).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert!(
        res.errors[0].message.contains("notanumber"),
        "{:?}",
        res.errors
    );
    assert_eq!(count(&mgr, &sess, &q(&exist)).await, "2");
    assert_eq!(res.error_file.as_deref(), Some(err_file.to_str().unwrap()));
    let log = std::fs::read_to_string(&err_file).unwrap();
    assert_eq!(log.lines().count(), 3, "{log}");

    // ---- 3. inconvertible values as NULL; skipped columns keep their default
    assert_ok(&run(&mgr, &sess, &format!("delete from {}", q(&exist))).await);
    let csv = dir.path().join("null.csv");
    std::fs::write(&csv, "id;qty\n1;x\n2;5\n").unwrap();
    let mut req = request(
        &csv,
        &exist,
        false,
        vec![
            column("id", Some(0), "integer"),
            column("name", None, "varchar(20)"),
            column("qty", Some(1), "integer"),
        ],
        json!({ "insertInconvertibleAsNull": true }),
    );
    req.schema = schema.map(str::to_string);
    req.format.delimiter = ";".into();
    // `name` is NOT NULL without a default: the database refuses both rows, which are reported
    let res = mgr
        .import_file(&cfg.id, &req, &CancellationToken::new(), &|_| {})
        .await
        .unwrap();
    assert_eq!((res.imported, res.failed), (0, 2), "{res:?}");
    req.columns[1] = serde_json::from_value(column("name", Some(0), "varchar(20)")).unwrap();
    let res = mgr
        .import_file(&cfg.id, &req, &CancellationToken::new(), &|_| {})
        .await
        .unwrap();
    assert_eq!((res.imported, res.failed), (2, 0), "{res:?}");
    let ev = run(
        &mgr,
        &sess,
        &format!("select qty from {} where id = 1", q(&exist)),
    )
    .await;
    assert!(first_rs(&ev).1[0][0].is_null());

    // ---- 4. abort on the first error rolls everything back, and a table created for it is gone
    let csv = dir.path().join("abort.csv");
    std::fs::write(&csv, "a\n1\n2\nx\n4\n").unwrap();
    let mut req = request(
        &csv,
        &fresh,
        false,
        vec![column("id", Some(0), "integer")],
        json!({ "abortOnError": true }),
    );
    req.schema = schema.map(str::to_string);
    assert_ok(&run(&mgr, &sess, &format!("delete from {}", q(&fresh))).await);
    req.columns = vec![serde_json::from_value(column("id", Some(0), "integer")).unwrap()];
    let res = mgr
        .import_file(&cfg.id, &req, &CancellationToken::new(), &|_| {})
        .await
        .unwrap();
    assert!(
        res.rolled_back && res.imported == 0 && res.failed == 1,
        "{res:?}"
    );
    assert_eq!(count(&mgr, &sess, &q(&fresh)).await, "0");
    let abort_new = format!("imp_abort_{n}");
    let mut req = request(
        &csv,
        &abort_new,
        true,
        vec![column("a", Some(0), "integer")],
        json!({ "abortOnError": true }),
    );
    req.schema = schema.map(str::to_string);
    let res = mgr
        .import_file(&cfg.id, &req, &CancellationToken::new(), &|_| {})
        .await
        .unwrap();
    assert!(res.rolled_back && !res.created_table, "{res:?}");
    let ev = run(
        &mgr,
        &sess,
        &format!("select count(*) from {}", q(&abort_new)),
    )
    .await;
    assert!(
        !errors(&ev).is_empty(),
        "the table of an aborted import must be gone"
    );

    // ---- 5. cancel: nothing is kept
    let csv = dir.path().join("big.csv");
    let mut big = String::from("a\n");
    for i in 0..5000 {
        big.push_str(&format!("{i}\n"));
    }
    std::fs::write(&csv, big).unwrap();
    let mut req = request(
        &csv,
        &fresh,
        false,
        vec![column("id", Some(0), "integer")],
        json!({ "batchSize": 100 }),
    );
    req.schema = schema.map(str::to_string);
    let token = CancellationToken::new();
    let t2 = token.clone();
    let res = mgr
        .import_file(&cfg.id, &req, &token, &move |p| {
            if p.rows >= 300 {
                t2.cancel();
            }
        })
        .await
        .unwrap();
    assert!(
        res.cancelled && res.rolled_back && res.imported == 0,
        "{res:?}"
    );
    assert_eq!(count(&mgr, &sess, &q(&fresh)).await, "0");

    // ---- 6. a larger file is committed in batches
    let mut req = request(
        &csv,
        &fresh,
        false,
        vec![column("id", Some(0), "integer")],
        json!({ "batchSize": 700 }),
    );
    req.schema = schema.map(str::to_string);
    let res = mgr
        .import_file(&cfg.id, &req, &CancellationToken::new(), &|_| {})
        .await
        .unwrap();
    assert_eq!(res.imported, 5000, "{res:?}");
    assert_eq!(count(&mgr, &sess, &q(&fresh)).await, "5000");

    assert_ok(&run(&mgr, &sess, &drop_all).await);
    mgr.close_session(&sess).await;
}

#[tokio::test]
async fn import_into_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    scenario(lite_cfg(&dir.path().join("imp.db")), None).await;
}

#[tokio::test]
async fn import_into_postgres() {
    let Some(cfg) = pg_cfg() else { return };
    scenario(cfg, Some("public")).await;
}

#[tokio::test]
async fn import_into_mysql() {
    let Some(cfg) = mysql_cfg() else { return };
    scenario(cfg, None).await;
}

#[tokio::test]
async fn refuses_a_read_only_data_source() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = lite_cfg(&dir.path().join("ro.db"));
    let mgr = connected(&cfg).await;
    mgr.disconnect(&cfg.id).await;
    cfg.read_only = true;
    let mgr = connected(&cfg).await;
    let csv = dir.path().join("a.csv");
    std::fs::write(&csv, "a\n1\n").unwrap();
    let req = request(
        &csv,
        "t",
        true,
        vec![column("a", Some(0), "integer")],
        json!({}),
    );
    let e = mgr
        .import_file(&cfg.id, &req, &CancellationToken::new(), &|_| {})
        .await
        .unwrap_err();
    assert!(e.to_string().contains("read-only"), "{e}");
}
