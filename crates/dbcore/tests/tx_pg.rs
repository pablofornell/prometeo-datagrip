//! PostgreSQL transaction tracking against the real server: the tracker (`session_tx_status`) must equal
//! what the server thinks after every statement, cancel inside a transaction, and lost connections. Run with:
//!   PROMETEO_PG_URL=postgres://postgres:prometeo@localhost:54329/postgres cargo test -p dbcore --test tx_pg -- --nocapture

mod common;

use common::*;
use dbcore::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

macro_rules! setup {
    () => {{
        let Some(cfg) = pg_cfg() else {
            eprintln!("PROMETEO_PG_URL not set: skipping");
            return;
        };
        let mgr = connected(&cfg).await;
        (cfg, mgr)
    }};
}

/// TEST-ONLY ground truth: what the server says about the transaction of `s`. `SAVEPOINT` fails with 25P01
/// outside a transaction and with 25P02 in an aborted one; in a healthy one it works (and is released).
/// Neither the server state nor the tracker changes by asking (the errors map to the state they report).
async fn truth(mgr: &ConnectionManager, s: &SessionId) -> TxStatus {
    let ev = run(mgr, s, "savepoint prometeo_truth").await;
    match errors(&ev).first() {
        None => {
            assert_ok(&run(mgr, s, "release savepoint prometeo_truth").await);
            TxStatus::Active
        }
        Some(m) if m.starts_with("[25P01]") => TxStatus::Idle,
        Some(m) if m.starts_with("[25P02]") => TxStatus::Failed,
        Some(m) => panic!("unexpected truth probe error: {m}"),
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

/// (name, setup statements, statement under test, expected state, expected `TxEnded`)
type Case = (
    &'static str,
    Vec<&'static str>,
    &'static str,
    TxStatus,
    Option<(bool, &'static str)>,
);

/// Every case: run the setup statements (one `execute` each), run the statement under test, then compare the
/// tracker with the server (`truth`) and with the state the PostgreSQL documentation promises (`expect`).
#[tokio::test]
async fn tracker_matches_the_server_after_every_kind_of_statement() {
    let (_cfg, mgr) = setup!();
    let admin = mgr.open_session("pg").await.unwrap();
    assert_ok(&run(&mgr, &admin, "drop schema if exists scratch_trk cascade; create schema scratch_trk; create table scratch_trk.d (i int primary key deferrable initially deferred); create table scratch_trk.t (i int)").await);

    use TxStatus::{Active as A, Failed as F, Idle as I};
    const FAIL: &str = "select 1/0";
    // (name, setup, statement under test, expected state, expected TxEnded of that statement)
    let cases: Vec<Case> = vec![
        (
            "commit and chain",
            vec!["begin"],
            "commit and chain",
            A,
            Some((true, "COMMIT")),
        ),
        (
            "commit and chain (failed tx: rolls back and chains)",
            vec!["begin", FAIL],
            "commit and chain",
            A,
            Some((false, "ROLLBACK")),
        ),
        (
            "rollback and chain",
            vec!["begin"],
            "rollback and chain",
            A,
            Some((false, "ROLLBACK")),
        ),
        (
            "rollback and chain (failed tx)",
            vec!["begin", FAIL],
            "rollback and chain",
            A,
            Some((false, "ROLLBACK")),
        ),
        (
            "abort and chain",
            vec!["begin"],
            "abort and chain",
            A,
            Some((false, "ROLLBACK")),
        ),
        (
            "end and chain",
            vec!["begin"],
            "end and chain",
            A,
            Some((true, "COMMIT")),
        ),
        (
            "commit and no chain",
            vec!["begin"],
            "commit and no chain",
            I,
            Some((true, "COMMIT")),
        ),
        ("end", vec!["begin"], "end", I, Some((true, "COMMIT"))),
        (
            "end (failed tx)",
            vec!["begin", FAIL],
            "end",
            I,
            Some((false, "ROLLBACK")),
        ),
        (
            "abort",
            vec!["begin"],
            "abort",
            I,
            Some((false, "ROLLBACK")),
        ),
        (
            "abort (failed tx)",
            vec!["begin", FAIL],
            "abort",
            I,
            Some((false, "ROLLBACK")),
        ),
        (
            "commit work",
            vec!["begin"],
            "commit work",
            I,
            Some((true, "COMMIT")),
        ),
        (
            "rollback transaction",
            vec!["begin"],
            "rollback transaction",
            I,
            Some((false, "ROLLBACK")),
        ),
        ("commit outside a transaction", vec![], "commit", I, None),
        (
            "rollback and chain outside a transaction",
            vec![],
            "rollback and chain",
            I,
            None,
        ),
        (
            "commit and chain outside a transaction",
            vec![],
            "commit and chain",
            I,
            None,
        ),
        // a failing PREPARE TRANSACTION (prepared transactions are disabled on the test server): the server
        // rolls the transaction back (idle, not failed)
        (
            "prepare transaction fails",
            vec!["begin"],
            "prepare transaction 'trk_a'",
            I,
            Some((false, "ROLLBACK")),
        ),
        (
            "prepare transaction, syntax error",
            vec!["begin"],
            "prepare transaction",
            F,
            None,
        ),
        (
            "prepare transaction fails in a failed tx",
            vec!["begin", FAIL],
            "prepare transaction 'trk_a'",
            I,
            Some((false, "ROLLBACK")),
        ),
        // COMMIT / ROLLBACK PREPARED: only outside a transaction block
        (
            "commit prepared in a transaction",
            vec!["begin"],
            "commit prepared 'trk_nope'",
            F,
            None,
        ),
        (
            "rollback prepared in a transaction",
            vec!["begin"],
            "rollback prepared 'trk_nope'",
            F,
            None,
        ),
        (
            "commit prepared outside (fails)",
            vec![],
            "commit prepared 'trk_nope'",
            I,
            None,
        ),
        (
            "rollback prepared outside (fails)",
            vec![],
            "rollback prepared 'trk_nope'",
            I,
            None,
        ),
        (
            "begin inside a transaction",
            vec!["begin"],
            "begin",
            A,
            None,
        ),
        (
            "begin inside a failed transaction",
            vec!["begin", FAIL],
            "begin",
            F,
            None,
        ),
        (
            "start transaction read only + write",
            vec!["start transaction read only"],
            "insert into scratch_trk.t values (1)",
            F,
            None,
        ),
        (
            "savepoint outside a transaction",
            vec![],
            "savepoint a",
            I,
            None,
        ),
        (
            "release unknown savepoint",
            vec!["begin", "savepoint a"],
            "release savepoint nosuch",
            F,
            None,
        ),
        (
            "rollback to unknown savepoint",
            vec!["begin"],
            "rollback to nosuch",
            F,
            None,
        ),
        (
            "rollback to unknown savepoint (failed tx)",
            vec!["begin", FAIL],
            "rollback to nosuch",
            F,
            None,
        ),
        (
            "rollback to savepoint revives",
            vec!["begin", "savepoint a", FAIL],
            "rollback to a",
            A,
            None,
        ),
        (
            "rollback to savepoint (healthy)",
            vec!["begin", "savepoint a"],
            "rollback to savepoint a",
            A,
            None,
        ),
        (
            "statement error in a transaction",
            vec!["begin"],
            FAIL,
            F,
            None,
        ),
        (
            "statement error outside a transaction",
            vec![],
            FAIL,
            I,
            None,
        ),
        // the deferred constraint fails at COMMIT: the server rolls back
        (
            "failing commit",
            vec!["begin", "insert into scratch_trk.d values (1), (1)"],
            "commit",
            I,
            Some((false, "ROLLBACK")),
        ),
        (
            "failing commit and chain",
            vec!["begin", "insert into scratch_trk.d values (1), (1)"],
            "commit and chain",
            I,
            Some((false, "ROLLBACK")),
        ),
        (
            "failing end",
            vec!["begin", "insert into scratch_trk.d values (1), (1)"],
            "end",
            I,
            Some((false, "ROLLBACK")),
        ),
        (
            "failing deferred check at SET CONSTRAINTS",
            vec!["begin", "insert into scratch_trk.d values (2), (2)"],
            "set constraints all immediate",
            F,
            None,
        ),
    ];

    let mut bad = Vec::new();
    for (name, setup, stmt, expect, expect_ended) in cases {
        let s = mgr.open_session("pg").await.unwrap();
        for st in &setup {
            run(&mgr, &s, st).await;
        }
        let ev = run(&mgr, &s, stmt).await;
        let tracked = mgr.session_tx_status(&s).unwrap();
        let real = truth(&mgr, &s).await;
        let ended = tx_ended(&ev);
        println!("{name:55} tracker={tracked:?} server={real:?} ended={ended:?}");
        if real != expect {
            bad.push(format!(
                "{name}: the case expects {expect:?} but the server says {real:?} (fix the case)"
            ));
        }
        if tracked != real {
            bad.push(format!("{name}: tracker {tracked:?} != server {real:?}"));
        }
        let want: Vec<(bool, String)> = expect_ended
            .map(|(c, t)| (c, t.to_string()))
            .into_iter()
            .collect();
        if ended != want {
            bad.push(format!("{name}: TxEnded {ended:?}, expected {want:?}"));
        }
        // leave nothing open
        run(&mgr, &s, "rollback").await;
        mgr.close_session(&s).await;
    }
    assert_ok(&run(&mgr, &admin, "drop schema scratch_trk cascade").await);
    mgr.close_session(&admin).await;
    assert!(bad.is_empty(), "tracker drift:\n{}", bad.join("\n"));
}

/// A failed batch of `apply_changes_in_session` rolls back to its savepoint: the transaction stays `Active`
/// (the PG error did not abort it) and the work done before the batch survives.
#[tokio::test]
async fn failed_apply_in_a_transaction_keeps_it_active() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop schema if exists scratch_trk_apply cascade; create schema scratch_trk_apply; create table scratch_trk_apply.t (id int primary key, v text not null); insert into scratch_trk_apply.t values (1,'a'),(2,'b')").await);
    let t = ObjectRef::table(Some("scratch_trk_apply"), "t");
    assert_ok(&run(&mgr, &s, "begin").await);
    assert_ok(
        &run(
            &mgr,
            &s,
            "update scratch_trk_apply.t set v = 'kept' where id = 1",
        )
        .await,
    );

    // duplicate key (a server error), a NOT NULL violation, and "no row matched": all fail inside the savepoint
    for bad in [
        vec![change(
            ChangeKind::Insert,
            json!({}),
            json!({"id": 2, "v": "dup"}),
        )],
        vec![change(
            ChangeKind::Update,
            json!({"id": 1}),
            json!({"v": null}),
        )],
        vec![change(ChangeKind::Delete, json!({"id": 99}), json!({}))],
        vec![
            change(ChangeKind::Update, json!({"id": 1}), json!({"v": "ok"})),
            change(ChangeKind::Insert, json!({}), json!({"id": 2, "v": "dup"})),
        ],
    ] {
        let r = mgr.apply_changes_in_session(&s, &t, &bad).await.unwrap();
        assert!(!r.committed, "{r:?}");
        assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
        assert_eq!(truth(&mgr, &s).await, TxStatus::Active);
        let rows = mgr
            .table_data_in_session(
                &s,
                &t,
                &TableDataRequest {
                    order_by: Some("id".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .rows;
        assert_eq!(
            rows[0][1],
            json!("kept"),
            "the earlier work of the transaction is intact"
        );
    }
    // and a good batch goes through, still in the transaction
    let r = mgr
        .apply_changes_in_session(
            &s,
            &t,
            &[change(
                ChangeKind::Update,
                json!({"id": 2}),
                json!({"v": "B"}),
            )],
        )
        .await
        .unwrap();
    assert!(r.committed);
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Active);
    let ev = run(&mgr, &s, "rollback").await;
    assert_eq!(tx_ended(&ev), vec![(false, "ROLLBACK".to_string())]);
    assert_eq!(
        mgr.table_data(
            "pg",
            &t,
            &TableDataRequest {
                order_by: Some("id".into()),
                ..Default::default()
            }
        )
        .await
        .unwrap()
        .rows[0][1],
        json!("a")
    );

    // outside a transaction a failed batch leaves the session idle
    let r = mgr
        .apply_changes_in_session(
            &s,
            &t,
            &[change(
                ChangeKind::Insert,
                json!({}),
                json!({"id": 2, "v": "dup"}),
            )],
        )
        .await
        .unwrap();
    assert!(!r.committed);
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Idle);
    assert_ok(&run(&mgr, &s, "drop schema scratch_trk_apply cascade").await);
    mgr.close_session(&s).await;
}

/// Item 1: a *user* cancel of a partially read result inside a transaction cancels the query, and PostgreSQL
/// aborts the transaction. The tracker must follow (`failed`, with a `TxStatus` event), so the `COMMIT` that
/// follows reports `committed: false` (the server answers with the tag ROLLBACK).
#[tokio::test]
async fn cancel_inside_a_transaction_marks_it_failed() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop table if exists public.scratch_trk_cancel; create table public.scratch_trk_cancel (i int)").await);
    let o = ExecOptions {
        max_rows: 100,
        stop_on_error: true,
        keep_open_secs: 600,
    };
    assert_ok(
        &mgr.execute_collect(
            &s,
            "begin; insert into public.scratch_trk_cancel values (1)",
            o.clone(),
        )
        .await
        .unwrap(),
    );

    let mut h = mgr
        .execute(
            &s,
            "select g, repeat('x', 200) from generate_series(1, 3000000) g",
            o.clone(),
        )
        .await
        .unwrap();
    let first = wait_done(&mut h).await;
    assert!(first
        .iter()
        .any(|e| matches!(e, ExecEvent::ResultSet { has_more: true, .. })));
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
    mgr.cancel(&h.id).unwrap();
    // the TxStatus event follows the cancel
    let mut late = Vec::new();
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_secs(5), h.events.recv()).await {
        late.push(e);
        if tx_statuses(&late).contains(&TxStatus::Failed) {
            break;
        }
    }
    assert_eq!(tx_statuses(&late), vec![TxStatus::Failed], "{late:?}");
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Failed);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Failed);

    let ev = run(&mgr, &s, "commit").await;
    assert_ok(&ev);
    assert_eq!(
        tx_ended(&ev),
        vec![(false, "ROLLBACK".to_string())],
        "{ev:?}"
    );
    assert_eq!(
        scalar(&run(&mgr, &s, "select count(*) from public.scratch_trk_cancel").await),
        json!(0),
        "the insert was rolled back"
    );

    // closing the result without cancelling (close_execution) still drains: the transaction survives
    assert_ok(&mgr.execute_collect(&s, "begin", o.clone()).await.unwrap());
    let mut h = mgr
        .execute(&s, "select g from generate_series(1, 100000) g", o.clone())
        .await
        .unwrap();
    wait_done(&mut h).await;
    mgr.close_execution(&h.id).unwrap();
    assert_eq!(scalar(&run(&mgr, &s, "select 1").await), json!(1));
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Active);
    assert_ok(&run(&mgr, &s, "rollback").await);

    // outside a transaction a cancel changes nothing
    let mut h = mgr
        .execute(&s, "select g from generate_series(1, 1000000) g", o.clone())
        .await
        .unwrap();
    wait_done(&mut h).await;
    mgr.cancel(&h.id).unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
    assert_eq!(scalar(&run(&mgr, &s, "select 2").await), json!(2));
    assert_ok(&run(&mgr, &s, "drop table public.scratch_trk_cancel").await);
    mgr.close_session(&s).await;
}

