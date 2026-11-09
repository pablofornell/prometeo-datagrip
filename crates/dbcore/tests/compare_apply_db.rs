//! The migration script of "Compare schemas" on live databases. The fixtures are the ones of
//! `src/features/schema-diff/fixtures.test.ts` (the golden test keeps the scripts equal to the models):
//!
//! 1. schema A is created from `<dbms>_a.sql` and its model is read;
//! 2. A's objects are removed (Oracle has one owner: B's objects take the same names, so A goes first);
//! 3. schema B is created from `<dbms>_b.sql`, and `<dbms>_migration.sql` runs against it (stops at the first error);
//! 4. the model of B must equal the model of A, except the column positions and the names the system made up
//!    (`SYS_...`, a constraint matched by its definition).
//!
//! Oracle, PostgreSQL and MySQL need the variables of the other integration tests and skip without them:
//!
//!   PROMETEO_ORACLE_URL=oracle://demo:...@127.0.0.1:15219/FREEPDB1 PROMETEO_PG_URL=... PROMETEO_MYSQL_URL=... \
//!   cargo test -p dbcore --test compare_apply_db -- --nocapture

mod common;

use common::*;
use dbcore::compare::SchemaModel;
use dbcore::import::CancellationToken;
use dbcore::*;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

/// Oracle: every object of the fixtures has this prefix, so the test removes exactly its own objects.
const ORA_PREFIX: &str = "CMPX_";

/// Drops every view and table of the fixtures in the login's schema (one anonymous block).
const ORA_CLEAN: &str = r#"begin
  for v in (select view_name as n from user_views where substr(view_name, 1, 5) = 'CMPX_') loop
    execute immediate 'drop view "' || v.n || '"';
  end loop;
  for t in (select table_name as n from user_tables where substr(table_name, 1, 5) = 'CMPX_') loop
    execute immediate 'drop table "' || t.n || '" cascade constraints purge';
  end loop;
end;
/
"#;

const PG_CLEAN: &str =
    "drop schema if exists cmpx_a cascade; drop schema if exists cmpx_b cascade;";

/// Runs one of the fixture scripts on `ds` with `schema` as the current schema. A failing statement fails the test.
async fn run_file(mgr: &ConnectionManager, ds: &str, schema: Option<&str>, file: &str) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/compare")
        .join(file);
    let opts = ScriptOptions {
        stop_on_error: true,
        ..Default::default()
    };
    let summary = mgr
        .run_sql_file(ds, schema, &path, &opts, &CancellationToken::new(), |_| {})
        .await
        .unwrap_or_else(|e| panic!("{file}: {e}"));
    assert_eq!(summary.failed, 0, "{file}: {:?}", summary.first_error);
    assert!(!summary.cancelled, "{file}: cancelled");
    println!("{file}: {} statements ran", summary.ok);
}

