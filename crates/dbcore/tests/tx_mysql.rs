//! MySQL transaction tracking against the real server: nothing is sent between the user's statements (so
//! `row_count()` / `show warnings` stay correct), and the tracker must still equal what the server thinks. Run with:
//!   PROMETEO_MYSQL_URL=mysql://root:prometeo@localhost:33069/demo cargo test -p dbcore --test tx_mysql -- --nocapture

mod common;

use common::*;
use dbcore::*;
use serde_json::json;
use std::time::Duration;

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

/// TEST-ONLY ground truth: `SET TRANSACTION` is refused with error 1568 while a transaction is in progress.
async fn truth(mgr: &ConnectionManager, s: &SessionId) -> TxStatus {
    let ev = run(mgr, s, "set transaction isolation level read committed").await;
    match errors(&ev).first() {
        None => TxStatus::Idle,
        Some(m) if m.contains("[1568]") => TxStatus::Active,
        Some(m) => panic!("unexpected truth probe error: {m}"),
    }
}

fn rows(ev: &[ExecEvent]) -> Vec<Vec<serde_json::Value>> {
    assert_ok(ev);
    if ev.iter().any(|e| matches!(e, ExecEvent::ResultSet { .. })) {
        first_rs(ev).1
    } else {
        Vec::new()
    }
}

/// `(setup, statement, commits)`: `setup` runs before the transaction starts; `commits` is what the *server* does
/// (checked below with the 1568 probe, not assumed). `{T}` is a table name unique to the case, `{U}` a table
/// created by `setup`. The first three are the cases proved by the re-check.
const COMMIT_CASES: &[(&str, &str, bool)] = &[
    ("", "create /* tmp */ temporary table {T}(i int)", false),
    ("", "/*!50001 create table {T}(i int) */", true),
    ("", "# hash comment\ncreate table {T}(i int)", true),
    ("", "-- dash comment\ncreate table {T}(i int)", true),
    ("", "/* a */ /* b */ create table {T}(i int)", true),
    ("", "/*+ hint */ create table {T}(i int)", true),
    ("", "CREATE/**/TABLE {T}(i int)", true),
    ("", "create /* a */ table /* b */ {T}(i int)", true),
    ("", "CrEaTe # x\n TaBlE {T}(i int)", true),
    ("", "create -- x\n table {T}(i int)", true),
    ("", "/*! create table {T}(i int) */", true),
    ("", "/*!50001 create */ table {T}(i int)", true),
    ("", "/*!80000 create table {T}(i int) */", true),
    ("", "/*!080000 create table {T}(i int) */", true),
    ("", "/*!999999 create table {T}(i int) */", false),
    ("", "/*!99999 create table {T}(i int) */ select 1", false),
    ("", "create table {T} select 1 as i", true),
    ("", "CREATE TABLE {T} AS SELECT 1 AS i", true),
    ("", "CREATE TEMPORARY TABLE {T} SELECT 1 AS i", false),
    (
        "",
        "create temporary /* x */ table {T} select 1 as i",
        false,
    ),
    ("", "create # x\n temporary table {T}(i int)", false),
    ("", "create -- x\n temporary table {T}(i int)", false),
    ("", "create /*!50001 temporary */ table {T}(i int)", false),
    ("", "/*!50001 create temporary table {T}(i int) */", false),
    (
        "create temporary table {U}(i int)",
        "DROP TEMPORARY TABLE {U}",
        false,
    ),
    (
        "create temporary table {U}(i int)",
        "drop /* x */ temporary /* y */ table {U}",
        false,
    ),
    ("create temporary table {U}(i int)", "drop table {U}", true),
    (
        "create temporary table {U}(i int)",
        "alter table {U} add j int",
        true,
    ),
    (
        "create temporary table {U}(i int)",
        "alter /* x */ table {U} add j int",
        true,
    ),
    ("create table {U}(i int)", "alter table {U} add j int", true),
    ("", "select 1 -- create table {T}(i int)", false),
    (
        "",
        "select 'create table {T}(i int)' # create table {T}(i int)",
        false,
    ),
    ("", "/* create table {T}(i int) */ select 1", false),
    ("", "select 1 /* ' */ , 2 -- '", false),
];

