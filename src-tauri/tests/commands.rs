//! Integration tests of the command layer (`AppState`), run without a Tauri runtime.
//!
//! SQLite tests always run. The PostgreSQL test (and the timing numbers, printed with
//! `--nocapture`, lines start with `BENCH`) needs:
//!   PROMETEO_PG_URL=postgres://postgres:prometeo@127.0.0.1:54329/postgres cargo test -p prometeo-datagrip --test commands -- --nocapture
//! The PG fixture (`shop` schema with the 100k-row `big_table`) is loaded by
//! `cargo test -p dbcore` (see crates/dbcore/README.md).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dbcore::{
    DataSourceConfig, Driver, ExecEvent, ExecOptions, NodeKind, ObjectRef, RowChange,
    TableDataRequest,
};
use prometeo_datagrip_lib::store::{NoKeyring, OsKeyring, SecretStore};
use prometeo_datagrip_lib::AppState;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::Notify;

fn state(dir: &tempfile::TempDir) -> AppState {
    AppState::with_secrets(
        dir.path().join("config"),
        dir.path().join("data"),
        Arc::new(NoKeyring),
    )
    .unwrap()
}

/// Collects events and wakes up the waiter on `Done`.
#[derive(Clone, Default)]
struct Collector {
    events: Arc<Mutex<Vec<ExecEvent>>>,
    done: Arc<Notify>,
}

impl Collector {
    fn sink(&self) -> impl Fn(ExecEvent) + Send + 'static {
        let (events, done) = (self.events.clone(), self.done.clone());
        move |ev| {
            let is_done = matches!(ev, ExecEvent::Done { .. });
            events.lock().unwrap().push(ev);
            if is_done {
                done.notify_one();
            }
        }
    }

    async fn wait(&self) -> Vec<ExecEvent> {
        tokio::time::timeout(Duration::from_secs(60), self.done.notified())
            .await
            .expect("execution did not finish");
        self.events.lock().unwrap().clone()
    }
}

async fn run(st: &AppState, session: &str, sql: &str, max_rows: usize) -> Vec<ExecEvent> {
    let col = Collector::default();
    st.execute(
        session,
        sql,
        ExecOptions {
            max_rows,
            stop_on_error: true,
            ..Default::default()
        },
        col.sink(),
    )
    .await
    .unwrap();
    col.wait().await
}

fn first_rs(ev: &[ExecEvent]) -> (usize, usize, bool) {
    for e in ev {
        if let ExecEvent::ResultSet {
            columns,
            rows,
            has_more,
            ..
        } = e
        {
            return (columns.len(), rows.len(), *has_more);
        }
    }
    panic!("no result set in {ev:#?}");
}

fn pg_ds() -> Option<DataSourceConfig> {
    let url = std::env::var("PROMETEO_PG_URL")
        .ok()
        .filter(|u| !u.is_empty())?;
    // postgres://user:pass@host:port/db
    let rest = url.split("://").nth(1)?;
    let (auth, tail) = rest.split_once('@')?;
    let (user, pass) = auth.split_once(':')?;
    let (hostport, db) = tail.split_once('/')?;
    let (host, port) = hostport.split_once(':')?;
    Some(DataSourceConfig {
        name: "shop@localhost".into(),
        driver: Driver::Postgres,
        host: host.into(),
        port: port.parse().ok()?,
        database: db.into(),
        user: user.into(),
        password: Some(pass.into()),
        ..Default::default()
    })
}