/// The model as JSON, without what may differ between the two sides: the schema name, the column positions, and the
/// names the system made up (`SYS_...`), which leave a constraint or index compared by its definition alone.
fn comparable(m: &SchemaModel) -> Value {
    fn name_of(v: &Value) -> &str {
        v.get("name").and_then(Value::as_str).unwrap_or("")
    }
    fn scrub(v: &mut Value) {
        match v {
            Value::Object(map) => {
                map.remove("schema");
                map.remove("position");
                let generated =
                    matches!(map.get("name"), Some(Value::String(n)) if n.starts_with("SYS_"));
                if generated {
                    map.insert("name".into(), Value::String(String::new()));
                }
                map.values_mut().for_each(scrub);
                // the order of the lists is not a difference: a column added by the script goes last
                for list in [
                    "tables",
                    "columns",
                    "unique",
                    "checks",
                    "foreignKeys",
                    "indexes",
                    "views",
                    "sequences",
                    "routines",
                ] {
                    if let Some(Value::Array(items)) = map.get_mut(list) {
                        items.sort_by(|x, y| name_of(x).cmp(name_of(y)));
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(scrub),
            _ => {}
        }
    }
    let mut v = serde_json::to_value(m).expect("the model as JSON");
    scrub(&mut v);
    v
}

/// One line per leaf where two JSON values differ: `path: a != b`.
fn differences(path: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            for k in keys {
                let null = Value::Null;
                differences(
                    &format!("{path}/{k}"),
                    x.get(k).unwrap_or(&null),
                    y.get(k).unwrap_or(&null),
                    out,
                );
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (p, q)) in x.iter().zip(y).enumerate() {
                differences(&format!("{path}[{i}]"), p, q, out);
            }
        }
        _ if a != b => out.push(format!("{path}: {a} != {b}")),
        _ => {}
    }
}

/// B, after the script, is A: every table, column (type, nullability, default), key, check, foreign key, index, view,
/// sequence and routine of A is in B with the same definition.
fn assert_same_model(a: &SchemaModel, b: &SchemaModel) {
    assert!(!a.tables.is_empty(), "A has no tables: {a:?}");
    let mut diffs = Vec::new();
    differences("", &comparable(a), &comparable(b), &mut diffs);
    assert!(
        diffs.is_empty(),
        "B differs from A after the script ({} differences):\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}

#[tokio::test]
async fn oracle_migration_makes_b_like_a() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let owner = cfg.user.to_uppercase();
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    // one owner for both schemas: A's objects are read and removed before B's are created
    assert_ok(&run(&mgr, &s, ORA_CLEAN).await);
    run_file(&mgr, &cfg.id, None, "oracle_a.sql").await;
    let a = mgr
        .schema_model(&cfg.id, &owner, Some(ORA_PREFIX))
        .await
        .expect("model of A");
    assert_ok(&run(&mgr, &s, ORA_CLEAN).await);

    run_file(&mgr, &cfg.id, None, "oracle_b.sql").await;
    run_file(&mgr, &cfg.id, None, "oracle_migration.sql").await;
    let b = mgr
        .schema_model(&cfg.id, &owner, Some(ORA_PREFIX))
        .await
        .expect("model of B");
    assert_same_model(&a, &b);

    assert_ok(&run(&mgr, &s, ORA_CLEAN).await);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn postgres_migration_makes_b_like_a() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("PROMETEO_PG_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    assert_ok(&run(&mgr, &s, PG_CLEAN).await);
    assert_ok(&run(&mgr, &s, "create schema cmpx_a").await);
    run_file(&mgr, &cfg.id, Some("cmpx_a"), "postgres_a.sql").await;
    let a = mgr
        .schema_model(&cfg.id, "cmpx_a", None)
        .await
        .expect("model of A");

    assert_ok(&run(&mgr, &s, "create schema cmpx_b").await);
    run_file(&mgr, &cfg.id, Some("cmpx_b"), "postgres_b.sql").await;
    run_file(&mgr, &cfg.id, Some("cmpx_b"), "postgres_migration.sql").await;
    let b = mgr
        .schema_model(&cfg.id, "cmpx_b", None)
        .await
        .expect("model of B");
    assert_same_model(&a, &b);

    assert_ok(&run(&mgr, &s, PG_CLEAN).await);
    mgr.close_session(&s).await;
}

#[tokio::test]
async fn mysql_migration_makes_b_like_a() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("PROMETEO_MYSQL_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    for stmt in [
        "drop database if exists cmpx_a",
        "drop database if exists cmpx_b",
        "create database cmpx_a",
    ] {
        assert_ok(&run(&mgr, &s, stmt).await);
    }
    run_file(&mgr, &cfg.id, Some("cmpx_a"), "mysql_a.sql").await;
    let a = mgr
        .schema_model(&cfg.id, "cmpx_a", None)
        .await
        .expect("model of A");

    assert_ok(&run(&mgr, &s, "create database cmpx_b").await);
    run_file(&mgr, &cfg.id, Some("cmpx_b"), "mysql_b.sql").await;
    run_file(&mgr, &cfg.id, Some("cmpx_b"), "mysql_migration.sql").await;
    let b = mgr
        .schema_model(&cfg.id, "cmpx_b", None)
        .await
        .expect("model of B");
    assert_same_model(&a, &b);

    for stmt in [
        "drop database if exists cmpx_a",
        "drop database if exists cmpx_b",
    ] {
        assert_ok(&run(&mgr, &s, stmt).await);
    }
    mgr.close_session(&s).await;
}