/// The classifier's reading of comments must equal the server's: every statement is run inside a transaction and
/// the 1568 probe says whether the server committed it; the tracker has to say the same.
#[tokio::test]
async fn comments_in_statements_commit_exactly_as_the_server_does() {
    let (_cfg, mgr) = setup!();
    let db = format!("scratch_cls_{}", std::process::id());
    let admin = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &admin, &format!("drop database if exists {db}; create database {db}; create table {db}.base (i int primary key) engine=innodb")).await);
    for (n, (setup, sql, commits)) in COMMIT_CASES.iter().enumerate() {
        let (t, u) = (format!("tc{n}"), format!("tu{n}"));
        let fill = |x: &str| x.replace("{T}", &t).replace("{U}", &u);
        let (setup, sql) = (fill(setup), fill(sql));
        let s = mgr.open_session("my").await.unwrap();
        assert_ok(&run(&mgr, &s, &format!("use {db}")).await);
        if !setup.is_empty() {
            assert_ok(&run(&mgr, &s, &setup).await);
        }
        assert_ok(
            &run(
                &mgr,
                &s,
                &format!("start transaction; insert into base values ({n})"),
            )
            .await,
        );
        assert_eq!(
            mgr.session_tx_status(&s).unwrap(),
            TxStatus::Active,
            "{sql}"
        );
        // the statement itself may fail (an empty statement after a skipped comment): it still ran or not on the server
        let _ = run(&mgr, &s, &sql).await;
        let want = if *commits {
            TxStatus::Idle
        } else {
            TxStatus::Active
        };
        assert_eq!(truth(&mgr, &s).await, want, "the server, for {sql:?}");
        assert_eq!(
            mgr.session_tx_status(&s).unwrap(),
            want,
            "the tracker, for {sql:?}"
        );
        mgr.close_session(&s).await;
    }
    assert_ok(&run(&mgr, &admin, &format!("drop database {db}")).await);
    mgr.close_session(&admin).await;
}

/// `SET autocommit` behind comments / in its spellings is followed (the next statement opens a transaction, the
/// server agrees), and `SET autocommit = 1` commits it.
#[tokio::test]
async fn set_autocommit_forms_behind_comments() {
    let (_cfg, mgr) = setup!();
    let db = format!("scratch_ac_{}", std::process::id());
    let admin = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &admin, &format!("drop database if exists {db}; create database {db}; create table {db}.base (i int primary key) engine=innodb")).await);
    let off = [
        "set autocommit = 0 -- manual",
        "SET @@session.autocommit=0",
        "SET autocommit=OFF /* x */",
        "set /* a */ autocommit /* b */ = /* c */ 0",
        "set # x\n session autocommit = false",
        "set @@local.autocommit = 'OFF'",
        "set @x = 1, autocommit = 0",
        "/*!50001 set autocommit = 0 */",
    ];
    let on = [
        "set autocommit = 1 -- x",
        "SET @@autocommit=ON /* x */",
        "set /* a */ autocommit /* b */ = TRUE",
        "set # x\n autocommit = 1",
    ];
    for (n, a) in off.iter().enumerate() {
        let b = &on[n % on.len()];
        let s = mgr.open_session("my").await.unwrap();
        assert_ok(&run(&mgr, &s, &format!("use {db}")).await);
        assert_ok(&run(&mgr, &s, a).await);
        assert_ok(&run(&mgr, &s, &format!("insert into base values ({n})")).await);
        assert_eq!(
            truth(&mgr, &s).await,
            TxStatus::Active,
            "the server, after {a:?}"
        );
        assert_eq!(
            mgr.session_tx_status(&s).unwrap(),
            TxStatus::Active,
            "the tracker, after {a:?}"
        );
        let ev = run(&mgr, &s, b).await;
        assert_ok(&ev);
        assert_eq!(
            tx_ended(&ev),
            vec![(true, "IMPLICIT COMMIT".to_string())],
            "{b:?}"
        );
        assert_eq!(
            truth(&mgr, &s).await,
            TxStatus::Idle,
            "the server, after {b:?}"
        );
        assert_eq!(
            mgr.session_tx_status(&s).unwrap(),
            TxStatus::Idle,
            "the tracker, after {b:?}"
        );
        mgr.close_session(&s).await;
    }
    assert_ok(&run(&mgr, &admin, &format!("drop database {db}")).await);
    mgr.close_session(&admin).await;
}