#[tokio::test]
async fn postgres_end_to_end() {
    let Some(cfg) = pg_ds() else {
        eprintln!("PROMETEO_PG_URL not set: skipping");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir);

    // ---- save (password handling) / list / test / connect
    let view = st.save_data_source(cfg).await.unwrap();
    let ds = view.cfg.id.clone();
    assert!(!ds.is_empty() && view.has_password);
    let listed = serde_json::to_value(st.list_data_sources().await.unwrap()).unwrap();
    assert!(listed[0].get("password").is_none(), "{listed}");
    assert_eq!(listed[0]["hasPassword"], true);
    assert_eq!(listed[0]["passwordStorage"], "file"); // NoKeyring
                                                      // unsaved copy without password: the stored one is used
    let probe = DataSourceConfig {
        password: None,
        ..view.cfg.clone()
    };
    let t = st.test_connection(probe).await.unwrap();
    assert!(t.ok, "{t:?}");
    let wrong = DataSourceConfig {
        password: Some("wrong".into()),
        ..view.cfg.clone()
    };
    let t = st.test_connection(wrong).await.unwrap();
    assert!(
        !t.ok && t.message.contains("password authentication failed"),
        "{t:?}"
    );
    let info = st.connect(&ds).await.unwrap();
    assert!(info.server_version.starts_with("PostgreSQL"), "{info:?}");
    assert_eq!(st.connected_data_sources(), vec![ds.clone()]);

    // ---- introspect down to columns
    let path = |p: &[&str]| p.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let dbs = st.introspect(&ds, vec![], false).await.unwrap();
    let db = dbs
        .iter()
        .find(|n| n.extra["current"] == true)
        .expect("current database")
        .name
        .clone();
    let schemas = st.introspect(&ds, path(&[&db]), false).await.unwrap();
    assert!(schemas.iter().any(|n| n.name == "shop"));
    let folders = st
        .introspect(&ds, path(&[&db, "shop"]), false)
        .await
        .unwrap();
    assert!(folders.iter().any(|n| n.name == "tables"));
    let tables = st
        .introspect(&ds, path(&[&db, "shop", "tables"]), false)
        .await
        .unwrap();
    let products = tables
        .iter()
        .find(|n| n.name == "products")
        .expect("shop.products");
    assert_eq!(products.kind, NodeKind::Table);
    let cols = st
        .introspect(
            &ds,
            path(&[&db, "shop", "tables", "products", "columns"]),
            false,
        )
        .await
        .unwrap();
    let names: Vec<_> = cols.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(&names[..3], ["id", "sku", "name"], "{names:?}");
    assert_eq!(cols[0].extra["isPk"], true);
    let ddl = st
        .get_ddl(&ds, ObjectRef::from_node(products))
        .await
        .unwrap();
    assert!(
        ddl.to_lowercase().contains("create table shop.products"),
        "{ddl}"
    );
    let snap = st.schema_snapshot(&ds, Some("shop".into())).await.unwrap();
    assert!(snap
        .iter()
        .any(|o| o.name == "big_table" && o.columns.len() == 6));

    // ---- execute select * from the big table, page with fetch_more
    let sess = st.open_session(&ds).await.unwrap();
    let t0 = Instant::now();
    let ev = run(
        &st,
        &sess,
        "select * from shop.big_table order by id limit 1000",
        500,
    )
    .await;
    println!(
        "BENCH execute(select * from shop.big_table order by id limit 1000) -> done: {:?}",
        t0.elapsed()
    );
    assert_eq!(first_rs(&ev), (6, 500, true));
    assert!(
        matches!(ev.first(), Some(ExecEvent::Statement { .. }))
            && matches!(ev.last(), Some(ExecEvent::Done { .. }))
    );
    let exec_id = st
        .running_executions()
        .pop()
        .expect("execution kept open for paging");
    let more = st.fetch_more(&exec_id, 0, 500).await.unwrap();
    assert_eq!((more.rows.len(), more.has_more), (500, false));
    assert_eq!(more.rows[0][0], json!(501));

    // a failing statement reports the server message
    let ev = run(&st, &sess, "select * from shop.does_not_exist", 500).await;
    let err = ev.iter().find_map(|e| {
        if let ExecEvent::Error {
            message, position, ..
        } = e
        {
            Some((message.clone(), *position))
        } else {
            None
        }
    });
    let (msg, pos) = err.expect("error event");
    assert!(msg.contains("does_not_exist"), "{msg}");
    assert!(pos.is_some());

    // ---- history was written automatically
    let hist = st.history_list(Some(ds.clone()), 0, 10).await.unwrap();
    assert_eq!(hist.len(), 2);
    assert!(!hist[0].ok && hist[0].error.as_deref().unwrap().contains("does_not_exist"));
    assert!(hist[1].ok && hist[1].sql.contains("big_table") && hist[1].rows == Some(500));
    assert_eq!(
        st.history_search("BIG_TABLE".into(), None, 10)
            .await
            .unwrap()
            .len(),
        1
    );

    // ---- apply an update (and revert it)
    let table = ObjectRef::table(Some("shop"), "products");
    let rd = |id: i64| TableDataRequest {
        where_clause: Some(format!("id = {id}")),
        limit: 5,
        ..Default::default()
    };
    let rs = st.table_data(&ds, table.clone(), rd(1)).await.unwrap();
    assert_eq!(rs.rows.len(), 1);
    let name_idx = rs.columns.iter().position(|c| c.name == "name").unwrap();
    let original = rs.rows[0][name_idx].clone();
    assert!(rs.columns[0].is_pk);
    let change = |to: &str| RowChange {
        kind: dbcore::ChangeKind::Update,
        key: [("id".to_string(), json!(1))].into(),
        values: [("name".to_string(), json!(to))].into(),
        row_locator: None,
    };
    let res = st
        .apply_changes(&ds, table.clone(), vec![change("Renamed by test")])
        .await
        .unwrap();
    assert!(res.committed && res.applied == 1, "{res:?}");
    let rs = st.table_data(&ds, table.clone(), rd(1)).await.unwrap();
    assert_eq!(rs.rows[0][name_idx], json!("Renamed by test"));
    let back = st
        .apply_changes(&ds, table.clone(), vec![change(original.as_str().unwrap())])
        .await
        .unwrap();
    assert!(back.committed);
    // a change that fails rolls back and reports the server message
    let bad = RowChange {
        kind: dbcore::ChangeKind::Update,
        key: [("id".to_string(), json!(1))].into(),
        values: [("price".to_string(), json!(-5))].into(),
        row_locator: None,
    };
    let res = st.apply_changes(&ds, table, vec![bad]).await.unwrap();
    assert!(
        !res.committed
            && res
                .first_error()
                .unwrap()
                .error
                .as_deref()
                .unwrap()
                .contains("products_price_positive"),
        "{res:?}"
    );

    // ---- export
    let opts = dbcore::ExportOptions::default();
    let csv = st
        .export_query_to_string(
            &ds,
            "select id, sku from shop.products order by id limit 3",
            opts.clone(),
        )
        .await
        .unwrap();
    assert!(csv.starts_with("id,sku\n1,SKU-0001\n"), "{csv}");
    let file = dir.path().join("out.csv");
    st.allow_export_path(file.clone()); // what `choose_export_path` does with the dialog's answer
    let n = st
        .export_query(&ds, "select * from shop.products", opts, &file)
        .await
        .unwrap();
    assert_eq!(n, 20);
    assert_eq!(std::fs::read_to_string(&file).unwrap().lines().count(), 21);

    st.close_session(&sess).await.unwrap();
    st.disconnect(&ds).await.unwrap();
    assert!(st.connected_data_sources().is_empty());
    st.delete_data_source(&ds).await.unwrap();
    assert!(st.list_data_sources().await.unwrap().is_empty());
}

