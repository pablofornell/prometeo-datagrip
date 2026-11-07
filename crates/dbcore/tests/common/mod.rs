#![allow(dead_code)]
//! Shared helpers for the integration tests.

use dbcore::*;
use serde_json::Value;
use tokio::sync::OnceCell;

pub const PG_SEED: &str = include_str!("../fixtures/pg_seed.sql");
pub const MYSQL_SEED: &str = include_str!("../fixtures/mysql_seed.sql");
pub const ORACLE_SEED: &str = include_str!("../fixtures/oracle_seed.sql");

pub fn pg_cfg() -> Option<DataSourceConfig> {
    let url = std::env::var("PROMETEO_PG_URL")
        .ok()
        .filter(|u| !u.is_empty())?;
    Some(DataSourceConfig {
        id: "pg".into(),
        name: "pg".into(),
        driver: Driver::Postgres,
        url_override: Some(url),
        ..Default::default()
    })
}

pub fn mysql_cfg() -> Option<DataSourceConfig> {
    let url = std::env::var("PROMETEO_MYSQL_URL")
        .ok()
        .filter(|u| !u.is_empty())?;
    Some(DataSourceConfig {
        id: "my".into(),
        name: "my".into(),
        driver: Driver::MySql,
        url_override: Some(url),
        ..Default::default()
    })
}

/// `PROMETEO_ORACLE_URL=oracle://demo:prometeo@127.0.0.1:15219/FREEPDB1` (user:password@host:port/service name).
pub fn oracle_cfg() -> Option<DataSourceConfig> {
    let url = std::env::var("PROMETEO_ORACLE_URL")
        .ok()
        .filter(|u| !u.is_empty())?;
    let rest = url.strip_prefix("oracle://")?;
    let (cred, target) = rest.rsplit_once('@')?;
    let (user, password) = cred.split_once(':').unwrap_or((cred, ""));
    let (hostport, service) = target.split_once('/')?;
    let (host, port) = hostport.split_once(':').unwrap_or((hostport, "1521"));
    Some(DataSourceConfig {
        id: "ora".into(),
        name: "ora".into(),
        driver: Driver::Oracle,
        host: host.into(),
        port: port.parse().ok()?,
        user: user.into(),
        password: Some(password.into()),
        database: service.into(),
        options: [("oracleConnType".to_string(), "service".to_string())].into(),
        ..Default::default()
    })
}

pub fn lite_cfg(path: &std::path::Path) -> DataSourceConfig {
    DataSourceConfig {
        id: "lite".into(),
        name: "lite".into(),
        driver: Driver::Sqlite,
        file: path.to_string_lossy().into_owned(),
        options: [("create".to_string(), "true".to_string())].into(),
        ..Default::default()
    }
}

/// Run a script and return all events (panics on setup errors, not on SQL errors).
pub async fn run(mgr: &ConnectionManager, sess: &SessionId, sql: &str) -> Vec<ExecEvent> {
    mgr.execute_collect(sess, sql, ExecOptions::default())
        .await
        .expect("execute")
}

pub async fn run_n(
    mgr: &ConnectionManager,
    sess: &SessionId,
    sql: &str,
    max_rows: usize,
) -> Vec<ExecEvent> {
    mgr.execute_collect(
        sess,
        sql,
        ExecOptions {
            max_rows,
            stop_on_error: true,
            ..Default::default()
        },
    )
    .await
    .expect("execute")
}