/// Item 2, the reviewer's probe: no hidden statement between the user's statements.
#[tokio::test]
async fn no_hidden_statements_between_user_statements() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop table if exists demo.scratch_trk_w; create table demo.scratch_trk_w (id int primary key, v int)").await);

    // show warnings after a plain statement is empty (the old probe left its own 1305 warning there)
    assert_ok(
        &run(
            &mgr,
            &s,
            "create table if not exists demo.scratch_trk_w (id int primary key, v int)",
        )
        .await,
    );
    let ev = run(&mgr, &s, "show warnings").await;
    let w = rows(&ev);
    assert_eq!(w.len(), 1, "{w:?}");
    assert_eq!(
        w[0][1],
        json!(1050),
        "the note of `create table if not exists`, nothing else: {w:?}"
    );
    assert_ok(&run(&mgr, &s, "select 1").await);
    assert!(rows(&run(&mgr, &s, "show warnings").await).is_empty());

    assert_ok(
        &run(
            &mgr,
            &s,
            "insert into demo.scratch_trk_w values (1,1),(2,2),(3,3)",
        )
        .await,
    );
    assert_ok(&run(&mgr, &s, "start transaction").await);
    assert_ok(&run(&mgr, &s, "update demo.scratch_trk_w set v = v + 1").await);
    assert_eq!(
        rows(&run(&mgr, &s, "select row_count()").await),
        vec![vec![json!(3)]],
        "row_count() of the UPDATE"
    );
    // insert ignore: the warning (duplicate) must survive until the user asks
    assert_ok(
        &run(
            &mgr,
            &s,
            "insert ignore into demo.scratch_trk_w values (1, 9)",
        )
        .await,
    );
    let w = rows(&run(&mgr, &s, "show warnings").await);
    assert_eq!(w.len(), 1, "{w:?}");
    assert_eq!(w[0][1], json!(1062));
    assert_eq!(
        rows(&run(&mgr, &s, "select row_count()").await),
        vec![vec![json!(-1)]]
    );
    // found_rows() after a SELECT with SQL_CALC_FOUND_ROWS
    assert_ok(
        &run(
            &mgr,
            &s,
            "select sql_calc_found_rows * from demo.scratch_trk_w limit 1",
        )
        .await,
    );
    assert_eq!(
        rows(&run(&mgr, &s, "select found_rows()").await),
        vec![vec![json!(3)]]
    );
    // as one script, too
    let ev = run(
        &mgr,
        &s,
        "update demo.scratch_trk_w set v = 0 where id = 1; select row_count()",
    )
    .await;
    assert_eq!(rows(&ev), vec![vec![json!(1)]]);
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Active);
    let ev = run(&mgr, &s, "rollback").await;
    assert_eq!(tx_ended(&ev), vec![(false, "ROLLBACK".to_string())]);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Idle);
    assert_ok(&run(&mgr, &s, "drop table demo.scratch_trk_w").await);
    mgr.close_session(&s).await;
}

/// `autocommit = 0`, the reviewer's probe: no spurious transaction, no spurious "committed implicitly".
#[tokio::test]
async fn autocommit_zero_is_followed_without_probing() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop table if exists demo.scratch_trk_ac; create table demo.scratch_trk_ac (id int primary key, v int); insert into demo.scratch_trk_ac values (1,1)").await);

    let ev = run(&mgr, &s, "set autocommit = 0").await;
    assert!(
        tx_statuses(&ev).is_empty() && tx_ended(&ev).is_empty(),
        "{ev:?}"
    );
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
    // COMMIT with nothing open, SELECT 1 (no table), SET: nothing starts
    let ev = run(&mgr, &s, "commit").await;
    assert!(tx_ended(&ev).is_empty() && tx_statuses(&ev).is_empty());
    assert_ok(&run(&mgr, &s, "select 1").await);
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Idle);
    // `set autocommit = 1` with nothing open must not claim an implicit commit
    let ev = run(&mgr, &s, "set autocommit = 1").await;
    assert!(
        tx_ended(&ev).is_empty()
            && tx_statuses(&ev).is_empty()
            && !ev.iter().any(|e| matches!(e, ExecEvent::Message { .. })),
        "{ev:?}"
    );
    let ev = run(&mgr, &s, "set autocommit = 0").await;
    assert!(tx_statuses(&ev).is_empty());

    // a statement on a table opens the transaction
    let ev = run(&mgr, &s, "update demo.scratch_trk_ac set v = 2").await;
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Active]);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Active);
    let ev = run(&mgr, &s, "commit").await;
    assert_eq!(tx_ended(&ev), vec![(true, "COMMIT".to_string())]);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Idle);

    // set autocommit = 1 commits what is open, and says so
    assert_ok(&run(&mgr, &s, "update demo.scratch_trk_ac set v = 3").await);
    let ev = run(&mgr, &s, "set autocommit = 1").await;
    assert_eq!(tx_ended(&ev), vec![(true, "IMPLICIT COMMIT".to_string())]);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Idle);
    assert_eq!(
        rows(&run(&mgr, &s, "select v from demo.scratch_trk_ac").await),
        vec![vec![json!(3)]]
    );

    // a session that starts with autocommit off (read once at open)
    let s2 = mgr
        .open_session_with("my", &["set autocommit = 0".to_string()])
        .await
        .unwrap();
    assert_eq!(mgr.session_tx_status(&s2).unwrap(), TxStatus::Idle);
    assert_ok(&run(&mgr, &s2, "update demo.scratch_trk_ac set v = 4").await);
    assert_eq!(mgr.session_tx_status(&s2).unwrap(), TxStatus::Active);
    assert_ok(&run(&mgr, &s2, "rollback").await);
    assert_eq!(
        rows(&run(&mgr, &s, "select v from demo.scratch_trk_ac").await),
        vec![vec![json!(3)]]
    );
    mgr.close_session(&s2).await;

    assert_ok(&run(&mgr, &s, "drop table demo.scratch_trk_ac").await);
    mgr.close_session(&s).await;
}