/// Terminate the backend of `target` from another session of the same manager.
async fn terminate(mgr: &ConnectionManager, other: &SessionId, pid: &Value) {
    assert_ok(&run(mgr, other, &format!("select pg_terminate_backend({pid})")).await);
    tokio::time::sleep(Duration::from_millis(300)).await;
}

fn lost_flags(ev: &[ExecEvent]) -> Vec<(String, bool)> {
    ev.iter()
        .filter_map(|e| {
            if let ExecEvent::Error {
                message,
                connection_lost,
                ..
            } = e
            {
                Some((message.clone(), *connection_lost))
            } else {
                None
            }
        })
        .collect()
}

/// Item 0: `pg_terminate_backend` from a second session while a transaction is open.
#[tokio::test]
async fn lost_connection_inside_a_transaction() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    let other = mgr.open_session("pg").await.unwrap();
    assert_ok(&run(&mgr, &s, "begin").await);
    let pid = scalar(&run(&mgr, &s, "select pg_backend_pid()").await);
    terminate(&mgr, &other, &pid).await;

    // the statement that finds out: SQLSTATE prefix, flag, transaction ended, session dead
    let ev = run(&mgr, &s, "select 2").await;
    let l = lost_flags(&ev);
    assert_eq!(l.len(), 1, "{ev:?}");
    assert!(l[0].0.starts_with("[08006] "), "{}", l[0].0);
    assert!(l[0].1);
    assert_eq!(tx_ended(&ev), vec![(false, "CONNECTION LOST".to_string())]);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    assert!(matches!(ev.last(), Some(ExecEvent::Done { .. })));
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
    assert!(!mgr.session_in_transaction(&s).unwrap());
    let st = mgr.session_state(&s).unwrap();
    assert!(
        st.connection_lost
            && st.transaction_lost
            && !st.in_transaction
            && st.tx_status == TxStatus::Idle,
        "{st:?}"
    );

    // later calls: the same error at once, not a hang, no matter what they are
    for sql in ["select 3", "rollback", "commit", "begin"] {
        let ev = tokio::time::timeout(Duration::from_secs(5), run(&mgr, &s, sql))
            .await
            .expect("must not hang");
        let l = lost_flags(&ev);
        assert_eq!(l.len(), 1, "{sql}: {ev:?}");
        assert!(l[0].0.starts_with("[08006] ") && l[0].1, "{sql}: {l:?}");
        assert!(tx_ended(&ev).is_empty() && tx_statuses(&ev).is_empty());
    }
    let t = ObjectRef::table(Some("public"), "nothing");
    let e = mgr
        .table_data_in_session(&s, &t, &Default::default())
        .await
        .unwrap_err();
    assert!(e.is_connection_lost(), "{e}");

    // closing a dead session is fine
    mgr.close_session(&s).await;
    assert!(mgr.session_state(&s).is_err());
    mgr.close_session(&s).await;
    mgr.close_session(&other).await;
}

