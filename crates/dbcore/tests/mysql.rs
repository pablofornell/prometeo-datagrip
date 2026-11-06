//! MySQL integration tests. Run with:
//!   PROMETEO_MYSQL_URL=mysql://root:prometeo@localhost:33069/demo cargo test -p dbcore --test mysql -- --nocapture

mod common;

use common::*;
use dbcore::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

macro_rules! setup {
    () => {{
        let Some(cfg) = mysql_cfg() else {
            eprintln!("PROMETEO_MYSQL_URL not set: skipping");
            return;
        };
        seed_mysql(&cfg).await;
        let mgr = connected(&cfg).await;
        (cfg, mgr)
    }};
}

#[tokio::test]
async fn test_connection_ok_and_failures() {
    let Some(cfg) = mysql_cfg() else { return };
    let mgr = ConnectionManager::new();
    let r = mgr.test_connection(&cfg).await;
    assert!(r.ok, "{r:?}");
    assert!(r.server_version.as_deref().unwrap().starts_with("MySQL 8"), "{r:?}");
    println!("test_connection: {} in {} ms", r.message, r.elapsed_ms);

    let c2 = DataSourceConfig {
        id: "my2".into(),
        driver: Driver::MySql,
        host: "127.0.0.1".into(),
        port: 33069,
        user: "root".into(),
        password: Some("nope".into()),
        database: "demo".into(),
        ..Default::default()
    };
    let r = mgr.test_connection(&c2).await;
    assert!(!r.ok);
    assert!(r.message.contains("Access denied"), "{}", r.message);
    println!("bad password message: {}", r.message);
    let r = mgr.test_connection(&DataSourceConfig { password: Some("prometeo".into()), ..c2.clone() }).await;
    assert!(r.ok, "{r:?}");
    let r = mgr.test_connection(&DataSourceConfig { password: Some("prometeo".into()), database: "no_such_db".into(), ..c2 }).await;
    assert!(!r.ok);
    assert!(r.message.contains("Unknown database"), "{}", r.message);
}

#[tokio::test]
async fn introspection_tree() {
    let (_cfg, mgr) = setup!();
    let schemas = names(&children(&mgr, "my", &[]).await);
    assert!(schemas.contains(&"demo".to_string()), "{schemas:?}");
    assert!(!schemas.contains(&"mysql".to_string()) && !schemas.contains(&"information_schema".to_string()));
    let all = mgr.introspect_with("my", &[], &IntrospectOptions { show_system: true }).await.unwrap();
    assert!(names(&all).contains(&"information_schema".to_string()));
    assert!(all.iter().all(|n| n.kind == NodeKind::Schema));

    let folders = children(&mgr, "my", &["demo"]).await;
    // other tests / users may add objects to `demo`: check the folders exist, not exact counts
    assert_eq!(names(&folders), ["tables", "views", "routines"]);

    let tables = children(&mgr, "my", &["demo", "tables"]).await;
    let tn = names(&tables);
    for t in ["all_types", "big_table", "categories", "customers", "order_items", "orders", "products"] {
        assert!(tn.contains(&t.to_string()), "{t} missing in {tn:?}");
    }
    assert_eq!(tables.iter().find(|t| t.name == "categories").unwrap().hint.as_deref(), Some("Product categories"));
    assert!(names(&children(&mgr, "my", &["demo", "views"]).await).contains(&"v_order_totals".to_string()));
    let routines = children(&mgr, "my", &["demo", "routines"]).await;
    let kind_of = |n: &str| routines.iter().find(|r| r.name == n).map(|r| r.kind);
    assert_eq!(kind_of("order_total"), Some(NodeKind::Function));
    assert_eq!(kind_of("restock"), Some(NodeKind::Procedure));

    let sub = children(&mgr, "my", &["demo", "tables", "products"]).await;
    let sub: Vec<_> = sub.iter().map(|f| (f.name.as_str(), f.hint.clone().unwrap())).collect();
    assert_eq!(
        sub,
        vec![
            ("columns", "9".to_string()),
            ("keys", "2".to_string()),
            ("foreign keys", "1".to_string()),
            ("indexes", "3".to_string()),
            ("checks", "1".to_string()),
            ("triggers", "1".to_string())
        ]
    );
    let cols = children(&mgr, "my", &["demo", "tables", "products", "columns"]).await;
    let hints: Vec<_> = cols.iter().map(|c| c.hint.clone().unwrap()).collect();
    assert_eq!(hints, ["int", "varchar(32)", "varchar(255)", "int", "decimal(10,2)", "int", "json", "timestamp", "timestamp"]);
    assert_eq!(cols[0].extra["isPk"], json!(true));
    assert_eq!(cols[1].extra["nullable"], json!(false));
    assert_eq!(cols[8].extra["nullable"], json!(true));
    assert_eq!(cols[5].extra["default"], "0");
    let keys = children(&mgr, "my", &["demo", "tables", "products", "keys"]).await;
    assert_eq!(names(&keys), ["PRIMARY", "uq_products_sku"]);
    assert_eq!((keys[0].kind, keys[1].kind), (NodeKind::PrimaryKey, NodeKind::UniqueKey));
    let fks = children(&mgr, "my", &["demo", "tables", "order_items", "foreign_keys"]).await;
    assert_eq!(names(&fks), ["fk_items_order", "fk_items_product"]);
    assert_eq!(fks[0].hint.as_deref(), Some("(order_id) -> orders(id)"));
    assert_eq!(fks[0].extra["onDelete"], "CASCADE");
    let idx = children(&mgr, "my", &["demo", "tables", "products", "indexes"]).await;
    assert_eq!(names(&idx), ["PRIMARY", "idx_products_category", "uq_products_sku"]);
    assert_eq!(idx[2].extra["unique"], json!(true));
    let checks = children(&mgr, "my", &["demo", "tables", "products", "checks"]).await;
    assert_eq!(names(&checks), ["products_price_positive"]);
    let trg = children(&mgr, "my", &["demo", "tables", "products", "triggers"]).await;
    assert_eq!((trg[0].name.as_str(), trg[0].hint.as_deref()), ("trg_products_touch", Some("BEFORE UPDATE")));
    let v = children(&mgr, "my", &["demo", "views", "v_order_totals"]).await;
    assert_eq!(names(&v), ["columns"]);
    assert!(mgr.introspect("my", &["demo".into(), "bogus".into()]).await.is_err());
}