/// 500 rows x 20 columns: serialization cost and the full path execute -> `Channel`.
#[tokio::test]
async fn bench_500x20_through_a_channel() {
    // serialization alone, synthetic cells of every common JSON shape
    let rows: Vec<Vec<Value>> = (0..500)
        .map(|i| {
            (0..20)
                .map(|c| match c % 5 {
                    0 => json!(i * 20 + c),
                    1 => json!(format!("name-{i}-{c}")),
                    2 => json!(format!("{}.{:02}", i, c)),
                    3 => Value::Null,
                    _ => json!("2024-01-01 10:00:00+00"),
                })
                .collect()
        })
        .collect();
    let col = |n: usize| dbcore::ColumnMeta {
        name: format!("c{n}"),
        type_name: "text".into(),
        nullable: true,
        is_pk: false,
        table_ref: None,
    };
    let ev = ExecEvent::ResultSet {
        index: 0,
        columns: (0..20).map(col).collect(),
        rows,
        has_more: true,
    };
    let t = Instant::now();
    let mut len = 0;
    for _ in 0..50 {
        len = serde_json::to_string(&ev).unwrap().len();
    }
    println!(
        "BENCH serde_json 500x20 resultset event: {:?} per event, {} KiB",
        t.elapsed() / 50,
        len / 1024
    );

    // the same event through a real tauri Channel (serialization + IPC body construction)
    let sizes = Arc::new(Mutex::new(Vec::<usize>::new()));
    let s2 = sizes.clone();
    let ch: Channel<ExecEvent> = Channel::new(move |body| {
        if let InvokeResponseBody::Json(j) = &body {
            s2.lock().unwrap().push(j.len());
        }
        Ok(())
    });
    let t = Instant::now();
    for _ in 0..50 {
        ch.send(ev.clone()).unwrap();
    }
    println!(
        "BENCH Channel::send 500x20 resultset event: {:?} per event",
        t.elapsed() / 50
    );
    assert_eq!(sizes.lock().unwrap().len(), 50);

    // full path against a real server: execute -> events -> Channel callback
    let Some(cfg) = pg_ds() else { return };
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir);
    let ds = st.save_data_source(cfg).await.unwrap().cfg.id;
    st.connect(&ds).await.unwrap();
    let sess = st.open_session(&ds).await.unwrap();
    let wide = (0..20)
        .map(|i| match i % 4 {
            0 => format!("id as c{i}"),
            1 => format!("name as c{i}"),
            2 => format!("amount as c{i}"),
            _ => format!("created as c{i}"),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("select {wide} from shop.big_table order by id limit 1000");
    let done = Arc::new(Notify::new());
    let bodies = Arc::new(Mutex::new(Vec::<(Duration, usize, String)>::new()));
    let start = Instant::now();
    let (d2, b2) = (done.clone(), bodies.clone());
    let ch: Channel<ExecEvent> = Channel::new(move |body| {
        if let InvokeResponseBody::Json(j) = body {
            let at = start.elapsed();
            if j.contains("\"kind\":\"done\"") {
                d2.notify_one();
            }
            b2.lock().unwrap().push((at, j.len(), j));
        }
        Ok(())
    });
    st.execute(
        &sess,
        &sql,
        ExecOptions {
            max_rows: 500,
            stop_on_error: true,
            ..Default::default()
        },
        move |ev| {
            let _ = ch.send(ev);
        },
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(30), done.notified())
        .await
        .unwrap();
    let all = bodies.lock().unwrap().clone();
    let (at, size, json) = all
        .iter()
        .find(|(_, _, j)| j.contains("\"kind\":\"resultset\""))
        .unwrap();
    println!(
        "BENCH pg execute -> 500x20 resultset event on the Channel: {:?} after execute() returned, payload {} KiB",
        at, size / 1024
    );
    if let Ok(p) = std::env::var("PROMETEO_BENCH_DUMP") {
        std::fs::write(p, json).unwrap();
    }
    st.disconnect(&ds).await.unwrap();
}

#[tokio::test]
async fn sqlite_end_to_end_and_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir);
    let db_file = dir.path().join("t.sqlite");
    let cfg = DataSourceConfig {
        name: "lite".into(),
        driver: Driver::Sqlite,
        file: db_file.display().to_string(),
        options: [("create".to_string(), "true".to_string())].into(),
        ..Default::default()
    };
    let ds = st.save_data_source(cfg).await.unwrap().cfg.id;
    st.connect(&ds).await.unwrap();
    let sess = st.open_session(&ds).await.unwrap();
    let ev = run(
        &st,
        &sess,
        "create table t (id integer primary key, name text); insert into t (name) values ('a'), ('b'), ('c'); select * from t order by id",
        500,
    )
    .await;
    assert_eq!(first_rs(&ev), (2, 3, false));
    let nodes = st
        .introspect(
            &ds,
            vec!["main".into(), "tables".into(), "t".into(), "columns".into()],
            false,
        )
        .await
        .unwrap();
    assert_eq!(
        nodes.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
        ["id", "name"]
    );

    // the cancel of a finished execution is not an error; busy sessions are reported
    let ev = run(&st, &sess, "select 1", 10).await;
    assert!(matches!(ev.last(), Some(ExecEvent::Done { .. })));
    st.cancel("no-such-execution").await.unwrap();

    // update through apply_changes
    let table = ObjectRef::table(Some("main"), "t");
    let upd = RowChange {
        kind: dbcore::ChangeKind::Update,
        key: [("id".to_string(), json!(2))].into(),
        values: [("name".to_string(), json!("B!"))].into(),
        row_locator: None,
    };
    let r = st
        .apply_changes(&ds, table.clone(), vec![upd])
        .await
        .unwrap();
    assert!(r.committed);
    let rs = st
        .table_data(
            &ds,
            table,
            TableDataRequest {
                order_by: Some("id".into()),
                count_total: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(rs.rows[1][1], json!("B!"));
    assert_eq!(rs.total_hint, Some(3));

    // splitter parity with the editor (UTF-16 offsets)
    let sql = "select 'é😀';\nselect 2;";
    let s = st
        .statement_at(sql, sql.encode_utf16().count() - 2, Driver::Sqlite)
        .unwrap();
    assert_eq!(s.text, "select 2");
    assert_eq!(st.split_statements(sql, Driver::Sqlite).len(), 2);

    // history persisted on disk, newest first
    assert_eq!(st.history_list(None, 0, 10).await.unwrap().len(), 2);
    st.history_clear().await.unwrap();
    assert!(st.history_list(None, 0, 10).await.unwrap().is_empty());

    // consoles
    assert_eq!(st.create_console(&ds).await.unwrap(), "console");
    assert_eq!(st.create_console(&ds).await.unwrap(), "console_1");
    st.write_console(&ds, "console_1", "select 1;".into())
        .await
        .unwrap();
    assert_eq!(
        st.read_console(&ds, "console_1").await.unwrap(),
        "select 1;"
    );
    assert_eq!(
        st.list_consoles(&ds).await.unwrap(),
        ["console", "console_1"]
    );

    // ui state: debounced, flushed explicitly
    st.set_ui_state("layout".into(), json!({ "left": 280 }));
    assert_eq!(st.get_ui_state("layout").unwrap()["left"], 280);
    st.flush_ui_state().await.unwrap();
    let on_disk: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("config/ui-state.json")).unwrap())
            .unwrap();
    assert_eq!(on_disk["layout"]["left"], 280);

    // everything survives a restart; saving a connection-relevant change disconnects
    drop(st);
    let st = state(&dir);
    assert_eq!(st.list_data_sources().await.unwrap().len(), 1);
    assert_eq!(st.get_ui_state("layout").unwrap()["left"], 280);
    st.connect(&ds).await.unwrap();
    let mut changed = st.list_data_sources().await.unwrap()[0].cfg.clone();
    changed.name = "renamed".into();
    st.save_data_source(changed.clone()).await.unwrap();
    assert!(
        st.connected_data_sources().contains(&ds),
        "rename must not disconnect"
    );
    changed.read_only = true;
    st.save_data_source(changed).await.unwrap();
    assert!(
        st.connected_data_sources().is_empty(),
        "changed connection settings must disconnect"
    );

    // deleting the data source removes its consoles
    st.delete_data_source(&ds).await.unwrap();
    assert!(st.list_consoles(&ds).await.unwrap().is_empty());
}