/// Item 0 (e): without a transaction the next `execute` reopens the connection transparently.
#[tokio::test]
async fn lost_connection_outside_a_transaction_reconnects_on_the_next_execute() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    let other = mgr.open_session("pg").await.unwrap();
    assert_ok(&run(&mgr, &s, "set search_path = pg_catalog").await);
    let pid = scalar(&run(&mgr, &s, "select pg_backend_pid()").await);
    terminate(&mgr, &other, &pid).await;

    let ev = run(&mgr, &s, "select 1").await;
    let l = lost_flags(&ev);
    assert_eq!(l.len(), 1, "{ev:?}");
    assert!(l[0].0.starts_with("[08006] ") && l[0].1);
    assert!(tx_ended(&ev).is_empty(), "no transaction was open: {ev:?}");
    let st = mgr.session_state(&s).unwrap();
    assert!(st.connection_lost && !st.transaction_lost);

    let ev = run(
        &mgr,
        &s,
        "select pg_backend_pid(), current_setting('search_path')",
    )
    .await;
    assert_ok(&ev);
    assert!(
        ev.iter().any(
            |e| matches!(e, ExecEvent::Message { text, .. } if text.contains("new connection"))
        ),
        "{ev:?}"
    );
    let (_, rows, _) = first_rs(&ev);
    assert_ne!(rows[0][0], pid, "a new backend");
    assert_ne!(
        rows[0][1],
        json!("pg_catalog"),
        "settings are not carried over"
    );
    let st = mgr.session_state(&s).unwrap();
    assert!(!st.connection_lost && !st.transaction_lost);
    // the session is fully usable again, also for cancel
    assert_eq!(scalar(&run(&mgr, &s, "select 5").await), json!(5));
    mgr.close_session(&s).await;
    mgr.close_session(&other).await;
}

