//! PostgreSQL integration tests. Run with:
//!   PROMETEO_PG_URL=postgres://postgres:prometeo@localhost:54329/postgres cargo test -p dbcore --test pg -- --nocapture

mod common;

use common::*;
use dbcore::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

macro_rules! setup {
    () => {{
        let Some(cfg) = pg_cfg() else {
            eprintln!("PROMETEO_PG_URL not set: skipping");
            return;
        };
        seed_pg(&cfg).await;
        let mgr = connected(&cfg).await;
        (cfg, mgr)
    }};
}

fn url_parts(url: &str) -> (String, u16, String, String, String) {
    // postgres://user:pass@host:port/db
    let rest = url.split("://").nth(1).unwrap();
    let (auth, tail) = rest.split_once('@').unwrap();
    let (user, pass) = auth.split_once(':').unwrap();
    let (hostport, db) = tail.split_once('/').unwrap();
    let (host, port) = hostport.split_once(':').unwrap();
    (host.into(), port.parse().unwrap(), user.into(), pass.into(), db.into())
}

#[tokio::test]
async fn test_connection_ok_and_failures() {
    let Some(cfg) = pg_cfg() else { return };
    let mgr = ConnectionManager::new();
    let r = mgr.test_connection(&cfg).await;
    assert!(r.ok, "{r:?}");
    assert!(r.server_version.as_deref().unwrap().starts_with("PostgreSQL 16"), "{r:?}");
    println!("test_connection: {} in {} ms", r.message, r.elapsed_ms);

    // same server from discrete fields
    let (host, port, user, pass, db) = url_parts(cfg.url_override.as_deref().unwrap());
    let mut c2 = DataSourceConfig {
        id: "pg2".into(),
        driver: Driver::Postgres,
        host,
        port,
        user,
        password: Some(pass.clone()),
        database: db,
        ..Default::default()
    };
    assert!(mgr.test_connection(&c2).await.ok);

    c2.password = Some("definitely-wrong".into());
    let r = mgr.test_connection(&c2).await;
    assert!(!r.ok);
    assert!(r.message.contains("password authentication failed"), "{}", r.message);
    println!("bad password message: {}", r.message);

    c2.password = Some(pass);
    c2.port = 1; // nothing listens there
    let r = mgr.test_connection(&c2).await;
    assert!(!r.ok);
    assert!(!r.message.is_empty());
}

#[tokio::test]
async fn introspection_tree() {
    let (_cfg, mgr) = setup!();
    let dbs = children(&mgr, "pg", &[]).await;
    let cur = dbs.iter().find(|d| d.extra["current"] == json!(true)).expect("current db");
    assert_eq!(cur.kind, NodeKind::Database);
    assert!(cur.has_children);
    let db = cur.name.as_str();

    let schemas = children(&mgr, "pg", &[db]).await;
    let sn = names(&schemas);
    assert!(sn.contains(&"shop".to_string()) && sn.contains(&"public".to_string()), "{sn:?}");
    assert!(!sn.contains(&"pg_catalog".to_string()) && !sn.iter().any(|s| s.starts_with("pg_toast")));
    let with_sys = mgr.introspect_with("pg", &[db.to_string()], &IntrospectOptions { show_system: true }).await.unwrap();
    assert!(names(&with_sys).contains(&"pg_catalog".to_string()));
    assert!(names(&with_sys).contains(&"information_schema".to_string()));

    let folders = children(&mgr, "pg", &[db, "shop"]).await;
    let f: Vec<_> = folders.iter().map(|f| (f.name.as_str(), f.hint.clone().unwrap())).collect();
    assert_eq!(
        f,
        vec![
            ("tables", "7".to_string()),
            ("views", "1".to_string()),
            ("materialized views", "1".to_string()),
            ("routines", "3".to_string()),
            ("sequences", "6".to_string())
        ]
    );
    assert!(folders.iter().all(|f| f.kind == NodeKind::Folder && f.has_children));
    // node ids are unique and paths are usable as-is
    assert_eq!(folders[0].path, vec![db, "shop", "tables"]);

    let tables = children(&mgr, "pg", &[db, "shop", "tables"]).await;
    assert_eq!(names(&tables), ["all_types", "big_table", "categories", "customers", "order_items", "orders", "products"]);
    let products = tables.iter().find(|t| t.name == "products").unwrap();
    assert_eq!(products.kind, NodeKind::Table);
    assert_eq!(products.extra["schema"], "shop");
    let oref = ObjectRef::from_node(products);
    assert_eq!((oref.schema.as_deref(), oref.name.as_str(), oref.kind), (Some("shop"), "products", NodeKind::Table));

    assert_eq!(names(&children(&mgr, "pg", &[db, "shop", "views"]).await), ["v_order_totals"]);
    assert_eq!(names(&children(&mgr, "pg", &[db, "shop", "materialized_views"]).await), ["mv_sales_by_category"]);
    let seqs = names(&children(&mgr, "pg", &[db, "shop", "sequences"]).await);
    assert!(seqs.contains(&"invoice_seq".to_string()), "{seqs:?}");
    let routines = children(&mgr, "pg", &[db, "shop", "routines"]).await;
    assert_eq!(names(&routines), ["order_total", "restock", "touch_updated_at"]);
    assert_eq!(routines[0].kind, NodeKind::Function);
    assert_eq!(routines[1].kind, NodeKind::Procedure);
    assert_eq!(routines[0].hint.as_deref(), Some("(p_order_id integer): numeric"));
    assert_eq!(routines[0].extra["signature"], "p_order_id integer");

    // table children
    let sub = children(&mgr, "pg", &[db, "shop", "tables", "products"]).await;
    let sub: Vec<_> = sub.iter().map(|f| (f.name.as_str(), f.hint.clone().unwrap())).collect();
    assert_eq!(
        sub,
        vec![
            ("columns", "9".to_string()),
            ("keys", "2".to_string()),
            ("foreign keys", "1".to_string()),
            ("indexes", "5".to_string()),
            ("checks", "1".to_string()),
            ("triggers", "1".to_string())
        ]
    );
    let base = [db, "shop", "tables", "products"];
    let p = |s: &'static str| {
        let mut v = base.to_vec();
        v.push(s);
        v
    };
    let cols = children(&mgr, "pg", &p("columns")).await;
    assert_eq!(names(&cols), ["id", "sku", "name", "category_id", "price", "stock", "tags", "created_at", "updated_at"]);
    let hints: Vec<_> = cols.iter().map(|c| c.hint.clone().unwrap()).collect();
    assert_eq!(
        hints,
        ["integer", "varchar(32)", "varchar(255)", "integer", "numeric(10,2)", "integer", "text[]", "timestamp with time zone", "timestamp with time zone"]
    );
    assert_eq!(cols[0].extra["isPk"], json!(true));
    assert_eq!(cols[0].extra["identity"], "d");
    assert_eq!(cols[1].extra["nullable"], json!(false));
    assert_eq!(cols[8].extra["nullable"], json!(true));
    assert!(cols[5].extra["default"].as_str().unwrap().contains('0'));
    assert!(cols.iter().all(|c| c.kind == NodeKind::Column && !c.has_children));

    let keys = children(&mgr, "pg", &p("keys")).await;
    assert_eq!(names(&keys), ["products_pkey", "products_sku_key"]);
    assert_eq!((keys[0].kind, keys[1].kind), (NodeKind::PrimaryKey, NodeKind::UniqueKey));
    assert_eq!(keys[0].hint.as_deref(), Some("(id)"));
    let idx = children(&mgr, "pg", &p("indexes")).await;
    assert_eq!(
        names(&idx),
        ["idx_products_category", "idx_products_low_stock", "idx_products_name_lower", "products_pkey", "products_sku_key"]
    );
    assert_eq!(idx[2].hint.as_deref(), Some("(lower(name::text))"));
    assert_eq!(idx[3].extra["primary"], json!(true));
    let checks = children(&mgr, "pg", &p("checks")).await;
    assert_eq!(names(&checks), ["products_price_positive"]);
    assert!(checks[0].hint.as_deref().unwrap().contains("price > (0)::numeric") || checks[0].hint.as_deref().unwrap().contains("price > 0"));
    let trg = children(&mgr, "pg", &p("triggers")).await;
    assert_eq!((trg[0].name.as_str(), trg[0].hint.as_deref()), ("trg_products_touch", Some("BEFORE UPDATE")));

    let fks = children(&mgr, "pg", &[db, "shop", "tables", "order_items", "foreign_keys"]).await;
    assert_eq!(names(&fks), ["order_items_order_id_fkey", "order_items_product_id_fkey"]);
    assert!(fks[0].hint.as_deref().unwrap().contains("(order_id) -> ") && fks[0].hint.as_deref().unwrap().ends_with("orders(id)"), "{:?}", fks[0].hint);
    assert_eq!(fks[1].extra["refTable"], "products");

    // views: columns only; matviews: columns + indexes
    let v = children(&mgr, "pg", &[db, "shop", "views", "v_order_totals"]).await;
    assert_eq!(names(&v), ["columns"]);
    let mv = children(&mgr, "pg", &[db, "shop", "materialized_views", "mv_sales_by_category"]).await;
    assert_eq!(names(&mv), ["columns", "indexes"]);

    // errors
    assert!(mgr.introspect("pg", &["nope".into()]).await.is_err());
    assert!(mgr.introspect("pg", &[db.into(), "shop".into(), "bogus".into()]).await.is_err());
    assert!(mgr.introspect("not-connected", &[]).await.is_err());
}

