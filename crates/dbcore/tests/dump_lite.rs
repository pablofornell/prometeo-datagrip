//! SQLite whole-schema dump / restore round-trip (always runs; temp files).

mod common;

use common::*;
use dbcore::import::CancellationToken;
use dbcore::*;
use serde_json::{json, Value};

const SCHEMA: &str = r#"
create table parents (
    id integer primary key,
    name text not null unique,
    check (length(name) > 0)
);
create table children (
    id integer primary key autoincrement,
    parent_id integer not null references parents (id),
    label text,
    data blob,
    big integer,
    unique (parent_id, label)
);
create index idx_children_parent on children (parent_id);
create view v_children as select c.id, p.name as parent, c.label from children c join parents p on p.id = c.parent_id;
create trigger trg_children_audit after insert on children
begin
    update children set label = coalesce(new.label, 'n/a') where id = new.id;
end;
insert into parents (name) values ('Alpha 😀'), ('Bêta');
insert into children (parent_id, label, data, big) values
    (1, 'c1', x'deadbeef', 9223372036854775807),
    (2, 'héllo', x'0001ff', 42);
"#;

fn opts() -> DumpOptions {
    DumpOptions {
        include_routines: true,
        ..Default::default()
    }
}

/// Creates the source DB and returns `(tempdir, manager, dump text)`.
async fn setup() -> (tempfile::TempDir, ConnectionManager, String) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = lite_cfg(&dir.path().join("src.db"));
    let mgr = ConnectionManager::new();
    mgr.connect(&cfg).await.unwrap();
    let s = mgr.open_session("lite").await.unwrap();
    assert_ok(&run(&mgr, &s, SCHEMA).await);
    mgr.close_session(&s).await;

    let mut buf = Vec::new();
    let cancel = CancellationToken::new();
    let res = mgr
        .dump_schema("lite", "main", &opts(), &cancel, &|_| {}, &mut buf)
        .await
        .unwrap();
    assert_eq!(res.tables, 2);
    assert_eq!(res.rows, 4);
    assert!(!res.cancelled);
    assert!(res.elapsed_ms > 0);

    (dir, mgr, String::from_utf8(buf).unwrap())
}