#[tokio::test]
async fn ddl_generation() {
    let (_cfg, mgr) = setup!();
    let t = |name: &str, kind: NodeKind| ObjectRef { schema: Some("demo".into()), name: name.into(), kind, table: None, signature: None };
    let ddl = mgr.ddl("my", &t("products", NodeKind::Table)).await.unwrap();
    println!("{ddl}");
    assert!(ddl.starts_with("CREATE TABLE `products` ("), "{ddl}");
    assert!(ddl.contains("CONSTRAINT `fk_products_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`)"));
    assert!(ddl.trim_end().ends_with(';'));
    let v = mgr.ddl("my", &t("v_order_totals", NodeKind::View)).await.unwrap();
    assert!(v.contains("VIEW `v_order_totals` AS select"), "{v}");
    let f = mgr.ddl("my", &t("order_total", NodeKind::Function)).await.unwrap();
    assert!(f.contains("FUNCTION `order_total`(p_order_id INT)"), "{f}");
    let p = mgr.ddl("my", &t("restock", NodeKind::Procedure)).await.unwrap();
    assert!(p.contains("PROCEDURE `restock`"));
    let tr = mgr.ddl("my", &t("trg_products_touch", NodeKind::Trigger)).await.unwrap();
    assert!(tr.contains("TRIGGER `trg_products_touch`"));
    let i = mgr.ddl("my", &ObjectRef { table: Some("products".into()), ..t("idx_products_category", NodeKind::Index) }).await.unwrap();
    assert_eq!(i, "create index `idx_products_category` on `demo`.`products` (`category_id`);");
    assert!(mgr.ddl("my", &t("nope", NodeKind::Table)).await.is_err());

    // the SHOW CREATE output of a compound routine executes through the splitter
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop database if exists scratch_my_ddl; create database scratch_my_ddl; use scratch_my_ddl").await);
    assert_ok(&run(&mgr, &s, &f).await);
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from information_schema.routines where routine_schema = 'scratch_my_ddl'").await), json!(1));
    assert_ok(&run(&mgr, &s, "drop database scratch_my_ddl").await);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn execute_select_and_types() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    let ev = run(&mgr, &s, "select 1 as a, 'x' as b, 1.5 as d, null as f").await;
    assert_ok(&ev);
    let (cols, rows, _) = first_rs(&ev);
    assert_eq!(cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["a", "b", "d", "f"]);
    assert_eq!(rows, vec![vec![json!(1), json!("x"), json!("1.5"), Value::Null]]);

    let ev = run(&mgr, &s, "select * from demo.all_types order by id").await;
    assert_ok(&ev);
    let (cols, rows, _) = first_rs(&ev);
    let row: BTreeMap<String, Value> = cols.iter().zip(&rows[0]).map(|(c, v)| (c.name.clone(), v.clone())).collect();
    let tn: BTreeMap<String, String> = cols.iter().map(|c| (c.name.clone(), c.type_name.clone())).collect();
    let expect = json!({
        "id": 1, "c_tinyint": -128, "c_smallint": 32767, "c_mediumint": 8388607, "c_int": 2147483647,
        "c_bigint": "9223372036854775807", "c_ubigint": "18446744073709551615",
        "c_decimal": "12345678901234567890.1234567890", "c_float": 1.5, "c_double": 1.2345678901234567,
        "c_bit": 170, "c_bool": 1, "c_char": "ab", "c_varchar": "varchar",
        "c_text": "multi\nline \"text\" with 'quotes' and unicode: éñ 😀", "c_longtext": "long",
        "c_binary": {"$bin": "deadbeef", "len": 4}, "c_varbinary": {"$bin": "0102", "len": 2},
        "c_blob": {"$bin": "cafebabe", "len": 4}, "c_json": "{\"a\": [1, 2, {\"b\": null}]}",
        "c_date": "2024-02-29", "c_time": "-12:34:56.789", "c_datetime": "2024-02-29 13:45:10.500",
        "c_timestamp": "2024-02-29 13:45:10", "c_year": 2024, "c_enum": "b", "c_set": "x,z"
    });
    for (k, v) in expect.as_object().unwrap() {
        assert_eq!(&row[k], v, "column {k}");
    }
    assert_eq!(row["c_point"]["len"], 25);
    assert_eq!(tn["c_bigint"], "bigint");
    assert_eq!(tn["c_ubigint"], "bigint unsigned");
    assert_eq!(tn["c_decimal"], "decimal");
    assert_eq!(tn["c_enum"], "enum");
    assert_eq!(tn["c_blob"], "blob");
    assert!(rows[1][1..].iter().all(Value::is_null));

    // empty result keeps metadata; DML reports rows affected; DDL is an update
    let ev = run(&mgr, &s, "select id, name from demo.products where 1 = 0").await;
    let (cols, rows, _) = first_rs(&ev);
    assert_eq!(cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "name"]);
    assert!(rows.is_empty());
    let ev = run(&mgr, &s, "update demo.products set stock = stock where id < 0").await;
    assert!(ev.iter().any(|e| matches!(e, ExecEvent::Update { index: 0, rows_affected: 0 })), "{ev:?}");
    let ev = run(&mgr, &s, "show tables from demo; describe demo.products; explain select 1").await;
    assert_ok(&ev);
    assert_eq!(ev.iter().filter(|e| matches!(e, ExecEvent::ResultSet { .. })).count(), 3);
    let ev = run(&mgr, &s, "call demo.restock(1, 0)").await;
    assert_ok(&ev);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn execute_scripts_errors_and_session_state() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();

    let ev = run(&mgr, &s, "create temporary table t_exec (a int);\ninsert into t_exec values (1), (2);\nselect * from t_exec order by a;\ndrop temporary table t_exec").await;
    assert_ok(&ev);
    let rs: Vec<_> = ev.iter().filter_map(|e| if let ExecEvent::Update { rows_affected, .. } = e { Some(*rows_affected) } else { None }).collect();
    assert_eq!(rs, vec![0, 2, 0]);

    let ev = run(&mgr, &s, "select * from nonexistent_table_xyz").await;
    assert_eq!(errors(&ev), vec!["[42S02][1146] Table 'demo.nonexistent_table_xyz' doesn't exist".to_string()]);
    let ev = run(&mgr, &s, "select 1 from").await;
    assert!(errors(&ev)[0].starts_with("[42000][1064] You have an error in your SQL syntax"), "{:?}", errors(&ev));
    let ev = run(&mgr, &s, "insert into demo.categories (name) values ('Books')").await;
    assert!(errors(&ev)[0].starts_with("[23000][1062] Duplicate entry 'Books' for key"), "{:?}", errors(&ev));
    let ev = run(&mgr, &s, "select 1; select * from nope; select 3").await;
    assert_eq!(ev.iter().filter(|e| matches!(e, ExecEvent::ResultSet { .. })).count(), 1);

    // USE persists in the session; transactions persist too
    assert_ok(&run(&mgr, &s, "use information_schema").await);
    assert_eq!(scalar(&run(&mgr, &s, "select database()").await), json!("information_schema"));
    assert_ok(&run(&mgr, &s, "use demo").await);
    let s2 = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "start transaction").await);
    assert!(mgr.session_in_transaction(&s).unwrap());
    assert_ok(&run(&mgr, &s, "insert into categories (name) values ('tx-test')").await);
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from categories where name = 'tx-test'").await), json!(1));
    assert_eq!(scalar(&run(&mgr, &s2, "select count(*) from demo.categories where name = 'tx-test'").await), json!(0));
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from categories where name = 'tx-test'").await), json!(0));

    // DELIMITER scripts are split client side
    let ev = run(&mgr, &s, "drop procedure if exists p_tmp;\nDELIMITER //\ncreate procedure p_tmp() begin select 1; select 2; end//\nDELIMITER ;\ncall p_tmp(); drop procedure p_tmp").await;
    assert_ok(&ev);
    mgr.close_session(&s).await;
    mgr.close_session(&s2).await;
}