/// A server-side `FATAL` ends the session: `idle_in_transaction_session_timeout` (25P03) closes the connection
/// under an open transaction. The statement that finds out is reported as a lost connection.
#[tokio::test]
async fn idle_in_transaction_timeout_is_a_lost_connection() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    assert_ok(&run(&mgr, &s, "set idle_in_transaction_session_timeout = '1s'").await);
    assert_ok(&run(&mgr, &s, "begin").await);
    tokio::time::sleep(Duration::from_secs(2)).await;

    let ev = run(&mgr, &s, "select 1").await;
    let l = lost_flags(&ev);
    assert_eq!(l.len(), 1, "{ev:?}");
    assert!(l[0].1, "connectionLost must be set: {l:?}");
    assert!(l[0].0.contains("idle-in-transaction timeout"), "{}", l[0].0);
    assert_eq!(tx_ended(&ev), vec![(false, "CONNECTION LOST".to_string())]);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    let st = mgr.session_state(&s).unwrap();
    assert!(st.connection_lost && st.transaction_lost, "{st:?}");
    mgr.close_session(&s).await;
}

/// Plain `ERROR`s stay ordinary errors that leave the session alive: statement_timeout (57014), lock_timeout
/// (55P03) and a deadlock (40P01).
#[tokio::test]
async fn timeouts_and_deadlocks_are_not_lost_connections() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    let o = mgr.open_session("pg").await.unwrap();

    assert_ok(&run(&mgr, &s, "set statement_timeout = '200ms'").await);
    let ev = run(&mgr, &s, "select pg_sleep(2)").await;
    let l = lost_flags(&ev);
    assert!(
        l.len() == 1 && l[0].0.starts_with("[57014]") && !l[0].1,
        "{l:?}"
    );
    assert_ok(&run(&mgr, &s, "set statement_timeout = 0").await);
    assert!(!mgr.session_state(&s).unwrap().connection_lost);

    assert_ok(&run(&mgr, &s, "drop table if exists public.scratch_lost_a; create table public.scratch_lost_a (id int primary key, v int); insert into public.scratch_lost_a values (1, 0), (2, 0)").await);
    assert_ok(&run(&mgr, &s, "set lock_timeout = '200ms'; begin; update public.scratch_lost_a set v = 1 where id = 1").await);
    assert_ok(&run(&mgr, &o, "set lock_timeout = '200ms'; begin").await);
    let ev = run(
        &mgr,
        &o,
        "update public.scratch_lost_a set v = 2 where id = 1",
    )
    .await;
    let l = lost_flags(&ev);
    assert!(
        l.len() == 1 && l[0].0.starts_with("[55P03]") && !l[0].1,
        "{l:?}"
    );
    assert_ok(&run(&mgr, &o, "rollback").await);
    assert_ok(&run(&mgr, &s, "rollback").await);

    // deadlock: s locks 1, o locks 2, s wants 2 (waits), o wants 1 -> one of them is the victim
    assert_ok(&run(&mgr, &s, "set lock_timeout = 0; set deadlock_timeout = '100ms'; begin; update public.scratch_lost_a set v = 1 where id = 1").await);
    assert_ok(&run(&mgr, &o, "set lock_timeout = 0; set deadlock_timeout = '100ms'; begin; update public.scratch_lost_a set v = 2 where id = 2").await);
    let waiter = {
        let (mgr, s) = (mgr.clone(), s.clone());
        tokio::spawn(async move {
            run(
                &mgr,
                &s,
                "update public.scratch_lost_a set v = 1 where id = 2",
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let ev_o = run(
        &mgr,
        &o,
        "update public.scratch_lost_a set v = 2 where id = 1",
    )
    .await;
    let ev_s = waiter.await.unwrap();
    let all: Vec<(String, bool)> = lost_flags(&ev_o)
        .into_iter()
        .chain(lost_flags(&ev_s))
        .collect();
    assert!(
        all.iter().any(|(m, _)| m.starts_with("[40P01]")),
        "one side is the deadlock victim: {all:?}"
    );
    assert!(all.iter().all(|(_, lost)| !lost), "{all:?}");
    assert!(
        !mgr.session_state(&s).unwrap().connection_lost
            && !mgr.session_state(&o).unwrap().connection_lost
    );
    assert_ok(&run(&mgr, &o, "rollback").await);
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert_ok(&run(&mgr, &s, "drop table public.scratch_lost_a").await);
    mgr.close_session(&s).await;
    mgr.close_session(&o).await;
}

/// The connection dies while a paged result is open: `fetch_more` fails with the lost error and the session is dead.
#[tokio::test]
async fn lost_connection_while_paging() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("pg").await.unwrap();
    let other = mgr.open_session("pg").await.unwrap();
    let o = ExecOptions {
        max_rows: 10,
        stop_on_error: true,
        keep_open_secs: 600,
    };
    assert_ok(&mgr.execute_collect(&s, "begin", o.clone()).await.unwrap());
    let pid = scalar(&run(&mgr, &s, "select pg_backend_pid()").await);
    let mut h = mgr
        .execute(
            &s,
            "select g, repeat('x', 1000) from generate_series(1, 3000000) g",
            o.clone(),
        )
        .await
        .unwrap();
    wait_done(&mut h).await;
    terminate(&mgr, &other, &pid).await;
    let mut err = None;
    for _ in 0..2000 {
        match mgr.fetch_more(&h.id, 0, 1000).await {
            Ok(_) => {}
            Err(e) => {
                err = Some(e);
                break;
            }
        }
    }
    let e = err.expect("fetch_more must fail once the buffered rows run out");
    assert!(
        e.is_connection_lost() && e.to_string().starts_with("[08006] "),
        "{e}"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    let st = mgr.session_state(&s).unwrap();
    assert!(
        st.connection_lost && st.transaction_lost && st.tx_status == TxStatus::Idle,
        "{st:?}"
    );
    mgr.close_session(&s).await;
    mgr.close_session(&other).await;
}