/// Connects a second, empty database in the same manager and restores `dump` into it.
async fn restore(mgr: &ConnectionManager, dir: &tempfile::TempDir, dump: &str) -> String {
    let cfg = DataSourceConfig {
        id: "dst".into(),
        name: "dst".into(),
        driver: Driver::Sqlite,
        file: dir.path().join("dst.db").to_string_lossy().into_owned(),
        options: [("create".to_string(), "true".to_string())].into(),
        ..Default::default()
    };
    mgr.connect(&cfg).await.unwrap();
    let s = mgr.open_session("dst").await.unwrap();
    let ev = mgr
        .execute_collect(
            &s,
            dump,
            ExecOptions {
                max_rows: 10,
                stop_on_error: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_ok(&ev);
    mgr.close_session(&s).await;
    "dst".into()
}

/// The `(type, name)` pairs of `sqlite_master`, excluding `sqlite_%` system objects.
async fn master(mgr: &ConnectionManager, ds: &str) -> Vec<(String, String)> {
    let s = mgr.open_session(ds).await.unwrap();
    let ev = run(
        mgr,
        &s,
        "select type, name from sqlite_master where name not like 'sqlite_%' order by type, name",
    )
    .await;
    mgr.close_session(&s).await;
    first_rs(&ev)
        .1
        .into_iter()
        .map(|r| {
            (
                r[0].as_str().unwrap().to_string(),
                r[1].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// Every row of `select * from <table> order by <pk>` (blobs as `$bin`, bigints as text, unicode kept).
async fn rows_of(mgr: &ConnectionManager, ds: &str, table: &str, pk: &str) -> Vec<Vec<Value>> {
    let s = mgr.open_session(ds).await.unwrap();
    let ev = run(mgr, &s, &format!("select * from {table} order by {pk}")).await;
    mgr.close_session(&s).await;
    first_rs(&ev).1
}

#[tokio::test]
async fn dump_writes_the_expected_sections() {
    let (_d, _mgr, dump) = setup().await;
    for needle in [
        "-- Prometeo DataGrip dump",
        "PRAGMA foreign_keys = OFF;",
        "PRAGMA foreign_keys = ON;",
        "Name: parents; Type: TABLE",
        "Name: children; Type: TABLE",
        "CREATE TABLE parents (",
        "CREATE TABLE children (",
        "CREATE INDEX idx_children_parent",
        "CREATE VIEW v_children",
        "CREATE TRIGGER trg_children_audit",
        "insert into \"parents\"",
        "insert into \"children\"",
        "X'deadbeef'",
        "X'0001ff'",
        "Alpha 😀",
        "9223372036854775807",
    ] {
        assert!(dump.contains(needle), "missing {needle:?} in dump:\n{dump}");
    }
}

#[tokio::test]
async fn round_trip_preserves_schema_and_data() {
    let (dir, mgr, dump) = setup().await;
    let dst = restore(&mgr, &dir, &dump).await;

    // identical object inventory (tables, index, view, trigger)
    let src_master = master(&mgr, "lite").await;
    let dst_master = master(&mgr, &dst).await;
    assert_eq!(src_master, dst_master);
    assert_eq!(
        src_master,
        vec![
            ("index".to_string(), "idx_children_parent".to_string()),
            ("table".to_string(), "children".to_string()),
            ("table".to_string(), "parents".to_string()),
            ("trigger".to_string(), "trg_children_audit".to_string()),
            ("view".to_string(), "v_children".to_string()),
        ]
    );

    // identical row data (blob as $bin, bigint as text, unicode text)
    assert_eq!(
        rows_of(&mgr, "lite", "parents", "id").await,
        rows_of(&mgr, &dst, "parents", "id").await
    );
    assert_eq!(
        rows_of(&mgr, "lite", "children", "id").await,
        rows_of(&mgr, &dst, "children", "id").await
    );
    assert_eq!(
        rows_of(&mgr, "lite", "children", "id").await,
        vec![
            vec![
                json!(1),
                json!(1),
                json!("c1"),
                json!({"$bin": "deadbeef", "len": 4}),
                json!("9223372036854775807"),
            ],
            vec![
                json!(2),
                json!(2),
                json!("héllo"),
                json!({"$bin": "0001ff", "len": 3}),
                json!(42),
            ],
        ]
    );

    // constraints actually restored: a FK violation and a UNIQUE violation are rejected
    let s = mgr.open_session(&dst).await.unwrap();
    let ev = run(
        &mgr,
        &s,
        "insert into children (parent_id, label) values (99, 'orphan')",
    )
    .await;
    assert!(
        errors(&ev)[0].contains("FOREIGN KEY constraint failed"),
        "{:?}",
        errors(&ev)
    );
    let ev = run(&mgr, &s, "insert into parents (name) values ('Alpha 😀')").await;
    assert!(
        errors(&ev)[0].contains("UNIQUE constraint failed"),
        "{:?}",
        errors(&ev)
    );
    mgr.close_session(&s).await;
}

/// A dump with `data: false` still carries the full schema but no `insert` statements.
#[tokio::test]
async fn schema_only_dump_omits_data() {
    let (dir, mgr, _) = setup().await;
    let mut buf = Vec::new();
    let cancel = CancellationToken::new();
    let res = mgr
        .dump_schema(
            "lite",
            "main",
            &DumpOptions {
                data: false,
                include_routines: true,
                ..Default::default()
            },
            &cancel,
            &|_| {},
            &mut buf,
        )
        .await
        .unwrap();
    assert_eq!((res.tables, res.rows), (2, 0));
    let dump = String::from_utf8(buf).unwrap();
    assert!(!dump.contains("insert into"), "{dump}");
    assert!(dump.contains("CREATE TABLE parents ("));

    // and it restores into an empty, populated-with-no-rows database
    let dst = restore(&mgr, &dir, &dump).await;
    assert_eq!(
        rows_of(&mgr, &dst, "parents", "id").await,
        Vec::<Vec<Value>>::new()
    );
}

/// Dropping objects before recreating them lets the dump run twice against the same target.
#[tokio::test]
async fn drop_if_exists_allows_rerun() {
    let (dir, mgr, _) = setup().await;
    let mut buf = Vec::new();
    let cancel = CancellationToken::new();
    mgr.dump_schema(
        "lite",
        "main",
        &DumpOptions {
            drop_if_exists: true,
            include_routines: true,
            ..Default::default()
        },
        &cancel,
        &|_| {},
        &mut buf,
    )
    .await
    .unwrap();
    let dump = String::from_utf8(buf).unwrap();
    assert!(dump.contains("drop table if exists \"parents\";"), "{dump}");
    assert!(
        dump.contains("drop index if exists \"idx_children_parent\";"),
        "{dump}"
    );
    assert!(
        dump.contains("drop view if exists \"v_children\";"),
        "{dump}"
    );
    assert!(
        dump.contains("drop trigger if exists \"trg_children_audit\";"),
        "{dump}"
    );

    // running twice must succeed and leave exactly one copy of the data
    let dst = restore(&mgr, &dir, &dump).await;
    let s = mgr.open_session(&dst).await.unwrap();
    assert_ok(
        &mgr.execute_collect(
            &s,
            &dump,
            ExecOptions {
                max_rows: 10,
                stop_on_error: true,
                ..Default::default()
            },
        )
        .await
        .unwrap(),
    );
    mgr.close_session(&s).await;
    assert_eq!(rows_of(&mgr, &dst, "parents", "id").await.len(), 2);
}

/// Dump written to a file, then run by `run_sql_file` into a new empty database: the same objects and rows.
/// `single` runs the restore in one transaction: SQLite then loads it with foreign keys off and checks them at the commit,
/// so the child rows the dump writes before their parent tables exist still load.
async fn script_restore(single: bool) {
    let (dir, mgr, dump) = setup().await;
    let file = dir.path().join("dump.sql");
    std::fs::write(&file, &dump).unwrap();
    let cfg = DataSourceConfig {
        id: "dst".into(),
        name: "dst".into(),
        driver: Driver::Sqlite,
        file: dir
            .path()
            .join("restored.db")
            .to_string_lossy()
            .into_owned(),
        options: [("create".to_string(), "true".to_string())].into(),
        ..Default::default()
    };
    mgr.connect(&cfg).await.unwrap();
    let opts = ScriptOptions {
        single_transaction: single,
        ..Default::default()
    };
    let cancel = CancellationToken::new();
    let sum = mgr
        .run_sql_file("dst", None, &file, &opts, &cancel, |_| {})
        .await
        .unwrap();
    assert_eq!(
        (sum.failed, sum.cancelled, sum.rolled_back),
        (0, false, false),
        "{:?}",
        sum.first_error
    );
    assert!(sum.ok >= 5, "{sum:?}");

    assert_eq!(master(&mgr, "lite").await, master(&mgr, "dst").await);
    for (table, pk) in [("parents", "id"), ("children", "id")] {
        assert_eq!(
            rows_of(&mgr, "lite", table, pk).await,
            rows_of(&mgr, "dst", table, pk).await,
            "{table}"
        );
    }
    assert_eq!(rows_of(&mgr, "dst", "children", "id").await.len(), 2);
}

#[tokio::test]
async fn run_sql_file_restores_a_dump_statement_by_statement() {
    script_restore(false).await;
}

#[tokio::test]
async fn run_sql_file_restores_a_dump_in_one_transaction() {
    script_restore(true).await;
}

/// `tables` limits the dump (and the indexes to those tables), `include_ddl = false` writes only the rows;
/// SQLite has no use for `commit_every` (no commit is written).
#[tokio::test]
async fn table_subset_and_data_only_dumps() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = lite_cfg(&dir.path().join("src.db"));
    let mgr = ConnectionManager::new();
    mgr.connect(&cfg).await.unwrap();
    let s = mgr.open_session("lite").await.unwrap();
    assert_ok(&run(&mgr, &s, SCHEMA).await);
    mgr.close_session(&s).await;

    let dump = |opts: DumpOptions| {
        let mgr = &mgr;
        async move {
            let mut buf = Vec::new();
            let res = mgr
                .dump_schema(
                    "lite",
                    "main",
                    &opts,
                    &CancellationToken::new(),
                    &|_| {},
                    &mut buf,
                )
                .await
                .unwrap();
            (String::from_utf8(buf).unwrap(), res)
        }
    };

    // parents only: no children, no index of children, no view, no trigger
    let (text, res) = dump(DumpOptions {
        tables: Some(vec!["parents".into()]),
        include_routines: true,
        ..Default::default()
    })
    .await;
    assert_eq!((res.tables, res.rows), (1, 2));
    for banned in ["children", "v_children", "TRIGGER", "idx_children_parent"] {
        assert!(!text.contains(banned), "{banned:?} in:\n{text}");
    }
    assert!(text.contains("CREATE TABLE parents ("));
    let dst = restore(&mgr, &dir, &text).await;
    assert_eq!(
        master(&mgr, &dst).await,
        vec![("table".to_string(), "parents".to_string())]
    );

    // the index of a dumped table comes along
    let (text, _) = dump(DumpOptions {
        tables: Some(vec!["children".into()]),
        ..Default::default()
    })
    .await;
    assert!(
        text.contains("CREATE INDEX idx_children_parent") && !text.contains("CREATE TABLE parents"),
        "{text}"
    );

    // data only, with the commit option set: rows and nothing else
    let (text, res) = dump(DumpOptions {
        include_ddl: false,
        commit_every: 1,
        batch_size: 1,
        ..Default::default()
    })
    .await;
    assert_eq!((res.tables, res.rows), (2, 4));
    for banned in ["CREATE", "DROP", "drop ", "commit", "COMMIT"] {
        assert!(!text.contains(banned), "{banned:?} in:\n{text}");
    }
    assert_eq!(text.matches("insert into").count(), 4);
}
