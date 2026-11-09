//! SQLite integration tests (always run; they use a temp file).

mod common;

use common::*;
use dbcore::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

const SCHEMA: &str = r#"
create table categories (id integer primary key, name text not null unique, parent_id integer references categories (id));
create table products (
    id integer primary key autoincrement,
    sku varchar(32) not null,
    name varchar(255) not null,
    category_id integer not null references categories (id) on delete cascade,
    price numeric(10,2) not null check (price > 0),
    stock integer not null default 0,
    created_at datetime default current_timestamp,
    unique (sku)
);
create index idx_products_category on products (category_id);
create table order_items (order_id integer not null, line_no integer not null, qty integer, primary key (order_id, line_no)) without rowid;
create table audit (id integer primary key, msg text);
create view v_products as select p.id, p.name, c.name as category from products p join categories c on c.id = p.category_id;
create trigger trg_products_audit after insert on products
begin
    insert into audit (msg) values ('added ' || new.name);
    update products set stock = case when new.stock < 0 then 0 else new.stock end where id = new.id;
end;
create table all_types (id integer primary key, i integer, r real, t text, b blob, n numeric, big integer, nul text);
insert into all_types values (1, 42, 2.5, 'héllo 😀', x'deadbeef', 7, 9223372036854775807, null);
insert into categories (name) values ('Books'), ('Garden');
insert into products (sku, name, category_id, price, stock) values ('A1', 'Alpha', 1, 9.99, 5), ('B2', 'Beta', 2, 19.5, 0);
create table nums (n integer);
insert into nums with recursive c(x) as (select 1 union all select x + 1 from c where x < 20000) select x from c;
"#;

async fn setup() -> (tempfile::TempDir, DataSourceConfig, ConnectionManager) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = lite_cfg(&dir.path().join("test.db"));
    let mgr = ConnectionManager::new();
    mgr.connect(&cfg).await.unwrap();
    let s = mgr.open_session("lite").await.unwrap();
    let ev = run(&mgr, &s, SCHEMA).await;
    assert_ok(&ev);
    mgr.close_session(&s).await;
    (dir, cfg, mgr)
}

fn change(kind: ChangeKind, key: Value, values: Value) -> RowChange {
    let m = |v: Value| {
        v.as_object()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeMap<_, _>>()
    };
    RowChange {
        kind,
        key: m(key),
        values: m(values),
        row_locator: None,
    }
}

#[tokio::test]
async fn connection_errors() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = ConnectionManager::new();
    let missing = DataSourceConfig {
        id: "x".into(),
        driver: Driver::Sqlite,
        file: dir.path().join("nope.db").to_string_lossy().into(),
        ..Default::default()
    };
    let r = mgr.test_connection(&missing).await;
    assert!(!r.ok);
    println!("missing sqlite file: {}", r.message);
    assert!(
        r.message.contains("unable to open database file"),
        "{}",
        r.message
    );
    let r = mgr
        .test_connection(&DataSourceConfig {
            id: "x".into(),
            driver: Driver::Sqlite,
            ..Default::default()
        })
        .await;
    assert!(!r.ok && r.message.contains("file is not set"));
    let r = mgr
        .test_connection(&lite_cfg(&dir.path().join("new.db")))
        .await;
    assert!(r.ok, "{r:?}");
    assert!(r.server_version.unwrap().starts_with("SQLite 3."));
}