#[tokio::test]
async fn ddl_generation() {
    let (_cfg, mgr) = setup!();
    let t = |name: &str, kind: NodeKind| ObjectRef { schema: Some("shop".into()), name: name.into(), kind, table: None, signature: None };

    let ddl = mgr.ddl("pg", &t("products", NodeKind::Table)).await.unwrap();
    println!("{ddl}");
    // DataGrip's style (73-ddl-view): lower-case keywords, header comment, aligned names, constraints under their column
    assert!(ddl.starts_with("-- auto-generated definition\ncreate table shop.products\n(\n"), "{ddl}");
    assert!(!ddl.contains("CREATE ") && !ddl.contains("NOT NULL"), "{ddl}");
    assert!(ddl.contains("    id          integer generated by default as identity not null\n        primary key,\n"));
    assert!(ddl.contains("    sku         character varying(32) not null\n        unique,\n"));
    assert!(ddl.contains("    tags        text[] default '{}'::text[] not null,"));
    assert!(ddl.contains("    price       numeric(10, 2) not null\n        constraint products_price_positive\n            check ((price > (0)::numeric)),"));
    assert!(ddl.contains("    category_id integer not null\n        references shop.categories,"));
    assert!(ddl.contains("alter table shop.products\n    owner to postgres;"));
    assert!(ddl.contains("create index idx_products_category\n    on shop.products (category_id);"));
    assert!(ddl.contains("on shop.products (stock) where (stock < 5);"));
    assert!(ddl.contains("create trigger trg_products_touch\n    before update\n    on shop.products\n    for each row\nexecute function shop.touch_updated_at();"));
    assert!(!ddl.contains("products_pkey ON"), "constraint-backed indexes must not be repeated");

    let cat = mgr.ddl("pg", &t("categories", NodeKind::Table)).await.unwrap();
    assert!(cat.contains("comment on table shop.categories is 'Product categories';"));

    // the generated DDL must be executable: recreate it in a scratch schema
    let s = mgr.open_session("pg").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop schema if exists scratch_ddl cascade; create schema scratch_ddl").await);
    let copy = cat.replace("shop.categories", "scratch_ddl.categories");
    let ev = run(&mgr, &s, &copy).await;
    assert_ok(&ev);
    let again = mgr.ddl("pg", &ObjectRef { schema: Some("scratch_ddl".into()), ..t("categories", NodeKind::Table) }).await.unwrap();
    assert_eq!(again, copy, "DDL round trip");
    assert_ok(&run(&mgr, &s, "drop schema scratch_ddl cascade").await);
    mgr.close_session(&s).await;

    let view = mgr.ddl("pg", &t("v_order_totals", NodeKind::View)).await.unwrap();
    assert!(view.starts_with("-- auto-generated definition\ncreate or replace view shop.v_order_totals as\n"), "{view}");
    assert!(view.contains("shop.order_total(o.id)"));
    let mv = mgr.ddl("pg", &t("mv_sales_by_category", NodeKind::MaterializedView)).await.unwrap();
    assert!(mv.contains("create materialized view shop.mv_sales_by_category as"), "{mv}");
    assert!(mv.contains("with data;") && mv.contains("create unique index mv_sales_by_category_pk"), "{mv}");
    let f = mgr
        .ddl("pg", &ObjectRef { signature: Some("p_order_id integer".into()), ..t("order_total", NodeKind::Function) })
        .await
        .unwrap();
    assert!(f.starts_with("CREATE OR REPLACE FUNCTION shop.order_total(p_order_id integer)") && f.trim_end().ends_with(';'), "{f}");
    let pr = mgr.ddl("pg", &t("restock", NodeKind::Procedure)).await.unwrap();
    assert!(pr.contains("CREATE OR REPLACE PROCEDURE shop.restock"));
    let seq = mgr.ddl("pg", &t("invoice_seq", NodeKind::Sequence)).await.unwrap();
    assert_eq!(
        seq,
        "-- auto-generated definition\ncreate sequence shop.invoice_seq\n    as bigint\n    start with 1000\n    increment by 5\n    minvalue 1\n    maxvalue 9223372036854775807\n    cache 1;\n\nalter sequence shop.invoice_seq owner to postgres;"
    );
    let idx = mgr.ddl("pg", &t("idx_orders_customer", NodeKind::Index)).await.unwrap();
    assert_eq!(idx, "create index idx_orders_customer\n    on shop.orders (customer_id);");
    let tr = mgr.ddl("pg", &ObjectRef { table: Some("products".into()), ..t("trg_products_touch", NodeKind::Trigger) }).await.unwrap();
    assert!(tr.starts_with("create trigger trg_products_touch\n    before update\n"), "{tr}");
    let fk = mgr.ddl("pg", &ObjectRef { table: Some("orders".into()), ..t("orders_customer_id_fkey", NodeKind::ForeignKey) }).await.unwrap();
    assert_eq!(fk, "alter table shop.orders\n    add constraint orders_customer_id_fkey foreign key (customer_id) references shop.customers(id) on delete cascade;");
    let col = mgr.ddl("pg", &ObjectRef { table: Some("products".into()), ..t("price", NodeKind::Column) }).await.unwrap();
    assert_eq!(col, "alter table shop.products\n    add price numeric(10, 2) not null;");
    assert!(mgr.ddl("pg", &t("nope", NodeKind::Table)).await.is_err());
}