/// (name, setup statements, statement under test, expected state, expected `TxEnded`)
type Case = (
    &'static str,
    Vec<&'static str>,
    &'static str,
    TxStatus,
    Option<(bool, &'static str)>,
);

/// Every case: setup statements (one `execute` each), the statement under test, then tracker vs the server
/// (`truth`) and the documented behaviour (`expect`, `ended`).
#[tokio::test]
async fn tracker_matches_the_server_after_every_kind_of_statement() {
    let (_cfg, mgr) = setup!();
    let admin = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &admin, "drop table if exists demo.scratch_trk; create table demo.scratch_trk (id int primary key, v int); insert into demo.scratch_trk values (1,1),(2,2)").await);

    use TxStatus::{Active as A, Idle as I};
    const IC: Option<(bool, &str)> = Some((true, "IMPLICIT COMMIT"));
    const T: &str = "demo.scratch_trk";
    let q = |s: &str| s.replace("T.", "demo.scratch_trk ").replace("T", T);
    // (name, setup, statement under test, expected state, expected TxEnded)
    let cases: Vec<Case> = vec![
        ("select on idle autocommit", vec![], "select * from T", I, None),
        ("begin", vec![], "begin", A, None),
        ("start transaction", vec![], "start transaction read only", A, None),
        ("begin inside a transaction commits", vec!["begin"], "begin", A, IC),
        ("start transaction inside a transaction", vec!["begin"], "start transaction", A, IC),
        ("commit", vec!["begin"], "commit", I, Some((true, "COMMIT"))),
        ("commit work", vec!["begin"], "commit work", I, Some((true, "COMMIT"))),
        ("rollback", vec!["begin"], "rollback", I, Some((false, "ROLLBACK"))),
        ("commit and chain", vec!["begin"], "commit and chain", A, Some((true, "COMMIT"))),
        ("rollback and chain", vec!["begin"], "rollback and chain", A, Some((false, "ROLLBACK"))),
        ("commit and no chain", vec!["begin"], "commit and no chain", I, Some((true, "COMMIT"))),
        ("savepoint + rollback to", vec!["begin", "savepoint a"], "rollback to savepoint a", A, None),
        ("rollback to unknown savepoint", vec!["begin"], "rollback to savepoint nope", A, None),
        ("statement error keeps the transaction", vec!["begin"], "select * from demo.no_such_table_xyz", A, None),
        ("dml error keeps the transaction", vec!["begin"], "insert into T values (1, 1)", A, None),
        ("xa start", vec![], "xa start 'trk'", A, None),
        ("xa rollback", vec!["xa start 'trk'", "xa end 'trk'", "xa prepare 'trk'"], "xa rollback 'trk'", I, Some((false, "ROLLBACK"))),
        // implicit commits (manual 15.3.3)
        ("create table", vec!["begin"], "create table demo.scratch_trk_c1 (i int)", I, IC),
        ("drop table", vec!["begin"], "drop table demo.scratch_trk_c1", I, IC),
        ("alter table", vec!["begin"], "alter table T add column x int", I, IC),
        ("alter table (drop column)", vec!["begin"], "alter table T drop column x", I, IC),
        ("create index", vec!["begin"], "create index trk_i on T (v)", I, IC),
        ("drop index", vec!["begin"], "drop index trk_i on T", I, IC),
        ("rename table", vec!["begin"], "rename table demo.scratch_trk_c2 to demo.scratch_trk_c3", I, IC),
        ("truncate", vec!["begin"], "truncate table demo.scratch_trk_c3", I, IC),
        ("create database", vec!["begin"], "create database if not exists scratch_trk_db", I, IC),
        ("drop database", vec!["begin"], "drop database if exists scratch_trk_db", I, IC),
        ("create view", vec!["begin"], "create or replace view demo.scratch_trk_v as select 1 as a", I, IC),
        ("drop view", vec!["begin"], "drop view demo.scratch_trk_v", I, IC),
        ("create procedure", vec!["begin"], "create procedure demo.scratch_trk_p() select 1", I, IC),
        ("drop procedure", vec!["begin"], "drop procedure demo.scratch_trk_p", I, IC),
        ("create function", vec!["begin"], "create function demo.scratch_trk_f() returns int deterministic return 1", I, IC),
        ("drop function", vec!["begin"], "drop function demo.scratch_trk_f", I, IC),
        ("create trigger", vec!["begin"], "create trigger demo.scratch_trk_tr before insert on demo.scratch_trk for each row set new.v = 1", I, IC),
        ("drop trigger", vec!["begin"], "drop trigger demo.scratch_trk_tr", I, IC),
        ("create event", vec!["begin"], "create event demo.scratch_trk_ev on schedule every 1 day disable do select 1", I, IC),
        ("drop event", vec!["begin"], "drop event demo.scratch_trk_ev", I, IC),
        ("create user", vec!["begin"], "create user 'scratch_trk_u'@'localhost' identified by 'x'", I, IC),
        ("alter user", vec!["begin"], "alter user 'scratch_trk_u'@'localhost' identified by 'y'", I, IC),
        ("grant", vec!["begin"], "grant select on demo.scratch_trk to 'scratch_trk_u'@'localhost'", I, IC),
        ("revoke", vec!["begin"], "revoke select on demo.scratch_trk from 'scratch_trk_u'@'localhost'", I, IC),
        ("set password", vec!["begin"], "set password for 'scratch_trk_u'@'localhost' = 'z'", I, IC),
        ("rename user", vec!["begin"], "rename user 'scratch_trk_u'@'localhost' to 'scratch_trk_u2'@'localhost'", I, IC),
        ("drop user", vec!["begin"], "drop user 'scratch_trk_u2'@'localhost'", I, IC),
        ("lock tables", vec!["begin"], "lock tables T write", I, IC),
        ("unlock tables after lock tables", vec!["lock tables T write", "begin", "update T set v = 1"], "unlock tables", A, None),
        ("unlock tables without a lock", vec!["begin"], "unlock tables", A, None),
        ("analyze table", vec!["begin"], "analyze table T", I, IC),
        ("check table", vec!["begin"], "check table T", I, IC),
        ("optimize table", vec!["begin"], "optimize table T", I, IC),
        ("repair table", vec!["begin"], "repair table T", I, IC),
        ("flush tables", vec!["begin"], "flush tables", I, IC),
        ("flush status", vec!["begin"], "flush status", I, IC),
        ("set autocommit = 1 (already 1)", vec!["begin"], "set autocommit = 1", A, None),
        // exceptions: temporary tables do not commit
        ("create temporary table", vec!["begin"], "create temporary table demo.scratch_trk_tmp (i int)", A, None),
        ("drop temporary table", vec!["begin", "create temporary table demo.scratch_trk_tmp2 (i int)"], "drop temporary table demo.scratch_trk_tmp2", A, None),
        // commits before it runs, so also when it fails (other than a parse error)
        ("failing create table", vec!["begin"], "create table T (i int)", I, IC),
        ("failing grant (no such user)", vec!["begin"], "grant select on demo.scratch_trk to 'scratch_trk_nobody'@'localhost'", I, IC),
        ("syntax error in a create", vec!["begin"], "create table", A, None),
        // autocommit = 0
        ("ac0: nothing yet", vec!["set autocommit = 0"], "set @x = 1", I, None),
        ("ac0: select 1", vec!["set autocommit = 0"], "select 1", I, None),
        ("ac0: show warnings", vec!["set autocommit = 0"], "show warnings", I, None),
        ("ac0: use", vec!["set autocommit = 0"], "use demo", I, None),
        ("ac0: select from table", vec!["set autocommit = 0"], "select * from T", A, None),
        ("ac0: update", vec!["set autocommit = 0"], "update T set v = v", A, None),
        ("ac0: insert", vec!["set autocommit = 0"], "insert into T values (99, 9)", A, None),
        ("ac0: duplicate key opens it anyway", vec!["set autocommit = 0"], "insert into T values (1, 9)", A, None),
        ("ac0: syntax error does not", vec!["set autocommit = 0"], "selec * from T", I, None),
        ("ac0: unknown table does not", vec!["set autocommit = 0"], "select * from demo.no_such_table_xyz", I, None),
        ("ac0: show tables", vec!["set autocommit = 0"], "show tables", A, None),
        ("ac0: commit", vec!["set autocommit = 0", "update T set v = v"], "commit", I, Some((true, "COMMIT"))),
        ("ac0: rollback", vec!["set autocommit = 0", "update T set v = v"], "rollback", I, Some((false, "ROLLBACK"))),
        ("ac0: commit and chain", vec!["set autocommit = 0", "update T set v = v"], "commit and chain", A, Some((true, "COMMIT"))),
        ("ac0: ddl", vec!["set autocommit = 0", "update T set v = v"], "create table demo.scratch_trk_c4 (i int)", I, IC),
        ("ac0: ddl alone", vec!["set autocommit = 0"], "drop table demo.scratch_trk_c4", I, None),
        ("ac0: set autocommit = 1 commits", vec!["set autocommit = 0", "update T set v = v"], "set autocommit = 1", I, IC),
        ("ac0: set autocommit = 0 again", vec!["set autocommit = 0", "update T set v = v"], "set autocommit = 0", A, None),
        ("ac0: begin", vec!["set autocommit = 0", "update T set v = v"], "begin", A, IC),
        ("ac0: begin then commit", vec!["set autocommit = 0", "begin"], "commit", I, Some((true, "COMMIT"))),
        ("ac0 spelled SESSION", vec!["set session autocommit = 0"], "update T set v = v", A, None),
        ("ac0 spelled @@", vec!["set @@autocommit = off"], "update T set v = v", A, None),
        ("ac0 spelled @@session.", vec!["set @@session.autocommit = 'OFF'"], "update T set v = v", A, None),
        ("ac0 in a list", vec!["set @a = 1, autocommit = false"], "update T set v = v", A, None),
        ("ac0 then 1 spelled ON", vec!["set autocommit = 0", "set autocommit = ON"], "update T set v = v", I, None),
        ("user variable named autocommit", vec!["set @autocommit = 0"], "update T set v = v", I, None),
        ("global autocommit is not the session one", vec!["set global autocommit = 1"], "update T set v = v", I, None),
    ];

    let mut bad = Vec::new();
    for (name, setup, stmt, expect, expect_ended) in cases {
        let s = mgr.open_session("my").await.unwrap();
        // objects some cases drop / rename
        for st in setup.iter().map(|s| q(s)).collect::<Vec<_>>() {
            run(&mgr, &s, &st).await;
        }
        if name.contains("drop table")
            || name.contains("rename")
            || name.contains("truncate")
            || name.contains("ddl alone")
        {
            run(&mgr, &admin, "create table if not exists demo.scratch_trk_c1 (i int); create table if not exists demo.scratch_trk_c2 (i int); create table if not exists demo.scratch_trk_c3 (i int); create table if not exists demo.scratch_trk_c4 (i int)").await;
        }
        let stmt = q(stmt);
        let ev = run(&mgr, &s, &stmt).await;
        let tracked = mgr.session_tx_status(&s).unwrap();
        let real = truth(&mgr, &s).await;
        let ended = tx_ended(&ev);
        println!(
            "{name:45} tracker={tracked:?} server={real:?} ended={ended:?} err={:?}",
            errors(&ev)
                .first()
                .map(|m| m.chars().take(60).collect::<String>())
        );
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
        run(&mgr, &s, "rollback").await;
        mgr.close_session(&s).await;
    }
    run(&mgr, &admin, "drop table if exists demo.scratch_trk; drop table if exists demo.scratch_trk_c1; drop table if exists demo.scratch_trk_c2; drop table if exists demo.scratch_trk_c3; drop table if exists demo.scratch_trk_c4; drop view if exists demo.scratch_trk_v; drop database if exists scratch_trk_db; drop user if exists 'scratch_trk_u'@'localhost'; drop user if exists 'scratch_trk_u2'@'localhost'").await;
    mgr.close_session(&admin).await;
    assert!(bad.is_empty(), "tracker drift:\n{}", bad.join("\n"));
}