/// Options that only the UI reads (the legacy `visibleSchemas`, `showSystemSchemas`, `comment`, ...) are not part of
/// the connection fingerprint: adding, changing or removing them keeps a live session; a key the backend reads does not.
#[tokio::test]
async fn view_only_options_do_not_disconnect_a_live_session() {
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir);
    let db_file = dir.path().join("v.sqlite");
    let cfg = DataSourceConfig {
        name: "v".into(),
        driver: Driver::Sqlite,
        file: db_file.display().to_string(),
        options: [
            ("create".to_string(), "true".to_string()),
            ("visibleSchemas".to_string(), "[[\"main\"]]".to_string()),
        ]
        .into(),
        ..Default::default()
    };
    let ds = st.save_data_source(cfg).await.unwrap().cfg.id;
    st.connect(&ds).await.unwrap();
    let sess = st.open_session(&ds).await.unwrap();
    run(&st, &sess, "begin", 10).await;
    let mut cfg = st.list_data_sources().await.unwrap()[0].cfg.clone();

    // the frontend migration removes visibleSchemas; then every other UI-only key is added and changed
    cfg.options.remove("visibleSchemas");
    st.save_data_source(cfg.clone()).await.unwrap();
    for (k, v) in [
        ("visibleSchemas", "[[\"main\"]]"),
        ("showSystemSchemas", "true"),
        ("comment", "hello"),
        ("txMode", "manual"),
        ("sessionControl", "single"),
        ("keepAliveSec", "30"),
        ("autoDisconnectSec", "60"),
        ("startupScript", "select 1"),
    ] {
        cfg.options.insert(k.to_string(), v.to_string());
        st.save_data_source(cfg.clone()).await.unwrap();
        cfg.options.insert(k.to_string(), format!("{v}2"));
        st.save_data_source(cfg.clone()).await.unwrap();
        assert!(
            st.connected_data_sources().contains(&ds),
            "{k} must not disconnect"
        );
    }
    assert!(
        st.session_in_transaction(&sess).await.unwrap(),
        "the open session and its transaction survive"
    );

    // a key the backend reads still reconnects
    cfg.options.insert("connectTimeout".into(), "5".into());
    st.save_data_source(cfg).await.unwrap();
    assert!(
        st.connected_data_sources().is_empty(),
        "connectTimeout changes the connection"
    );
}