#[tokio::test]
async fn execute_select_and_types() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();

    let ev = run(&mgr, &s, "select 1::int4 as a, 'x'::text as b, 1.5::numeric as d, true as e, null::int as f").await;
    assert_ok(&ev);
    assert!(matches!(ev.first(), Some(ExecEvent::Statement { index: 0, .. })));
    assert!(matches!(ev.last(), Some(ExecEvent::Done { .. })));
    let (cols, rows, more) = first_rs(&ev);
    assert_eq!(cols.iter().map(|c| c.type_name.as_str()).collect::<Vec<_>>(), ["int4", "text", "numeric", "bool", "int4"]);
    assert_eq!(rows, vec![vec![json!(1), json!("x"), json!("1.5"), json!(true), Value::Null]]);
    assert!(!more);

    let ev = run(&mgr, &s, "select * from shop.all_types order by id").await;
    assert_ok(&ev);
    let (cols, rows, _) = first_rs(&ev);
    let row: BTreeMap<String, Value> = cols.iter().zip(&rows[0]).map(|(c, v)| (c.name.clone(), v.clone())).collect();
    let tn: BTreeMap<String, String> = cols.iter().map(|c| (c.name.clone(), c.type_name.clone())).collect();
    let expect = json!({
        "id": 1, "c_smallint": 32767, "c_int": 2147483647, "c_bigint": "9223372036854775807",
        "c_numeric": "12345678901234567890.1234567890", "c_real": 1.5, "c_double": 1.2345678901234567, "c_bool": true,
        "c_text": "multi\nline \"text\" with 'quotes' and unicode: éñ 😀", "c_varchar": "varchar", "c_char": "ab   ",
        "c_bytea": {"$bin": "deadbeef", "len": 4}, "c_uuid": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        "c_json": "{\"a\": [1, 2, {\"b\": null}]}", "c_jsonb": "{\"k\": \"v\", \"n\": 1.50}",
        "c_date": "2024-02-29", "c_time": "13:45:10.123456", "c_timetz": "13:45:10+02",
        "c_timestamp": "2024-02-29 13:45:10.5", "c_timestamptz": "2024-02-29 13:45:10+00",
        "c_interval": "1 year 2 mons 3 days 04:05:06", "c_inet": "192.168.1.10", "c_cidr": "10.0.0.0/8",
        "c_macaddr": "08:00:2b:01:02:03", "c_int_arr": [1, 2, null, 4], "c_text_arr": ["a b", "c,d", "e\"f", null],
        "c_enum": "paid", "c_enum_arr": ["new", "shipped"], "c_money": "$1,234.50", "c_bit": "10101010", "c_varbit": "101",
        "c_xml": "<root a=\"1\"/>", "c_point": "(1.5,2.5)", "c_tsvector": "'cat' 'fat'", "c_int4range": "[1,10)"
    });
    for (k, v) in expect.as_object().unwrap() {
        assert_eq!(&row[k], v, "column {k}");
    }
    assert_eq!(tn["c_enum"], "order_status");
    assert_eq!(tn["c_enum_arr"], "order_status[]");
    assert_eq!(tn["c_int_arr"], "int4[]");
    assert_eq!(tn["c_bigint"], "int8");
    // the all-NULL row
    assert!(rows[1][1..].iter().all(Value::is_null));

    // binary preview is truncated for big values but reports the real length
    let ev = run(&mgr, &s, "select decode(repeat('ab', 1000), 'hex') as b").await;
    let cell = &first_rs(&ev).1[0][0];
    assert_eq!(cell["len"], 1000);
    assert_eq!(cell["truncated"], true);
    assert_eq!(cell["$bin"].as_str().unwrap().len(), 512);

    // empty result keeps column metadata; DML reports rows affected
    let ev = run(&mgr, &s, "select id, name from shop.products where false").await;
    let (cols, rows, _) = first_rs(&ev);
    assert_eq!(cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "name"]);
    assert!(rows.is_empty());
    let ev = run(&mgr, &s, "update shop.products set stock = stock where id < 0").await;
    assert!(ev.iter().any(|e| matches!(e, ExecEvent::Update { index: 0, rows_affected: 0 })), "{ev:?}");

    // ad-hoc results report the table of a plain column reference (schema.table); expressions have none
    let refs = |ev: &[ExecEvent]| first_rs(ev).0.iter().map(|c| c.table_ref.clone()).collect::<Vec<_>>();
    let ev = run(&mgr, &s, "select id, name, price * 2 as double_price from shop.products limit 1").await;
    assert_eq!(refs(&ev), [Some("shop.products".to_string()), Some("shop.products".to_string()), None]);
    let ev = run(&mgr, &s, "select p.id, c.id from shop.products p join shop.categories c on c.id = p.category_id limit 1").await;
    assert_eq!(refs(&ev), [Some("shop.products".to_string()), Some("shop.categories".to_string())]);
    let ev = run(&mgr, &s, "select count(*), 1 from shop.products").await;
    assert_eq!(refs(&ev), [None, None]);
    // also when there are no rows (the columns come from `describe`)
    let ev = run(&mgr, &s, "select id, name from shop.products where false").await;
    assert_eq!(refs(&ev), [Some("shop.products".to_string()), Some("shop.products".to_string())]);
    // a second run is answered from the per-source cache
    let ev = run(&mgr, &s, "select * from shop.categories limit 1").await;
    assert!(refs(&ev).iter().all(|r| r.as_deref() == Some("shop.categories")));
    let ev = run(&mgr, &s, "show server_version; explain select 1; values (1), (2)").await;
    assert_ok(&ev);
    assert_eq!(ev.iter().filter(|e| matches!(e, ExecEvent::ResultSet { .. })).count(), 3);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn execute_scripts_errors_and_session_state() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();

    // multi statement script with ranges
    let script = "create temp table t_exec (a int);\ninsert into t_exec values (1), (2);\nselect * from t_exec order by a;\nupdate t_exec set a = a + 1;\ndrop table t_exec";
    let ev = run(&mgr, &s, script).await;
    assert_ok(&ev);
    let kinds: Vec<String> = ev
        .iter()
        .map(|e| match e {
            ExecEvent::Statement { index, range, .. } => format!("stmt{index}@{}", range.start),
            ExecEvent::Update { rows_affected, .. } => format!("upd{rows_affected}"),
            ExecEvent::ResultSet { rows, .. } => format!("rs{}", rows.len()),
            ExecEvent::Done { .. } => "done".into(),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(
        kinds,
        ["stmt0@0", "upd0", "stmt1@34", "upd2", "stmt2@70", "rs2", "stmt3@103", "upd2", "stmt4@132", "upd0", "done"]
    );

    // server error: real message, SQLSTATE, position
    let ev = run(&mgr, &s, "select * from nonexistent_table_xyz").await;
    let err = ev.iter().find_map(|e| if let ExecEvent::Error { message, position, index, .. } = e { Some((message.clone(), *position, *index)) } else { None }).unwrap();
    assert_eq!(err.0, "[42P01] ERROR: relation \"nonexistent_table_xyz\" does not exist\n  Position: 15");
    assert_eq!(err.1, Some(15));
    assert_eq!(err.2, 0);
    assert!(matches!(ev.last(), Some(ExecEvent::Done { .. })));

    let ev = run(&mgr, &s, "do $$ begin raise exception 'boom %', 42; end $$").await;
    assert_eq!(errors(&ev), vec!["[P0001] ERROR: boom 42".to_string()]);
    let ev = run(&mgr, &s, "insert into shop.categories (name) values ('Books')").await;
    let e = &errors(&ev)[0];
    assert!(e.starts_with("[23505] ERROR: duplicate key value violates unique constraint \"categories_name_key\"\n  Detail: Key (name)=(Books) already exists."), "{e}");

    // stop_on_error true / false
    let ev = run(&mgr, &s, "select 1; select * from nope; select 3").await;
    assert_eq!(ev.iter().filter(|e| matches!(e, ExecEvent::ResultSet { .. })).count(), 1);
    let ev = mgr.execute_collect(&s, "select 1; select * from nope; select 3", ExecOptions { max_rows: 10, stop_on_error: false, ..Default::default() }).await.unwrap();
    assert_eq!(ev.iter().filter(|e| matches!(e, ExecEvent::ResultSet { .. })).count(), 2);
    assert_eq!(errors(&ev).len(), 1);

    // session state survives between executions: search_path ...
    assert_ok(&run(&mgr, &s, "set search_path to shop, public").await);
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from categories").await), json!(5));
    // ... and open transactions
    let s2 = mgr.open_session("pg").await.unwrap();
    assert_ok(&run(&mgr, &s, "begin").await);
    assert!(mgr.session_in_transaction(&s).unwrap());
    assert_ok(&run(&mgr, &s, "insert into categories (name) values ('tx-test')").await);
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from categories where name = 'tx-test'").await), json!(1));
    assert_eq!(scalar(&run(&mgr, &s2, "select count(*) from shop.categories where name = 'tx-test'").await), json!(0));
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert!(!mgr.session_in_transaction(&s).unwrap());
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from categories where name = 'tx-test'").await), json!(0));
    // a failed statement inside a transaction leaves it aborted, like psql
    assert_ok(&run(&mgr, &s, "begin").await);
    assert!(!errors(&run(&mgr, &s, "select 1/0").await).is_empty());
    let e = errors(&run(&mgr, &s, "select 1").await);
    assert!(e[0].contains("25P02"), "{e:?}");
    assert_ok(&run(&mgr, &s, "rollback").await);

    mgr.close_session(&s).await;
    mgr.close_session(&s2).await;
    assert!(mgr.execute(&s, "select 1", ExecOptions::default()).await.is_err());
}

#[tokio::test]
async fn paging_with_fetch_more() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    let t0 = Instant::now();
    let mut h = mgr.execute(&s, "select * from shop.big_table order by id", ExecOptions { max_rows: 500, stop_on_error: true, ..Default::default() }).await.unwrap();
    let mut events = Vec::new();
    while let Some(e) = h.events.recv().await {
        let done = matches!(e, ExecEvent::Done { .. });
        events.push(e);
        if done {
            break;
        }
    }
    let first_page = t0.elapsed();
    let (cols, rows, more) = first_rs(&events);
    assert_eq!(rows.len(), 500);
    assert!(more);
    assert_eq!(cols[0].name, "id");
    assert_eq!(rows[499][0], json!(500));
    println!("first 500 rows of 100k via execute: {first_page:?}");

    // the stream is still open: pull the rest in pages
    let mut next = 501;
    let mut total = 500;
    let mut pages = 0;
    loop {
        let page = mgr.fetch_more(&h.id, 0, 20_000).await.unwrap();
        assert_eq!(page.rows[0][0], json!(next));
        next += page.rows.len() as i64;
        total += page.rows.len();
        pages += 1;
        if !page.has_more {
            break;
        }
        assert_eq!(page.rows.len(), 20_000);
    }
    assert_eq!(total, 100_000);
    assert_eq!(pages, 5);
    println!("fetched all 100k rows in {pages} pages: {:?}", t0.elapsed());
    // result is exhausted -> the execution is gone
    assert!(mgr.fetch_more(&h.id, 0, 10).await.is_err());

    // wrong result index
    let h2 = mgr.execute(&s, "select * from shop.big_table", ExecOptions { max_rows: 10, stop_on_error: true, ..Default::default() }).await.unwrap();
    let mut ev = h2.events;
    while let Some(e) = ev.recv().await {
        if matches!(e, ExecEvent::Done { .. }) {
            break;
        }
    }
    assert!(mgr.fetch_more(&h2.id, 7, 10).await.is_err());
    let page = mgr.fetch_more(&h2.id, 0, 5).await.unwrap();
    assert_eq!(page.rows.len(), 5);
    assert!(page.has_more);

    // executing something new on the session releases the half-read result quickly
    let t = Instant::now();
    let ev = run(&mgr, &s, "select 42").await;
    assert_eq!(scalar(&ev), json!(42));
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    assert!(mgr.fetch_more(&h2.id, 0, 5).await.is_err());

    // earlier statements of a script are truncated (only the last one is pageable)
    let ev = run_n(&mgr, &s, "select * from shop.big_table; select 7", 10).await;
    assert_ok(&ev);
    let rs: Vec<_> = ev.iter().filter_map(|e| if let ExecEvent::ResultSet { rows, has_more, .. } = e { Some((rows.len(), *has_more)) } else { None }).collect();
    assert_eq!(rs, vec![(10, false), (1, false)]);
    assert!(ev.iter().any(|e| matches!(e, ExecEvent::Message { .. })));
    // connection still healthy after the aborted stream
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from shop.big_table").await), json!(100000));

    // explicit close
    let h3 = mgr.execute(&s, "select * from shop.big_table", ExecOptions { max_rows: 10, stop_on_error: true, ..Default::default() }).await.unwrap();
    let mut ev = h3.events;
    while let Some(e) = ev.recv().await {
        if matches!(e, ExecEvent::Done { .. }) {
            break;
        }
    }
    mgr.close_execution(&h3.id).unwrap();
    assert_eq!(scalar(&run(&mgr, &s, "select 1").await), json!(1));
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn cancellation() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    let t = Instant::now();
    let mut h = mgr.execute(&s, "select pg_sleep(30)", ExecOptions::default()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    mgr.cancel(&h.id).unwrap();
    let mut got_err = None;
    let mut done = false;
    while let Some(e) = h.events.recv().await {
        match e {
            ExecEvent::Error { message, .. } => got_err = Some(message),
            ExecEvent::Done { .. } => {
                done = true;
                break;
            }
            _ => {}
        }
    }
    assert!(done);
    let msg = got_err.expect("error event");
    assert!(msg.starts_with("[57014] ERROR: canceling statement due to user request"), "{msg}");
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    println!("cancel pg_sleep(30): returned after {:?}", t.elapsed());

    // session is usable afterwards
    assert_eq!(scalar(&run(&mgr, &s, "select 5").await), json!(5));

    // cancel a CPU-bound query that never produces rows
    let mut h = mgr.execute(&s, "select count(*) from generate_series(1, 5000000000)", ExecOptions::default()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    mgr.cancel(&h.id).unwrap();
    let mut got = false;
    while let Some(e) = h.events.recv().await {
        if let ExecEvent::Error { message, .. } = &e {
            got = message.contains("57014");
        }
        if matches!(e, ExecEvent::Done { .. }) {
            break;
        }
    }
    assert!(got);

    // cancelling a half-read result
    let h = mgr.execute(&s, "select * from shop.big_table", ExecOptions { max_rows: 10, stop_on_error: true, ..Default::default() }).await.unwrap();
    let mut ev = h.events;
    while let Some(e) = ev.recv().await {
        if matches!(e, ExecEvent::Done { .. }) {
            break;
        }
    }
    mgr.cancel(&h.id).unwrap();
    assert_eq!(scalar(&run(&mgr, &s, "select 6").await), json!(6));

    // a second execute on a busy session is rejected
    let h = mgr.execute(&s, "select pg_sleep(5)", ExecOptions::default()).await.unwrap();
    assert!(matches!(mgr.execute(&s, "select 1", ExecOptions::default()).await, Err(DbError::Busy(_))));
    mgr.cancel(&h.id).unwrap();
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn table_data_and_snapshot() {
    let (_cfg, mgr) = setup!();
    let products = ObjectRef::table(Some("shop"), "products");
    let rs = mgr
        .table_data("pg", &products, &TableDataRequest { order_by: Some("id".into()), offset: 5, limit: 5, count_total: true, ..Default::default() })
        .await
        .unwrap();
    assert_eq!(rs.rows.len(), 5);
    assert_eq!(rs.rows[0][0], json!(6));
    assert!(rs.has_more);
    assert_eq!(rs.total_hint, Some(20));
    let id = &rs.columns[0];
    assert_eq!((id.name.as_str(), id.is_pk, id.nullable, id.table_ref.as_deref()), ("id", true, false, Some("shop.products")));
    assert_eq!(rs.columns[1].type_name, "varchar");
    assert!(!rs.columns[1].is_pk);

    let rs = mgr
        .table_data(
            "pg",
            &products,
            &TableDataRequest { where_clause: Some("price > 50 and category_id = 2".into()), order_by: Some("price desc".into()), limit: 100, count_total: true, ..Default::default() },
        )
        .await
        .unwrap();
    assert_eq!(rs.total_hint, Some(rs.rows.len() as i64));
    assert!(!rs.has_more);
    assert!(!rs.rows.is_empty());

    let rs = mgr.table_data("pg", &products, &TableDataRequest { where_clause: Some("1 = 0".into()), limit: 10, ..Default::default() }).await.unwrap();
    assert!(rs.rows.is_empty() && rs.columns.len() == 9);

    // bad where -> server error with position
    let err = mgr.table_data("pg", &products, &TableDataRequest { where_clause: Some("nosuchcol = 1".into()), limit: 10, ..Default::default() }).await.unwrap_err();
    assert!(err.to_string().contains("42703"), "{err}");

    // composite pk table, views
    let rs = mgr.table_data("pg", &ObjectRef::table(Some("shop"), "order_items"), &TableDataRequest { limit: 3, ..Default::default() }).await.unwrap();
    assert_eq!(rs.columns.iter().filter(|c| c.is_pk).map(|c| c.name.as_str()).collect::<Vec<_>>(), ["order_id", "line_no"]);
    let rs = mgr.table_data("pg", &ObjectRef::table(Some("shop"), "v_order_totals"), &TableDataRequest { limit: 3, ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows.len(), 3);
    assert!(mgr.table_data("pg", &ObjectRef::table(Some("shop"), "nope"), &TableDataRequest::default()).await.is_err());

    let snap = mgr.schema_snapshot("pg", Some("shop")).await.unwrap();
    let p = snap.iter().find(|o| o.name == "products").unwrap();
    assert_eq!(p.kind, NodeKind::Table);
    assert_eq!(p.columns.len(), 9);
    assert!(p.columns[0].is_pk && p.columns[0].name == "id");
    assert_eq!(p.columns[1].type_name, "varchar(32)");
    assert_eq!(snap.iter().find(|o| o.name == "v_order_totals").unwrap().kind, NodeKind::View);
    assert_eq!(snap.iter().find(|o| o.name == "mv_sales_by_category").unwrap().kind, NodeKind::MaterializedView);
    let all = mgr.schema_snapshot("pg", None).await.unwrap();
    assert!(all.iter().all(|o| o.schema != "pg_catalog"));
}

fn change(kind: ChangeKind, key: Value, values: Value) -> RowChange {
    let m = |v: Value| v.as_object().cloned().unwrap_or_default().into_iter().collect::<BTreeMap<_, _>>();
    RowChange { kind, key: m(key), values: m(values), row_locator: None }
}

#[tokio::test]
async fn apply_changes_roundtrip() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop schema if exists scratch_edit cascade; create schema scratch_edit;\
        create table scratch_edit.scratch_edit (id serial primary key, name text, qty int, tags text[], data jsonb, bin bytea, ts timestamptz, flag boolean default true, price numeric(10,2));\
        create table scratch_edit.scratch_nopk (a int, b text)").await);
    let t = ObjectRef::table(Some("scratch_edit"), "scratch_edit");
    let evil = "x'); drop table scratch_edit.scratch_edit; --";

    let r = mgr
        .apply_changes(
            "pg",
            &t,
            &[
                change(ChangeKind::Insert, json!({}), json!({"name": "O'Reilly", "qty": 3, "tags": ["a", "b c", null, "q\"uote"], "data": {"k": [1, 2]}, "bin": {"$bin": "cafe"}, "ts": "2024-01-01 10:00:00+00", "flag": false, "price": "12.50"})),
                change(ChangeKind::Insert, json!({}), json!({"name": evil, "qty": null, "flag": {"$default": true}})),
                change(ChangeKind::Insert, json!({}), json!({})),
            ],
        )
        .await
        .unwrap();
    assert!(r.committed && r.applied == 3, "{r:?}");
    assert!(r.results.iter().all(|c| c.rows_affected == 1 && c.error.is_none()));

    let rs = mgr.table_data("pg", &t, &TableDataRequest { order_by: Some("id".into()), limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows.len(), 3);
    let r0 = &rs.rows[0];
    assert_eq!(r0[1], json!("O'Reilly"));
    assert_eq!(r0[2], json!(3));
    assert_eq!(r0[3], json!(["a", "b c", null, "q\"uote"]));
    assert_eq!(r0[4], json!("{\"k\": [1, 2]}"));
    assert_eq!(r0[5], json!({"$bin": "cafe", "len": 2}));
    assert_eq!(r0[6], json!("2024-01-01 10:00:00+00"));
    assert_eq!(r0[7], json!(false));
    assert_eq!(r0[8], json!("12.50"));
    assert_eq!(rs.rows[1][1], json!(evil));
    assert_eq!(rs.rows[1][7], json!(true));
    assert_eq!(rs.rows[2][1], Value::Null);
    let id1 = r0[0].clone();

    // update + delete by pk
    let r = mgr
        .apply_changes(
            "pg",
            &t,
            &[
                change(ChangeKind::Update, json!({"id": id1}), json!({"qty": 99, "name": null, "tags": []})),
                change(ChangeKind::Delete, json!({"id": rs.rows[2][0]}), json!({})),
            ],
        )
        .await
        .unwrap();
    assert!(r.committed);
    let rs2 = mgr.table_data("pg", &t, &TableDataRequest { order_by: Some("id".into()), limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(rs2.rows.len(), 2);
    assert_eq!((rs2.rows[0][1].clone(), rs2.rows[0][2].clone(), rs2.rows[0][3].clone()), (Value::Null, json!(99), json!([])));

    // atomicity: second change fails -> nothing is applied
    let before = scalar(&run(&mgr, &s, "select count(*) from scratch_edit.scratch_edit").await);
    let r = mgr
        .apply_changes(
            "pg",
            &t,
            &[
                change(ChangeKind::Insert, json!({}), json!({"name": "should-not-exist"})),
                change(ChangeKind::Update, json!({"id": 987654}), json!({"name": "ghost"})),
                change(ChangeKind::Insert, json!({}), json!({"name": "never-reached"})),
            ],
        )
        .await
        .unwrap();
    assert!(!r.committed && r.applied == 0);
    assert_eq!(r.results.len(), 2);
    assert!(r.first_error().unwrap().error.as_deref().unwrap().contains("No row matched"));
    assert_eq!(r.first_error().unwrap().index, 1);
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from scratch_edit.scratch_edit").await), before);

    // server-side error is reported with its real message and rolled back
    let r = mgr
        .apply_changes("pg", &t, &[change(ChangeKind::Insert, json!({}), json!({"qty": "not a number"}))])
        .await
        .unwrap();
    assert!(!r.committed);
    assert!(r.results[0].error.as_deref().unwrap().contains("22P02"), "{r:?}");

    // unknown column is rejected before touching the database
    let err = mgr.apply_changes("pg", &t, &[change(ChangeKind::Insert, json!({}), json!({"nope": 1}))]).await.unwrap_err();
    assert!(err.to_string().contains("Unknown column 'nope'"), "{err}");

    // table without PK: key = all original values, NULL matched with IS NULL
    let nopk = ObjectRef::table(Some("scratch_edit"), "scratch_nopk");
    let r = mgr
        .apply_changes(
            "pg",
            &nopk,
            &[
                change(ChangeKind::Insert, json!({}), json!({"a": 1, "b": null})),
                change(ChangeKind::Insert, json!({}), json!({"a": 2, "b": "two"})),
            ],
        )
        .await
        .unwrap();
    assert!(r.committed);
    let r = mgr
        .apply_changes("pg", &nopk, &[change(ChangeKind::Update, json!({"a": 1, "b": null}), json!({"b": "now set"})), change(ChangeKind::Delete, json!({"a": 2, "b": "two"}), json!({}))])
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    let rs = mgr.table_data("pg", &nopk, &TableDataRequest { limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(rs.rows, vec![vec![json!(1), json!("now set")]]);
    assert!(rs.columns.iter().all(|c| !c.is_pk));

    assert_ok(&run(&mgr, &s, "drop schema scratch_edit cascade").await);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn read_only_data_source() {
    let Some(mut cfg) = pg_cfg() else { return };
    seed_pg(&cfg).await;
    cfg.id = "pg-ro".into();
    cfg.read_only = true;
    let mgr = ConnectionManager::new();
    mgr.connect(&cfg).await.unwrap();
    let s = mgr.open_session("pg-ro").await.unwrap();
    let ev = run(&mgr, &s, "create table shop.should_fail (a int)").await;
    assert!(errors(&ev)[0].contains("read-only transaction"), "{ev:?}");
    let r = mgr.apply_changes("pg-ro", &ObjectRef::table(Some("shop"), "categories"), &[change(ChangeKind::Insert, json!({}), json!({"name": "ro"}))]).await.unwrap();
    assert!(!r.committed);
}

#[tokio::test]
async fn export_and_benchmark() {
    let (_cfg, mgr) = setup!();

    // benchmark-like: first 500 rows of the 100k table
    let t = Instant::now();
    let rs = mgr
        .table_data("pg", &ObjectRef::table(Some("shop"), "big_table"), &TableDataRequest { limit: 500, order_by: Some("id".into()), ..Default::default() })
        .await
        .unwrap();
    let td = t.elapsed();
    assert_eq!(rs.rows.len(), 500);
    let s = mgr.open_session("pg").await.unwrap();
    let t = Instant::now();
    let mut h = mgr.execute(&s, "select * from shop.big_table", ExecOptions { max_rows: 500, stop_on_error: true, ..Default::default() }).await.unwrap();
    let mut n = 0;
    let mut first_rs_at = None;
    while let Some(e) = h.events.recv().await {
        if let ExecEvent::ResultSet { rows, .. } = &e {
            n = rows.len();
            first_rs_at = Some(t.elapsed());
        }
        if let ExecEvent::Done { elapsed_ms, execution_ms, fetching_ms } = e {
            println!("Done: elapsed={elapsed_ms}ms execution={execution_ms}ms fetching={fetching_ms}ms");
            break;
        }
    }
    assert_eq!(n, 500);
    println!("BENCH pg first 500 rows of 100k-row table: table_data={td:?}, execute(first page event)={:?}", first_rs_at.unwrap());
    assert!(td < Duration::from_secs(5) && first_rs_at.unwrap() < Duration::from_secs(5));
    mgr.close_session(&s).await;

    // export everything (100k rows) as CSV through the streaming path
    let mut buf: Vec<u8> = Vec::new();
    let t = Instant::now();
    let n = mgr
        .export_query("pg", "select id, name, amount, created from shop.big_table order by id", &ExportOptions::default(), &mut buf)
        .await
        .unwrap();
    println!("export 100k rows to CSV: {:?} ({} bytes)", t.elapsed(), buf.len());
    assert_eq!(n, 100_000);
    let text = String::from_utf8(buf).unwrap();
    let mut lines = text.lines();
    assert_eq!(lines.next().unwrap(), "id,name,amount,created");
    assert_eq!(lines.next().unwrap(), "1,name-1,1.37,2024-01-01 00:01:00+00");
    assert_eq!(text.lines().count(), 100_001);

    let mut buf = Vec::new();
    mgr.export_query("pg", "select * from shop.categories order by id", &ExportOptions { format: ExportFormat::Json, ..Default::default() }, &mut buf)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&buf).unwrap();
    assert_eq!(v[0], json!({"id": 1, "name": "Electronics", "parent_id": null}));
    let mut buf = Vec::new();
    mgr.export_query(
        "pg",
        "select id, name from shop.categories order by id limit 2",
        &ExportOptions { format: ExportFormat::SqlInsert, table_name: Some("shop.categories".into()), ..Default::default() },
        &mut buf,
    )
    .await
    .unwrap();
    assert_eq!(
        String::from_utf8(buf).unwrap(),
        "insert into \"shop\".\"categories\" (\"id\", \"name\") values (1, 'Electronics');\ninsert into \"shop\".\"categories\" (\"id\", \"name\") values (2, 'Books');\n"
    );
    // zero rows still writes the header
    let mut buf = Vec::new();
    mgr.export_query("pg", "select id, name from shop.categories where false", &ExportOptions::default(), &mut buf).await.unwrap();
    assert_eq!(String::from_utf8(buf).unwrap(), "id,name\n");
}

#[tokio::test]
async fn concurrent_sessions_and_disconnect() {
    let (_cfg, mgr) = setup!();
    let mut tasks = Vec::new();
    for i in 0..6 {
        let m = mgr.clone();
        tasks.push(tokio::spawn(async move {
            let s = m.open_session("pg").await.unwrap();
            let ev = run(&m, &s, &format!("select {i} as n, pg_backend_pid() as pid, count(*) from shop.big_table")).await;
            let rs = first_rs(&ev).1;
            (rs[0][0].clone(), rs[0][1].clone(), s)
        }));
    }
    let mut pids = std::collections::HashSet::new();
    for (i, t) in tasks.into_iter().enumerate() {
        let (n, pid, _s) = t.await.unwrap();
        assert_eq!(n, json!(i));
        pids.insert(pid.to_string());
    }
    assert_eq!(pids.len(), 6, "each session has its own backend");
    mgr.disconnect("pg").await;
    assert!(!mgr.is_connected("pg"));
    assert!(mgr.introspect("pg", &[]).await.is_err());
}

// ------------------------------------------------------------ regression tests (review)

async fn scratch_schema(mgr: &ConnectionManager, s: &SessionId, name: &str, ddl: &str) {
    assert_ok(&run(mgr, s, &format!("drop schema if exists {name} cascade; create schema {name}; set search_path = {name}, public")).await);
    assert_ok(&run(mgr, s, ddl).await);
}

/// Defect 1: values longer than the column fail like a plain UPDATE; they are not truncated.
#[tokio::test]
async fn typmod_columns_reject_too_long_values() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    scratch_schema(
        &mgr,
        &s,
        "scratch_typmod",
        "create type mood as enum ('sad', 'ok');\
         create domain d4 as varchar(4);\
         create table scratch_typmod.t (id int primary key, v varchar(5), b bit(4), c char(3), n numeric(5,2), arr varchar(3)[], d d4, e mood, bv bit varying(3), ts timestamp(0), bits bit(3)[]);\
         insert into scratch_typmod.t (id, v, b, c, n) values (1, 'ab', B'1010', 'xy', 1.5)",
    )
    .await;
    let t = ObjectRef::table(Some("scratch_typmod"), "t");
    let upd = |values: Value| {
        let mgr = mgr.clone();
        let t = t.clone();
        async move { mgr.apply_changes("pg", &t, &[change(ChangeKind::Update, json!({"id": 1}), values)]).await }
    };

    for (col, val, code) in [
        ("v", json!("abcdefghij"), "22001"),
        ("c", json!("abcd"), "22001"),
        ("b", json!("10"), "22026"),
        ("b", json!("101010"), "22026"),
        ("n", json!("123456"), "22003"),
        ("arr", json!(["abcd"]), "22001"),
        ("d", json!("abcde"), "22001"),
        ("e", json!("angry"), "22P02"),
        ("bv", json!("1010"), "22001"),
        ("bits", json!(["1010"]), "22026"),
    ] {
        let r = upd(json!({ col: val })).await.unwrap();
        assert!(!r.committed, "{col}: {r:?}");
        let msg = r.results[0].error.clone().unwrap();
        assert!(msg.contains(code), "{col}: {msg}");
    }
    let r = upd(json!({"v": "abcdefghij"})).await.unwrap();
    assert!(r.results[0].error.as_deref().unwrap().contains("value too long"), "{r:?}");
    // nothing was truncated into the table
    let rs = mgr.table_data("pg", &t, &TableDataRequest::default()).await.unwrap();
    assert_eq!((rs.rows[0][1].clone(), rs.rows[0][2].clone()), (json!("ab"), json!("1010")));

    // values that fit (or are rounded by the assignment, as in a plain UPDATE) are accepted
    let r = upd(json!({"v": "abcde", "b": "0110", "c": "ab", "n": "1.239", "arr": ["abc", null], "d": "abcd", "e": "ok", "bv": "10", "ts": "2024-01-01 10:00:00.6", "bits": ["101", "010"]}))
        .await
        .unwrap();
    assert!(r.committed, "{r:?}");
    let rs = mgr.table_data("pg", &t, &TableDataRequest::default()).await.unwrap();
    let row = &rs.rows[0];
    assert_eq!(row[1], json!("abcde"));
    assert_eq!(row[2], json!("0110"));
    assert_eq!(row[3], json!("ab "));
    assert_eq!(row[4], json!("1.24"));
    assert_eq!(row[5], json!(["abc", null]));
    assert_eq!(row[6], json!("abcd"));
    assert_eq!(row[7], json!("ok"));
    assert_eq!(row[9], json!("2024-01-01 10:00:01"));
    assert_eq!(row[10], json!(["101", "010"]));

    // inserts take the same path
    let r = mgr.apply_changes("pg", &t, &[change(ChangeKind::Insert, json!({}), json!({"id": 2, "v": "toolongvalue"}))]).await.unwrap();
    assert!(!r.committed && r.results[0].error.as_deref().unwrap().contains("22001"), "{r:?}");
    // keys over typmod columns still match (char(3) is blank padded)
    let r = mgr.apply_changes("pg", &t, &[change(ChangeKind::Delete, json!({"id": 1, "c": "ab ", "b": "0110"}), json!({}))]).await.unwrap();
    assert!(r.committed, "{r:?}");
    assert_ok(&run(&mgr, &s, "drop schema scratch_typmod cascade").await);
    mgr.close_session(&s).await;
}

/// Defect 2: PG addresses rows of PK-less tables by `ctid` (+ `tableoid`); one change = one row.
#[tokio::test]
async fn nopk_rows_are_addressed_by_ctid_locator() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    scratch_schema(
        &mgr,
        &s,
        "scratch_nopk",
        "create table dup (a int, b text, j json);\
         insert into dup values (1,'x','{\"k\":1}'),(1,'x','{\"k\":1}'),(2,'y',null);\
         create table parent (a int); create table child () inherits (parent);\
         insert into parent values (1); insert into child values (1);\
         create table withpk (id int primary key, v int); insert into withpk values (1, 1);\
         create view v_dup as select * from dup",
    )
    .await;
    let dup = ObjectRef::table(Some("scratch_nopk"), "dup");
    let ordered = TableDataRequest { order_by: Some("ctid".into()), ..Default::default() };
    let rs = mgr.table_data("pg", &dup, &ordered).await.unwrap();
    let loc = rs.row_locators.clone().expect("locators for a table without PK");
    assert_eq!((loc.len(), rs.columns.len(), rs.rows[0].len()), (3, 3, 3));
    assert!(mgr.table_data("pg", &ObjectRef::table(Some("scratch_nopk"), "withpk"), &Default::default()).await.unwrap().row_locators.is_none());

    // update the second duplicate by locator (json column present in the old key is irrelevant)
    let mut upd = change(ChangeKind::Update, json!({"a": 1, "b": "x", "j": rs.rows[1][2]}), json!({"b": "second"}));
    upd.row_locator = Some(loc[1].clone());
    let r = mgr.apply_changes("pg", &dup, &[upd]).await.unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    let rs = mgr.table_data("pg", &dup, &TableDataRequest { order_by: Some("b, a".into()), ..Default::default() }).await.unwrap();
    let bs: Vec<_> = rs.rows.iter().map(|r| r[1].clone()).collect();
    assert_eq!(bs, vec![json!("second"), json!("x"), json!("y")]);

    // delete by locator
    let loc = rs.row_locators.clone().unwrap();
    let mut del = change(ChangeKind::Delete, json!({}), json!({}));
    del.row_locator = Some(loc[1].clone());
    assert!(mgr.apply_changes("pg", &dup, &[del]).await.unwrap().committed);
    assert_eq!(mgr.table_data("pg", &dup, &Default::default()).await.unwrap().rows.len(), 2);

    // without a locator, a key that matches two rows (and a json column) still changes one row
    assert_ok(&run(&mgr, &s, "insert into scratch_nopk.dup values (5,'z','{\"k\":2}'),(5,'z','{\"k\":2}')").await);
    let rs = mgr.table_data("pg", &dup, &Default::default()).await.unwrap();
    let row = rs.rows.iter().find(|r| r[0] == json!(5)).unwrap().clone();
    let r = mgr
        .apply_changes("pg", &dup, &[change(ChangeKind::Update, json!({"a": row[0], "b": row[1], "j": row[2]}), json!({"a": 6}))])
        .await
        .unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from scratch_nopk.dup where a = 6").await), json!(1));
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from scratch_nopk.dup where a = 5").await), json!(1));

    // inheritance: the same ctid exists in parent and child; the locator carries tableoid
    let parent = ObjectRef::table(Some("scratch_nopk"), "parent");
    let rs = mgr.table_data("pg", &parent, &Default::default()).await.unwrap();
    assert_eq!(rs.rows.len(), 2);
    let mut upd = change(ChangeKind::Update, json!({"a": 1}), json!({"a": 7}));
    upd.row_locator = Some(rs.row_locators.unwrap()[0].clone());
    let r = mgr.apply_changes("pg", &parent, &[upd]).await.unwrap();
    assert!(r.committed && r.results[0].rows_affected == 1, "{r:?}");
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from scratch_nopk.parent where a = 7").await), json!(1));

    // views have no ctid: no locators, table_data still works
    let rs = mgr.table_data("pg", &ObjectRef::table(Some("scratch_nopk"), "v_dup"), &Default::default()).await.unwrap();
    assert!(rs.row_locators.is_none() && !rs.rows.is_empty());

    assert_ok(&run(&mgr, &s, "drop schema scratch_nopk cascade").await);
    mgr.close_session(&s).await;
}

/// Session-scoped editing: uncommitted inside `begin`, invisible to the pool until `commit`, a failing batch
/// leaves the (otherwise aborted) PostgreSQL transaction usable.
#[tokio::test]
async fn session_scoped_edit_stays_in_the_transaction() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    scratch_schema(&mgr, &s, "scratch_sess", "create table t (id int primary key, v varchar(3)); insert into t values (1,'a'),(2,'b')").await;
    let t = ObjectRef::table(Some("scratch_sess"), "t");
    let req = TableDataRequest { order_by: Some("id".into()), ..Default::default() };
    let vs = |rs: &ResultSet| rs.rows.iter().map(|r| r[1].clone()).collect::<Vec<_>>();

    assert_ok(&run(&mgr, &s, "begin").await);
    let r = mgr.apply_changes_in_session(&s, &t, &[change(ChangeKind::Update, json!({"id": 1}), json!({"v": "one"}))]).await.unwrap();
    assert!(r.committed, "{r:?}");
    assert_eq!(vs(&mgr.table_data_in_session(&s, &t, &req).await.unwrap()), vec![json!("one"), json!("b")]);
    assert_eq!(vs(&mgr.table_data("pg", &t, &req).await.unwrap()), vec![json!("a"), json!("b")], "not visible to other connections");

    // too long value: the change fails, the transaction is not aborted
    let r = mgr.apply_changes_in_session(&s, &t, &[change(ChangeKind::Update, json!({"id": 2}), json!({"v": "toolong"}))]).await.unwrap();
    assert!(!r.committed && r.results[0].error.as_deref().unwrap().contains("too long"), "{r:?}");
    assert_eq!(vs(&mgr.table_data_in_session(&s, &t, &req).await.unwrap()), vec![json!("one"), json!("b")]);

    assert_ok(&run(&mgr, &s, "commit").await);
    assert_eq!(vs(&mgr.table_data("pg", &t, &req).await.unwrap()), vec![json!("one"), json!("b")]);

    // rollback path
    assert_ok(&run(&mgr, &s, "begin").await);
    let del = change(ChangeKind::Delete, json!({"id": 2}), json!({}));
    assert!(mgr.apply_changes_in_session(&s, &t, &[del]).await.unwrap().committed);
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert_eq!(mgr.table_data("pg", &t, &req).await.unwrap().rows.len(), 2);

    assert_ok(&run(&mgr, &s, "drop schema scratch_sess cascade").await);
    mgr.close_session(&s).await;
}

/// Defect 2: a no-PK key that matches two rows through a locator-less change affects exactly one;
/// a count other than 1 rolls everything back (here: a locator that matches nothing).
#[tokio::test]
async fn nopk_unexpected_count_rolls_back() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    scratch_schema(&mgr, &s, "scratch_cnt", "create table t (a int); insert into t values (1)").await;
    let t = ObjectRef::table(Some("scratch_cnt"), "t");
    let mut bad = change(ChangeKind::Delete, json!({}), json!({}));
    bad.row_locator = Some(json!("16384:(99,99)"));
    let r = mgr.apply_changes("pg", &t, &[change(ChangeKind::Insert, json!({}), json!({"a": 2})), bad]).await.unwrap();
    assert!(!r.committed && r.applied == 0, "{r:?}");
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from scratch_cnt.t").await), json!(1));
    let mut garbage = change(ChangeKind::Delete, json!({}), json!({}));
    garbage.row_locator = Some(json!("not a locator"));
    assert!(mgr.apply_changes("pg", &t, &[garbage]).await.is_err());
    assert_ok(&run(&mgr, &s, "drop schema scratch_cnt cascade").await);
    mgr.close_session(&s).await;
}

/// Defect 3: several result sets in one call (different column sets) must not panic.
#[tokio::test]
async fn multi_result_sets_and_separators() {
    let (_cfg, mgr) = setup!();
    let m2 = mgr.clone();
    let out = tokio::spawn(async move {
        m2.export_query("pg", "select 1 as a; select 1 as a, 2 as b", &ExportOptions { format: ExportFormat::Json, ..Default::default() }, Vec::<u8>::new()).await
    })
    .await
    .expect("export task panicked");
    assert_eq!(out.unwrap(), 1, "only the rows of the first column set are exported");

    let s = mgr.open_session("pg").await.unwrap();
    scratch_schema(&mgr, &s, "scratch_multi", "create table one (a int); insert into one values (1)").await;
    let t = ObjectRef::table(Some("scratch_multi"), "one");
    let m2 = mgr.clone();
    let t2 = t.clone();
    let r = tokio::spawn(async move {
        m2.table_data("pg", &t2, &TableDataRequest { where_clause: Some("true; select 1, 2, 3".into()), ..Default::default() }).await.map(|_| ())
    })
    .await
    .expect("table_data task panicked");
    assert!(r.unwrap_err().to_string().contains("statement separator"));
    let err = mgr
        .table_data("pg", &t, &TableDataRequest { order_by: Some("a; select 1".into()), ..Default::default() })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("statement separator"), "{err}");
    let ok = mgr.table_data("pg", &t, &TableDataRequest { where_clause: Some("a = 1 and 'x;y' <> ''".into()), ..Default::default() }).await.unwrap();
    assert_eq!(ok.rows.len(), 1);
    assert_ok(&run(&mgr, &s, "drop schema scratch_multi cascade").await);
    mgr.close_session(&s).await;
}

/// Defect 4: SQL INSERT export of PG arrays round-trips.
#[tokio::test]
async fn sql_insert_export_of_arrays_round_trips() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    scratch_schema(
        &mgr,
        &s,
        "scratch_arr",
        "create table src (id int primary key, i int[], t text[], n numeric[], b bool[], nested int[][], by bytea[], d date[], f float8[], ts timestamptz[], e text[]);\
         insert into src values \
           (1, '{1,2}', array['a','b c','d\"q', 'back\\slash', 'it''s', 'x,y', '{br}', '', 'NULL', null], '{1.50,2}', '{t,f,NULL}', '{{1,2},{3,4}}', array['\\x00ff'::bytea, null], '{2024-01-02}', '{1.5,-2e10}', '{\"2024-01-01 10:00:00+00\"}', '{}'),\
           (2, null, null, null, null, null, null, null, null, null, null),\
           (3, '{null}', '{\"\"}', '{}', '{}', '{{null,1}}', '{}', '{}', '{NaN,Infinity}', '{}', '{null,null}');\
         create table dst (like src including all)",
    )
    .await;
    let o = ExportOptions { format: ExportFormat::SqlInsert, table_name: Some("scratch_arr.dst".into()), rows_per_insert: 2, ..Default::default() };
    let mut buf = Vec::new();
    let n = mgr.export_query("pg", "select * from scratch_arr.src order by id", &o, &mut buf).await.unwrap();
    assert_eq!(n, 3);
    let sql = String::from_utf8(buf).unwrap();
    assert!(!sql.contains("'[1,2]'"), "array exported as JSON text: {sql}");
    assert_ok(&run(&mgr, &s, &sql).await);
    assert_eq!(scalar(&run(&mgr, &s, "select count(*) from scratch_arr.dst").await), json!(3));
    // identical content: no row differs in either direction
    let diff = scalar(&run(&mgr, &s, "select count(*) from ((select * from scratch_arr.src except select * from scratch_arr.dst) union all (select * from scratch_arr.dst except select * from scratch_arr.src)) x").await);
    assert_eq!(diff, json!(0), "exported:\n{sql}");
    assert_ok(&run(&mgr, &s, "drop schema scratch_arr cascade").await);
    mgr.close_session(&s).await;
}

/// Defect 5: no `Busy` right after `Done`.
#[tokio::test]
async fn no_busy_right_after_done() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    let opts = ExecOptions { max_rows: 1, ..Default::default() };
    for i in 0..100 {
        let mut h = mgr.execute(&s, "select generate_series(1, 5)", opts.clone()).await.unwrap_or_else(|e| panic!("run {i}: {e}"));
        wait_done(&mut h).await;
        let mut h = mgr.execute(&s, "select 1", opts.clone()).await.unwrap_or_else(|e| panic!("run {i}b: {e}"));
        wait_done(&mut h).await;
        let mut h = mgr.execute(&s, "select 2", opts.clone()).await.unwrap_or_else(|e| panic!("run {i}c: {e}"));
        wait_done(&mut h).await;
    }
    mgr.close_session(&s).await;
}

/// Defect 6: new execution closes the previous open result; an idle one is closed on a timer,
/// which releases its locks on the server.
#[tokio::test]
async fn open_results_are_closed_on_reexecute_and_idle_timeout() {
    let (_cfg, mgr) = setup!();
    let a = mgr.open_session("pg").await.unwrap();
    let b = mgr.open_session("pg").await.unwrap();
    // try to take an exclusive lock on the table in a transaction that is always ended
    let try_lock = |s: &SessionId, secs: &str| {
        let (mgr, s) = (mgr.clone(), s.clone());
        let sql = format!("set lock_timeout = '{secs}'; begin; lock table shop.big_table in access exclusive mode; commit");
        async move { mgr.execute_collect(&s, &sql, ExecOptions { stop_on_error: false, ..Default::default() }).await.unwrap() }
    };

    // re-execute closes the previous result and frees the lock
    let mut h = // A result far bigger than the socket buffers, so the server cannot finish the query (and release
    // the lock) while the client reads nothing. 100k rows alone can fit in localhost buffers.
    mgr.execute(&a, "select b.*, g from shop.big_table b cross join generate_series(1, 200) g", ExecOptions { max_rows: 10, keep_open_secs: 0, ..Default::default() }).await.unwrap();
    wait_done(&mut h).await;
    let ev = try_lock(&b, "700ms").await;
    assert!(errors(&ev).iter().any(|e| e.contains("55P03")), "lock must be held while the result is open: {ev:?}");
    assert_ok(&run(&mgr, &a, "select 1").await);
    let err = mgr.fetch_more(&h.id, 0, 5).await.unwrap_err();
    assert!(err.to_string().contains("result set is closed"), "{err}");
    assert_ok(&try_lock(&b, "2s").await);

    // idle timeout closes it, cancelling the query server side
    let mut h = mgr.execute(&a, "select * from shop.big_table", ExecOptions { max_rows: 10, keep_open_secs: 1, ..Default::default() }).await.unwrap();
    wait_done(&mut h).await;
    assert!(mgr.fetch_more(&h.id, 0, 5).await.is_ok());
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let err = mgr.fetch_more(&h.id, 0, 5).await.unwrap_err();
    assert!(err.to_string().contains("result set is closed"), "{err}");
    assert_ok(&try_lock(&b, "2s").await);
    assert_eq!(scalar(&run(&mgr, &a, "select 3").await), json!(3));

    // inside an explicit transaction the rows are drained instead (the transaction survives)
    assert_ok(&run(&mgr, &a, "begin").await);
    let mut h = mgr.execute(&a, "select * from shop.big_table", ExecOptions { max_rows: 10, keep_open_secs: 1, ..Default::default() }).await.unwrap();
    wait_done(&mut h).await;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(mgr.fetch_more(&h.id, 0, 5).await.unwrap_err().to_string().contains("result set is closed"));
    assert_eq!(scalar(&run(&mgr, &a, "select 4").await), json!(4));
    assert_ok(&run(&mgr, &a, "rollback").await);
    mgr.close_session(&a).await;
    mgr.close_session(&b).await;
}

/// A failed transaction is reported as such, and `COMMIT` of it (which the server turns into a rollback with the
/// command tag `ROLLBACK`, without an error) is reported as `TxEnded { committed: false }`.
#[tokio::test]
async fn failed_transaction_status_and_commit_that_rolls_back() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    scratch_schema(&mgr, &s, "scratch_txs", "create table t (id int primary key, v text); insert into t values (1,'a')").await;
    let t = ObjectRef::table(Some("scratch_txs"), "t");
    let v = |mgr: &ConnectionManager| {
        let mgr = mgr.clone();
        let t = t.clone();
        async move { mgr.table_data("pg", &t, &Default::default()).await.unwrap().rows[0][1].clone() }
    };
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);

    let ev = run(&mgr, &s, "begin").await;
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Active]);
    assert_ok(&run(&mgr, &s, "update t set v = 'edited' where id = 1").await);
    let ev = run(&mgr, &s, "select 1/0").await;
    assert_eq!(errors(&ev).len(), 1);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Failed]);
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Failed);
    assert!(mgr.session_in_transaction(&s).unwrap());
    // a later statement is refused by the server and the state stays failed (no new event)
    let ev = run(&mgr, &s, "select 1").await;
    assert!(errors(&ev)[0].contains("25P02"));
    assert!(tx_statuses(&ev).is_empty());
    // editing in a failed transaction is refused with a clear message
    let e = mgr.apply_changes_in_session(&s, &t, &[change(ChangeKind::Update, json!({"id": 1}), json!({"v": "x"}))]).await.unwrap_err();
    assert!(e.to_string().contains("failed state"), "{e}");

    // COMMIT: no error, but the work is gone
    let ev = run(&mgr, &s, "commit").await;
    assert_ok(&ev);
    assert_eq!(tx_ended(&ev), vec![(false, "ROLLBACK".to_string())]);
    assert!(ev.iter().any(|e| matches!(e, ExecEvent::Message { text, .. } if text.contains("ROLLBACK"))), "{ev:#?}");
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
    assert_eq!(v(&mgr).await, json!("a"), "the edit did not survive the COMMIT");

    // a healthy COMMIT is reported as committed
    assert_ok(&run(&mgr, &s, "begin").await);
    assert_ok(&run(&mgr, &s, "update t set v = 'kept' where id = 1").await);
    let ev = run(&mgr, &s, "commit").await;
    assert_eq!(tx_ended(&ev), vec![(true, "COMMIT".to_string())]);
    assert_eq!(v(&mgr).await, json!("kept"));

    // ROLLBACK TO SAVEPOINT revives a failed transaction
    assert_ok(&run(&mgr, &s, "begin; savepoint sp; update t set v = 'x' where id = 1").await);
    assert_eq!(tx_statuses(&run(&mgr, &s, "select 1/0").await), vec![TxStatus::Failed]);
    let ev = run(&mgr, &s, "rollback to savepoint sp").await;
    assert_ok(&ev);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Active]);
    assert!(tx_ended(&ev).is_empty());
    let ev = run(&mgr, &s, "rollback").await;
    assert_eq!(tx_ended(&ev), vec![(false, "ROLLBACK".to_string())]);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);

    // an error outside a transaction does not make it "failed"
    let ev = run(&mgr, &s, "select 1/0").await;
    assert!(tx_statuses(&ev).is_empty());
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);

    assert_ok(&run(&mgr, &s, "drop schema scratch_txs cascade").await);
    mgr.close_session(&s).await;
}

