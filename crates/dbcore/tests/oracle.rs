//! Oracle integration tests. Run with:
//!   PROMETEO_ORACLE_URL=oracle://demo:prometeo@127.0.0.1:15219/FREEPDB1 cargo test -p dbcore --test oracle -- --nocapture

mod common;

use common::*;
use dbcore::import::CancellationToken;
use dbcore::*;
use serde_json::{json, Value};

/// SQL dialect: introspection, DDL, table data and editing, export, import, explain, script splitting.
mod dialect {
    use super::*;
    use std::collections::BTreeMap;

    macro_rules! setup {
        () => {{
            let Some(cfg) = oracle_cfg() else {
                eprintln!("PROMETEO_ORACLE_URL not set: skipping");
                return;
            };
            seed_oracle(&cfg).await;
            let mgr = connected(&cfg).await;
            (cfg, mgr)
        }};
    }

    /// A cell as text: Oracle numbers may arrive as JSON numbers or as strings.
    fn txt(v: &Value) -> String {
        match v {
            Value::String(s) => s.clone(),
            Value::Null => "NULL".into(),
            other => other.to_string(),
        }
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

    fn node<'a>(nodes: &'a [TreeNode], name: &str) -> &'a TreeNode {
        nodes
            .iter()
            .find(|n| n.name == name)
            .unwrap_or_else(|| panic!("{name} not in {:?}", names(nodes)))
    }

    #[tokio::test]
    async fn introspection_tree() {
        let (_cfg, mgr) = setup!();
        let schemas = children(&mgr, "ora", &[]).await;
        assert!(schemas.iter().all(|n| n.kind == NodeKind::Schema));
        let sn = names(&schemas);
        assert_eq!(sn[0], "DEMO", "the login schema comes first: {sn:?}");
        assert_eq!(schemas[0].extra["default"], json!(true));
        assert!(!sn.contains(&"SYS".to_string()) && !sn.contains(&"SYSTEM".to_string()));
        let all = mgr
            .introspect_with("ora", &[], &IntrospectOptions { show_system: true })
            .await
            .unwrap();
        assert!(names(&all).contains(&"SYS".to_string()));

        let folders = children(&mgr, "ora", &["DEMO"]).await;
        assert_eq!(
            names(&folders),
            [
                "tables",
                "views",
                "materialized views",
                "sequences",
                "routines",
                "packages",
                "triggers",
                "synonyms"
            ]
        );
        let tables = children(&mgr, "ora", &["DEMO", "tables"]).await;
        let tn = names(&tables);
        for t in [
            "ALL_TYPES",
            "BIG_TABLE",
            "CATEGORIES",
            "CUSTOMERS",
            "ORDER_ITEMS",
            "ORDERS",
            "PRODUCTS",
        ] {
            assert!(tn.contains(&t.to_string()), "{t} missing in {tn:?}");
        }
        assert!(
            !tn.contains(&"MV_SALES_BY_CATEGORY".to_string()),
            "the storage of a materialized view is not a table: {tn:?}"
        );
        let cat = node(&tables, "CATEGORIES");
        assert_eq!(cat.kind, NodeKind::Table);
        assert_eq!(cat.hint.as_deref(), Some("Product categories"));
        assert_eq!(cat.path, ["DEMO", "tables", "CATEGORIES"]);

        // views / materialized views / sequences / routines / packages / triggers / synonyms
        let views = children(&mgr, "ora", &["DEMO", "views"]).await;
        assert_eq!(node(&views, "V_ORDER_TOTALS").kind, NodeKind::View);
        let mvs = children(&mgr, "ora", &["DEMO", "materialized_views"]).await;
        assert_eq!(
            node(&mvs, "MV_SALES_BY_CATEGORY").kind,
            NodeKind::MaterializedView
        );
        let seqs = children(&mgr, "ora", &["DEMO", "sequences"]).await;
        assert!(names(&seqs).contains(&"SEQ_INVOICE".to_string()));
        assert!(
            seqs.iter().all(|s| !s.name.starts_with("ISEQ$$")),
            "identity sequences are not objects of their own: {:?}",
            names(&seqs)
        );
        let routines = children(&mgr, "ora", &["DEMO", "routines"]).await;
        let f = node(&routines, "ORDER_TOTAL");
        assert_eq!(f.kind, NodeKind::Function);
        assert_eq!(f.hint.as_deref(), Some("(P_ORDER_ID NUMBER): NUMBER"));
        assert_eq!(node(&routines, "RESTOCK").kind, NodeKind::Procedure);
        let pkgs = children(&mgr, "ora", &["DEMO", "packages"]).await;
        assert_eq!(node(&pkgs, "PKG_SHOP").kind, NodeKind::Package);
        let members = children(&mgr, "ora", &["DEMO", "packages", "PKG_SHOP"]).await;
        assert_eq!(names(&members), ["WITH_VAT", "LOG_MSG"]);
        assert_eq!(members[0].kind, NodeKind::Function);
        assert_eq!(members[1].kind, NodeKind::Procedure);
        let trg = children(&mgr, "ora", &["DEMO", "triggers"]).await;
        let t = node(&trg, "TRG_PRODUCTS_TOUCH");
        assert_eq!(t.hint.as_deref(), Some("BEFORE EACH ROW UPDATE"));
        assert_eq!(t.extra["table"], json!("PRODUCTS"));
        let syn = children(&mgr, "ora", &["DEMO", "synonyms"]).await;
        let sy = node(&syn, "SYN_PRODUCTS");
        assert_eq!(sy.kind, NodeKind::Synonym);
        assert_eq!(sy.hint.as_deref(), Some("-> DEMO.PRODUCTS"));

        // a table: columns, keys, foreign keys, indexes, checks, triggers
        let sub = children(&mgr, "ora", &["DEMO", "tables", "PRODUCTS"]).await;
        assert_eq!(
            names(&sub),
            [
                "columns",
                "keys",
                "foreign keys",
                "indexes",
                "checks",
                "triggers"
            ]
        );
        let cols = children(&mgr, "ora", &["DEMO", "tables", "PRODUCTS", "columns"]).await;
        assert_eq!(
            names(&cols),
            [
                "ID",
                "SKU",
                "NAME",
                "CATEGORY_ID",
                "PRICE",
                "STOCK",
                "TAGS",
                "CREATED_AT",
                "UPDATED_AT"
            ]
        );
        let ty = |n: &str| node(&cols, n).hint.clone().unwrap();
        assert_eq!(ty("ID"), "NUMBER");
        assert_eq!(ty("SKU"), "VARCHAR2(32)");
        assert_eq!(ty("PRICE"), "NUMBER(10,2)");
        assert_eq!(ty("STOCK"), "NUMBER(9)");
        assert_eq!(ty("TAGS"), "CLOB");
        assert_eq!(ty("CREATED_AT"), "TIMESTAMP(6)");
        let id = node(&cols, "ID");
        assert_eq!(id.extra["isPk"], json!(true));
        assert_eq!(id.extra["nullable"], json!(false));
        assert_eq!(id.extra["identity"], json!(true));
        assert_eq!(node(&cols, "UPDATED_AT").extra["nullable"], json!(true));
        assert_eq!(node(&cols, "STOCK").extra["default"], json!("0"));
        assert_eq!(
            node(&cols, "SKU").extra["comment"],
            json!("Stock keeping unit")
        );
        let types = children(&mgr, "ora", &["DEMO", "tables", "ALL_TYPES", "columns"]).await;
        let tys: Vec<String> = types.iter().filter_map(|c| c.hint.clone()).collect();
        for t in [
            "NUMBER(30,10)",
            "FLOAT(63)",
            "BINARY_DOUBLE",
            "CHAR(5)",
            "VARCHAR2(40 CHAR)",
            "NVARCHAR2(20)",
            "RAW(16)",
            "TIMESTAMP(3)",
            "TIMESTAMP(6) WITH TIME ZONE",
            "TIMESTAMP(6) WITH LOCAL TIME ZONE",
            "INTERVAL YEAR(2) TO MONTH",
            "INTERVAL DAY(2) TO SECOND(3)",
            "BLOB",
            "NCLOB",
        ] {
            assert!(tys.contains(&t.to_string()), "{t} missing in {tys:?}");
        }
        let keys = children(&mgr, "ora", &["DEMO", "tables", "PRODUCTS", "keys"]).await;
        assert_eq!(keys.len(), 2, "{keys:?}");
        assert_eq!(keys[0].kind, NodeKind::PrimaryKey);
        assert_eq!(keys[0].hint.as_deref(), Some("(ID)"));
        assert_eq!(keys[1].name, "UQ_PRODUCTS_SKU");
        assert_eq!(keys[1].kind, NodeKind::UniqueKey);
        let order_items_keys =
            children(&mgr, "ora", &["DEMO", "tables", "ORDER_ITEMS", "keys"]).await;
        assert_eq!(
            order_items_keys[0].hint.as_deref(),
            Some("(ORDER_ID, LINE_NO)")
        );
        let fks = children(&mgr, "ora", &["DEMO", "tables", "PRODUCTS", "foreign_keys"]).await;
        assert_eq!(names(&fks), ["FK_PRODUCTS_CATEGORY"]);
        assert_eq!(
            fks[0].hint.as_deref(),
            Some("(CATEGORY_ID) -> CATEGORIES(ID)")
        );
        assert_eq!(fks[0].extra["refTable"], json!("CATEGORIES"));
        let fk_items = children(
            &mgr,
            "ora",
            &["DEMO", "tables", "ORDER_ITEMS", "foreign_keys"],
        )
        .await;
        assert_eq!(
            node(&fk_items, "FK_ITEMS_ORDER").extra["onDelete"],
            json!("CASCADE")
        );
        let idx = children(&mgr, "ora", &["DEMO", "tables", "PRODUCTS", "indexes"]).await;
        let ic = node(&idx, "IDX_PRODUCTS_CATEGORY");
        assert_eq!(ic.hint.as_deref(), Some("(CATEGORY_ID)"));
        assert_eq!(ic.extra["unique"], json!(false));
        assert!(idx.iter().any(|i| i.extra["primary"] == json!(true)));
        let checks = children(&mgr, "ora", &["DEMO", "tables", "PRODUCTS", "checks"]).await;
        assert_eq!(
            names(&checks),
            ["PRODUCTS_PRICE_POSITIVE", "PRODUCTS_TAGS_JSON"]
        );
        assert_eq!(checks[0].hint.as_deref(), Some("price > 0"));
        let trgs = children(&mgr, "ora", &["DEMO", "tables", "PRODUCTS", "triggers"]).await;
        assert_eq!(names(&trgs), ["TRG_PRODUCTS_TOUCH"]);
        // views and materialized views: columns (and indexes for the latter)
        let vsub = children(&mgr, "ora", &["DEMO", "views", "V_ORDER_TOTALS"]).await;
        assert_eq!(names(&vsub), ["columns"]);
        let vcols = children(&mgr, "ora", &["DEMO", "views", "V_ORDER_TOTALS", "columns"]).await;
        assert_eq!(names(&vcols), ["ORDER_ID", "CUSTOMER", "STATUS", "TOTAL"]);
        let mcols = children(
            &mgr,
            "ora",
            &[
                "DEMO",
                "materialized_views",
                "MV_SALES_BY_CATEGORY",
                "columns",
            ],
        )
        .await;
        assert_eq!(names(&mcols), ["CATEGORY_ID", "ITEMS", "REVENUE"]);
        // bad paths are errors, not panics
        assert!(mgr
            .introspect("ora", &["DEMO".into(), "nonsense".into()])
            .await
            .is_err());
    }

    #[tokio::test]
    async fn snapshot_has_tables_views_and_columns() {
        let (_cfg, mgr) = setup!();
        let snap = mgr.schema_snapshot("ora", Some("DEMO")).await.unwrap();
        let p = snap.iter().find(|o| o.name == "PRODUCTS").unwrap();
        assert_eq!(
            (p.columns.len(), p.columns[0].is_pk, p.kind),
            (9, true, NodeKind::Table)
        );
        assert_eq!(p.columns[4].type_name, "NUMBER(10,2)");
        assert_eq!(
            snap.iter()
                .find(|o| o.name == "V_ORDER_TOTALS")
                .unwrap()
                .kind,
            NodeKind::View
        );
        assert_eq!(
            snap.iter()
                .find(|o| o.name == "MV_SALES_BY_CATEGORY")
                .unwrap()
                .kind,
            NodeKind::MaterializedView
        );
        assert_eq!(
            snap.iter()
                .filter(|o| o.name == "MV_SALES_BY_CATEGORY")
                .count(),
            1,
            "the storage table of a materialized view is not listed twice"
        );
        let all = mgr.schema_snapshot("ora", None).await.unwrap();
        assert!(all.iter().all(|o| o.schema != "SYS"));
        assert!(all.iter().any(|o| o.schema == "DEMO"));
    }

    #[tokio::test]
    async fn ddl_generation() {
        let (_cfg, mgr) = setup!();
        let obj = |kind: NodeKind, name: &str| ObjectRef {
            schema: Some("DEMO".into()),
            name: name.into(),
            kind,
            table: None,
            signature: None,
        };
        let table = mgr
            .ddl("ora", &obj(NodeKind::Table, "PRODUCTS"))
            .await
            .unwrap();
        assert!(
            table.starts_with("CREATE TABLE \"DEMO\".\"PRODUCTS\""),
            "{table}"
        );
        assert!(
            table.contains("\"PRICE\" NUMBER(10,2) NOT NULL ENABLE"),
            "{table}"
        );
        assert!(
            table.contains("REFERENCES \"DEMO\".\"CATEGORIES\" (\"ID\")"),
            "{table}"
        );
        assert!(
            table.contains("CREATE INDEX \"DEMO\".\"IDX_PRODUCTS_CATEGORY\""),
            "{table}"
        );
        assert!(
            table.contains("COMMENT ON COLUMN \"DEMO\".\"PRODUCTS\".\"SKU\""),
            "{table}"
        );
        assert!(
            !table.contains("SEGMENT CREATION") && !table.contains("TABLESPACE"),
            "{table}"
        );
        assert!(!table.contains("\n\n\n"), "{table}");
        let short = mgr
            .ddl_with("ora", &obj(NodeKind::Table, "PRODUCTS"), true)
            .await
            .unwrap();
        assert!(short.starts_with("CREATE TABLE \"PRODUCTS\""), "{short}");
        assert!(!short.contains("\"DEMO\"."), "{short}");
        let view = mgr
            .ddl("ora", &obj(NodeKind::View, "V_ORDER_TOTALS"))
            .await
            .unwrap();
        assert!(view.contains("VIEW \"DEMO\".\"V_ORDER_TOTALS\""), "{view}");
        let mv = mgr
            .ddl(
                "ora",
                &obj(NodeKind::MaterializedView, "MV_SALES_BY_CATEGORY"),
            )
            .await
            .unwrap();
        assert!(mv.contains("CREATE MATERIALIZED VIEW"), "{mv}");
        let seq = mgr
            .ddl("ora", &obj(NodeKind::Sequence, "SEQ_INVOICE"))
            .await
            .unwrap();
        // DBMS_METADATA writes the sequence's current position as START WITH,
        // so it moves on once anything has used the sequence.
        let start = seq
            .split("INCREMENT BY 5 START WITH ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|n| n.parse::<u64>().ok());
        assert!(start.is_some_and(|n| n >= 1000), "{seq}");
        let proc_ = mgr
            .ddl("ora", &obj(NodeKind::Procedure, "RESTOCK"))
            .await
            .unwrap();
        assert!(proc_.contains("PROCEDURE \"DEMO\".\"RESTOCK\""), "{proc_}");
        assert!(proc_.contains("UPDATE products SET stock"), "{proc_}");
        let func = mgr
            .ddl("ora", &obj(NodeKind::Routine, "ORDER_TOTAL"))
            .await
            .unwrap();
        assert!(func.contains("FUNCTION \"DEMO\".\"ORDER_TOTAL\""), "{func}");
        let pkg = mgr
            .ddl("ora", &obj(NodeKind::Package, "PKG_SHOP"))
            .await
            .unwrap();
        assert!(pkg.contains("PACKAGE \"DEMO\".\"PKG_SHOP\""), "{pkg}");
        assert!(pkg.contains("PACKAGE BODY \"DEMO\".\"PKG_SHOP\""), "{pkg}");
        let member = ObjectRef {
            table: Some("PKG_SHOP".into()),
            ..obj(NodeKind::Function, "WITH_VAT")
        };
        assert!(mgr
            .ddl("ora", &member)
            .await
            .unwrap()
            .contains("PACKAGE BODY"));
        let trg = mgr
            .ddl("ora", &obj(NodeKind::Trigger, "TRG_PRODUCTS_TOUCH"))
            .await
            .unwrap();
        assert!(
            trg.contains("TRIGGER \"DEMO\".\"TRG_PRODUCTS_TOUCH\""),
            "{trg}"
        );
        let syn = mgr
            .ddl("ora", &obj(NodeKind::Synonym, "SYN_PRODUCTS"))
            .await
            .unwrap();
        assert!(
            syn.contains("SYNONYM \"DEMO\".\"SYN_PRODUCTS\" FOR \"DEMO\".\"PRODUCTS\""),
            "{syn}"
        );
        let idx = mgr
            .ddl("ora", &obj(NodeKind::Index, "IDX_PRODUCTS_CATEGORY"))
            .await
            .unwrap();
        assert!(
            idx.starts_with("CREATE INDEX \"DEMO\".\"IDX_PRODUCTS_CATEGORY\""),
            "{idx}"
        );
        // a column / key shows the DDL of its table
        let col = ObjectRef {
            table: Some("PRODUCTS".into()),
            ..obj(NodeKind::Column, "SKU")
        };
        assert!(mgr
            .ddl("ora", &col)
            .await
            .unwrap()
            .starts_with("CREATE TABLE"));
        assert!(mgr
            .ddl("ora", &obj(NodeKind::Table, "NO_SUCH_TABLE"))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn table_data_paging_and_locators() {
        let (_cfg, mgr) = setup!();
        let products = ObjectRef::table(Some("DEMO"), "PRODUCTS");
        let rs = mgr
            .table_data(
                "ora",
                &products,
                &TableDataRequest {
                    order_by: Some("id".into()),
                    offset: 5,
                    limit: 5,
                    count_total: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            (rs.rows.len(), rs.has_more, rs.total_hint),
            (5, true, Some(20))
        );
        assert_eq!(txt(&rs.rows[0][0]), "6");
        assert_eq!(rs.columns.len(), 9);
        assert_eq!(
            (
                rs.columns[0].is_pk,
                rs.columns[0].nullable,
                rs.columns[0].table_ref.as_deref()
            ),
            (true, false, Some("DEMO.PRODUCTS"))
        );
        assert!(rs.row_locators.is_none());
        let last = mgr
            .table_data(
                "ora",
                &products,
                &TableDataRequest {
                    order_by: Some("id".into()),
                    offset: 15,
                    limit: 5,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!((last.rows.len(), last.has_more), (5, false));
        let w = mgr
            .table_data(
                "ora",
                &products,
                &TableDataRequest {
                    where_clause: Some("price > 50 and category_id = 2".into()),
                    limit: 100,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(!w.rows.is_empty());
        let none = mgr
            .table_data(
                "ora",
                &products,
                &TableDataRequest {
                    where_clause: Some("1 = 0".into()),
                    limit: 10,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(none.rows.is_empty() && none.columns.len() == 9);
        // a second statement in the where clause is refused
        assert!(mgr
            .table_data(
                "ora",
                &products,
                &TableDataRequest {
                    where_clause: Some("1 = 1; drop table products".into()),
                    ..Default::default()
                },
            )
            .await
            .is_err());
        // a table without a key: hidden ROWID locators, not part of the columns
        let nopk = ObjectRef::table(Some("DEMO"), "NO_PK_TABLE");
        let rs = mgr
            .table_data(
                "ora",
                &nopk,
                &TableDataRequest {
                    order_by: Some("a".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!((rs.columns.len(), rs.rows.len()), (2, 3));
        let locs = rs.row_locators.expect("locators");
        assert_eq!(locs.len(), 3);
        assert!(locs[0].as_str().is_some_and(|l| l.len() == 18), "{locs:?}");
        assert_ne!(locs[1], locs[2]);
        // a view has no key and no ROWID: plain data
        let v = mgr
            .table_data(
                "ora",
                &ObjectRef {
                    kind: NodeKind::View,
                    ..ObjectRef::table(Some("DEMO"), "V_ORDER_TOTALS")
                },
                &TableDataRequest::default(),
            )
            .await
            .unwrap();
        assert!(v.row_locators.is_none() && v.rows.len() == 30);
        // identifiers with odd case need their quotes
        assert!(mgr
            .table_data(
                "ora",
                &ObjectRef::table(Some("DEMO"), "products"),
                &TableDataRequest::default()
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn edit_rows_of_every_type() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        assert_ok(
            &run(
                &mgr,
                &s,
                "begin execute immediate 'drop table b_edit purge'; exception when others then null; end;\n/\n\
                 create table b_edit (id number generated by default as identity primary key, name varchar2(100), qty number, \
                 bin blob, ts timestamp(3), d date, tz timestamp with time zone, flag number(1) default 1, price number(10,2), notes clob)",
            )
            .await,
        );
        let t = ObjectRef::table(Some("DEMO"), "B_EDIT");
        let r = mgr
            .apply_changes(
                "ora",
                &t,
                &[
                    change(ChangeKind::Insert, json!({}), json!({"NAME": "O'Reilly", "QTY": 3, "BIN": {"$bin": "cafe"}, "TS": "2024-01-01 10:00:00.123", "D": "2024-02-29", "TZ": "2024-01-01 10:00:00 +02:00", "FLAG": false, "PRICE": "12.50", "NOTES": "a\nb"})),
                    change(ChangeKind::Insert, json!({}), json!({"NAME": "second", "FLAG": {"$default": true}})),
                    change(ChangeKind::Insert, json!({}), json!({"NAME": "x'); drop table b_edit; --"})),
                ],
            )
            .await
            .unwrap();
        assert!(r.committed, "{r:?}");
        let sel = |extra: &str| format!("select * from demo.b_edit {extra} order by id");
        let ev = run(&mgr, &s, &sel("")).await;
        let (_c, rows, _) = first_rs(&ev);
        assert_eq!(rows.len(), 3, "{ev:#?}");
        assert_eq!(rows[0][1], json!("O'Reilly"));
        assert_eq!(txt(&rows[0][2]), "3");
        assert_eq!(txt(&rows[0][7]), "0");
        assert_eq!(txt(&rows[1][7]), "1");
        assert_eq!(txt(&rows[0][8]), "12.5");
        assert_eq!(rows[0][9], json!("a\nb"));
        assert!(
            txt(&rows[0][5]).starts_with("2024-02-29"),
            "{:?}",
            rows[0][5]
        );
        assert!(
            txt(&rows[0][4]).starts_with("2024-01-01 10:00:00.123"),
            "{:?}",
            rows[0][4]
        );
        // the driver hands time zone values over as the UTC instant: 10:00 at +02:00 is 08:00 UTC
        assert!(txt(&rows[0][6]).contains("08:00:00"), "{:?}", rows[0][6]);
        // update by key: the original values identify the row (LOB and date columns included)
        let id1 = txt(&rows[0][0]);
        let r = mgr
            .apply_changes(
                "ora",
                &t,
                &[change(ChangeKind::Update, json!({"ID": id1}), json!({"NAME": "changed", "D": "2025-12-31 23:59:59", "TS": "2025-12-31 23:59:59.5"}))],
            )
            .await
            .unwrap();
        assert!(r.committed, "{r:?}");
        let ev = run(&mgr, &s, "select name, to_char(d, 'YYYY-MM-DD HH24:MI:SS'), to_char(ts, 'YYYY-MM-DD HH24:MI:SS.FF1') from demo.b_edit where id = (select min(id) from demo.b_edit)").await;
        let (_c, rows, _) = first_rs(&ev);
        assert_eq!(
            rows[0],
            vec![
                json!("changed"),
                json!("2025-12-31 23:59:59"),
                json!("2025-12-31 23:59:59.5")
            ]
        );
        // updating a missing row fails and rolls the whole batch back
        let r = mgr
            .apply_changes(
                "ora",
                &t,
                &[change(
                    ChangeKind::Update,
                    json!({"ID": 999999}),
                    json!({"NAME": "ghost"}),
                )],
            )
            .await
            .unwrap();
        assert!(!r.committed);
        assert!(
            r.first_error()
                .unwrap()
                .error
                .as_deref()
                .unwrap()
                .contains("No row matched"),
            "{r:?}"
        );
        let ev = run(
            &mgr,
            &s,
            "select count(*) from demo.b_edit where name = 'ghost'",
        )
        .await;
        assert_eq!(txt(&scalar(&ev)), "0");
        // an invalid date is refused before anything runs
        let err = mgr
            .apply_changes(
                "ora",
                &t,
                &[change(
                    ChangeKind::Insert,
                    json!({}),
                    json!({"D": "yesterday"}),
                )],
            )
            .await;
        assert!(err.is_err(), "{err:?}");
        // delete
        let r = mgr
            .apply_changes(
                "ora",
                &t,
                &[change(
                    ChangeKind::Delete,
                    json!({"ID": txt(&rows_id(&mgr, &s).await)}),
                    json!({}),
                )],
            )
            .await
            .unwrap();
        assert!(r.committed, "{r:?}");
        let ev = run(&mgr, &s, "select count(*) from demo.b_edit").await;
        assert_eq!(txt(&scalar(&ev)), "2");
        assert_ok(&run(&mgr, &s, "drop table b_edit purge").await);
        mgr.close_session(&s).await;
    }

    async fn rows_id(mgr: &ConnectionManager, s: &SessionId) -> Value {
        let ev = run(mgr, s, "select max(id) from demo.b_edit").await;
        scalar(&ev)
    }

    #[tokio::test]
    async fn keyless_tables_change_exactly_one_row() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        assert_ok(
            &run(
                &mgr,
                &s,
                "begin execute immediate 'drop table b_nopk purge'; exception when others then null; end;\n/\n\
                 create table b_nopk (a number, b varchar2(20), c clob);\n\
                 insert into b_nopk values (1, 'dup', 'x');\ninsert into b_nopk values (1, 'dup', 'x');\n\
                 insert into b_nopk values (2, null, null);\ncommit",
            )
            .await,
        );
        let t = ObjectRef::table(Some("DEMO"), "B_NOPK");
        let count = |w: &'static str| {
            let mgr = &mgr;
            let s = &s;
            async move {
                let ev = run(mgr, s, &format!("select count(*) from demo.b_nopk {w}")).await;
                txt(&scalar(&ev))
            }
        };
        // key without a locator: duplicates exist, only one row goes
        let r = mgr
            .apply_changes(
                "ora",
                &t,
                &[change(
                    ChangeKind::Delete,
                    json!({"A": 1, "B": "dup", "C": "x"}),
                    json!({}),
                )],
            )
            .await
            .unwrap();
        assert!(r.committed, "{r:?}");
        assert_eq!(count("").await, "2");
        // NULLs in the key
        let r = mgr
            .apply_changes(
                "ora",
                &t,
                &[change(
                    ChangeKind::Update,
                    json!({"A": 2, "B": null, "C": null}),
                    json!({"B": "set"}),
                )],
            )
            .await
            .unwrap();
        assert!(r.committed, "{r:?}");
        assert_eq!(count("where b = 'set'").await, "1");
        // with the ROWID locator of the grid
        let rs = mgr
            .table_data(
                "ora",
                &t,
                &TableDataRequest {
                    order_by: Some("a".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let locs = rs.row_locators.unwrap();
        let mut ch = change(ChangeKind::Delete, json!({}), json!({}));
        ch.row_locator = Some(locs[1].clone());
        let r = mgr.apply_changes("ora", &t, &[ch]).await.unwrap();
        assert!(r.committed, "{r:?}");
        assert_eq!(count("where a = 2").await, "0");
        assert_eq!(count("").await, "1");
        assert_ok(&run(&mgr, &s, "drop table b_nopk purge").await);
        mgr.close_session(&s).await;
    }

    #[tokio::test]
    async fn script_splitting_runs_plsql_units() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let ev = run(
            &mgr,
            &s,
            "begin execute immediate 'drop table b_plsql purge'; exception when others then null; end;\n/\n\
             create table b_plsql (n number);\n\
             create or replace procedure b_fill(p_n in number) is\nbegin\n  for i in 1..p_n loop\n    insert into b_plsql values (i);\n  end loop;\nend b_fill;\n/\n\
             begin b_fill(5); end;\n/\n\
             select count(*) from b_plsql;\n\
             declare v number; begin select count(*) into v from b_plsql; if v <> 5 then raise_application_error(-20001, 'bad'); end if; end;\n\
             select sum(n) from b_plsql",
        )
        .await;
        assert_ok(&ev);
        let sets: Vec<_> = ev
            .iter()
            .filter_map(|e| match e {
                ExecEvent::ResultSet { rows, .. } => Some(txt(&rows[0][0])),
                _ => None,
            })
            .collect();
        assert_eq!(sets, ["5", "15"]);
        let ev = run(
            &mgr,
            &s,
            "begin raise_application_error(-20001, 'boom'); end;",
        )
        .await;
        assert!(errors(&ev)[0].contains("boom"), "{:?}", errors(&ev));
        assert_ok(&run(&mgr, &s, "drop procedure b_fill; drop table b_plsql purge").await);
        mgr.close_session(&s).await;
    }

    #[tokio::test]
    async fn export_round_trips_through_the_server() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let mut buf: Vec<u8> = Vec::new();
        let n = mgr
            .export_query(
                "ora",
                "select id, name, amount, created from demo.big_table where id <= 1000 order by id",
                &ExportOptions::default(),
                &mut buf,
            )
            .await
            .unwrap();
        assert_eq!(n, 1000);
        let text = String::from_utf8(buf).unwrap();
        assert_eq!(text.lines().next().unwrap(), "ID,NAME,AMOUNT,CREATED");
        assert!(
            text.lines()
                .nth(1)
                .unwrap()
                .starts_with("1,name-1,1.37,2024-01-01 00:01:00"),
            "{}",
            text.lines().nth(1).unwrap()
        );

        // INSERT scripts of every type run back as they are
        assert_ok(
            &run(
                &mgr,
                &s,
                "begin execute immediate 'drop table b_copy purge'; exception when others then null; end;\n/\n\
                 create table b_copy as select * from demo.all_types where 1 = 0",
            )
            .await,
        );
        for per in [1usize, 5] {
            let mut buf: Vec<u8> = Vec::new();
            mgr.export_query(
                "ora",
                "select * from demo.all_types order by id",
                &ExportOptions {
                    format: ExportFormat::SqlInsert,
                    dialect: Driver::Oracle,
                    table_name: Some("DEMO.B_COPY".into()),
                    rows_per_insert: per,
                    ..Default::default()
                },
                &mut buf,
            )
            .await
            .unwrap();
            let script = String::from_utf8(buf).unwrap();
            assert_ok(&run(&mgr, &s, &format!("delete from demo.b_copy;\n{script}")).await);
            let ev = run(
                &mgr,
                &s,
                "with cols as (select id, c_number, c_number_ps, c_integer, c_float, c_bin_float, c_bin_double, c_char, \
                 c_varchar, c_nchar, c_nvarchar, c_raw, c_date, c_ts, c_tstz, c_tsltz, c_iv_ym, c_iv_ds \
                 from demo.all_types) \
                 select count(*) from (select * from cols minus select id, c_number, c_number_ps, c_integer, c_float, \
                 c_bin_float, c_bin_double, c_char, c_varchar, c_nchar, c_nvarchar, c_raw, c_date, c_ts, c_tstz, c_tsltz, \
                 c_iv_ym, c_iv_ds from demo.b_copy) union all \
                 select count(*) from demo.b_copy union all \
                 select count(*) from demo.all_types a join demo.b_copy b on a.id = b.id \
                 where dbms_lob.compare(a.c_clob, b.c_clob) = 0 and dbms_lob.compare(a.c_nclob, b.c_nclob) = 0 \
                 and dbms_lob.compare(a.c_blob, b.c_blob) = 0",
            )
            .await;
            let (_c, rows, _) = first_rs(&ev);
            assert_eq!(
                (txt(&rows[0][0]), txt(&rows[1][0]), txt(&rows[2][0])),
                ("0".into(), "2".into(), "1".into()),
                "{script}"
            );
        }
        assert_ok(&run(&mgr, &s, "drop table b_copy purge").await);
        // UPDATE and WHERE scripts
        let mut buf: Vec<u8> = Vec::new();
        mgr.export_query(
            "ora",
            "select id, name, created from demo.big_table where id <= 2 order by id",
            &ExportOptions {
                format: ExportFormat::SqlUpdate,
                dialect: Driver::Oracle,
                table_name: Some("DEMO.BIG_TABLE".into()),
                ..Default::default()
            },
            &mut buf,
        )
        .await
        .unwrap();
        let upd = String::from_utf8(buf).unwrap();
        // a result without key information: every column identifies the row
        assert!(
            upd.starts_with(
                "update DEMO.BIG_TABLE set ID = 1, NAME = 'name-1', CREATED = TO_TIMESTAMP("
            ),
            "{upd}"
        );
        assert!(
            upd.lines()
                .next()
                .unwrap()
                .contains(" where ID = 1 and NAME = 'name-1' and CREATED = TO_TIMESTAMP("),
            "{upd}"
        );
        assert_ok(&run(&mgr, &s, &upd).await);
        mgr.close_session(&s).await;
    }

    #[tokio::test]
    async fn explain_plan_tree() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let sql = "select o.id, c.name from orders o join customers c on c.id = o.customer_id where o.status = 'new' order by o.id";
        let plan = mgr.explain(&s, sql, false).await.unwrap();
        assert_eq!(plan.driver, Driver::Oracle);
        assert_eq!(plan.root.operation, "Select");
        assert!(plan.root.total_cost.is_some(), "{plan:#?}");
        fn walk(n: &PlanNode, out: &mut Vec<String>) {
            out.push(format!("{} {}", n.operation, n.params));
            n.children.iter().for_each(|c| walk(c, out));
        }
        let mut ops = Vec::new();
        walk(&plan.root, &mut ops);
        assert!(
            ops.iter().any(|o| o.starts_with("SORT ORDER BY")),
            "{ops:?}"
        );
        assert!(
            ops.iter().any(|o| o.contains("table: DEMO.ORDERS;")),
            "{ops:?}"
        );
        assert!(
            ops.iter().any(|o| o.contains("table: DEMO.CUSTOMERS;")),
            "{ops:?}"
        );
        // DML works too, and nothing is left in PLAN_TABLE
        let dml = mgr
            .explain(&s, "update products set stock = 0 where id = 1", false)
            .await
            .unwrap();
        assert_eq!(dml.root.operation, "Update");
        let ev = run(&mgr, &s, "select count(*) from plan_table").await;
        assert_eq!(txt(&scalar(&ev)), "0");
        // errors come back as errors
        assert!(mgr
            .explain(&s, "select * from no_such_table_x", false)
            .await
            .is_err());
        assert!(mgr.explain(&s, sql, true).await.is_err());
        mgr.close_session(&s).await;
    }

    /// EXPLAIN PLAN writes into PLAN_TABLE: the session must end up as it was (no transaction, or the user's own).
    #[tokio::test]
    async fn explain_leaves_the_transaction_state_alone() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let auto = ExecOptions {
            auto_commit: true,
            ..Default::default()
        };
        let _ = mgr
            .execute_collect(&s, "drop table fxb_explain purge", auto.clone())
            .await;
        assert_ok(
            &mgr.execute_collect(&s, "create table fxb_explain (id number)", auto.clone())
                .await
                .unwrap(),
        );
        // idle console in Auto mode: nothing open afterwards
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        mgr.explain(&s, "select * from fxb_explain", false)
            .await
            .unwrap();
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        assert!(!mgr.session_in_transaction(&s).unwrap());
        // a failing explain leaves nothing open either
        assert!(mgr
            .explain(&s, "select * from no_such_t_x", false)
            .await
            .is_err());
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        // the user's open transaction is untouched: still open, its row still there
        assert_ok(&run(&mgr, &s, "insert into fxb_explain values (7)").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        mgr.explain(&s, "select * from fxb_explain where id = 7", false)
            .await
            .unwrap();
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        assert_eq!(
            txt(&scalar(
                &run(&mgr, &s, "select count(*) from fxb_explain").await
            )),
            "1"
        );
        assert_eq!(
            txt(&scalar(
                &run(&mgr, &s, "select count(*) from plan_table").await
            )),
            "0"
        );
        assert_ok(&run(&mgr, &s, "rollback").await);
        assert_eq!(
            txt(&scalar(
                &run(&mgr, &s, "select count(*) from fxb_explain").await
            )),
            "0"
        );
        assert_ok(&run(&mgr, &s, "drop table fxb_explain purge").await);
        mgr.close_session(&s).await;
    }

    /// A batch mixing short texts with texts over 2000 bytes (CLOB expressions) must go in as one statement.
    #[tokio::test]
    async fn import_batches_mixing_short_and_long_text() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        assert_ok(&run(&mgr, &s, "begin execute immediate 'drop table fxb_imp_clob purge'; exception when others then null; end;").await);
        assert_ok(
            &run(
                &mgr,
                &s,
                "create table fxb_imp_clob (id number, body clob, note varchar2(50))",
            )
            .await,
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("in.csv");
        let long = "x".repeat(2500);
        std::fs::write(
            &path,
            format!("id,body,note\n1,short,a\n2,{long},\n3,,c\n4,\"é\",d\n"),
        )
        .unwrap();
        let col = |name: &str, i: usize, ty: &str| json!({"name": name, "source": i, "type": ty});
        let req: ImportRequest = serde_json::from_value(json!({
            "path": path,
            "schema": "DEMO",
            "table": "FXB_IMP_CLOB",
            "createTable": false,
            "columns": [col("ID", 0, "number"), col("BODY", 1, "clob"), col("NOTE", 2, "varchar2(50)")],
            "options": {"batchSize": 100},
        }))
        .unwrap();
        let r = mgr
            .import_file("ora", &req, &CancellationToken::new(), &|_| {})
            .await
            .unwrap();
        assert_eq!((r.imported, r.failed), (4, 0), "{r:?}");
        let ev = run(
            &mgr,
            &s,
            "select id, length(body), dbms_lob.substr(body, 5, 1) from fxb_imp_clob order by id",
        )
        .await;
        let (_c, rows, _) = first_rs(&ev);
        let got: Vec<_> = rows
            .iter()
            .map(|r| (txt(&r[0]), txt(&r[1]), txt(&r[2])))
            .collect();
        assert_eq!(
            got,
            [
                ("1".into(), "5".into(), "short".into()),
                ("2".into(), "2500".into(), "xxxxx".into()),
                ("3".into(), "NULL".into(), "NULL".into()),
                ("4".into(), "1".into(), "é".into()),
            ]
        );
        assert_ok(&run(&mgr, &s, "drop table fxb_imp_clob purge").await);
        mgr.close_session(&s).await;
    }

    #[tokio::test]
    async fn import_csv_creates_and_fills_a_table() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        assert_ok(&run(&mgr, &s, "begin execute immediate 'drop table b_imp purge'; exception when others then null; end;").await);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("in.csv");
        let mut csv = String::from("id,name,born,seen,score,flag\n");
        for i in 1..=450 {
            csv.push_str(&format!(
                "{i},\"n'{i}\",2020-01-{:02},2024-02-29 13:45:10.25,{}.5,{}\n",
                1 + i % 28,
                i,
                i % 2 == 0
            ));
        }
        csv.push_str("x,bad,2020-01-01,2024-02-29 13:45:10,1,true\n");
        std::fs::write(&path, csv).unwrap();
        let mk = |table: &str, create: bool, options: Value| -> ImportRequest {
            let col =
                |name: &str, i: usize, ty: &str| json!({"name": name, "source": i, "type": ty});
            serde_json::from_value(json!({
                "path": path,
                "schema": "DEMO",
                "table": table,
                "createTable": create,
                "columns": [
                    col("ID", 0, "number(10)"),
                    col("NAME", 1, "varchar2(4000)"),
                    col("BORN", 2, "date"),
                    col("SEEN", 3, "timestamp"),
                    col("SCORE", 4, "binary_double"),
                    col("FLAG", 5, "number(1)"),
                ],
                "options": options,
            }))
            .unwrap()
        };
        let req = mk("B_IMP", true, json!({"batchSize": 100}));
        let r = mgr
            .import_file("ora", &req, &CancellationToken::new(), &|_| {})
            .await
            .unwrap();
        assert_eq!(
            (r.imported, r.failed, r.created_table, r.rolled_back),
            (450, 1, true, false),
            "{r:?}"
        );
        assert_eq!(r.errors[0].row, 452, "{r:?}");
        let ev = run(
            &mgr,
            &s,
            "select count(*), sum(flag), min(seen), max(born), max(name) from demo.b_imp",
        )
        .await;
        let (_c, rows, _) = first_rs(&ev);
        assert_eq!(txt(&rows[0][0]), "450");
        assert_eq!(txt(&rows[0][1]), "225");
        assert!(
            txt(&rows[0][2]).starts_with("2024-02-29 13:45:10.25"),
            "{:?}",
            rows[0][2]
        );
        // into the existing table; abort on error rolls back and keeps the table
        let req2 = mk("B_IMP", false, json!({"abortOnError": true}));
        let r = mgr
            .import_file("ora", &req2, &CancellationToken::new(), &|_| {})
            .await
            .unwrap();
        assert!(r.rolled_back && r.imported == 0 && r.failed == 1, "{r:?}");
        let ev = run(&mgr, &s, "select count(*) from demo.b_imp").await;
        assert_eq!(txt(&scalar(&ev)), "450");
        // a new table that aborts is dropped again (Oracle commits DDL at once)
        let req3 = mk("B_IMP2", true, json!({"abortOnError": true}));
        let r = mgr
            .import_file("ora", &req3, &CancellationToken::new(), &|_| {})
            .await
            .unwrap();
        assert!(r.rolled_back && !r.created_table, "{r:?}");
        let ev = run(
            &mgr,
            &s,
            "select count(*) from user_tables where table_name = 'B_IMP2'",
        )
        .await;
        assert_eq!(txt(&scalar(&ev)), "0");
        assert_ok(&run(&mgr, &s, "drop table b_imp purge").await);
        mgr.close_session(&s).await;
    }
}

/// Runtime: connection, sessions, streaming and paging, cancel, value decoding, errors, transactions, read-only,
/// DBMS_OUTPUT, keep alive. Scratch tables are prefixed `A_RT_`.
mod runtime {
    use super::*;
    use std::time::{Duration, Instant};

    macro_rules! setup {
        () => {{
            let Some(cfg) = oracle_cfg() else {
                eprintln!("PROMETEO_ORACLE_URL not set: skipping");
                return;
            };
            let mgr = connected(&cfg).await;
            (cfg, mgr)
        }};
    }

    /// A cell as text: NUMBER may arrive as a JSON number or, when it would lose digits, as a string.
    fn txt(v: &Value) -> String {
        match v {
            Value::String(s) => s.clone(),
            Value::Null => "NULL".into(),
            other => other.to_string(),
        }
    }

    fn auto() -> ExecOptions {
        ExecOptions {
            auto_commit: true,
            ..Default::default()
        }
    }

    async fn run_auto(mgr: &ConnectionManager, s: &SessionId, sql: &str) -> Vec<ExecEvent> {
        mgr.execute_collect(s, sql, auto()).await.expect("execute")
    }

    fn messages(ev: &[ExecEvent]) -> Vec<String> {
        ev.iter()
            .filter_map(|e| match e {
                ExecEvent::Message { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn connection_test_and_probe() {
        let (cfg, mgr) = setup!();
        let r = mgr.test_connection(&cfg).await;
        assert!(r.ok, "{}", r.message);
        let v = r.server_version.unwrap();
        assert!(v.starts_with("Oracle"), "{v}");
        assert!(r.message.starts_with("Succeeded. Oracle"), "{}", r.message);
        assert_eq!(r.ssl, None, "ssl does not apply");
        assert_eq!(mgr.server_version("ora").unwrap(), v);
        assert_eq!(mgr.driver("ora").unwrap(), Driver::Oracle);

        let mut bad = cfg.clone();
        bad.password = Some("wrong".into());
        let r = mgr.test_connection(&bad).await;
        assert!(!r.ok && r.message.contains("ORA-01017"), "{}", r.message);

        let mut nosvc = cfg.clone();
        nosvc.database = "NOPE_SERVICE".into();
        let r = mgr.test_connection(&nosvc).await;
        assert!(!r.ok && r.message.contains("ORA-"), "{}", r.message);

        let mut nohost = cfg.clone();
        nohost.port = 1;
        nohost.options.insert("connectTimeout".into(), "3".into());
        let r = mgr.test_connection(&nohost).await;
        assert!(!r.ok, "{}", r.message);

        // the URL forms
        let mut by_url = cfg.clone();
        by_url.host = String::new();
        by_url.database = String::new();
        by_url.url_override = Some(format!(
            "jdbc:oracle:thin:@//{}:{}/FREEPDB1",
            cfg.host, cfg.port
        ));
        let r = mgr.test_connection(&by_url).await;
        assert!(r.ok, "{}", r.message);
    }

    #[tokio::test]
    async fn session_basics_and_current_schema() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let ev = run(
            &mgr,
            &s,
            "select user, sys_context('userenv','current_schema'), sys_context('userenv','sid') from dual",
        )
        .await;
        assert_ok(&ev);
        let (cols, rows, more) = first_rs(&ev);
        assert!(!more);
        assert_eq!(rows[0][0], json!("DEMO"));
        assert_eq!(rows[0][1], json!("DEMO"));
        assert!(
            cols[0].type_name.starts_with("VARCHAR2("),
            "{}",
            cols[0].type_name
        );
        // schema switch: does not open a transaction
        let ev = run(&mgr, &s, "alter session set current_schema = \"SYSTEM\"").await;
        assert_ok(&ev);
        assert!(tx_statuses(&ev).is_empty());
        let ev = run(
            &mgr,
            &s,
            "select sys_context('userenv','current_schema') from dual",
        )
        .await;
        assert_eq!(scalar(&ev), json!("SYSTEM"));
        // a second session has its own schema and sid
        let t = mgr.open_session("ora").await.unwrap();
        let ev = run(
            &mgr,
            &t,
            "select sys_context('userenv','current_schema') from dual",
        )
        .await;
        assert_eq!(scalar(&ev), json!("DEMO"));
        // init statements run on the new connection
        let u = mgr
            .open_session_with(
                "ora",
                &["alter session set current_schema = SYSTEM".to_string()],
            )
            .await
            .unwrap();
        let ev = run(
            &mgr,
            &u,
            "select sys_context('userenv','current_schema') from dual",
        )
        .await;
        assert_eq!(scalar(&ev), json!("SYSTEM"));
        assert!(mgr
            .open_session_with("ora", &["select * from a_rt_nope".to_string()])
            .await
            .is_err());
        for x in [s, t, u] {
            mgr.close_session(&x).await;
        }
    }

    #[tokio::test]
    async fn value_decoding_and_real_types() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let _ = run_auto(&mgr, &s, "drop table a_rt_types purge").await;
        let ev = run_auto(
            &mgr,
            &s,
            "create table a_rt_types (id number primary key, n number(10,2), f float, bd binary_double, bf binary_float, \
             v varchar2(50), c char(5), nv nvarchar2(20), d date, ts timestamp(6), tstz timestamp(6) with time zone, \
             tsl timestamp with local time zone, cl clob, bl blob, r raw(8), ids interval day(2) to second(3), \
             iym interval year(3) to month, big number, flag number(1))",
        )
        .await;
        assert_ok(&ev);
        let ev = run_auto(
            &mgr,
            &s,
            "insert into a_rt_types values (1, 12.34, 1.5, 2.5, 3.5, 'héllo', 'ab', 'nv', date '2024-03-05', \
             timestamp '2024-03-05 10:11:12.123456', timestamp '2024-03-05 10:11:12.5 +02:00', timestamp '2024-03-05 10:11:12', \
             to_clob('clobtext'), utl_raw.cast_to_raw('blob'), hextoraw('DEADBEEF'), interval '1 02:03:04.5' day to second, \
             interval '1-2' year to month, 12345678901234567890123, 1)",
        )
        .await;
        assert_ok(&ev);
        assert!(
            matches!(
                &ev[1],
                ExecEvent::Update {
                    rows_affected: 1,
                    ..
                }
            ),
            "{ev:?}"
        );
        assert_ok(&run_auto(&mgr, &s, "insert into a_rt_types (id) values (2)").await);

        let ev = run(&mgr, &s, "select * from a_rt_types order by id").await;
        assert_ok(&ev);
        let (cols, rows, _) = first_rs(&ev);
        let types: Vec<(&str, &str)> = cols
            .iter()
            .map(|c| (c.name.as_str(), c.type_name.as_str()))
            .collect();
        let t = |name: &str| types.iter().find(|(n, _)| *n == name).unwrap().1;
        assert_eq!(t("ID"), "NUMBER");
        assert_eq!(t("N"), "NUMBER(10,2)");
        assert_eq!(t("BD"), "BINARY_DOUBLE");
        assert_eq!(t("BF"), "BINARY_FLOAT");
        assert_eq!(t("V"), "VARCHAR2(50)");
        assert_eq!(t("C"), "CHAR(5)");
        assert_eq!(t("D"), "DATE");
        assert_eq!(t("TS"), "TIMESTAMP(6)");
        assert_eq!(t("TSTZ"), "TIMESTAMP(6) WITH TIME ZONE");
        assert_eq!(t("TSL"), "TIMESTAMP(6) WITH LOCAL TIME ZONE");
        assert_eq!(t("CL"), "CLOB", "CLOB must not show as LONG");
        assert_eq!(t("BL"), "BLOB", "BLOB must not show as LONG RAW");
        assert_eq!(t("R"), "RAW(8)");
        assert!(t("IDS").starts_with("INTERVAL DAY"), "{}", t("IDS"));
        assert!(t("IYM").starts_with("INTERVAL YEAR"), "{}", t("IYM"));
        assert!(!cols[0].nullable && cols[1].nullable);

        let r = &rows[0];
        let col = |name: &str| cols.iter().position(|c| c.name == name).unwrap();
        // NUMBER: a JSON number when exact, the exact text when digits would be lost
        assert_eq!(r[col("ID")], json!(1));
        assert_eq!(r[col("N")], json!(12.34));
        assert_eq!(r[col("BIG")], json!("12345678901234567890123"));
        assert_eq!(r[col("F")], json!(1.5));
        assert_eq!(r[col("BD")], json!(2.5));
        assert_eq!(r[col("BF")], json!(3.5));
        assert_eq!(r[col("V")], json!("héllo"));
        assert_eq!(r[col("C")], json!("ab   "));
        assert_eq!(r[col("NV")], json!("nv"));
        assert_eq!(r[col("D")], json!("2024-03-05 00:00:00"));
        assert_eq!(r[col("TS")], json!("2024-03-05 10:11:12.123456"));
        assert_eq!(r[col("TSTZ")], json!("2024-03-05 08:11:12.500000 +00:00"));
        assert_eq!(r[col("CL")], json!("clobtext"));
        assert_eq!(r[col("BL")]["$bin"], json!("626c6f62"));
        assert_eq!(r[col("BL")]["len"], json!(4));
        assert_eq!(r[col("R")]["$bin"], json!("deadbeef"));
        assert_eq!(r[col("IDS")], json!("+01 02:03:04.500"));
        assert_eq!(r[col("IYM")], json!("+01-02"));
        assert!(rows[1].iter().skip(1).all(Value::is_null), "{:?}", rows[1]);

        // expression columns, the 2^53 boundary and BOOLEAN (23ai)
        let ev = run(
            &mgr,
            &s,
            "select 1 a, 0.1 b, -5 c, 9007199254740992 d, 9007199254740993 e, 1/3 f, 'x' g, to_char(1) h, null i, true j from dual",
        )
        .await;
        assert_ok(&ev);
        let (cols, rows, _) = first_rs(&ev);
        assert_eq!(rows[0][0], json!(1));
        assert_eq!(rows[0][1], json!(0.1));
        assert_eq!(rows[0][2], json!(-5));
        assert_eq!(rows[0][3], json!(9007199254740992i64));
        assert_eq!(rows[0][4], json!("9007199254740993"));
        assert_eq!(
            rows[0][5],
            json!("0.3333333333333333333333333333333333333333")
        );
        assert_eq!(rows[0][6], json!("x"));
        assert!(rows[0][8].is_null());
        assert_eq!(rows[0][9], json!(true));
        assert_eq!(cols[9].type_name, "BOOLEAN");

        // an empty result still has its columns
        let ev = run(&mgr, &s, "select id, v from a_rt_types where 1 = 0").await;
        assert_ok(&ev);
        let (cols, rows, more) = first_rs(&ev);
        assert!(rows.is_empty() && !more);
        assert_eq!(names_of(&cols), ["ID", "V"]);

        let _ = run_auto(&mgr, &s, "drop table a_rt_types purge").await;
        mgr.close_session(&s).await;
    }

    fn names_of(cols: &[ColumnMeta]) -> Vec<String> {
        cols.iter().map(|c| c.name.clone()).collect()
    }

    #[tokio::test]
    async fn streaming_paging_and_fetch_more() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let sql = "select level n, 'row ' || level t from dual connect by level <= 2500";
        let mut h = mgr
            .execute(
                &s,
                sql,
                ExecOptions {
                    max_rows: 1000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let ev = wait_done(&mut h).await;
        assert_ok(&ev);
        let (cols, rows, more) = first_rs(&ev);
        assert_eq!(names_of(&cols), ["N", "T"]);
        assert_eq!(rows.len(), 1000);
        assert!(more);
        assert_eq!(rows[999][0], json!(1000));
        // the session is busy paging; fetch the rest
        let page = mgr.fetch_more(&h.id, 0, 1000).await.unwrap();
        assert_eq!(page.rows.len(), 1000);
        assert!(page.has_more);
        assert_eq!(page.rows[0][0], json!(1001));
        let page = mgr.fetch_more(&h.id, 0, 1000).await.unwrap();
        assert_eq!(page.rows.len(), 500);
        assert!(!page.has_more);
        assert_eq!(page.rows[499][1], json!("row 2500"));
        // exhausted: the session is free again
        let ev = run(&mgr, &s, "select 1 from dual").await;
        assert_eq!(scalar(&ev), json!(1));

        // closing a result early frees the session without reading everything
        let t0 = Instant::now();
        let mut h = mgr
            .execute(
                &s,
                "select a.object_id, b.object_name from all_objects a, all_objects b",
                ExecOptions {
                    max_rows: 100,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let ev = wait_done(&mut h).await;
        assert_ok(&ev);
        let (_, rows, more) = first_rs(&ev);
        assert_eq!((rows.len(), more), (100, true));
        mgr.close_execution(&h.id).unwrap();
        let ev = run(&mgr, &s, "select 2 from dual").await;
        assert_eq!(scalar(&ev), json!(2));
        assert!(t0.elapsed() < Duration::from_secs(20), "{:?}", t0.elapsed());

        // several statements, only the last one pages; earlier ones are truncated
        let ev = run_n(
            &mgr,
            &s,
            "select level from dual connect by level <= 10; select level from dual connect by level <= 3",
            5,
        )
        .await;
        assert_ok(&ev);
        let sets: Vec<(usize, bool)> = ev
            .iter()
            .filter_map(|e| match e {
                ExecEvent::ResultSet { rows, has_more, .. } => Some((rows.len(), *has_more)),
                _ => None,
            })
            .collect();
        assert_eq!(sets, vec![(5, false), (3, false)]);
        mgr.close_session(&s).await;
    }

    #[tokio::test]
    async fn cancel_running_statements() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();

        // 1) a call busy on the server (no row yet): the break marker
        let t0 = Instant::now();
        let mut h = mgr
            .execute(
                &s,
                "select count(*) from all_objects a, all_objects b, all_objects c",
                ExecOptions::default(),
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        mgr.cancel(&h.id).unwrap();
        let ev = wait_done(&mut h).await;
        let errs = errors(&ev);
        assert_eq!(errs.len(), 1, "{ev:?}");
        assert!(errs[0].starts_with("ORA-01013"), "{errs:?}");
        assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
        // the connection is still good
        assert_eq!(
            scalar(&run(&mgr, &s, "select 42 from dual").await),
            json!(42)
        );

        // 2) a streaming query that keeps producing rows
        let t0 = Instant::now();
        let mut h = mgr
            .execute(
                &s,
                "select a.object_id, b.object_name from all_objects a, all_objects b",
                ExecOptions {
                    max_rows: 100000000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1000)).await;
        mgr.cancel(&h.id).unwrap();
        let ev = wait_done(&mut h).await;
        assert!(
            errors(&ev).iter().any(|e| e.starts_with("ORA-01013")),
            "{:?}",
            errors(&ev)
        );
        assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
        assert_eq!(
            scalar(&run(&mgr, &s, "select 43 from dual").await),
            json!(43)
        );

        // 3a) inside a transaction closing a big result cancels it (Oracle keeps the transaction)
        let _ = run_auto(&mgr, &s, "drop table a_rt_cx purge").await;
        assert_ok(&run_auto(&mgr, &s, "create table a_rt_cx (id number)").await);
        assert_ok(&run(&mgr, &s, "insert into a_rt_cx values (1)").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        let t0 = Instant::now();
        let mut h = mgr
            .execute(
                &s,
                "select a.object_id from all_objects a, all_objects b",
                ExecOptions {
                    max_rows: 50,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(first_rs(&wait_done(&mut h).await).2);
        mgr.close_execution(&h.id).unwrap();
        assert_eq!(
            scalar(&run(&mgr, &s, "select count(*) from a_rt_cx").await),
            json!(1)
        );
        assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        assert_ok(&run(&mgr, &s, "rollback").await);
        assert_ok(&run_auto(&mgr, &s, "drop table a_rt_cx purge").await);

        // 3) a result held open for paging is cancelled and freed
        let mut h = mgr
            .execute(
                &s,
                "select a.object_id from all_objects a, all_objects b",
                ExecOptions {
                    max_rows: 50,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let ev = wait_done(&mut h).await;
        assert!(first_rs(&ev).2);
        mgr.cancel(&h.id).unwrap();
        let ev = run(&mgr, &s, "select 44 from dual").await;
        assert_eq!(scalar(&ev), json!(44));
        mgr.close_session(&s).await;
    }

    #[tokio::test]
    async fn errors_and_positions() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let ev = run(&mgr, &s, "select * from a_rt_does_not_exist").await;
        let (msg, pos) = ev
            .iter()
            .find_map(|e| match e {
                ExecEvent::Error {
                    message,
                    position,
                    connection_lost,
                    ..
                } => {
                    assert!(!connection_lost);
                    Some((message.clone(), *position))
                }
                _ => None,
            })
            .expect("an error");
        assert!(msg.starts_with("ORA-00942"), "{msg}");
        assert_eq!(pos, Some(15), "position of the table name");
        let ev = run(&mgr, &s, "selec 1 from dual").await;
        assert!(errors(&ev)[0].starts_with("ORA-00900"), "{:?}", errors(&ev));
        // a script stops at the first error by default and continues when asked to
        let ev = run(
            &mgr,
            &s,
            "select 1 from dual; select * from a_rt_nope; select 3 from dual",
        )
        .await;
        assert_eq!(errors(&ev).len(), 1);
        assert_eq!(
            ev.iter()
                .filter(|e| matches!(e, ExecEvent::ResultSet { .. }))
                .count(),
            1
        );
        let ev = mgr
            .execute_collect(
                &s,
                "select 1 from dual; select * from a_rt_nope; select 3 from dual",
                ExecOptions {
                    stop_on_error: false,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(errors(&ev).len(), 1);
        assert_eq!(
            ev.iter()
                .filter(|e| matches!(e, ExecEvent::ResultSet { .. }))
                .count(),
            2
        );
        // constraint violation keeps the session alive
        let _ = run_auto(&mgr, &s, "drop table a_rt_uq purge").await;
        assert_ok(&run_auto(&mgr, &s, "create table a_rt_uq (id number primary key)").await);
        assert_ok(&run_auto(&mgr, &s, "insert into a_rt_uq values (1)").await);
        let ev = run_auto(&mgr, &s, "insert into a_rt_uq values (1)").await;
        assert!(errors(&ev)[0].starts_with("ORA-00001"), "{:?}", errors(&ev));
        assert!(!mgr.session_state(&s).unwrap().connection_lost);
        assert_ok(&run_auto(&mgr, &s, "drop table a_rt_uq purge").await);
        mgr.close_session(&s).await;
    }

    /// Kill the session from another login (SYSTEM) and look at what the app reports.
    #[tokio::test]
    async fn lost_connection() {
        let (cfg, mgr) = setup!();
        let mut sys = cfg.clone();
        sys.id = "ora-system".into();
        sys.user = "system".into();
        sys.password = Some("prometeo".into());
        let admin = ConnectionManager::new();
        if admin.connect(&sys).await.is_err() {
            eprintln!("cannot log in as SYSTEM: skipping");
            return;
        }
        let a = admin.open_session("ora-system").await.unwrap();
        async fn kill(
            admin: &ConnectionManager,
            a: &SessionId,
            mgr: &ConnectionManager,
            s: &SessionId,
        ) {
            let sid = scalar(&run(mgr, s, "select sys_context('userenv','sid') from dual").await);
            let sid = txt(&sid);
            let serial = scalar(
                &run(
                    admin,
                    a,
                    &format!("select serial# from v$session where sid = {sid}"),
                )
                .await,
            );
            let ev = run(
                admin,
                a,
                &format!(
                    "alter system kill session '{sid},{}' immediate",
                    txt(&serial)
                ),
            )
            .await;
            assert_ok(&ev);
        }

        // without a transaction: the next execute reports the loss, the one after reopens
        let s = mgr.open_session("ora").await.unwrap();
        kill(&admin, &a, &mgr, &s).await;
        let ev = run(&mgr, &s, "select 1 from dual").await;
        let lost = ev.iter().any(|e| {
            matches!(
                e,
                ExecEvent::Error {
                    connection_lost: true,
                    ..
                }
            )
        });
        assert!(lost, "{ev:?}");
        assert!(errors(&ev)[0].starts_with("[08006]"), "{:?}", errors(&ev));
        assert!(mgr.session_state(&s).unwrap().connection_lost);
        let ev = run(&mgr, &s, "select 2 from dual").await;
        assert_ok(&ev);
        assert_eq!(scalar(&ev), json!(2));
        assert!(
            messages(&ev).iter().any(|m| m.contains("new connection")),
            "{:?}",
            messages(&ev)
        );

        // with a transaction open: it is gone and the session says so
        let _ = run_auto(&mgr, &s, "drop table a_rt_lost purge").await;
        assert_ok(&run_auto(&mgr, &s, "create table a_rt_lost (id number)").await);
        assert_ok(&run(&mgr, &s, "insert into a_rt_lost values (1)").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        kill(&admin, &a, &mgr, &s).await;
        let ev = run(&mgr, &s, "select 1 from dual").await;
        assert!(
            ev.iter().any(|e| matches!(
                e,
                ExecEvent::Error {
                    connection_lost: true,
                    ..
                }
            )),
            "{ev:?}"
        );
        assert_eq!(tx_ended(&ev), vec![(false, "CONNECTION LOST".to_string())]);
        let st = mgr.session_state(&s).unwrap();
        assert!(st.connection_lost && st.transaction_lost, "{st:?}");
        mgr.close_session(&s).await;

        let t = mgr.open_session("ora").await.unwrap();
        assert_ok(&run_auto(&mgr, &t, "drop table a_rt_lost purge").await);
        mgr.close_session(&t).await;
        admin.close_session(&a).await;
        admin.disconnect("ora-system").await;
    }

    #[tokio::test]
    async fn transactions_manual_auto_and_implicit_commit() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let o = mgr.open_session("ora").await.unwrap();
        let _ = run_auto(&mgr, &s, "drop table a_rt_tx purge").await;
        assert_ok(
            &run(
                &mgr,
                &s,
                "create table a_rt_tx (id number primary key, v varchar2(20))",
            )
            .await,
        );

        // Manual mode: DML opens a transaction (there is no BEGIN)
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        let ev = run(&mgr, &s, "insert into a_rt_tx values (1, 'a')").await;
        assert_ok(&ev);
        assert_eq!(tx_statuses(&ev), vec![TxStatus::Active]);
        assert!(mgr.session_in_transaction(&s).unwrap());
        // not visible to another session before the commit
        assert_eq!(
            scalar(&run(&mgr, &o, "select count(*) from a_rt_tx").await),
            json!(0)
        );
        // a PL/SQL block called BEGIN is not a transaction start, a select does not end it
        assert_ok(&run(&mgr, &s, "begin null; end;").await);
        assert_ok(&run(&mgr, &s, "select * from a_rt_tx").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        let ev = run(&mgr, &s, "commit").await;
        assert_eq!(tx_ended(&ev), vec![(true, "COMMIT".to_string())]);
        assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
        assert_eq!(
            scalar(&run(&mgr, &o, "select count(*) from a_rt_tx").await),
            json!(1)
        );

        // rollback
        assert_ok(&run(&mgr, &s, "insert into a_rt_tx values (2, 'b')").await);
        assert_ok(&run(&mgr, &s, "savepoint sp1").await);
        assert_ok(&run(&mgr, &s, "insert into a_rt_tx values (3, 'c')").await);
        assert_ok(&run(&mgr, &s, "rollback to savepoint sp1").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        let ev = run(&mgr, &s, "rollback").await;
        assert_eq!(tx_ended(&ev), vec![(false, "ROLLBACK".to_string())]);
        assert_eq!(
            scalar(&run(&mgr, &s, "select count(*) from a_rt_tx").await),
            json!(1)
        );

        // a failing statement does not end the transaction
        assert_ok(&run(&mgr, &s, "insert into a_rt_tx values (4, 'd')").await);
        assert!(!errors(&run(&mgr, &s, "insert into a_rt_tx values (4, 'dup')").await).is_empty());
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);

        // DDL commits implicitly
        let ev = run(&mgr, &s, "create table a_rt_tx2 (id number)").await;
        assert_ok(&ev);
        assert_eq!(tx_ended(&ev), vec![(true, "IMPLICIT COMMIT".to_string())]);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        assert_eq!(
            scalar(&run(&mgr, &o, "select count(*) from a_rt_tx").await),
            json!(2)
        );
        assert_ok(&run(&mgr, &s, "drop table a_rt_tx2 purge").await);

        // Auto mode: every statement is committed, the session stays idle
        let ev = run_auto(&mgr, &s, "insert into a_rt_tx values (5, 'e')").await;
        assert_ok(&ev);
        assert!(
            tx_statuses(&ev).is_empty() && tx_ended(&ev).is_empty(),
            "{ev:?}"
        );
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        assert_eq!(
            scalar(&run(&mgr, &o, "select count(*) from a_rt_tx").await),
            json!(3)
        );
        // a failing statement in a script is not committed; the earlier ones are
        let ev = run_auto(
            &mgr,
            &s,
            "insert into a_rt_tx values (6, 'f'); insert into a_rt_tx values (6, 'dup'); insert into a_rt_tx values (7, 'g')",
        )
        .await;
        assert_eq!(errors(&ev).len(), 1);
        assert_eq!(
            scalar(&run(&mgr, &o, "select count(*) from a_rt_tx").await),
            json!(4)
        );

        // isolation level and read-only transactions are plain statements
        assert_ok(&run(&mgr, &s, "alter session set isolation_level = serializable").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        assert_ok(
            &run(
                &mgr,
                &s,
                "alter session set isolation_level = read committed",
            )
            .await,
        );

        assert_ok(&run_auto(&mgr, &s, "drop table a_rt_tx purge").await);
        mgr.close_session(&s).await;
        mgr.close_session(&o).await;
    }

    #[tokio::test]
    async fn read_only_data_source() {
        let (cfg, _mgr) = setup!();
        let rw = connected(&cfg).await;
        let w = rw.open_session("ora").await.unwrap();
        let _ = run_auto(&rw, &w, "drop table a_rt_ro purge").await;
        assert_ok(&run_auto(&rw, &w, "create table a_rt_ro (id number)").await);
        assert_ok(&run_auto(&rw, &w, "insert into a_rt_ro values (1)").await);

        let mut ro_cfg = cfg.clone();
        ro_cfg.read_only = true;
        let mgr = connected(&ro_cfg).await;
        let s = mgr.open_session("ora").await.unwrap();
        assert_eq!(
            scalar(&run(&mgr, &s, "select count(*) from a_rt_ro").await),
            json!(1)
        );
        let ev = run(&mgr, &s, "insert into a_rt_ro values (2)").await;
        assert!(errors(&ev)[0].starts_with("ORA-01456"), "{:?}", errors(&ev));
        let ev = run(&mgr, &s, "delete from a_rt_ro").await;
        assert!(errors(&ev)[0].starts_with("ORA-01456"), "{:?}", errors(&ev));
        let ev = run(&mgr, &s, "begin delete from a_rt_ro; end;").await;
        assert!(errors(&ev)[0].starts_with("ORA-"), "{:?}", errors(&ev));
        for ddl in [
            "create table a_rt_ro2 (id number)",
            "drop table a_rt_ro",
            "truncate table a_rt_ro",
            "alter table a_rt_ro add (x number)",
        ] {
            let ev = run(&mgr, &s, ddl).await;
            assert!(
                errors(&ev)[0].starts_with("ORA-01456"),
                "{ddl}: {:?}",
                errors(&ev)
            );
        }
        // session settings are fine; the read-only transaction the rejected writes opened is reported (Manual
        // mode) until it is ended
        assert_ok(&run(&mgr, &s, "alter session set current_schema = DEMO").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        assert_ok(&run(&mgr, &s, "commit").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        // still readable and unchanged after the rejected writes and the commit
        assert_eq!(
            scalar(&run(&mgr, &s, "select count(*) from a_rt_ro").await),
            json!(1)
        );
        mgr.close_session(&s).await;
        assert_ok(&run_auto(&rw, &w, "drop table a_rt_ro purge").await);
        rw.close_session(&w).await;
    }

    /// Auto mode ends the read-only transaction after each statement: later reads see what other sessions commit.
    #[tokio::test]
    async fn read_only_auto_mode_does_not_freeze_the_snapshot() {
        let (cfg, _mgr) = setup!();
        let rw = connected(&cfg).await;
        let w = rw.open_session("ora").await.unwrap();
        let _ = run_auto(&rw, &w, "drop table fxb_ro_snap purge").await;
        assert_ok(&run_auto(&rw, &w, "create table fxb_ro_snap (id number)").await);
        // a read-only transaction cannot read a table whose DDL is younger than its snapshot (ORA-01466, 1 s grain)
        tokio::time::sleep(Duration::from_millis(1500)).await;

        let mut ro_cfg = cfg.clone();
        ro_cfg.read_only = true;
        let mgr = connected(&ro_cfg).await;
        let s = mgr.open_session("ora").await.unwrap();
        let count = |mgr: &ConnectionManager, s: &SessionId| {
            let (mgr, s) = (mgr.clone(), s.clone());
            async move {
                txt(&scalar(
                    &run_auto(&mgr, &s, "select count(*) from fxb_ro_snap").await,
                ))
            }
        };
        assert_eq!(count(&mgr, &s).await, "0");
        // a statement that opens the read-only transaction (a block), then the other session commits
        assert_ok(&run_auto(&mgr, &s, "begin null; end;").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        assert_ok(&run_auto(&rw, &w, "insert into fxb_ro_snap values (1)").await);
        assert_eq!(count(&mgr, &s).await, "1");
        // a rejected write ends its transaction too
        let ev = run_auto(&mgr, &s, "insert into fxb_ro_snap values (2)").await;
        assert!(errors(&ev)[0].starts_with("ORA-01456"), "{:?}", errors(&ev));
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        assert_ok(&run_auto(&rw, &w, "insert into fxb_ro_snap values (3)").await);
        assert_eq!(count(&mgr, &s).await, "2");
        // Manual mode: the transaction is reported and keeps its snapshot until it ends
        assert_ok(&run(&mgr, &s, "begin null; end;").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        assert_ok(&run_auto(&rw, &w, "insert into fxb_ro_snap values (4)").await);
        assert_eq!(
            txt(&scalar(
                &run(&mgr, &s, "select count(*) from fxb_ro_snap").await
            )),
            "2"
        );
        assert_ok(&run(&mgr, &s, "rollback").await);
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
        assert_eq!(
            txt(&scalar(
                &run(&mgr, &s, "select count(*) from fxb_ro_snap").await
            )),
            "3"
        );
        mgr.close_session(&s).await;
        assert_ok(&run_auto(&rw, &w, "drop table fxb_ro_snap purge").await);
        rw.close_session(&w).await;
    }

    /// PL/SQL and SET TRANSACTION must not be a way out of a read-only data source.
    #[tokio::test]
    async fn read_only_refuses_the_bypasses() {
        let (cfg, _mgr) = setup!();
        let rw = connected(&cfg).await;
        let w = rw.open_session("ora").await.unwrap();
        let _ = run_auto(&rw, &w, "drop table fxb_ro_by purge").await;
        let _ = run_auto(&rw, &w, "drop table fxb_ro_by2 purge").await;
        assert_ok(&run_auto(&rw, &w, "create table fxb_ro_by (id number)").await);
        assert_ok(&run_auto(&rw, &w, "insert into fxb_ro_by values (1)").await);
        tokio::time::sleep(Duration::from_millis(1500)).await; // see read_only_auto_mode_does_not_freeze_the_snapshot

        let mut ro_cfg = cfg.clone();
        ro_cfg.read_only = true;
        let mgr = connected(&ro_cfg).await;
        let s = mgr.open_session("ora").await.unwrap();
        for sql in [
            "begin execute immediate 'create table fxb_ro_by2 (a number)'; end;",
            "begin commit; delete from fxb_ro_by; commit; end;",
            "begin rollback; delete from fxb_ro_by; end;",
            "declare c integer := dbms_sql.open_cursor; begin null; end;",
            "set transaction read write",
            "set transaction isolation level serializable",
        ] {
            for auto in [false, true] {
                let ev = if auto {
                    run_auto(&mgr, &s, sql).await
                } else {
                    run(&mgr, &s, sql).await
                };
                let e = errors(&ev);
                assert!(
                    e.len() == 1 && e[0].starts_with("ORA-01456") && e[0].contains("read-only"),
                    "{sql}: {e:?}"
                );
            }
        }
        // the gate was not fooled: the follow-up DML fails, nothing changed, no table appeared
        let ev = run_auto(&mgr, &s, "delete from fxb_ro_by").await;
        assert!(errors(&ev)[0].starts_with("ORA-01456"), "{:?}", errors(&ev));
        assert_eq!(
            txt(&scalar(
                &run_auto(&rw, &w, "select count(*) from fxb_ro_by").await
            )),
            "1"
        );
        assert_eq!(
            txt(&scalar(
                &run_auto(
                    &rw,
                    &w,
                    "select count(*) from user_tables where table_name = 'FXB_RO_BY2'"
                )
                .await
            )),
            "0"
        );
        // harmless blocks and SET TRANSACTION READ ONLY still work; words in strings and comments are no code
        assert_ok(&run_auto(&mgr, &s, "set transaction read only").await);
        assert_ok(&run_auto(&mgr, &s, "commit").await);
        let ev = run_auto(
            &mgr,
            &s,
            "begin dbms_output.put_line('commit; execute immediate'); /* rollback */ end;",
        )
        .await;
        assert_ok(&ev);
        assert_eq!(messages(&ev), ["commit; execute immediate"]);
        mgr.close_session(&s).await;
        assert_ok(&run_auto(&rw, &w, "drop table fxb_ro_by purge").await);
        rw.close_session(&w).await;
    }

    #[tokio::test]
    async fn dbms_output_goes_to_the_output_log() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let ev = run(
            &mgr,
            &s,
            "begin dbms_output.put_line('hello'); dbms_output.put_line(''); dbms_output.put_line('wörld'); end;",
        )
        .await;
        assert_ok(&ev);
        assert_eq!(messages(&ev), ["hello", "", "wörld"]);
        // drained: nothing the second time
        let ev = run(&mgr, &s, "begin null; end;").await;
        assert!(messages(&ev).is_empty());
        // a long output arrives completely (more than one buffer)
        let ev = run(
            &mgr,
            &s,
            "begin for i in 1..3000 loop dbms_output.put_line('line ' || i || rpad('x', 20, 'x')); end loop; end;",
        )
        .await;
        let m = messages(&ev);
        assert_eq!(m.len(), 3000, "{}", m.len());
        assert!(m[0].starts_with("line 1x") && m[2999].starts_with("line 3000x"));
        // output of a statement that failed is shown before the error
        let ev = run(
            &mgr,
            &s,
            "begin dbms_output.put_line('before'); raise_application_error(-20001, 'boom'); end;",
        )
        .await;
        assert_eq!(messages(&ev), ["before"]);
        assert!(
            errors(&ev)[0].starts_with("ORA-20001: boom"),
            "{:?}",
            errors(&ev)
        );
        // call to a procedure
        assert_ok(&run(&mgr, &s, "create or replace procedure a_rt_hi as begin dbms_output.put_line('hi from proc'); end;\n/").await);
        let ev = run(&mgr, &s, "call a_rt_hi()").await;
        assert_ok(&ev);
        assert_eq!(messages(&ev), ["hi from proc"]);
        assert_ok(&run(&mgr, &s, "drop procedure a_rt_hi").await);
        mgr.close_session(&s).await;
    }

    #[tokio::test]
    async fn plsql_scripts_and_dml_counts() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let _ = run_auto(&mgr, &s, "drop table a_rt_pl purge").await;
        let ev = run_auto(
            &mgr,
            &s,
            "create table a_rt_pl (id number, v varchar2(10));\n\
             insert into a_rt_pl select level, 'v' || level from dual connect by level <= 5;\n\
             update a_rt_pl set v = 'z' where id > 2;\n\
             create or replace procedure a_rt_p (n number) as\nbegin\n  update a_rt_pl set v = 'p' where id = n;\nend;\n/\n\
             begin a_rt_p(1); end;\n/\n\
             select * from a_rt_pl order by id",
        )
        .await;
        assert_ok(&ev);
        let updates: Vec<u64> = ev
            .iter()
            .filter_map(|e| match e {
                ExecEvent::Update { rows_affected, .. } => Some(*rows_affected),
                _ => None,
            })
            .collect();
        assert_eq!(updates[1], 5);
        assert_eq!(updates[2], 3);
        let (_, rows, _) = first_rs(&ev);
        assert_eq!(
            rows.iter().map(|r| txt(&r[1])).collect::<Vec<_>>(),
            ["p", "v2", "z", "z", "z"]
        );
        assert_ok(&run_auto(&mgr, &s, "drop procedure a_rt_p").await);
        assert_ok(&run_auto(&mgr, &s, "drop table a_rt_pl purge").await);
        mgr.close_session(&s).await;
    }

    /// `CREATE OR REPLACE PROCEDURE` with a compile error succeeds (ORA-24344): the statement still ends with a
    /// `Warning` event that lists the PL/SQL errors; a clean one has none. A PL/SQL block reports no row count.
    #[tokio::test]
    async fn invalid_stored_objects_end_with_a_warning() {
        let (_cfg, mgr) = setup!();
        let s = mgr.open_session("ora").await.unwrap();
        let warnings = |ev: &[ExecEvent]| -> Vec<(usize, String, Vec<String>)> {
            ev.iter()
                .filter_map(|e| match e {
                    ExecEvent::Warning {
                        index,
                        message,
                        details,
                    } => Some((*index, message.clone(), details.clone())),
                    _ => None,
                })
                .collect()
        };
        let ev = run_auto(
            &mgr,
            &s,
            "create or replace procedure fxk_bad as\nbegin\n  select nosuchcol into x from dual;\nend;\n/\n\
             create or replace procedure fxk_good as\nbegin\n  null;\nend;\n/\n\
             create or replace force view fxk_bv as select nosuchcol from dual;\n\
             select 1 from dual",
        )
        .await;
        assert_ok(&ev);
        let w = warnings(&ev);
        assert_eq!(w.len(), 2, "{w:?}");
        assert_eq!(w[0].0, 0);
        assert_eq!(w[0].1, "Warning: PROCEDURE FXK_BAD compiled with errors");
        assert!(!w[0].2.is_empty());
        for d in &w[0].2 {
            let (pos, text) = d.split_once(": ").expect(d);
            let (l, c) = pos.split_once('/').expect(d);
            assert!(l.parse::<u32>().is_ok() && c.parse::<u32>().is_ok(), "{d}");
            assert!(!text.is_empty());
        }
        assert!(
            w[0].2
                .iter()
                .any(|d| d.contains("PLS-00201") || d.contains("PL/SQL")),
            "{:?}",
            w[0].2
        );
        assert_eq!(
            (w[1].0, w[1].1.as_str()),
            (2, "Warning: VIEW FXK_BV compiled with errors")
        );
        // the statement itself did succeed: an Update event, the next statements ran
        assert_eq!(scalar(&ev), json!(1));
        // fixing it clears the warning
        let ev = run_auto(
            &mgr,
            &s,
            "create or replace procedure fxk_bad as\nbegin\n  null;\nend;\n/",
        )
        .await;
        assert_ok(&ev);
        assert!(warnings(&ev).is_empty());
        // an anonymous block / call reports no row count
        let ev = run_auto(&mgr, &s, "begin null; end;\n/\ncall fxk_good()").await;
        assert_ok(&ev);
        let counts: Vec<u64> = ev
            .iter()
            .filter_map(|e| match e {
                ExecEvent::Update { rows_affected, .. } => Some(*rows_affected),
                _ => None,
            })
            .collect();
        assert_eq!(counts, [0, 0]);
        for sql in [
            "drop procedure fxk_bad",
            "drop procedure fxk_good",
            "drop view fxk_bv",
        ] {
            assert_ok(&run_auto(&mgr, &s, sql).await);
        }
        mgr.close_session(&s).await;
    }

    #[tokio::test]
    async fn keep_alive_pings_idle_connections() {
        let (cfg, _mgr) = setup!();
        let mut c = cfg.clone();
        c.id = "ora-ka".into();
        c.options.insert("keepAlive".into(), "1".into());
        let mgr = connected(&c).await;
        let s = mgr.open_session("ora-ka").await.unwrap();
        assert_eq!(scalar(&run(&mgr, &s, "select 1 from dual").await), json!(1));
        tokio::time::sleep(Duration::from_millis(3500)).await;
        // still usable (and the ping did not disturb an open transaction)
        assert_eq!(scalar(&run(&mgr, &s, "select 2 from dual").await), json!(2));
        mgr.close_session(&s).await;
    }
}