pub fn errors(ev: &[ExecEvent]) -> Vec<String> {
    ev.iter()
        .filter_map(|e| match e {
            ExecEvent::Error { message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

pub fn assert_ok(ev: &[ExecEvent]) {
    let e = errors(ev);
    assert!(e.is_empty(), "unexpected errors: {e:?}");
}

/// The first result set of an event list: (columns, rows, has_more).
pub fn first_rs(ev: &[ExecEvent]) -> (Vec<ColumnMeta>, Vec<Vec<Value>>, bool) {
    for e in ev {
        if let ExecEvent::ResultSet {
            columns,
            rows,
            has_more,
            ..
        } = e
        {
            return (columns.clone(), rows.clone(), *has_more);
        }
    }
    panic!("no result set in {ev:#?}");
}

pub fn scalar(ev: &[ExecEvent]) -> Value {
    assert_ok(ev);
    first_rs(ev).1[0][0].clone()
}

pub fn names(nodes: &[TreeNode]) -> Vec<String> {
    nodes.iter().map(|n| n.name.clone()).collect()
}

pub async fn children(mgr: &ConnectionManager, ds: &str, path: &[&str]) -> Vec<TreeNode> {
    let p: Vec<String> = path.iter().map(|s| s.to_string()).collect();
    mgr.introspect(ds, &p)
        .await
        .unwrap_or_else(|e| panic!("introspect {path:?}: {e}"))
}

static PG_SEEDED: OnceCell<()> = OnceCell::const_new();
static MY_SEEDED: OnceCell<()> = OnceCell::const_new();
static ORA_SEEDED: OnceCell<()> = OnceCell::const_new();

async fn seed(cfg: &DataSourceConfig, sql: &str, probe: &str) {
    let mgr = ConnectionManager::new();
    mgr.connect(cfg).await.expect("connect for seeding");
    let sess = mgr.open_session(&cfg.id).await.unwrap();
    let ev = run(&mgr, &sess, probe).await;
    // Oracle hands NUMBER over as text
    let seeded =
        errors(&ev).is_empty() && first_rs(&ev).1[0][0].to_string().trim_matches('"') == "100000";
    if !seeded {
        eprintln!("[seed] loading fixture into {}", cfg.id);
        let ev = mgr
            .execute_collect(
                &sess,
                sql,
                ExecOptions {
                    max_rows: 10,
                    stop_on_error: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_ok(&ev);
    }
    mgr.close_session(&sess).await;
    mgr.disconnect(&cfg.id).await;
}

/// Load the PG fixture once per test binary (skipped when it is already in the database).
pub async fn seed_pg(cfg: &DataSourceConfig) {
    PG_SEEDED
        .get_or_init(|| seed(cfg, PG_SEED, "select count(*) from shop.big_table"))
        .await;
}

pub async fn seed_mysql(cfg: &DataSourceConfig) {
    MY_SEEDED
        .get_or_init(|| seed(cfg, MYSQL_SEED, "select count(*) from big_table"))
        .await;
}

pub async fn seed_oracle(cfg: &DataSourceConfig) {
    ORA_SEEDED
        .get_or_init(|| seed(cfg, ORACLE_SEED, "select count(*) from big_table"))
        .await;
}

pub async fn connected(cfg: &DataSourceConfig) -> ConnectionManager {
    let mgr = ConnectionManager::new();
    mgr.connect(cfg).await.expect("connect");
    mgr
}

/// Drain the events of an execution up to and including `Done`.
pub async fn wait_done(h: &mut ExecHandle) -> Vec<ExecEvent> {
    let mut out = Vec::new();
    while let Some(e) = h.events.recv().await {
        let done = matches!(e, ExecEvent::Done { .. });
        out.push(e);
        if done {
            break;
        }
    }
    out
}

/// The `TxStatus` events of a run, in order.
pub fn tx_statuses(ev: &[ExecEvent]) -> Vec<TxStatus> {
    ev.iter()
        .filter_map(|e| {
            if let ExecEvent::TxStatus { status } = e {
                Some(*status)
            } else {
                None
            }
        })
        .collect()
}

/// The `TxEnded` events of a run: `(committed, tag)`.
pub fn tx_ended(ev: &[ExecEvent]) -> Vec<(bool, String)> {
    ev.iter()
        .filter_map(|e| {
            if let ExecEvent::TxEnded { committed, tag, .. } = e {
                Some((*committed, tag.clone()))
            } else {
                None
            }
        })
        .collect()
}