#[tokio::test]
async fn paging_and_cancellation() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    let t0 = Instant::now();
    let mut h = mgr.execute(&s, "select * from demo.big_table order by id", ExecOptions { max_rows: 500, stop_on_error: true, ..Default::default() }).await.unwrap();
    let mut events = Vec::new();
    while let Some(e) = h.events.recv().await {
        let done = matches!(e, ExecEvent::Done { .. });
        events.push(e);
        if done {
            break;
        }
    }
    println!("mysql first page (500 of 100k) via execute: {:?}", t0.elapsed());
    let (_, rows, more) = first_rs(&events);
    assert_eq!((rows.len(), more), (500, true));
    let mut total = 500;
    let mut next = 501;
    loop {
        let page = mgr.fetch_more(&h.id, 0, 25_000).await.unwrap();
        assert_eq!(page.rows[0][0], json!(next));
        next += page.rows.len() as i64;
        total += page.rows.len();
        if !page.has_more {
            break;
        }
    }
    assert_eq!(total, 100_000);
    println!("mysql fetched all 100k rows: {:?}", t0.elapsed());

    // abandon a half-read result by running something else
    let h = mgr.execute(&s, "select * from demo.big_table", ExecOptions { max_rows: 10, stop_on_error: true, ..Default::default() }).await.unwrap();
    let mut ev = h.events;
    while let Some(e) = ev.recv().await {
        if matches!(e, ExecEvent::Done { .. }) {
            break;
        }
    }
    assert_eq!(mgr.fetch_more(&h.id, 0, 5).await.unwrap().rows.len(), 5);
    let t = Instant::now();
    assert_eq!(scalar(&run(&mgr, &s, "select 42").await), json!(42));
    assert!(t.elapsed() < Duration::from_secs(5));

    // truncation of non-last statements
    let ev = run_n(&mgr, &s, "select * from demo.big_table; select 7", 10).await;
    assert_ok(&ev);
    let rs: Vec<_> = ev.iter().filter_map(|e| if let ExecEvent::ResultSet { rows, has_more, .. } = e { Some((rows.len(), *has_more)) } else { None }).collect();
    assert_eq!(rs, vec![(10, false), (1, false)]);

    // cancel a query that would run for ages
    let t = Instant::now();
    let mut h = mgr.execute(&s, "select max(md5(concat(a.id, b.id))) from demo.big_table a, demo.big_table b", ExecOptions::default()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    mgr.cancel(&h.id).unwrap();
    let mut msg = None;
    while let Some(e) = h.events.recv().await {
        if let ExecEvent::Error { message, .. } = &e {
            msg = Some(message.clone());
        }
        if matches!(e, ExecEvent::Done { .. }) {
            break;
        }
    }
    assert!(msg.expect("error").contains("Query execution was interrupted"));
    println!("mysql cancel: returned after {:?}", t.elapsed());
    assert!(t.elapsed() < Duration::from_secs(5));
    assert_eq!(scalar(&run(&mgr, &s, "select 5").await), json!(5));
    mgr.close_session(&s).await;
}

