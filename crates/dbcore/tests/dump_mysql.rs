//! MySQL whole-database dump / restore round-trip. Needs PROMETEO_MYSQL_URL (see `make test-rust-db`):
//!   cargo test -p dbcore --test dump_mysql -- --nocapture

mod common;

use common::*;
use dbcore::import::CancellationToken;
use dbcore::*;
use serde_json::json;

/// Self-contained schema built on a placeholder database name: FK, self FK, unique, index, view,
/// auto_increment, unicode, NULL, binary and date values.
const SEED: &str = r#"
create table __DB__.parents (
    id int auto_increment primary key,
    name varchar(50) not null unique,
    amount decimal(12,2) not null default 0,
    born date null,
    raw varbinary(8) null
);
create table __DB__.children (
    id int auto_increment primary key,
    parent_id int not null,
    boss_id int null,
    label varchar(50),
    key idx_children_label (label),
    constraint fk_parent foreign key (parent_id) references __DB__.parents (id),
    constraint fk_boss foreign key (boss_id) references __DB__.children (id)
);
create view __DB__.v_children as select c.id, p.name as parent, c.label from __DB__.children c join __DB__.parents p on p.id = c.parent_id;
insert into __DB__.parents (name, amount, born, raw) values ('Alpha', 10.50, '2001-02-03', x'00ff10'), ('Bêta ''q''', 20.25, null, null);
insert into __DB__.children (parent_id, boss_id, label) values (1, null, 'c1'), (2, 1, 'héllo\\n');
"#;