#[tokio::test]
async fn introspection_and_ddl() {
    let (_d, _cfg, mgr) = setup().await;
    assert_eq!(names(&children(&mgr, "lite", &[]).await), ["main"]);
    let folders = children(&mgr, "lite", &["main"]).await;
    let f: Vec<_> = folders
        .iter()
        .map(|f| (f.name.as_str(), f.hint.clone().unwrap()))
        .collect();
    assert_eq!(
        f,
        vec![("tables", "6".to_string()), ("views", "1".to_string())]
    );
    assert_eq!(
        names(&children(&mgr, "lite", &["main", "tables"]).await),
        [
            "all_types",
            "audit",
            "categories",
            "nums",
            "order_items",
            "products"
        ]
    );
    let with_sys = mgr
        .introspect_with(
            "lite",
            &["main".into(), "tables".into()],
            &IntrospectOptions { show_system: true },
        )
        .await
        .unwrap();
    assert!(names(&with_sys).contains(&"sqlite_sequence".to_string()));
    assert_eq!(
        names(&children(&mgr, "lite", &["main", "views"]).await),
        ["v_products"]
    );

    let sub = children(&mgr, "lite", &["main", "tables", "products"]).await;
    let sub: Vec<_> = sub
        .iter()
        .map(|f| (f.name.as_str(), f.hint.clone().unwrap()))
        .collect();
    assert_eq!(
        sub,
        vec![
            ("columns", "7".to_string()),
            ("keys", "2".to_string()),
            ("foreign keys", "1".to_string()),
            ("indexes", "1".to_string()),
            ("triggers", "1".to_string())
        ]
    );
    let cols = children(&mgr, "lite", &["main", "tables", "products", "columns"]).await;
    assert_eq!(
        names(&cols),
        [
            "id",
            "sku",
            "name",
            "category_id",
            "price",
            "stock",
            "created_at"
        ]
    );
    let hints: Vec<_> = cols.iter().map(|c| c.hint.clone().unwrap()).collect();
    assert_eq!(
        hints,
        [
            "INTEGER",
            "varchar(32)",
            "varchar(255)",
            "INTEGER",
            "numeric(10,2)",
            "INTEGER",
            "datetime"
        ]
    );
    assert_eq!(cols[0].extra["isPk"], json!(true));
    assert_eq!(cols[1].extra["nullable"], json!(false));
    assert_eq!(cols[6].extra["nullable"], json!(true));
    assert_eq!(cols[5].extra["default"], "0");

    let keys = children(&mgr, "lite", &["main", "tables", "products", "keys"]).await;
    assert_eq!(names(&keys), ["products_pk", "sqlite_autoindex_products_1"]);
    assert_eq!(
        (keys[0].kind, keys[1].kind),
        (NodeKind::PrimaryKey, NodeKind::UniqueKey)
    );
    assert_eq!(keys[1].hint.as_deref(), Some("(sku)"));
    let fks = children(
        &mgr,
        "lite",
        &["main", "tables", "products", "foreign_keys"],
    )
    .await;
    assert_eq!(fks.len(), 1);
    assert_eq!(
        fks[0].hint.as_deref(),
        Some("(category_id) -> categories(id)")
    );
    assert_eq!(fks[0].extra["onDelete"], "CASCADE");
    let idx = children(&mgr, "lite", &["main", "tables", "products", "indexes"]).await;
    assert_eq!(names(&idx), ["idx_products_category"]);
    assert_eq!(idx[0].hint.as_deref(), Some("(category_id)"));
    let trg = children(&mgr, "lite", &["main", "tables", "products", "triggers"]).await;
    assert_eq!(
        (trg[0].name.as_str(), trg[0].hint.as_deref()),
        ("trg_products_audit", Some("AFTER INSERT"))
    );
    // composite PK
    let keys = children(&mgr, "lite", &["main", "tables", "order_items", "keys"]).await;
    assert_eq!(keys[0].hint.as_deref(), Some("(order_id, line_no)"));
    let v = children(&mgr, "lite", &["main", "views", "v_products"]).await;
    assert_eq!(names(&v), ["columns"]);
    assert!(mgr
        .introspect("lite", &["main".into(), "bogus".into()])
        .await
        .is_err());

    // DDL = sqlite_master.sql
    let t = |name: &str, kind: NodeKind| ObjectRef {
        schema: Some("main".into()),
        name: name.into(),
        kind,
        table: None,
        signature: None,
    };
    let ddl = mgr
        .ddl("lite", &t("products", NodeKind::Table))
        .await
        .unwrap();
    assert!(ddl.starts_with("CREATE TABLE products ("), "{ddl}");
    assert!(ddl.ends_with(");"));
    let v = mgr
        .ddl("lite", &t("v_products", NodeKind::View))
        .await
        .unwrap();
    assert!(v.starts_with("CREATE VIEW v_products"));
    let i = mgr
        .ddl("lite", &t("idx_products_category", NodeKind::Index))
        .await
        .unwrap();
    assert_eq!(
        i,
        "CREATE INDEX idx_products_category on products (category_id);"
    );
    let tr = mgr
        .ddl("lite", &t("trg_products_audit", NodeKind::Trigger))
        .await
        .unwrap();
    assert!(
        tr.starts_with("CREATE TRIGGER trg_products_audit") && tr.trim_end().ends_with("end;"),
        "{tr}"
    );
    assert!(mgr.ddl("lite", &t("nope", NodeKind::Table)).await.is_err());

    // the stored trigger DDL (BEGIN .. END with inner semicolons and CASE) survives the splitter
    let s = mgr.open_session("lite").await.unwrap();
    let ev = run(&mgr, &s, &format!("drop trigger trg_products_audit; {tr}")).await;
    assert_ok(&ev);
    assert_eq!(
        ev.iter()
            .filter(|e| matches!(e, ExecEvent::Statement { .. }))
            .count(),
        2
    );
    mgr.close_session(&s).await;

    let snap = mgr.schema_snapshot("lite", None).await.unwrap();
    let p = snap.iter().find(|o| o.name == "products").unwrap();
    assert_eq!((p.columns.len(), p.columns[0].is_pk), (7, true));
    assert_eq!(
        snap.iter().find(|o| o.name == "v_products").unwrap().kind,
        NodeKind::View
    );
}

#[tokio::test]
async fn snapshot_has_foreign_keys() {
    let (_d, _cfg, mgr) = setup().await;
    let snap = mgr.schema_snapshot("lite", None).await.unwrap();
    let products = snap.iter().find(|o| o.name == "products").unwrap();
    assert_eq!(products.foreign_keys.len(), 1);
    let fk = &products.foreign_keys[0];
    assert_eq!(fk.columns, vec!["category_id".to_string()]);
    assert_eq!(fk.ref_schema, "main");
    assert_eq!(fk.ref_table, "categories");
    assert_eq!(fk.ref_columns, vec!["id".to_string()]);
    // a self-referencing FK keeps its direction
    let categories = snap.iter().find(|o| o.name == "categories").unwrap();
    assert_eq!(categories.foreign_keys.len(), 1);
    assert_eq!(
        categories.foreign_keys[0].columns,
        vec!["parent_id".to_string()]
    );
    assert_eq!(categories.foreign_keys[0].ref_table, "categories");
    assert_eq!(
        categories.foreign_keys[0].ref_columns,
        vec!["id".to_string()]
    );

    // composite FK: the columns and referenced columns keep their order
    let s = mgr.open_session("lite").await.unwrap();
    assert_ok(
        &run(
            &mgr,
            &s,
            "create table pfk_parent (a int, b int, primary key (a, b));\
         create table pfk_child (x int, y int, foreign key (x, y) references pfk_parent (a, b));",
        )
        .await,
    );
    mgr.close_session(&s).await;
    let snap = mgr.schema_snapshot("lite", None).await.unwrap();
    let child = snap.iter().find(|o| o.name == "pfk_child").unwrap();
    assert_eq!(child.foreign_keys.len(), 1);
    assert_eq!(
        child.foreign_keys[0].columns,
        vec!["x".to_string(), "y".to_string()]
    );
    assert_eq!(child.foreign_keys[0].ref_table, "pfk_parent");
    assert_eq!(
        child.foreign_keys[0].ref_columns,
        vec!["a".to_string(), "b".to_string()]
    );
}