/// Uses the real OS keyring when there is one (skips otherwise) and cleans up after itself.
#[tokio::test]
async fn os_keyring_roundtrip_when_available() {
    let dir = tempfile::tempdir().unwrap();
    let st = AppState::with_secrets(
        dir.path().join("c"),
        dir.path().join("d"),
        Arc::new(OsKeyring),
    )
    .unwrap();
    let info = st.app_info().await.unwrap();
    println!(
        "BENCH password storage backend: {:?}",
        info.password_storage
    );
    let cfg = DataSourceConfig {
        name: "kr".into(),
        driver: Driver::Postgres,
        password: Some("kr-secret".into()),
        ..Default::default()
    };
    let view = st.save_data_source(cfg).await.unwrap();
    let file = std::fs::read_to_string(dir.path().join("c/data-sources.json")).unwrap();
    match serde_json::to_value(&view).unwrap()["passwordStorage"]
        .as_str()
        .unwrap()
    {
        "keyring" => {
            assert!(!file.contains("kr-secret"), "password leaked into the file");
            let id = view.cfg.id.clone();
            let stored = tokio::task::spawn_blocking(move || OsKeyring.get(&id))
                .await
                .unwrap();
            assert_eq!(stored.unwrap().as_deref(), Some("kr-secret"));
        }
        _ => assert!(file.contains("kr-secret")),
    }
    st.delete_data_source(&view.cfg.id).await.unwrap();
    let id = view.cfg.id.clone();
    let left = tokio::task::spawn_blocking(move || OsKeyring.get(&id))
        .await
        .unwrap();
    assert_eq!(
        left.ok().flatten(),
        None,
        "keyring entry must be removed on delete"
    );
}