async fn tables(mgr: &ConnectionManager, s: &SessionId, db: &str) -> Vec<String> {
    let sql = format!("select cast(table_name as char) from information_schema.tables where table_schema = '{db}' order by table_name");
    first_rs(&run(mgr, s, &sql).await)
        .1
        .into_iter()
        .map(|r| r[0].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn dump_restore_round_trip() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("PROMETEO_MYSQL_URL not set: skipping");
        return;
    };
    let mgr = &connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    let (src, dst) = ("dump_src_my", "dump_dst_my");
    assert_ok(
        &run(
            mgr,
            &s,
            &format!("drop database if exists {dst}; drop database if exists {src}; create database {src};"),
        )
        .await,
    );
    assert_ok(&run(mgr, &s, &SEED.replace("__DB__", src)).await);

    let mut buf = Vec::new();
    let res = mgr
        .dump_schema(
            &cfg.id,
            src,
            &DumpOptions {
                target_schema: Some(dst.into()),
                ..Default::default()
            },
            &CancellationToken::new(),
            &|_| {},
            &mut buf,
        )
        .await
        .unwrap();
    assert_eq!(res.tables, 2);
    assert_eq!(res.rows, 4);
    let dump = String::from_utf8(buf).unwrap();
    assert!(!dump.contains(src), "source database leaked:\n{dump}");

    assert_ok(&run(mgr, &s, &format!("create database {dst}; use {dst};")).await);
    let ev = mgr
        .execute_collect(
            &s,
            &dump,
            ExecOptions {
                max_rows: 10,
                stop_on_error: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_ok(&ev);

    assert_eq!(tables(mgr, &s, src).await, tables(mgr, &s, dst).await);
    for t in ["parents", "children"] {
        assert_eq!(
            first_rs(&run(mgr, &s, &format!("select * from {src}.{t} order by id")).await).1,
            first_rs(&run(mgr, &s, &format!("select * from {dst}.{t} order by id")).await).1,
            "content of {t}"
        );
    }
    assert_eq!(
        scalar(&run(mgr, &s, &format!("select count(*) from {dst}.v_children")).await),
        json!(2)
    );
    // auto_increment continues after the restored rows, the FKs are enforced
    assert_ok(
        &run(
            mgr,
            &s,
            &format!("insert into {dst}.parents (name) values ('Gamma')"),
        )
        .await,
    );
    assert_eq!(
        scalar(&run(mgr, &s, &format!("select max(id) from {dst}.parents")).await),
        json!(3)
    );
    let ev = run(
        mgr,
        &s,
        &format!("insert into {dst}.children (parent_id) values (99)"),
    )
    .await;
    assert!(
        errors(&ev)[0].contains("foreign key constraint"),
        "{:?}",
        errors(&ev)
    );

    assert_ok(
        &run(
            mgr,
            &s,
            &format!("drop database if exists {dst}; drop database if exists {src};"),
        )
        .await,
    );
    mgr.close_session(&s).await;
}

async fn restore_text(mgr: &ConnectionManager, s: &SessionId, dump: &str) {
    let ev = mgr
        .execute_collect(
            s,
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
}

async fn dump_with(
    mgr: &ConnectionManager,
    id: &str,
    src: &str,
    dst: &str,
    opts: DumpOptions,
) -> (String, DumpResult) {
    let mut buf = Vec::new();
    let res = mgr
        .dump_schema(
            id,
            src,
            &DumpOptions {
                target_schema: Some(dst.into()),
                ..opts
            },
            &CancellationToken::new(),
            &|_| {},
            &mut buf,
        )
        .await
        .unwrap();
    (String::from_utf8(buf).unwrap(), res)
}

/// Restoring twice with `drop_if_exists`, a table subset, and a data-only dump with commits.
#[tokio::test]
async fn drop_if_exists_twice_subset_and_data_only() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("PROMETEO_MYSQL_URL not set: skipping");
        return;
    };
    let mgr = &connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    let (src, dst) = ("dump_src_my2", "dump_dst_my2");
    assert_ok(
        &run(
            mgr,
            &s,
            &format!("drop database if exists {dst}; drop database if exists {src}; create database {src}; create database {dst};"),
        )
        .await,
    );
    assert_ok(&run(mgr, &s, &SEED.replace("__DB__", src)).await);

    // twice into the same database
    let (dump, res) = dump_with(
        mgr,
        &cfg.id,
        src,
        dst,
        DumpOptions {
            drop_if_exists: true,
            ..Default::default()
        },
    )
    .await;
    assert_eq!((res.tables, res.rows), (2, 4));
    restore_text(mgr, &s, &dump).await;
    restore_text(mgr, &s, &dump).await;
    assert_eq!(
        scalar(&run(mgr, &s, &format!("select count(*) from {dst}.children")).await),
        json!(2)
    );

    // a subset: no view, only the asked table
    assert_ok(
        &run(
            mgr,
            &s,
            &format!("drop database {dst}; create database {dst};"),
        )
        .await,
    );
    let (dump, res) = dump_with(
        mgr,
        &cfg.id,
        src,
        dst,
        DumpOptions {
            tables: Some(vec!["parents".into()]),
            include_routines: true,
            ..Default::default()
        },
    )
    .await;
    assert_eq!((res.tables, res.rows), (1, 2));
    assert!(
        !dump.contains("children") && !dump.contains("v_children"),
        "{dump}"
    );
    restore_text(mgr, &s, &dump).await;
    assert_eq!(tables(mgr, &s, dst).await, vec!["parents".to_string()]);

    // data only into the existing table, with commits
    assert_ok(&run(mgr, &s, &format!("delete from {dst}.parents")).await);
    let (data, res) = dump_with(
        mgr,
        &cfg.id,
        src,
        dst,
        DumpOptions {
            tables: Some(vec!["parents".into()]),
            include_ddl: false,
            commit_every: 1,
            batch_size: 1,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(res.rows, 2);
    assert!(
        !data.contains("create table") && !data.contains("drop "),
        "{data}"
    );
    assert_eq!(data.matches("commit;").count(), 2, "{data}");
    restore_text(mgr, &s, &data).await;
    assert_eq!(
        scalar(&run(mgr, &s, &format!("select count(*) from {dst}.parents")).await),
        json!(2)
    );

    assert_ok(
        &run(
            mgr,
            &s,
            &format!("drop database if exists {dst}; drop database if exists {src};"),
        )
        .await,
    );
    mgr.close_session(&s).await;
}