#[tokio::test]
async fn expression_indexes_keep_their_terms() {
    let (_dir, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();
    let ev = run(
        &mgr,
        &s,
        "create table ex (d text, b text, c integer);\n\
         create unique index ex_u on ex (d, lower(b) collate nocase desc, c);\n\
         create index ex_plain on ex (c, d);",
    )
    .await;
    assert_ok(&ev);
    mgr.close_session(&s).await;
    let idx = children(&mgr, "lite", &["main", "tables", "ex", "indexes"]).await;
    assert_eq!(names(&idx), ["ex_plain", "ex_u"]);
    assert_eq!(idx[0].extra["expression"], json!(false));
    assert_eq!(idx[0].extra["columns"], "c, d");
    assert_eq!(idx[1].extra["expression"], json!(true));
    assert_eq!(idx[1].extra["columns"], "d, lower(b), c");
    assert_eq!(idx[1].hint.as_deref(), Some("(d, lower(b), c)"));
}

#[tokio::test]
async fn execute_types_errors_and_state() {
    let (_d, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();

    let ev = run(&mgr, &s, "select * from all_types").await;
    assert_ok(&ev);
    let (cols, rows, _) = first_rs(&ev);
    assert_eq!(
        rows[0],
        vec![
            json!(1),
            json!(42),
            json!(2.5),
            json!("héllo 😀"),
            json!({"$bin": "deadbeef", "len": 4}),
            json!(7),
            json!("9223372036854775807"),
            Value::Null
        ]
    );
    assert_eq!(cols[1].type_name, "integer");
    assert_eq!(cols[3].type_name, "text");

    let ev = run(&mgr, &s, "select id, name from products where 0").await;
    let (cols, rows, _) = first_rs(&ev);
    assert_eq!(
        cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["id", "name"]
    );
    assert!(rows.is_empty());
    let ev = run(&mgr, &s, "update products set stock = stock where id < 0").await;
    assert!(
        ev.iter().any(|e| matches!(
            e,
            ExecEvent::Update {
                index: 0,
                rows_affected: 0
            }
        )),
        "{ev:?}"
    );
    let ev = run(
        &mgr,
        &s,
        "pragma table_info(products); explain query plan select 1",
    )
    .await;
    assert_ok(&ev);
    assert_eq!(
        ev.iter()
            .filter(|e| matches!(e, ExecEvent::ResultSet { .. }))
            .count(),
        2
    );

    // trigger fired by an insert (the statement splitter keeps the trigger body intact)
    let ev = run(&mgr, &s, "insert into products (sku, name, category_id, price, stock) values ('C3', 'Gamma', 1, 1, -4); select msg from audit where msg like '%Gamma'; select stock from products where sku = 'C3'").await;
    assert_ok(&ev);
    let rs: Vec<_> = ev
        .iter()
        .filter_map(|e| {
            if let ExecEvent::ResultSet { rows, .. } = e {
                Some(rows[0][0].clone())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(rs, vec![json!("added Gamma"), json!(0)]);

    // errors
    let ev = run(&mgr, &s, "select * from nonexistent_table_xyz").await;
    assert_eq!(
        errors(&ev),
        vec![
            "[1] [SQLITE_ERROR] SQL error or missing database (no such table: nonexistent_table_xyz)"
                .to_string()
        ]
    );
    let ev = run(&mgr, &s, "insert into categories (name) values ('Books')").await;
    assert_eq!(errors(&ev), vec!["[2067] [SQLITE_CONSTRAINT_UNIQUE] A UNIQUE constraint failed (UNIQUE constraint failed: categories.name)".to_string()]);
    let ev = run(
        &mgr,
        &s,
        "insert into products (sku, name, category_id, price) values ('Z', 'Z', 99, 1)",
    )
    .await;
    assert!(
        errors(&ev)[0].contains("FOREIGN KEY constraint failed"),
        "{:?}",
        errors(&ev)
    );
    let ev = run(&mgr, &s, "select 1; select * from nope; select 3").await;
    assert_eq!(
        ev.iter()
            .filter(|e| matches!(e, ExecEvent::ResultSet { .. }))
            .count(),
        1
    );

    // transactions live on the session connection
    let s2 = mgr.open_session("lite").await.unwrap();
    assert_ok(&run(&mgr, &s, "begin; insert into audit (msg) values ('in tx')").await);
    assert_eq!(
        scalar(&run(&mgr, &s, "select count(*) from audit where msg = 'in tx'").await),
        json!(1)
    );
    assert_eq!(
        scalar(&run(&mgr, &s2, "select count(*) from audit where msg = 'in tx'").await),
        json!(0)
    );
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert_eq!(
        scalar(&run(&mgr, &s, "select count(*) from audit where msg = 'in tx'").await),
        json!(0)
    );
    mgr.close_session(&s).await;
    mgr.close_session(&s2).await;
}

#[tokio::test]
async fn paging_and_cancellation() {
    let (_d, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();
    let mut h = mgr
        .execute(
            &s,
            "select n from nums order by n",
            ExecOptions {
                max_rows: 500,
                stop_on_error: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut events = Vec::new();
    while let Some(e) = h.events.recv().await {
        let done = matches!(e, ExecEvent::Done { .. });
        events.push(e);
        if done {
            break;
        }
    }
    let (_, rows, more) = first_rs(&events);
    assert_eq!((rows.len(), more), (500, true));
    let mut total = 500;
    let mut next = 501;
    loop {
        let page = mgr.fetch_more(&h.id, 0, 7000).await.unwrap();
        assert_eq!(page.rows[0][0], json!(next));
        next += page.rows.len() as i64;
        total += page.rows.len();
        if !page.has_more {
            break;
        }
    }
    assert_eq!(total, 20_000);

    // abandon a half-read result
    let h = mgr
        .execute(
            &s,
            "select n from nums",
            ExecOptions {
                max_rows: 10,
                stop_on_error: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let mut ev = h.events;
    while let Some(e) = ev.recv().await {
        if matches!(e, ExecEvent::Done { .. }) {
            break;
        }
    }
    assert_eq!(scalar(&run(&mgr, &s, "select 42").await), json!(42));
    assert!(mgr.fetch_more(&h.id, 0, 5).await.is_err());

    // interrupt a query that never ends
    let t = Instant::now();
    let mut h = mgr
        .execute(&s, "with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c", ExecOptions::default())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
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
    let msg = msg.expect("error event");
    assert!(
        msg.contains("SQLITE_INTERRUPT") && msg.contains("interrupted"),
        "{msg}"
    );
    println!("sqlite cancel: returned after {:?}", t.elapsed());
    assert!(t.elapsed() < Duration::from_secs(5));
    assert_eq!(scalar(&run(&mgr, &s, "select 5").await), json!(5));
    mgr.close_session(&s).await;
}

/// Editing on a session: own transaction outside `BEGIN`, a savepoint inside it (the transaction survives a failed
/// batch and the rows are visible to `table_data_in_session`).
#[tokio::test]
async fn session_scoped_edit_and_read() {
    let (_d, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();
    let products = ObjectRef::table(Some("main"), "products");
    let req = TableDataRequest {
        order_by: Some("id".into()),
        limit: 10,
        ..Default::default()
    };
    let name_of = |rs: &ResultSet| rs.rows.iter().map(|r| r[2].clone()).collect::<Vec<_>>();

    // auto: committed at once (the pool sees it)
    let r = mgr
        .apply_changes_in_session(
            &s,
            &products,
            &[change(
                ChangeKind::Update,
                json!({"id": 1}),
                json!({"name": "Auto"}),
            )],
        )
        .await
        .unwrap();
    assert!(r.committed && r.applied == 1, "{r:?}");
    assert_eq!(
        name_of(&mgr.table_data("lite", &products, &req).await.unwrap())[0],
        json!("Auto")
    );

    // manual: applied inside the open transaction
    assert_ok(&run(&mgr, &s, "begin").await);
    assert!(mgr.session_in_transaction(&s).unwrap());
    let r = mgr
        .apply_changes_in_session(
            &s,
            &products,
            &[change(
                ChangeKind::Update,
                json!({"id": 1}),
                json!({"name": "Manual"}),
            )],
        )
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    assert!(
        mgr.session_in_transaction(&s).unwrap(),
        "still in the transaction"
    );
    assert_eq!(
        name_of(
            &mgr.table_data_in_session(&s, &products, &req)
                .await
                .unwrap()
        )[0],
        json!("Manual")
    );

    // a failing batch rolls back to the savepoint only: "Manual" survives, the second row stays untouched
    let r = mgr
        .apply_changes_in_session(
            &s,
            &products,
            &[
                change(
                    ChangeKind::Update,
                    json!({"id": 2}),
                    json!({"name": "Lost"}),
                ),
                change(ChangeKind::Update, json!({"id": 999}), json!({"name": "x"})),
            ],
        )
        .await
        .unwrap();
    assert!(
        !r.committed && r.applied == 0 && r.results[1].error.is_some(),
        "{r:?}"
    );
    let rs = mgr
        .table_data_in_session(&s, &products, &req)
        .await
        .unwrap();
    assert_eq!(
        (name_of(&rs)[0].clone(), name_of(&rs)[1].clone()),
        (json!("Manual"), json!("Beta"))
    );

    // rollback undoes the batch of the transaction
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert_eq!(
        name_of(
            &mgr.table_data_in_session(&s, &products, &req)
                .await
                .unwrap()
        )[0],
        json!("Auto")
    );

    // an open paging result of the session is released first
    let mut h = mgr
        .execute(
            &s,
            "select n from nums",
            ExecOptions {
                max_rows: 10,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let ev = wait_done(&mut h).await;
    assert!(matches!(
        ev.iter().find(|e| matches!(e, ExecEvent::ResultSet { .. })),
        Some(ExecEvent::ResultSet { has_more: true, .. })
    ));
    let rs = mgr
        .table_data_in_session(&s, &products, &req)
        .await
        .unwrap();
    assert_eq!(rs.rows.len(), 2);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn table_data_edit_export() {
    let (_d, _cfg, mgr) = setup().await;
    let nums = ObjectRef::table(Some("main"), "nums");
    let t = Instant::now();
    let rs = mgr
        .table_data(
            "lite",
            &nums,
            &TableDataRequest {
                order_by: Some("n desc".into()),
                limit: 500,
                count_total: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    println!("BENCH sqlite first 500 rows: {:?}", t.elapsed());
    assert_eq!(
        (rs.rows.len(), rs.has_more, rs.total_hint),
        (500, true, Some(20000))
    );
    assert_eq!(rs.rows[0][0], json!(20000));

    let products = ObjectRef::table(None, "products");
    let rs = mgr
        .table_data(
            "lite",
            &products,
            &TableDataRequest {
                limit: 10,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(rs.rows.len(), 2);
    assert_eq!(
        (rs.columns[0].is_pk, rs.columns[0].table_ref.as_deref()),
        (true, Some("products"))
    );
    assert!(!rs.columns[1].nullable);

    let r = mgr
        .apply_changes(
            "lite",
            &products,
            &[
                change(ChangeKind::Insert, json!({}), json!({"sku": "NEW", "name": "O'Reilly", "category_id": 1, "price": 3.5, "stock": 2})),
                change(ChangeKind::Update, json!({"id": rs.rows[0][0]}), json!({"price": 11.25, "name": "Renamed"})),
                change(ChangeKind::Delete, json!({"id": rs.rows[1][0]}), json!({})),
            ],
        )
        .await
        .unwrap();
    assert!(r.committed && r.applied == 3, "{r:?}");
    let rs = mgr
        .table_data(
            "lite",
            &products,
            &TableDataRequest {
                limit: 10,
                order_by: Some("id".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(rs.rows.len(), 2);
    assert_eq!(rs.rows[0][2], json!("Renamed"));
    assert_eq!(rs.rows[0][4], json!(11.25));
    assert_eq!(rs.rows[1][2], json!("O'Reilly"));

    // failure rolls back
    let r = mgr
        .apply_changes(
            "lite",
            &products,
            &[
                change(
                    ChangeKind::Insert,
                    json!({}),
                    json!({"sku": "ROLLED", "name": "x", "category_id": 1, "price": 1}),
                ),
                change(
                    ChangeKind::Insert,
                    json!({}),
                    json!({"sku": "NEW", "name": "dup", "category_id": 1, "price": 1}),
                ),
            ],
        )
        .await
        .unwrap();
    assert!(!r.committed);
    assert!(
        r.results[1]
            .error
            .as_deref()
            .unwrap()
            .contains("SQLITE_CONSTRAINT_UNIQUE"),
        "{r:?}"
    );
    let s = mgr.open_session("lite").await.unwrap();
    assert_eq!(
        scalar(
            &run(
                &mgr,
                &s,
                "select count(*) from products where sku = 'ROLLED'"
            )
            .await
        ),
        json!(0)
    );
    mgr.close_session(&s).await;

    // blobs round trip as $bin
    let at = ObjectRef::table(Some("main"), "all_types");
    mgr.apply_changes(
        "lite",
        &at,
        &[change(
            ChangeKind::Insert,
            json!({}),
            json!({"id": 2, "b": {"$bin": "0001ff"}, "big": "9223372036854775806"}),
        )],
    )
    .await
    .unwrap();
    let rs = mgr
        .table_data(
            "lite",
            &at,
            &TableDataRequest {
                limit: 10,
                order_by: Some("id".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(rs.rows[1][4], json!({"$bin": "0001ff", "len": 3}));

    // export
    let mut buf = Vec::new();
    let n = mgr
        .export_query(
            "lite",
            "select id, name from categories order by id",
            &ExportOptions {
                format: ExportFormat::Markdown,
                ..Default::default()
            },
            &mut buf,
        )
        .await
        .unwrap();
    assert_eq!(n, 2);
    assert_eq!(
        String::from_utf8(buf).unwrap(),
        "| id | name |\n| --- | --- |\n| 1 | Books |\n| 2 | Garden |\n"
    );
    let mut buf = Vec::new();
    mgr.export_query(
        "lite",
        "select id, name from categories order by id",
        &ExportOptions {
            format: ExportFormat::SqlInsert,
            dialect: Driver::Sqlite,
            table_name: Some("categories".into()),
            rows_per_insert: 10,
            ..Default::default()
        },
        &mut buf,
    )
    .await
    .unwrap();
    assert_eq!(
        String::from_utf8(buf).unwrap(),
        "insert into \"categories\" (\"id\", \"name\") values (1, 'Books'),\n    (2, 'Garden');\n"
    );
}

#[tokio::test]
async fn sql_expression_values_are_stored_as_expressions() {
    let (_d, _c, mgr) = setup().await;
    let t = ObjectRef::table(Some("main"), "products");
    // insert with an expression for a column, update another one with an expression
    let r = mgr
        .apply_changes(
            "lite",
            &t,
            &[change(
                ChangeKind::Insert,
                json!({}),
                json!({"sku": "E1", "name": {"$expr": "upper('expr')"}, "category_id": 1, "price": 1.5}),
            )],
        )
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    let r = mgr
        .apply_changes(
            "lite",
            &t,
            &[change(
                ChangeKind::Update,
                json!({"id": 1}),
                json!({"created_at": {"$expr": "date('2001-02-03')"}}),
            )],
        )
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    let s = mgr.open_session("lite").await.unwrap();
    let ev = run(
        &mgr,
        &s,
        "select name from products where sku = 'E1' union all select created_at from products where id = 1",
    )
    .await;
    assert_ok(&ev);
    mgr.close_session(&s).await;
    let rs = mgr
        .table_data(
            "lite",
            &t,
            &TableDataRequest {
                where_clause: Some("sku = 'E1' or id = 1".into()),
                order_by: Some("id".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(rs.rows[0][6], json!("2001-02-03"));
    assert_eq!(rs.rows[1][2], json!("EXPR"));
    // a second statement is refused, nothing is applied
    let bad = mgr
        .apply_changes(
            "lite",
            &t,
            &[change(
                ChangeKind::Update,
                json!({"id": 1}),
                json!({"name": {"$expr": "'x'; drop table products"}}),
            )],
        )
        .await;
    assert!(bad.is_err(), "{bad:?}");
}

#[tokio::test]
async fn read_only_and_reconnect() {
    let (dir, cfg, mgr) = setup().await;
    let ro = DataSourceConfig {
        id: "lite-ro".into(),
        read_only: true,
        options: Default::default(),
        ..cfg.clone()
    };
    mgr.connect(&ro).await.unwrap();
    let s = mgr.open_session("lite-ro").await.unwrap();
    assert_eq!(
        scalar(&run(&mgr, &s, "select count(*) from categories").await),
        json!(2)
    );
    let ev = run(&mgr, &s, "insert into categories (name) values ('x')").await;
    assert!(errors(&ev)[0].contains("readonly"), "{:?}", errors(&ev));
    mgr.disconnect("lite-ro").await;
    assert!(mgr.open_session("lite-ro").await.is_err());
    // reconnect applies a changed config
    mgr.reconnect(&cfg).await.unwrap();
    assert!(mgr.is_connected("lite"));
    drop(dir);
}

// ------------------------------------------------------------ regression tests (review)

/// Defect 3: several result sets with different columns in one call used to panic.
#[tokio::test]
async fn multi_result_set_export_does_not_panic() {
    let (_d, _cfg, mgr) = setup().await;
    let m2 = mgr.clone();
    let r = tokio::spawn(async move {
        m2.export_query(
            "lite",
            "select 1 as a; select 1 as a, 2 as b",
            &ExportOptions::default(),
            Vec::<u8>::new(),
        )
        .await
    })
    .await;
    // must not panic (a JoinError would mean the task panicked); the rows are exported
    let out = r.expect("export task panicked");
    assert!(out.is_ok(), "{out:?}");
    let mut buf = Vec::new();
    let o = ExportOptions {
        format: ExportFormat::Json,
        ..Default::default()
    };
    mgr.export_query("lite", "select 1 as a; select 1 as a, 2 as b", &o, &mut buf)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&buf).unwrap();
    // rows of a later result set with other columns are skipped, equally shaped ones appended
    assert_eq!(v, json!([{"a": 1}]));
    let mut buf = Vec::new();
    mgr.export_query("lite", "select 1 as a; select 2 as a", &o, &mut buf)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&buf).unwrap(),
        json!([{"a": 1}, {"a": 2}])
    );
}

/// Defect 3: a statement separator in the where / order by fragment is rejected.
#[tokio::test]
async fn table_data_rejects_statement_separators() {
    let (_d, _cfg, mgr) = setup().await;
    let t = ObjectRef::table(Some("main"), "categories");
    for (w, o) in [
        ("1=1; select 1,2,3", None),
        ("1=1;", None),
        ("1=1", Some("id; drop table audit")),
    ] {
        let req = TableDataRequest {
            where_clause: Some(w.into()),
            order_by: o.map(String::from),
            ..Default::default()
        };
        let err = mgr.table_data("lite", &t, &req).await.unwrap_err();
        assert!(err.to_string().contains("statement separator"), "{err}");
    }
    // a ';' inside quotes is fine
    let req = TableDataRequest {
        where_clause: Some("name <> 'a;b'".into()),
        ..Default::default()
    };
    assert_eq!(
        mgr.table_data("lite", &t, &req).await.unwrap().rows.len(),
        2
    );
}

async fn nopk_setup(mgr: &ConnectionManager) {
    let s = mgr.open_session("lite").await.unwrap();
    assert_ok(
        &run(
            mgr,
            &s,
            "create table nopk (a int, b text); insert into nopk values (1,'x'),(1,'x'),(2,'y')",
        )
        .await,
    );
    mgr.close_session(&s).await;
}

/// Defect 2: tables without a PK are edited through `rowid`; exactly one row changes.
#[tokio::test]
async fn nopk_rows_are_addressed_by_rowid_locator() {
    let (_d, _cfg, mgr) = setup().await;
    nopk_setup(&mgr).await;
    let t = ObjectRef::table(Some("main"), "nopk");
    let rs = mgr
        .table_data(
            "lite",
            &t,
            &TableDataRequest {
                order_by: Some("rowid".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let loc = rs
        .row_locators
        .clone()
        .expect("row locators for a table without PK");
    assert_eq!(loc.len(), rs.rows.len());
    assert_eq!(rs.columns.len(), 2, "the locator is not a column");
    assert!(rs.rows.iter().all(|r| r.len() == 2));
    // a table with a PK gets none
    let rs_pk = mgr
        .table_data(
            "lite",
            &ObjectRef::table(Some("main"), "categories"),
            &TableDataRequest::default(),
        )
        .await
        .unwrap();
    assert!(rs_pk.row_locators.is_none());

    let mut upd = change(
        ChangeKind::Update,
        json!({"a": 1, "b": "x"}),
        json!({"b": "changed"}),
    );
    upd.row_locator = Some(loc[1].clone());
    let r = mgr.apply_changes("lite", &t, &[upd]).await.unwrap();
    assert!(r.committed, "{r:?}");
    let rs = mgr
        .table_data(
            "lite",
            &t,
            &TableDataRequest {
                order_by: Some("rowid".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        rs.rows,
        vec![
            vec![json!(1), json!("x")],
            vec![json!(1), json!("changed")],
            vec![json!(2), json!("y")]
        ]
    );

    let mut del = change(ChangeKind::Delete, json!({"a": 1, "b": "x"}), json!({}));
    del.row_locator = Some(loc[0].clone());
    assert!(
        mgr.apply_changes("lite", &t, &[del])
            .await
            .unwrap()
            .committed
    );
    let rs = mgr
        .table_data(
            "lite",
            &t,
            &TableDataRequest {
                order_by: Some("rowid".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(rs.rows.len(), 2);
}

/// Defect 2: without a locator the key still touches exactly one row, never two.
#[tokio::test]
async fn nopk_duplicates_without_locator_touch_one_row() {
    let (_d, _cfg, mgr) = setup().await;
    nopk_setup(&mgr).await;
    let t = ObjectRef::table(Some("main"), "nopk");
    let r = mgr
        .apply_changes(
            "lite",
            &t,
            &[change(
                ChangeKind::Delete,
                json!({"a": 1, "b": "x"}),
                json!({}),
            )],
        )
        .await
        .unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    let rs = mgr
        .table_data("lite", &t, &TableDataRequest::default())
        .await
        .unwrap();
    assert_eq!(rs.rows.len(), 2);
}

/// Defect 2: an update/delete that does not affect exactly one row rolls the batch back.
#[tokio::test]
async fn unexpected_update_count_rolls_back() {
    let (_d, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();
    // SQLite allows several NULLs in a non-INTEGER primary key column: `k is null` matches 2 rows
    assert_ok(&run(&mgr, &s, "create table nullpk (k text primary key, v text); insert into nullpk values (null,'a'),(null,'b'),('x','c')").await);
    let t = ObjectRef::table(Some("main"), "nullpk");
    let r = mgr
        .apply_changes(
            "lite",
            &t,
            &[
                change(
                    ChangeKind::Insert,
                    json!({}),
                    json!({"k": "new", "v": "rolled back"}),
                ),
                change(ChangeKind::Update, json!({"k": null}), json!({"v": "z"})),
            ],
        )
        .await
        .unwrap();
    assert!(!r.committed && r.applied == 0, "{r:?}");
    let e = r.first_error().unwrap();
    assert_eq!(e.index, 1);
    assert!(
        e.error
            .as_deref()
            .unwrap()
            .contains("Unexpected update count: 2"),
        "{e:?}"
    );
    assert_eq!(
        scalar(
            &run(
                &mgr,
                &s,
                "select count(*) from nullpk where k = 'new' or v = 'z'"
            )
            .await
        ),
        json!(0)
    );
    // a locator that matches nothing: nothing is applied either
    let t = ObjectRef::table(Some("main"), "nopk_none");
    assert_ok(&run(&mgr, &s, "create table nopk_none (a int)").await);
    let mut bad = change(ChangeKind::Delete, json!({}), json!({}));
    bad.row_locator = Some(json!(987654));
    let r = mgr
        .apply_changes(
            "lite",
            &t,
            &[change(ChangeKind::Insert, json!({}), json!({"a": 10})), bad],
        )
        .await
        .unwrap();
    assert!(!r.committed && r.applied == 0, "{r:?}");
    assert!(r
        .first_error()
        .unwrap()
        .error
        .as_deref()
        .unwrap()
        .contains("No row matched"));
    assert_eq!(
        scalar(&run(&mgr, &s, "select count(*) from nopk_none").await),
        json!(0)
    );
    mgr.close_session(&s).await;
}

/// Defect 5: the session is idle when `Done` arrives; the next execute never gets `Busy`.
#[tokio::test]
async fn no_busy_right_after_done() {
    let (_d, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();
    let opts = ExecOptions {
        max_rows: 1,
        ..Default::default()
    };
    for i in 0..100 {
        // paged result left open, then a plain statement, then a one-shot statement
        let mut h = mgr
            .execute(&s, "select n from nums", opts.clone())
            .await
            .unwrap_or_else(|e| panic!("run {i}: {e}"));
        wait_done(&mut h).await;
        let mut h = mgr
            .execute(&s, "select 1", opts.clone())
            .await
            .unwrap_or_else(|e| panic!("run {i}b: {e}"));
        wait_done(&mut h).await;
        let mut h = mgr
            .execute(&s, "select 2", opts.clone())
            .await
            .unwrap_or_else(|e| panic!("run {i}c: {e}"));
        wait_done(&mut h).await;
    }
    mgr.close_session(&s).await;
}

/// Defect 6: starting a new execution closes the previous open result.
#[tokio::test]
async fn new_execution_closes_previous_open_result() {
    let (_d, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();
    let mut h1 = mgr
        .execute(
            &s,
            "select n from nums",
            ExecOptions {
                max_rows: 5,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    wait_done(&mut h1).await;
    assert_eq!(mgr.fetch_more(&h1.id, 0, 3).await.unwrap().rows.len(), 3);
    assert_eq!(scalar(&run(&mgr, &s, "select 1").await), json!(1));
    let err = mgr.fetch_more(&h1.id, 0, 3).await.unwrap_err();
    assert!(err.to_string().contains("result set is closed"), "{err}");
    mgr.close_session(&s).await;
}

/// Defect 6: an open result nobody fetches from is closed after `keep_open_secs`.
#[tokio::test]
async fn idle_open_result_is_closed_after_timeout() {
    let (_d, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();
    let mut h = mgr
        .execute(
            &s,
            "select n from nums",
            ExecOptions {
                max_rows: 5,
                keep_open_secs: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    wait_done(&mut h).await;
    // activity inside the window keeps it open
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(mgr.fetch_more(&h.id, 0, 3).await.unwrap().rows.len(), 3);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(mgr.fetch_more(&h.id, 0, 3).await.unwrap().rows.len(), 3);
    // idle for longer than keep_open_secs
    tokio::time::sleep(Duration::from_millis(1800)).await;
    let err = mgr.fetch_more(&h.id, 0, 3).await.unwrap_err();
    assert!(err.to_string().contains("result set is closed"), "{err}");
    // the session is usable again
    assert_eq!(scalar(&run(&mgr, &s, "select 7").await), json!(7));
    // keep_open_secs = 0 disables the timeout
    let mut h = mgr
        .execute(
            &s,
            "select n from nums",
            ExecOptions {
                max_rows: 5,
                keep_open_secs: 0,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    wait_done(&mut h).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(mgr.fetch_more(&h.id, 0, 3).await.unwrap().rows.len(), 3);
    mgr.close_session(&s).await;
}

/// Defect 7: every session and the pool of a `:memory:` data source see one database.
#[tokio::test]
async fn memory_database_is_shared_per_data_source() {
    let mgr = ConnectionManager::new();
    let cfg = DataSourceConfig {
        id: "m".into(),
        driver: Driver::Sqlite,
        file: ":memory:".into(),
        ..Default::default()
    };
    mgr.connect(&cfg).await.unwrap();
    let s = mgr.open_session("m").await.unwrap();
    assert_ok(&run(&mgr, &s, "create table t(a int); insert into t values (1)").await);
    let rs = mgr
        .table_data(
            "m",
            &ObjectRef::table(Some("main"), "t"),
            &TableDataRequest::default(),
        )
        .await
        .unwrap();
    assert_eq!(rs.rows, vec![vec![json!(1)]]);
    let s2 = mgr.open_session("m").await.unwrap();
    assert_eq!(
        scalar(&run(&mgr, &s2, "select count(*) from t").await),
        json!(1)
    );
    // closing every session keeps the database alive
    mgr.close_session(&s).await;
    mgr.close_session(&s2).await;
    let s3 = mgr.open_session("m").await.unwrap();
    assert_eq!(
        scalar(&run(&mgr, &s3, "select count(*) from t").await),
        json!(1)
    );
    // editing through the pool is visible to the console
    let r = mgr
        .apply_changes(
            "m",
            &ObjectRef::table(Some("main"), "t"),
            &[change(ChangeKind::Insert, json!({}), json!({"a": 2}))],
        )
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    assert_eq!(
        scalar(&run(&mgr, &s3, "select count(*) from t").await),
        json!(2)
    );

    // another data source has its own database, even in another manager with the same id
    let other = ConnectionManager::new();
    other.connect(&cfg).await.unwrap();
    let o = other.open_session("m").await.unwrap();
    assert_eq!(
        scalar(&run(&other, &o, "select count(*) from sqlite_master").await),
        json!(0)
    );
    // disconnect + connect gives a fresh database
    mgr.disconnect("m").await;
    mgr.connect(&cfg).await.unwrap();
    let s4 = mgr.open_session("m").await.unwrap();
    assert_eq!(
        scalar(&run(&mgr, &s4, "select count(*) from sqlite_master").await),
        json!(0)
    );
}

/// The transaction state is read from the connection (`sqlite3_get_autocommit`), events report changes and ends.
#[tokio::test]
async fn transaction_status_events_and_init_sql() {
    let (_d, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
    let ev = run(&mgr, &s, "begin").await;
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Active]);
    // the savepoint-free "release" of an outer transaction: SQLite also ends it with END
    let ev = run(&mgr, &s, "end").await;
    assert_eq!(tx_ended(&ev), vec![(true, "COMMIT".to_string())]);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    assert_ok(&run(&mgr, &s, "begin").await);
    let ev = run(&mgr, &s, "rollback").await;
    assert_eq!(tx_ended(&ev), vec![(false, "ROLLBACK".to_string())]);
    // a savepoint outside BEGIN opens a transaction (autocommit off) that only RELEASE closes
    let ev = run(&mgr, &s, "savepoint a").await;
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Active]);
    assert!(mgr.session_in_transaction(&s).unwrap());
    let ev = run(&mgr, &s, "release a").await;
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    mgr.close_session(&s).await;

    // init_sql
    let s = mgr
        .open_session_with("lite", &["pragma foreign_keys = off".to_string()])
        .await
        .unwrap();
    assert_eq!(
        scalar(&run(&mgr, &s, "pragma foreign_keys").await),
        json!(0)
    );
    mgr.close_session(&s).await;
    assert!(mgr
        .open_session_with("lite", &["select * from nope_nope".to_string()])
        .await
        .is_err());
}

#[tokio::test]
async fn explain_query_plan() {
    let (_dir, _cfg, mgr) = setup().await;
    let s = mgr.open_session("lite").await.unwrap();
    let plan = mgr
        .explain(
            &s,
            "select * from products where category_id = 1 order by name;",
            false,
        )
        .await
        .unwrap();
    assert_eq!(plan.root.operation, "Select");
    let first = &plan.root.children[0];
    assert_eq!(first.operation, "Index Search (SEARCH)");
    assert!(first.params.contains("table: products;"), "{first:?}");
    assert!(plan
        .root
        .children
        .iter()
        .any(|n| n.operation.contains("ORDER BY")));
    // no ANALYZE in SQLite
    assert!(mgr.explain(&s, "select 1", true).await.is_err());
    assert!(mgr.explain(&s, "  ;", false).await.is_err());
    mgr.close_session(&s).await;
}

/// Driver properties of the Advanced tab: journal mode, synchronous, foreign keys and busy timeout are applied.
#[tokio::test]
async fn advanced_properties_are_honoured() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = lite_cfg(&dir.path().join("adv.db"));
    cfg.options.insert("journal_mode".into(), "wal".into());
    cfg.options.insert("synchronous".into(), "full".into());
    cfg.options.insert("foreign_keys".into(), "false".into());
    cfg.options.insert("busy_timeout".into(), "1234".into());
    let mgr = ConnectionManager::new();
    mgr.connect(&cfg).await.unwrap();
    let s = mgr.open_session("lite").await.unwrap();
    for (sql, want) in [
        ("pragma journal_mode", json!("wal")),
        ("pragma synchronous", json!(2)),
        ("pragma foreign_keys", json!(0)),
        ("pragma busy_timeout", json!(1234)),
    ] {
        assert_eq!(scalar(&run(&mgr, &s, sql).await), want, "{sql}");
    }
    mgr.close_session(&s).await;

    cfg.options.insert("foreign_keys".into(), "maybe".into());
    assert!(mgr
        .test_connection(&cfg)
        .await
        .message
        .contains("foreign_keys: expected true or false"));
}