/// Item 1 for MySQL: `KILL QUERY` rolls back the statement only; the transaction stays and keeps its earlier work.
#[tokio::test]
async fn cancel_inside_a_transaction_keeps_it_active() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop table if exists demo.scratch_trk_k; create table demo.scratch_trk_k (id int primary key, v int); insert into demo.scratch_trk_k values (1,1),(2,2),(3,3)").await);
    let o = ExecOptions {
        max_rows: 100,
        stop_on_error: true,
        keep_open_secs: 600,
    };
    assert_ok(
        &mgr.execute_collect(
            &s,
            "begin; insert into demo.scratch_trk_k values (4,4)",
            o.clone(),
        )
        .await
        .unwrap(),
    );

    // 1. cancel a paged result
    let mut h = mgr
        .execute(&s, "select * from demo.big_table", o.clone())
        .await
        .unwrap();
    let first = wait_done(&mut h).await;
    assert!(first
        .iter()
        .any(|e| matches!(e, ExecEvent::ResultSet { has_more: true, .. })));
    mgr.cancel(&h.id).unwrap();
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Active);

    // 2. cancel a running UPDATE: the statement is rolled back, the transaction is not
    let mut h = mgr
        .execute(
            &s,
            "update demo.scratch_trk_k set v = v + 100 + sleep(2)",
            o.clone(),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(700)).await;
    mgr.cancel(&h.id).unwrap();
    let ev = wait_done(&mut h).await;
    assert_eq!(errors(&ev).len(), 1, "{ev:?}");
    assert!(
        tx_statuses(&ev).is_empty(),
        "the transaction state did not change: {ev:?}"
    );
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Active);
    assert_eq!(truth(&mgr, &s).await, TxStatus::Active);
    // the UPDATE is gone, the earlier INSERT is not
    assert_eq!(
        rows(&run(&mgr, &s, "select id, v from demo.scratch_trk_k order by id").await).len(),
        4
    );
    assert_eq!(
        scalar(&run(&mgr, &s, "select sum(v) from demo.scratch_trk_k").await),
        json!("10")
    );

    let ev = run(&mgr, &s, "commit").await;
    assert_eq!(
        tx_ended(&ev),
        vec![(true, "COMMIT".to_string())],
        "the COMMIT really commits: {ev:?}"
    );
    assert_eq!(
        scalar(&run(&mgr, &s, "select count(*) from demo.scratch_trk_k").await),
        json!(4)
    );
    assert_ok(&run(&mgr, &s, "drop table demo.scratch_trk_k").await);
    mgr.close_session(&s).await;
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