/// Export targets must come from the backend's save dialog: a path the webview invents is refused.
#[tokio::test]
async fn export_only_writes_to_dialog_chosen_paths() {
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir);
    let rs = dbcore::ResultSet {
        columns: vec![],
        rows: vec![],
        has_more: false,
        total_hint: None,
        row_locators: None,
    };
    let opts = dbcore::ExportOptions::default();
    let target = dir.path().join("out.csv");

    let e = st
        .export_result(rs.clone(), opts.clone(), target.clone())
        .await
        .unwrap_err();
    assert!(e.contains("save dialog"), "{e}");
    assert!(!target.exists(), "nothing may be written");
    let cfg = DataSourceConfig {
        name: "m".into(),
        driver: Driver::Sqlite,
        file: ":memory:".into(),
        ..Default::default()
    };
    let ds = st.save_data_source(cfg).await.unwrap().cfg.id;
    st.connect(&ds).await.unwrap();
    let e = st
        .export_query(&ds, "select 1", opts.clone(), &target)
        .await
        .unwrap_err();
    assert!(e.contains("save dialog"), "{e}");
    assert!(!target.exists());

    // the path the dialog returned works, once, and only that exact path
    st.allow_export_path(target.clone());
    assert!(st
        .export_result(rs.clone(), opts.clone(), dir.path().join("other.csv"))
        .await
        .is_err());
    assert!(!dir.path().join("other.csv").exists());
    st.export_result(rs.clone(), opts.clone(), target.clone())
        .await
        .unwrap();
    assert!(target.exists());
    assert!(
        st.export_result(rs.clone(), opts.clone(), target.clone())
            .await
            .is_err(),
        "single use"
    );
    st.allow_export_path(target.clone());
    assert_eq!(
        st.export_query(
            &ds,
            "select 1 as a union all select 2",
            opts.clone(),
            &target
        )
        .await
        .unwrap(),
        2
    );
    // the string variants (clipboard) need no path
    assert!(st.export_to_string(rs, opts).await.is_ok());
}