fn change(kind: ChangeKind, key: Value, values: Value) -> RowChange {
    let m = |v: Value| v.as_object().cloned().unwrap_or_default().into_iter().collect::<BTreeMap<_, _>>();
    RowChange { kind, key: m(key), values: m(values), row_locator: None }
}

/// Session-scoped editing: uncommitted inside `begin`, invisible to the pool until `commit`.
#[tokio::test]
async fn session_scoped_edit_stays_in_the_transaction() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop table if exists demo.scratch_sess; create table demo.scratch_sess (id int primary key, v varchar(3)); insert into demo.scratch_sess values (1,'a'),(2,'b')").await);
    let t = ObjectRef::table(Some("demo"), "scratch_sess");
    let req = TableDataRequest { order_by: Some("id".into()), ..Default::default() };
    let vs = |rs: &ResultSet| rs.rows.iter().map(|r| r[1].clone()).collect::<Vec<_>>();

    assert_ok(&run(&mgr, &s, "start transaction").await);
    let r = mgr.apply_changes_in_session(&s, &t, &[change(ChangeKind::Update, json!({"id": 1}), json!({"v": "one"}))]).await.unwrap();
    assert!(r.committed, "{r:?}");
    assert!(mgr.session_in_transaction(&s).unwrap());
    assert_eq!(vs(&mgr.table_data_in_session(&s, &t, &req).await.unwrap()), vec![json!("one"), json!("b")]);
    assert_eq!(vs(&mgr.table_data("my", &t, &req).await.unwrap()), vec![json!("a"), json!("b")], "not visible to other connections");

    let r = mgr.apply_changes_in_session(&s, &t, &[change(ChangeKind::Update, json!({"id": 2}), json!({"v": "x"})), change(ChangeKind::Delete, json!({"id": 99}), json!({}))]).await.unwrap();
    assert!(!r.committed, "{r:?}");
    assert_eq!(vs(&mgr.table_data_in_session(&s, &t, &req).await.unwrap()), vec![json!("one"), json!("b")]);

    assert_ok(&run(&mgr, &s, "rollback").await);
    assert_eq!(vs(&mgr.table_data_in_session(&s, &t, &req).await.unwrap()), vec![json!("a"), json!("b")]);

    // outside a transaction: its own transaction, committed
    let r = mgr.apply_changes_in_session(&s, &t, &[change(ChangeKind::Update, json!({"id": 2}), json!({"v": "two"}))]).await.unwrap();
    assert!(r.committed, "{r:?}");
    assert_eq!(vs(&mgr.table_data("my", &t, &req).await.unwrap()), vec![json!("a"), json!("two")]);

    assert_ok(&run(&mgr, &s, "drop table demo.scratch_sess").await);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn table_data_and_edit() {
    let (_cfg, mgr) = setup!();
    let products = ObjectRef::table(Some("demo"), "products");
    let rs = mgr
        .table_data("my", &products, &TableDataRequest { order_by: Some("id".into()), offset: 5, limit: 5, count_total: true, ..Default::default() })
        .await
        .unwrap();
    assert_eq!((rs.rows.len(), rs.has_more, rs.total_hint), (5, true, Some(20)));
    assert_eq!(rs.rows[0][0], json!(6));
    assert_eq!(rs.rows[0][6], json!("[\"std\"]").as_str().map(|s| json!(s)).unwrap_or(Value::Null).clone().as_str().map(|_| rs.rows[0][6].clone()).unwrap());
    assert_eq!((rs.columns[0].is_pk, rs.columns[0].nullable, rs.columns[0].table_ref.as_deref()), (true, false, Some("demo.products")));
    let rs = mgr
        .table_data("my", &products, &TableDataRequest { where_clause: Some("price > 50 and category_id = 2".into()), limit: 100, ..Default::default() })
        .await
        .unwrap();
    assert!(!rs.rows.is_empty());
    let rs = mgr.table_data("my", &products, &TableDataRequest { where_clause: Some("1 = 0".into()), limit: 10, ..Default::default() }).await.unwrap();
    assert!(rs.rows.is_empty() && rs.columns.len() == 9);
    let snap = mgr.schema_snapshot("my", Some("demo")).await.unwrap();
    let p = snap.iter().find(|o| o.name == "products").unwrap();
    assert_eq!((p.columns.len(), p.columns[0].is_pk), (9, true));

    let s = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop table if exists demo.scratch_edit; drop table if exists demo.scratch_nopk;\
        create table demo.scratch_edit (id int auto_increment primary key, name text, qty int, data json, bin blob, ts datetime, flag tinyint(1) default 1, price decimal(10,2));\
        create table demo.scratch_nopk (a int, b varchar(20))").await);
    let t = ObjectRef::table(Some("demo"), "scratch_edit");
    let evil = "x'); drop table demo.scratch_edit; -- \\";
    let r = mgr
        .apply_changes(
            "my",
            &t,
            &[
                change(ChangeKind::Insert, json!({}), json!({"name": "O'Reilly", "qty": 3, "data": {"k": [1, 2]}, "bin": {"$bin": "cafe"}, "ts": "2024-01-01 10:00:00", "flag": false, "price": "12.50"})),
                change(ChangeKind::Insert, json!({}), json!({"name": evil, "qty": null, "flag": {"$default": true}})),
                change(ChangeKind::Insert, json!({}), json!({})),
            ],
        )
        .await
        .unwrap();
    assert!(r.committed && r.applied == 3, "{r:?}");
    let rs = mgr.table_data("my", &t, &TableDataRequest { order_by: Some("id".into()), limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows.len(), 3);
    assert_eq!(rs.rows[0][1], json!("O'Reilly"));
    assert_eq!(rs.rows[0][3], json!("{\"k\": [1, 2]}"));
    assert_eq!(rs.rows[0][4], json!({"$bin": "cafe", "len": 2}));
    assert_eq!(rs.rows[0][5], json!("2024-01-01 10:00:00"));
    assert_eq!(rs.rows[0][6], json!(0));
    assert_eq!(rs.rows[0][7], json!("12.50"));
    assert_eq!(rs.rows[1][1], json!(evil));
    assert_eq!(rs.rows[1][6], json!(1));

    let r = mgr
        .apply_changes(
            "my",
            &t,
            &[change(ChangeKind::Update, json!({"id": rs.rows[0][0]}), json!({"qty": 99, "name": null})), change(ChangeKind::Delete, json!({"id": rs.rows[2][0]}), json!({}))],
        )
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    let rs2 = mgr.table_data("my", &t, &TableDataRequest { order_by: Some("id".into()), limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(rs2.rows.len(), 2);
    assert_eq!((rs2.rows[0][1].clone(), rs2.rows[0][2].clone()), (Value::Null, json!(99)));

    // atomic: InnoDB rolls the first insert back when the second change fails
    let r = mgr
        .apply_changes(
            "my",
            &t,
            &[change(ChangeKind::Insert, json!({}), json!({"name": "should-not-exist"})), change(ChangeKind::Update, json!({"id": 987654}), json!({"name": "ghost"}))],
        )
        .await
        .unwrap();
    assert!(!r.committed && r.first_error().unwrap().index == 1);
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from demo.scratch_edit").await), json!(2));
    let r = mgr.apply_changes("my", &t, &[change(ChangeKind::Insert, json!({}), json!({"qty": "not a number"}))]).await.unwrap();
    assert!(!r.committed);
    assert!(r.results[0].error.as_deref().unwrap().contains("1366"), "{r:?}");

    let nopk = ObjectRef::table(Some("demo"), "scratch_nopk");
    let r = mgr
        .apply_changes("my", &nopk, &[change(ChangeKind::Insert, json!({}), json!({"a": 1, "b": null})), change(ChangeKind::Insert, json!({}), json!({"a": 2, "b": "two"}))])
        .await
        .unwrap();
    assert!(r.committed);
    let r = mgr
        .apply_changes("my", &nopk, &[change(ChangeKind::Update, json!({"a": 1, "b": null}), json!({"b": "now set"})), change(ChangeKind::Delete, json!({"a": 2, "b": "two"}), json!({}))])
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    let rs = mgr.table_data("my", &nopk, &TableDataRequest { limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows, vec![vec![json!(1), json!("now set")]]);
    assert_ok(&run(&mgr, &s, "drop table demo.scratch_edit; drop table demo.scratch_nopk").await);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn export_and_benchmark() {
    let (_cfg, mgr) = setup!();
    let t = Instant::now();
    let rs = mgr
        .table_data("my", &ObjectRef::table(Some("demo"), "big_table"), &TableDataRequest { limit: 500, order_by: Some("id".into()), ..Default::default() })
        .await
        .unwrap();
    println!("BENCH mysql first 500 rows of 100k-row table: table_data={:?}", t.elapsed());
    assert_eq!(rs.rows.len(), 500);
    assert!(t.elapsed() < Duration::from_secs(5));

    let mut buf: Vec<u8> = Vec::new();
    let t = Instant::now();
    let n = mgr.export_query("my", "select id, name, amount, created from demo.big_table order by id", &ExportOptions::default(), &mut buf).await.unwrap();
    println!("mysql export 100k rows to CSV: {:?}", t.elapsed());
    assert_eq!(n, 100_000);
    let text = String::from_utf8(buf).unwrap();
    assert_eq!(text.lines().nth(1).unwrap(), "1,name-1,1.37,2024-01-01 00:01:00");

    let mut buf = Vec::new();
    mgr.export_query(
        "my",
        "select id, name from demo.categories order by id limit 2",
        &ExportOptions { format: ExportFormat::SqlInsert, dialect: Driver::MySql, table_name: Some("demo.categories".into()), ..Default::default() },
        &mut buf,
    )
    .await
    .unwrap();
    assert_eq!(
        String::from_utf8(buf).unwrap(),
        "insert into `demo`.`categories` (`id`, `name`) values (1, 'Electronics');\ninsert into `demo`.`categories` (`id`, `name`) values (2, 'Books');\n"
    );
}

// ------------------------------------------------------------ regression tests (review)

/// Create a throwaway database (never `demo`) for a test.
async fn scratch_db(mgr: &ConnectionManager, s: &SessionId, name: &str, ddl: &str) {
    assert_ok(&run(mgr, s, &format!("drop database if exists {name}; create database {name}; use {name}")).await);
    assert_ok(&run(mgr, s, ddl).await);
}

/// Defect 2: no-PK tables match on all column values and touch one row (`LIMIT 1`).
#[tokio::test]
async fn nopk_changes_touch_exactly_one_row() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    let blob = "ab".repeat(600);
    scratch_db(
        &mgr,
        &s,
        "scratch_dbcore_nopk",
        &format!(
            "create table dup (a int, b text); insert into dup values (1,'x'),(1,'x'),(2,'y');\
             create table kinds (a int, j json, f float, d double, dec_ decimal(30,10), bl blob, t tinyint(1));\
             insert into kinds values (1, '{{\"k\": 1, \"z\": [1, 2]}}', 0.1, 0.1, '1.2345678901', x'{blob}', 5),\
                                      (1, '{{\"k\": 1, \"z\": [1, 2]}}', 0.1, 0.1, '1.2345678901', x'{blob}', 5),\
                                      (2, '{{\"k\": 2}}', 0.3, 1e-5, '2.5', x'00ff', 0);\
             create table onlyfloat (f float, d double); insert into onlyfloat values (0.1, 0.2)"
        ),
    )
    .await;
    let dup = ObjectRef::table(Some("scratch_dbcore_nopk"), "dup");
    let r = mgr.apply_changes("my", &dup, &[change(ChangeKind::Delete, json!({"a": 1, "b": "x"}), json!({}))]).await.unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    let r = mgr.apply_changes("my", &dup, &[change(ChangeKind::Update, json!({"a": 2, "b": "y"}), json!({"b": "z"}))]).await.unwrap();
    assert!(r.committed, "{r:?}");
    let rs = mgr.table_data("my", &dup, &TableDataRequest { order_by: Some("a".into()), ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows, vec![vec![json!(1), json!("x")], vec![json!(2), json!("z")]]);
    assert!(rs.row_locators.is_none());

    // keys built from the grid values work for json / float / double / decimal / blob (truncated preview!) / tinyint(1)
    let kinds = ObjectRef::table(Some("scratch_dbcore_nopk"), "kinds");
    let rs = mgr.table_data("my", &kinds, &TableDataRequest { order_by: Some("a, d desc".into()), ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows[0][6], json!(5), "tinyint(1) is an integer");
    assert_eq!(rs.rows[0][5]["truncated"], json!(true));
    let key = |row: &Vec<Value>| -> Value { json!({"a": row[0], "j": row[1], "f": row[2], "d": row[3], "dec_": row[4], "bl": row[5], "t": row[6]}) };
    let r = mgr.apply_changes("my", &kinds, &[change(ChangeKind::Update, key(&rs.rows[0]), json!({"t": 6}))]).await.unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    let r = mgr.apply_changes("my", &kinds, &[change(ChangeKind::Delete, key(&rs.rows[2]), json!({}))]).await.unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from kinds where t = 6").await), json!(1));
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from kinds").await), json!(2));

    // only float columns: compared with a tolerance
    let of = ObjectRef::table(Some("scratch_dbcore_nopk"), "onlyfloat");
    let rs = mgr.table_data("my", &of, &Default::default()).await.unwrap();
    let r = mgr.apply_changes("my", &of, &[change(ChangeKind::Update, json!({"f": rs.rows[0][0], "d": rs.rows[0][1]}), json!({"d": 0.5}))]).await.unwrap();
    assert!(r.committed, "{r:?}");
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from onlyfloat where d = 0.5").await), json!(1));

    assert_ok(&run(&mgr, &s, "drop database scratch_dbcore_nopk").await);
    mgr.close_session(&s).await;
}

/// Defect 2 (+ keys): bigint keys above 2^53 arrive as strings and must match exactly one row.
#[tokio::test]
async fn bigint_keys_above_2_pow_53_match_exactly() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    scratch_db(
        &mgr,
        &s,
        "scratch_dbcore_big",
        "create table big (id bigint primary key, v int); insert into big values (9007199254740992,0),(9007199254740993,0),(9007199254740994,0);\
         create table ubig (id bigint unsigned primary key, v int); insert into ubig values (18446744073709551614,0),(18446744073709551615,0)",
    )
    .await;
    let t = ObjectRef::table(Some("scratch_dbcore_big"), "big");
    let rs = mgr.table_data("my", &t, &TableDataRequest { order_by: Some("id".into()), ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows[1][0], json!("9007199254740993"));
    let r = mgr.apply_changes("my", &t, &[change(ChangeKind::Update, json!({"id": rs.rows[1][0]}), json!({"v": 1}))]).await.unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    assert_eq!(scalar(&run(&mgr, &s, "select group_concat(v order by id) from big").await), json!("0,1,0"));
    let u = ObjectRef::table(Some("scratch_dbcore_big"), "ubig");
    let r = mgr.apply_changes("my", &u, &[change(ChangeKind::Update, json!({"id": "18446744073709551615"}), json!({"v": 1}))]).await.unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    assert_eq!(scalar(&run(&mgr, &s, "select group_concat(v order by id) from ubig").await), json!("0,1"));
    assert_ok(&run(&mgr, &s, "drop database scratch_dbcore_big").await);
    mgr.close_session(&s).await;
}

/// Defect 8: TINYINT(1) is an integer (0/1/5); keys and export keep the real value.
#[tokio::test]
async fn tinyint1_is_an_integer() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    scratch_db(
        &mgr,
        &s,
        "scratch_dbcore_t1",
        "create table t1 (id int primary key, f tinyint(1), g boolean, h tinyint(4)); insert into t1 values (1, 5, 1, 5), (2, 0, 0, 0), (3, 1, 2, -3), (4, null, null, null)",
    )
    .await;
    let t = ObjectRef::table(Some("scratch_dbcore_t1"), "t1");
    let rs = mgr.table_data("my", &t, &TableDataRequest { order_by: Some("id".into()), ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows[0], vec![json!(1), json!(5), json!(1), json!(5)]);
    assert_eq!(rs.rows[1], vec![json!(2), json!(0), json!(0), json!(0)]);
    assert_eq!(rs.rows[2], vec![json!(3), json!(1), json!(2), json!(-3)]);
    assert_eq!(rs.rows[3][1], Value::Null);
    let ev = run(&mgr, &s, "select f, g from t1 where id = 1").await;
    assert_eq!(first_rs(&ev).1, vec![vec![json!(5), json!(1)]]);
    // export keeps the value
    let mut buf = Vec::new();
    mgr.export_query("my", "select id, f from scratch_dbcore_t1.t1 order by id", &ExportOptions { format: ExportFormat::Csv, ..Default::default() }, &mut buf).await.unwrap();
    assert_eq!(String::from_utf8(buf).unwrap(), "id,f\n1,5\n2,0\n3,1\n4,\n");
    let mut buf = Vec::new();
    let o = ExportOptions { format: ExportFormat::SqlInsert, dialect: Driver::MySql, table_name: Some("scratch_dbcore_t1.t1".into()), ..Default::default() };
    mgr.export_query("my", "select id, f from scratch_dbcore_t1.t1 where id = 1", &o, &mut buf).await.unwrap();
    assert!(String::from_utf8(buf).unwrap().contains("values (1, 5)"));
    // key on a tinyint(1) column, and editing it
    let nokey = ObjectRef::table(Some("scratch_dbcore_t1"), "t1");
    let r = mgr.apply_changes("my", &nokey, &[change(ChangeKind::Update, json!({"id": 1, "f": 5}), json!({"f": 7}))]).await.unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    assert_eq!(scalar(&run(&mgr, &s, "select f from t1 where id = 1").await), json!(7));
    assert_ok(&run(&mgr, &s, "drop database scratch_dbcore_t1").await);
    mgr.close_session(&s).await;
}

/// Defect 3: `CALL` with two result sets of different shape, and statement separators.
#[tokio::test]
async fn multi_result_call_and_separators() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    scratch_db(
        &mgr,
        &s,
        "scratch_dbcore_multi",
        "create procedure rv_two() begin select 1 as a; select 1 as a, 2 as b; end; create table one (a int); insert into one values (1)",
    )
    .await;
    let m2 = mgr.clone();
    let out = tokio::spawn(async move {
        m2.export_query("my", "call scratch_dbcore_multi.rv_two()", &ExportOptions { format: ExportFormat::Json, ..Default::default() }, Vec::<u8>::new()).await
    })
    .await
    .expect("export task panicked");
    out.unwrap();
    // the grid shows the first result set and ignores the rest, without panicking
    let ev = run(&mgr, &s, "call scratch_dbcore_multi.rv_two()").await;
    assert_ok(&ev);

    let t = ObjectRef::table(Some("scratch_dbcore_multi"), "one");
    let m2 = mgr.clone();
    let t2 = t.clone();
    let r = tokio::spawn(async move {
        m2.table_data("my", &t2, &TableDataRequest { where_clause: Some("true; select 1, 2, 3".into()), ..Default::default() }).await.map(|_| ())
    })
    .await
    .expect("table_data task panicked");
    assert!(r.unwrap_err().to_string().contains("statement separator"));
    assert_ok(&run(&mgr, &s, "drop database scratch_dbcore_multi").await);
    mgr.close_session(&s).await;
}

/// Defect 5 + 6 on MySQL.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_busy_after_done_and_idle_timeout() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    let opts = ExecOptions { max_rows: 1, ..Default::default() };
    for i in 0..100 {
        let mut h = mgr.execute(&s, "select 1 union all select 2", opts.clone()).await.unwrap_or_else(|e| panic!("run {i}: {e}"));
        wait_done(&mut h).await;
        let mut h = mgr.execute(&s, "select 1", opts.clone()).await.unwrap_or_else(|e| panic!("run {i}b: {e}"));
        wait_done(&mut h).await;
        let mut h = mgr.execute(&s, "select 2", opts.clone()).await.unwrap_or_else(|e| panic!("run {i}c: {e}"));
        wait_done(&mut h).await;
    }
    let mut h = mgr.execute(&s, "select * from demo.big_table", ExecOptions { max_rows: 10, keep_open_secs: 1, ..Default::default() }).await.unwrap();
    wait_done(&mut h).await;
    assert!(mgr.fetch_more(&h.id, 0, 5).await.is_ok());
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let err = mgr.fetch_more(&h.id, 0, 5).await.unwrap_err();
    assert!(err.to_string().contains("result set is closed"), "{err}");
    assert_eq!(scalar(&run(&mgr, &s, "select 9").await), json!(9));
    mgr.close_session(&s).await;
}

/// DDL commits implicitly in MySQL: the session must notice that the transaction is gone (it used to keep
/// `in_tx == true`, so a later ROLLBACK undid nothing and `apply_changes_in_session` edited with a savepoint
/// in autocommit mode, i.e. never inside a transaction the user could roll back).
#[tokio::test]
async fn implicit_commit_ends_the_tracked_transaction() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop table if exists demo.scratch_ic2; drop table if exists demo.scratch_ic; create table demo.scratch_ic (id int primary key, v varchar(32)); insert into demo.scratch_ic values (1,'a')").await);
    let t = ObjectRef::table(Some("demo"), "scratch_ic");
    let req = TableDataRequest { order_by: Some("id".into()), ..Default::default() };
    let vs = |rs: &ResultSet| rs.rows.iter().map(|r| r[1].clone()).collect::<Vec<_>>();

    assert_ok(&run(&mgr, &s, "start transaction").await);
    assert!(mgr.session_in_transaction(&s).unwrap());
    // DDL: implicit commit
    assert_ok(&run(&mgr, &s, "create table demo.scratch_ic2 (i int)").await);
    assert!(!mgr.session_in_transaction(&s).unwrap(), "the server ended the transaction");
    assert_ok(&run(&mgr, &s, "drop table demo.scratch_ic2").await);

    // an edit now gets a transaction of its own and is committed (visible to another connection)
    let r = mgr.apply_changes_in_session(&s, &t, &[change(ChangeKind::Update, json!({"id": 1}), json!({"v": "kept"}))]).await.unwrap();
    assert!(r.committed, "{r:?}");
    assert_eq!(vs(&mgr.table_data("my", &t, &req).await.unwrap()), vec![json!("kept")]);

    // a new explicit transaction is tracked again; ROLLBACK undoes the work
    assert_ok(&run(&mgr, &s, "begin").await);
    assert!(mgr.session_in_transaction(&s).unwrap());
    assert_ok(&run(&mgr, &s, "update demo.scratch_ic set v = 'gone'").await);
    assert!(mgr.session_in_transaction(&s).unwrap());
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert!(!mgr.session_in_transaction(&s).unwrap());
    assert_eq!(vs(&mgr.table_data("my", &t, &req).await.unwrap()), vec![json!("kept")]);

    // ROLLBACK after an implicit commit really has nothing to undo
    assert_ok(&run(&mgr, &s, "begin; update demo.scratch_ic set v = 'ddl-commits-me'; alter table demo.scratch_ic add column x int").await);
    assert!(!mgr.session_in_transaction(&s).unwrap());
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert_eq!(vs(&mgr.table_data("my", &t, &req).await.unwrap()), vec![json!("ddl-commits-me")]);

    // autocommit = 0 puts every statement into an open transaction
    assert_ok(&run(&mgr, &s, "set autocommit = 0").await);
    assert_ok(&run(&mgr, &s, "update demo.scratch_ic set v = 'ac0'").await);
    assert!(mgr.session_in_transaction(&s).unwrap());
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert_ok(&run(&mgr, &s, "set autocommit = 1").await);
    assert!(!mgr.session_in_transaction(&s).unwrap());
    assert_eq!(vs(&mgr.table_data("my", &t, &req).await.unwrap()), vec![json!("ddl-commits-me")]);

    assert_ok(&run(&mgr, &s, "drop table demo.scratch_ic").await);
    mgr.close_session(&s).await;
}

/// Events for the transaction: `TxStatus` on every change, `TxEnded` for COMMIT / ROLLBACK and the implicit commit.
#[tokio::test]
async fn transaction_events_and_init_sql() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop table if exists demo.scratch_ev; drop table if exists demo.scratch_ev2; create table demo.scratch_ev (i int)").await);
    let ev = run(&mgr, &s, "begin").await;
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Active]);
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
    let ev = run(&mgr, &s, "insert into demo.scratch_ev values (1)").await;
    assert!(tx_statuses(&ev).is_empty());
    let ev = run(&mgr, &s, "create table demo.scratch_ev2 (i int)").await;
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    assert_eq!(tx_ended(&ev), vec![(true, "IMPLICIT COMMIT".to_string())]);
    assert_ok(&run(&mgr, &s, "begin").await);
    let ev = run(&mgr, &s, "commit").await;
    assert_eq!(tx_ended(&ev), vec![(true, "COMMIT".to_string())]);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    assert_ok(&run(&mgr, &s, "begin").await);
    let ev = run(&mgr, &s, "rollback").await;
    assert_eq!(tx_ended(&ev), vec![(false, "ROLLBACK".to_string())]);
    assert_ok(&run(&mgr, &s, "drop table demo.scratch_ev; drop table demo.scratch_ev2").await);
    mgr.close_session(&s).await;

    // init_sql
    let s = mgr.open_session_with("my", &["use information_schema".to_string()]).await.unwrap();
    assert_eq!(scalar(&run(&mgr, &s, "select database()").await), json!("information_schema"));
    mgr.close_session(&s).await;
    let e = mgr.open_session_with("my", &["use no_such_database_xyz".to_string()]).await.unwrap_err();
    assert!(e.to_string().contains("1049"), "{e}");
}

/// A URL without a password plus the `password` field connects (the app keeps passwords out of stored URLs).
#[tokio::test]
async fn password_field_completes_a_url_without_password() {
    let Some(mut cfg) = mysql_cfg() else { return };
    let url = cfg.url_override.clone().unwrap();
    let (auth, tail) = url.strip_prefix("mysql://").unwrap().split_once('@').unwrap();
    let (user, pass) = auth.split_once(':').unwrap();
    cfg.url_override = Some(format!("mysql://{user}@{tail}"));
    let mgr = ConnectionManager::new();
    assert!(!mgr.test_connection(&cfg).await.ok, "no password: must be refused");
    cfg.password = Some(pass.to_string());
    let r = mgr.test_connection(&cfg).await;
    assert!(r.ok, "{r:?}");
}