/// Item 0 for MySQL: `KILL <connection id>` from a second session.
#[tokio::test]
async fn lost_connection_inside_a_transaction() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    let other = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "begin").await);
    let id = scalar(&run(&mgr, &s, "select connection_id()").await);
    assert_ok(&run(&mgr, &other, &format!("kill {id}")).await);
    tokio::time::sleep(Duration::from_millis(300)).await;

    let ev = run(&mgr, &s, "select 2").await;
    let l = lost_flags(&ev);
    assert_eq!(l.len(), 1, "{ev:?}");
    assert!(l[0].0.starts_with("[08S01] "), "{}", l[0].0);
    assert!(l[0].1);
    assert_eq!(tx_ended(&ev), vec![(false, "CONNECTION LOST".to_string())]);
    assert_eq!(tx_statuses(&ev), vec![TxStatus::Idle]);
    assert_eq!(mgr.session_tx_status(&s).unwrap(), TxStatus::Idle);
    assert!(!mgr.session_in_transaction(&s).unwrap());
    let st = mgr.session_state(&s).unwrap();
    assert!(st.connection_lost && st.transaction_lost, "{st:?}");

    for sql in ["select 3", "rollback", "commit"] {
        let ev = tokio::time::timeout(Duration::from_secs(5), run(&mgr, &s, sql))
            .await
            .expect("must not hang");
        let l = lost_flags(&ev);
        assert_eq!(l.len(), 1, "{sql}: {ev:?}");
        assert!(l[0].0.starts_with("[08S01] ") && l[0].1, "{sql}: {l:?}");
    }
    mgr.close_session(&s).await;
    mgr.close_session(&s).await;
    mgr.close_session(&other).await;
}