/// `position_utf16` counts UTF-16 code units: it is ahead of `position` (code points) after an emoji.
#[tokio::test]
async fn error_position_in_utf16_units() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    let ev = run(&mgr, &s, "select '😀😀', nosuchcolumn").await;
    let pos: Vec<_> = ev.iter().filter_map(|e| if let ExecEvent::Error { position, position_utf16, .. } = e { Some((*position, *position_utf16)) } else { None }).collect();
    // `select ` + quote + 2 emoji + quote + comma + space = 13 code points before the identifier; the emoji take 2 units each
    assert_eq!(pos, vec![(Some(14), Some(16))], "{ev:#?}");
    let ev = run(&mgr, &s, "select nosuchcolumn").await;
    let pos: Vec<_> = ev.iter().filter_map(|e| if let ExecEvent::Error { position, position_utf16, .. } = e { Some((*position, *position_utf16)) } else { None }).collect();
    assert_eq!(pos, vec![(Some(8), Some(8))]);
    mgr.close_session(&s).await;
}

/// `open_session_with` re-applies session settings on a fresh connection.
#[tokio::test]
async fn open_session_with_init_sql() {
    let (_cfg, mgr) = setup!();
    let init = vec!["set search_path to shop, public".to_string(), "set session characteristics as transaction isolation level serializable".to_string()];
    let s = mgr.open_session_with("pg", &init).await.unwrap();
    assert_eq!(scalar(&run(&mgr, &s, "select current_schema()").await), json!("shop"));
    assert_eq!(scalar(&run(&mgr, &s, "show default_transaction_isolation").await), json!("serializable"));
    mgr.close_session(&s).await;
    // a failing statement fails the open and leaves no session behind
    let e = mgr.open_session_with("pg", &["select * from definitely_not_a_table".to_string()]).await.unwrap_err();
    assert!(e.to_string().contains("42P01"), "{e}");
    // plain open_session is unchanged
    let s = mgr.open_session("pg").await.unwrap();
    assert_ne!(scalar(&run(&mgr, &s, "select current_schema()").await), json!("shop"));
    mgr.close_session(&s).await;
}

/// A URL without a password plus the `password` field connects (the app keeps passwords out of stored URLs).
#[tokio::test]
async fn password_field_completes_a_url_without_password() {
    let Some(mut cfg) = pg_cfg() else { return };
    let (_, _, user, pass, _) = url_parts(cfg.url_override.as_deref().unwrap());
    let url = cfg.url_override.clone().unwrap();
    cfg.url_override = Some(url.replacen(&format!("{user}:{pass}@"), &format!("{user}@"), 1));
    assert!(!cfg.url_override.as_deref().unwrap().contains(&pass));
    let mgr = ConnectionManager::new();
    assert!(!mgr.test_connection(&cfg).await.ok, "no password: must be refused");
    cfg.password = Some(pass);
    let r = mgr.test_connection(&cfg).await;
    assert!(r.ok, "{r:?}");
}