/// A corrupt config file does not stop the app: it is set aside and reported in `app_info`.
#[tokio::test]
async fn corrupt_config_files_start_the_app_with_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let cfg_dir = dir.path().join("config");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(cfg_dir.join("data-sources.json"), b"\0\0garbage").unwrap();
    std::fs::write(cfg_dir.join("ui-state.json"), b"{\"a\":").unwrap();
    let st = state(&dir);
    assert!(st.list_data_sources().await.unwrap().is_empty());
    let info = st.app_info().await.unwrap();
    let mut files: Vec<_> = info
        .startup_warnings
        .iter()
        .map(|w| w.file.clone())
        .collect();
    files.sort();
    assert_eq!(files, ["data-sources.json", "ui-state.json"]);
    for w in &info.startup_warnings {
        assert!(std::path::Path::new(w.backup.as_ref().unwrap()).exists());
    }
    let names: Vec<_> = std::fs::read_dir(&cfg_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names
            .iter()
            .any(|n| n.starts_with("data-sources.json.corrupt-"))
            && names
                .iter()
                .any(|n| n.starts_with("ui-state.json.corrupt-")),
        "{names:?}"
    );
    // the JSON the UI gets
    assert_eq!(
        serde_json::to_value(&info).unwrap()["startupWarnings"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

/// A password typed into the URL is stored apart, never returned, and still used to connect; errors do not echo it.
#[tokio::test]
async fn url_password_never_reaches_the_ui_or_error_messages() {
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir);
    let cfg = DataSourceConfig {
        name: "pw".into(),
        driver: Driver::Postgres,
        url_override: Some(
            "postgres://bob:Sup3rS3cret@127.0.0.1:1/x?connect_timeout=1&password=Sup3rS3cret"
                .into(),
        ),
        options: [("connectTimeout".to_string(), "1".to_string())].into(),
        ..Default::default()
    };
    let view = st.save_data_source(cfg.clone()).await.unwrap();
    let ui = serde_json::to_string(&st.list_data_sources().await.unwrap()).unwrap();
    assert!(!ui.contains("Sup3rS3cret"), "{ui}");
    assert_eq!(
        view.cfg.url_override.as_deref(),
        Some("postgres://bob@127.0.0.1:1/x?connect_timeout=1")
    );
    assert!(view.has_password);
    // no keyring in tests: the password is in the (0600) file, which is the only place it may be
    assert!(
        std::fs::read_to_string(dir.path().join("config/data-sources.json"))
            .unwrap()
            .contains("Sup3rS3cret")
    );
    // unreachable server: the error is shown, without the password
    let id = view.cfg.id.clone();
    let err = st.connect(&id).await.unwrap_err();
    assert!(!err.contains("Sup3rS3cret"), "{err}");
    let t = st.test_connection(cfg).await.unwrap();
    assert!(!t.ok && !t.message.contains("Sup3rS3cret"), "{}", t.message);
}

/// Session settings can be applied when a session is opened; the transaction state is queryable.
#[tokio::test]
async fn open_session_with_init_sql_and_tx_status() {
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir);
    let cfg = DataSourceConfig {
        name: "m".into(),
        driver: Driver::Sqlite,
        file: ":memory:".into(),
        ..Default::default()
    };
    let ds = st.save_data_source(cfg).await.unwrap().cfg.id;
    st.connect(&ds).await.unwrap();
    let s = st
        .open_session_with(&ds, &["pragma foreign_keys = off".to_string()])
        .await
        .unwrap();
    let ev = run(&st, &s, "select * from pragma_foreign_keys", 10).await;
    assert_eq!(first_rs(&ev), (1, 1, false));
    assert_eq!(
        st.session_tx_status(&s).await.unwrap(),
        dbcore::TxStatus::Idle
    );
    run(&st, &s, "begin", 10).await;
    assert_eq!(
        st.session_tx_status(&s).await.unwrap(),
        dbcore::TxStatus::Active
    );
    assert!(st.session_in_transaction(&s).await.unwrap());
    assert_eq!(
        serde_json::to_value(st.session_tx_status(&s).await.unwrap()).unwrap(),
        "active"
    );
    // session_state: same status / flag, plus the connection health
    let state = st.session_state(&s).await.unwrap();
    assert_eq!(
        serde_json::to_value(state).unwrap(),
        serde_json::json!({"txStatus": "active", "inTransaction": true, "connectionLost": false, "transactionLost": false})
    );
    assert!(st
        .open_session_with(&ds, &["select * from nope".to_string()])
        .await
        .is_err());
}

/// Import: only files picked in the open dialog are read; the error file is the default one or a save-dialog pick.
#[tokio::test]
async fn import_reads_only_picked_files_and_writes_only_allowed_error_files() {
    use dbcore::{ImportFormat, ImportRequest};

    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir);
    let cfg = DataSourceConfig {
        name: "lite".into(),
        driver: Driver::Sqlite,
        file: dir.path().join("i.sqlite").display().to_string(),
        options: [("create".to_string(), "true".to_string())].into(),
        ..Default::default()
    };
    let ds = st.save_data_source(cfg).await.unwrap().cfg.id;
    st.connect(&ds).await.unwrap();
    let csv = dir.path().join("rows.csv");
    std::fs::write(&csv, "id,name\n1,a\n2,b\nx,c\n").unwrap();
    let path = csv.display().to_string();

    // not picked in the dialog: refused
    let e = st
        .import_preview(&path, ImportFormat::default(), 10)
        .await
        .unwrap_err();
    assert!(e.contains("choose_import_file"), "{e}");

    st.allow_import_path(csv.clone());
    let pv = st
        .import_preview(&path, ImportFormat::default(), 10)
        .await
        .unwrap();
    assert_eq!(pv.rows.len(), 3);
    assert_eq!(pv.columns[0].name, "id");

    let request = |error_file: &std::path::Path| -> ImportRequest {
        serde_json::from_value(json!({
            "path": path,
            "table": "t",
            "createTable": true,
            "columns": [
                { "name": "id", "source": 0, "type": "integer" },
                { "name": "name", "source": 1, "type": "text" },
            ],
            "options": { "errorFile": error_file },
        }))
        .unwrap()
    };

    // an error file nobody picked: refused, nothing is imported
    let other = dir.path().join("elsewhere.txt");
    let e = st
        .import_file(&ds, "imp1", request(&other), |_| {})
        .await
        .unwrap_err();
    assert!(e.contains("Refusing to write"), "{e}");

    // the default error file next to the source is allowed
    let default = AppState::default_error_file(&csv);
    assert_eq!(default, dir.path().join("rows_errors.txt"));
    let progress = Mutex::new(Vec::new());
    let res = st
        .import_file(&ds, "imp2", request(&default), |p| {
            progress.lock().unwrap().push(p.rows)
        })
        .await
        .unwrap();
    assert_eq!((res.imported, res.failed), (2, 1), "{res:?}");
    assert_eq!(res.error_file.as_deref(), default.to_str());
    assert!(default.exists());
    assert_eq!(progress.lock().unwrap().last(), Some(&3));

    // a save-dialog pick is allowed, once
    let picked = dir.path().join("picked.txt");
    st.allow_export_path(picked.clone());
    let again = dir.path().join("rows2.csv");
    std::fs::write(&again, "id,name\n1,a\nx,b\n").unwrap();
    st.allow_import_path(again.clone());
    let mut req = request(&picked);
    req.path = again.clone();
    req.create_table = false;
    let res = st.import_file(&ds, "imp3", req, |_| {}).await.unwrap();
    assert_eq!((res.imported, res.failed), (1, 1), "{res:?}");
    assert!(std::fs::read_to_string(&picked)
        .unwrap()
        .contains("not a valid integer"));

    // cancelling an unknown import is a no-op
    st.cancel_import("nope");
}