/// `wait_timeout` expiry: the server closes an idle connection; since 8.0.24 it says so (4031
/// `ER_CLIENT_INTERACTION_TIMEOUT`) when the client talks next, older servers just drop the socket.
#[tokio::test]
async fn idle_timeout_is_a_lost_connection() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "set session wait_timeout = 2").await);
    assert_ok(&run(&mgr, &s, "begin").await);
    tokio::time::sleep(Duration::from_secs(3)).await;

    let ev = run(&mgr, &s, "select 1").await;
    let l = lost_flags(&ev);
    assert_eq!(l.len(), 1, "{ev:?}");
    assert!(l[0].1, "connectionLost must be set: {l:?}");
    assert_eq!(tx_ended(&ev), vec![(false, "CONNECTION LOST".to_string())]);
    assert!(mgr.session_state(&s).unwrap().connection_lost);
    mgr.close_session(&s).await;
}

/// Ordinary server errors (lock wait timeout 1205, deadlock 1213) do not lose the connection.
#[tokio::test]
async fn lock_timeout_and_deadlock_are_not_lost_connections() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    let o = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "drop table if exists demo.scratch_lost_a; create table demo.scratch_lost_a (id int primary key, v int) engine=innodb; insert into demo.scratch_lost_a values (1, 0), (2, 0)").await);
    assert_ok(&run(&mgr, &s, "set innodb_lock_wait_timeout = 1; begin; update demo.scratch_lost_a set v = 1 where id = 1").await);
    assert_ok(&run(&mgr, &o, "set innodb_lock_wait_timeout = 1; begin").await);
    let ev = run(
        &mgr,
        &o,
        "update demo.scratch_lost_a set v = 2 where id = 1",
    )
    .await;
    let l = lost_flags(&ev);
    assert!(
        l.len() == 1 && l[0].0.contains("[1205]") && !l[0].1,
        "{l:?}"
    );
    assert_ok(&run(&mgr, &o, "rollback").await);
    assert_ok(&run(&mgr, &s, "rollback").await);

    assert_ok(&run(&mgr, &s, "set innodb_lock_wait_timeout = 10; begin; update demo.scratch_lost_a set v = 1 where id = 1").await);
    assert_ok(&run(&mgr, &o, "set innodb_lock_wait_timeout = 10; begin; update demo.scratch_lost_a set v = 2 where id = 2").await);
    let waiter = {
        let (mgr, s) = (mgr.clone(), s.clone());
        tokio::spawn(async move {
            run(
                &mgr,
                &s,
                "update demo.scratch_lost_a set v = 1 where id = 2",
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let ev_o = run(
        &mgr,
        &o,
        "update demo.scratch_lost_a set v = 2 where id = 1",
    )
    .await;
    let ev_s = waiter.await.unwrap();
    let all: Vec<(String, bool)> = lost_flags(&ev_o)
        .into_iter()
        .chain(lost_flags(&ev_s))
        .collect();
    assert!(
        all.iter().any(|(m, _)| m.contains("[1213]")),
        "one side is the deadlock victim: {all:?}"
    );
    assert!(all.iter().all(|(_, lost)| !lost), "{all:?}");
    assert!(
        !mgr.session_state(&s).unwrap().connection_lost
            && !mgr.session_state(&o).unwrap().connection_lost
    );
    assert_ok(&run(&mgr, &o, "rollback").await);
    assert_ok(&run(&mgr, &s, "rollback").await);
    assert_ok(&run(&mgr, &s, "drop table demo.scratch_lost_a").await);
    mgr.close_session(&s).await;
    mgr.close_session(&o).await;
}

#[tokio::test]
async fn lost_connection_outside_a_transaction_reconnects_on_the_next_execute() {
    let (_cfg, mgr) = setup!();
    let s = mgr.open_session("my").await.unwrap();
    let other = mgr.open_session("my").await.unwrap();
    assert_ok(&run(&mgr, &s, "use information_schema").await);
    let id = scalar(&run(&mgr, &s, "select connection_id()").await);
    assert_ok(&run(&mgr, &other, &format!("kill {id}")).await);
    tokio::time::sleep(Duration::from_millis(300)).await;

    let ev = run(&mgr, &s, "select 1").await;
    let l = lost_flags(&ev);
    assert_eq!(l.len(), 1, "{ev:?}");
    assert!(l[0].0.starts_with("[08S01] ") && l[0].1);
    assert!(tx_ended(&ev).is_empty());
    assert!(!mgr.session_state(&s).unwrap().transaction_lost);

    let ev = run(&mgr, &s, "select connection_id(), database()").await;
    assert_ok(&ev);
    assert!(
        ev.iter().any(
            |e| matches!(e, ExecEvent::Message { text, .. } if text.contains("new connection"))
        ),
        "{ev:?}"
    );
    let (_, r, _) = first_rs(&ev);
    assert_ne!(r[0][0], id);
    assert_ne!(r[0][1], json!("information_schema"));
    assert!(!mgr.session_state(&s).unwrap().connection_lost);
    mgr.close_session(&s).await;
    mgr.close_session(&other).await;
}