/// Export and import of data sources and settings only touch files picked in the backend's dialogs, never write a
/// password, and refuse oversized input.
#[tokio::test]
async fn data_source_and_settings_files_go_through_granted_paths_only() {
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir);
    let cfg = DataSourceConfig {
        name: "prod".into(),
        driver: Driver::Postgres,
        user: "scott".into(),
        password: Some("tr0ub4dor-secret".into()),
        ..Default::default()
    };
    st.save_data_source(cfg).await.unwrap();

    // a path the webview invents is not written
    let out = dir.path().join("out.json");
    let e = st.export_data_sources(None, &out).await.unwrap_err();
    assert!(e.contains("save dialog"), "{e}");
    assert!(!out.exists());
    // a dialog-chosen one is, once, and the text never holds the password
    st.allow_export_path(out.clone());
    assert_eq!(st.export_data_sources(None, &out).await.unwrap(), 1);
    let text = std::fs::read_to_string(&out).unwrap();
    assert!(!text.contains("tr0ub4dor-secret"));
    assert!(text.contains("\"hasPassword\": true"));
    assert!(
        st.export_data_sources(None, &out).await.is_err(),
        "the grant is used up"
    );

    // reading: only a file picked in the open dialog
    let e = st
        .import_data_sources(&out.display().to_string())
        .await
        .unwrap_err();
    assert!(e.contains("open dialog"), "{e}");
    st.allow_import_path(out.clone());
    let summary = st
        .import_data_sources(&out.display().to_string())
        .await
        .unwrap();
    assert_eq!(summary.imported.len(), 1);
    assert_eq!(summary.imported[0].name, "prod (2)");
    assert!(summary.imported[0].needs_password);
    assert_eq!(st.list_data_sources().await.unwrap().len(), 2);

    // more than 8 MB is refused, as a file and as text
    let big = dir.path().join("big.json");
    let size = prometeo_datagrip_lib::store::MAX_EXPORT_FILE as usize + 1;
    std::fs::write(&big, vec![b' '; size]).unwrap();
    st.allow_import_path(big.clone());
    let e = st
        .import_data_sources(&big.display().to_string())
        .await
        .unwrap_err();
    assert!(e.contains("too big"), "{e}");
    let e = st
        .import_settings(&big.display().to_string())
        .await
        .unwrap_err();
    assert!(e.contains("too big"), "{e}");
    let e = st
        .import_data_sources_text(" ".repeat(size))
        .await
        .unwrap_err();
    assert!(e.contains("too big"), "{e}");
    assert_eq!(
        st.list_data_sources().await.unwrap().len(),
        2,
        "nothing was imported"
    );

    // settings: same grants, and a data sources file is not a settings file
    let settings_file = dir.path().join("settings.json");
    st.allow_export_path(settings_file.clone());
    st.export_settings(
        json!({ "settings": { "gridPageSize": 100 }, "theme": "dark" }),
        &settings_file,
    )
    .await
    .unwrap();
    st.allow_import_path(settings_file.clone());
    let back = st
        .import_settings(&settings_file.display().to_string())
        .await
        .unwrap();
    assert_eq!(back["settings"]["gridPageSize"], 100);
    st.allow_import_path(out.clone());
    let e = st
        .import_settings(&out.display().to_string())
        .await
        .unwrap_err();
    assert!(e.contains("not a Prometeo settings"), "{e}");
}
