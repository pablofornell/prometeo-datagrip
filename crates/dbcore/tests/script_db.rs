//! Running SQL script files (`run_sql_file`) on PostgreSQL, MySQL and Oracle: DDL + inserts + one failing statement under
//! every combination of `stopOnError` x `singleTransaction`, routines (`$$`, `DELIMITER`, PL/SQL with `/`) and the restore of
//! a real dump. Run with:
//!   PROMETEO_PG_URL=... PROMETEO_MYSQL_URL=... PROMETEO_ORACLE_URL=... cargo test -p dbcore --test script_db -- --nocapture
//! A test skips when the URL of its database is not set.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use dbcore::import::CancellationToken;
use dbcore::*;
use serde_json::Value;

fn txt(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "NULL".into(),
        other => other.to_string(),
    }
}

/// First cell of a query as text.
async fn one(mgr: &ConnectionManager, s: &SessionId, sql: &str) -> String {
    txt(&scalar(&run(mgr, s, sql).await))
}

/// First column of every row as text.
async fn column(mgr: &ConnectionManager, s: &SessionId, sql: &str) -> Vec<String> {
    let ev = run(mgr, s, sql).await;
    assert_ok(&ev);
    first_rs(&ev).1.iter().map(|r| txt(&r[0])).collect()
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, text).unwrap();
    p
}

async fn run_file(
    mgr: &ConnectionManager,
    ds: &str,
    schema: Option<&str>,
    path: &Path,
    stop_on_error: bool,
    single_transaction: bool,
) -> ScriptSummary {
    mgr.run_sql_file(
        ds,
        schema,
        path,
        &ScriptOptions {
            stop_on_error,
            single_transaction,
            ..Default::default()
        },
        &CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap_or_else(|e| panic!("run_sql_file: {e}"))
}

/// What a run of the standard script must give: (ok, failed, rolled back, table exists, ids left, ddl committed).
type Expected = (u64, u64, bool, bool, Vec<&'static str>, bool);

/// The script: DDL, two inserts, a duplicate key at line 4, one more insert. `transactional_ddl` is true on PostgreSQL
/// (DDL rolls back with the transaction) and false on MySQL and Oracle (the server commits it).
fn expected(stop: bool, single: bool, transactional_ddl: bool) -> Expected {
    match (stop, single) {
        (true, false) => (3, 1, false, true, vec!["1", "2"], false),
        (false, false) => (4, 1, false, true, vec!["1", "2", "3"], false),
        (true, true) if transactional_ddl => (3, 1, true, false, vec![], false),
        (true, true) => (3, 1, true, true, vec![], true),
        (false, true) => (4, 1, false, true, vec!["1", "2", "3"], !transactional_ddl),
    }
}

struct Target<'a> {
    mgr: &'a ConnectionManager,
    ds: &'a str,
    driver: Driver,
    /// The schema / database of the run (PostgreSQL, MySQL); none on Oracle (the login user's own).
    schema: Option<&'a str>,
}

impl Target<'_> {
    /// `table` qualified as the checks need it.
    fn qualified(&self, table: &str) -> String {
        match self.schema {
            Some(s) => format!("{s}.{table}"),
            None => table.into(),
        }
    }

    async fn drop_table(&self, s: &SessionId, table: &str) {
        let q = self.qualified(table);
        let sql = match self.driver {
            Driver::Oracle => format!(
                "begin execute immediate 'drop table {q} purge'; exception when others then null; end;\n/\n"
            ),
            _ => format!("drop table if exists {q}"),
        };
        run(self.mgr, s, &sql).await;
    }

    async fn exists(&self, s: &SessionId, table: &str) -> bool {
        let sql = match self.driver {
            Driver::Oracle => format!("select count(*) from user_tables where table_name = upper('{table}')"),
            _ => format!(
                "select count(*) from information_schema.tables where table_schema = '{}' and table_name = '{table}'",
                self.schema.unwrap()
            ),
        };
        one(self.mgr, s, &sql).await == "1"
    }

    async fn ids(&self, s: &SessionId, table: &str) -> Vec<String> {
        column(
            self.mgr,
            s,
            &format!("select id from {} order by id", self.qualified(table)),
        )
        .await
    }
}

/// The four combinations of the options on the standard script.
async fn matrix(t: &Target<'_>, dir: &Path, first_error: &str) {
    let s = t.mgr.open_session(t.ds).await.unwrap();
    for (n, (stop, single)) in [(true, false), (false, false), (true, true), (false, true)]
        .into_iter()
        .enumerate()
    {
        let table = format!("psc_t{n}");
        t.drop_table(&s, &table).await;
        let script = format!(
            "create table {table} (id int primary key, v varchar(20));\n\
             insert into {table} values (1, 'a');\n\
             insert into {table} values (2, 'b');\n\
             insert into {table} values (1, 'dup');\n\
             insert into {table} values (3, 'c');\n"
        );
        let path = write(dir, &format!("matrix{n}.sql"), &script);
        let sum = run_file(t.mgr, t.ds, t.schema, &path, stop, single).await;
        let label = format!(
            "{:?} stopOnError={stop} singleTransaction={single}: {sum:?}",
            t.driver
        );
        let (ok, failed, rolled_back, exists, ids, ddl) =
            expected(stop, single, t.driver == Driver::Postgres);
        assert_eq!((sum.ok, sum.failed), (ok, failed), "{label}");
        assert_eq!(
            (sum.rolled_back, sum.ddl_committed, sum.cancelled),
            (rolled_back, ddl, false),
            "{label}"
        );
        let e = sum
            .first_error
            .as_ref()
            .unwrap_or_else(|| panic!("{label}"));
        assert_eq!(e.line, 4, "{label}");
        assert!(e.message.contains(first_error), "{label}");
        assert_eq!(t.exists(&s, &table).await, exists, "{label}");
        if exists {
            assert_eq!(t.ids(&s, &table).await, ids, "{label}");
        }
        t.drop_table(&s, &table).await;
    }
    t.mgr.close_session(&s).await;
}

/// Row counts of `tables` (same names in both places) must agree.
async fn same_counts(
    mgr: &ConnectionManager,
    s: &SessionId,
    from: &str,
    to: &str,
    tables: &[&str],
) {
    for t in tables {
        let a = one(mgr, s, &format!("select count(*) from {from}{t}")).await;
        let b = one(mgr, s, &format!("select count(*) from {to}{t}")).await;
        assert_eq!(a, b, "rows of {t}");
        assert_ne!(a, "0", "{t} has rows");
    }
}

// ---------------------------------------------------------------- PostgreSQL

#[tokio::test]
async fn pg_every_combination_of_the_options() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("PROMETEO_PG_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session("pg").await.unwrap();
    assert_ok(
        &run(
            &mgr,
            &s,
            "drop schema if exists psc_pg cascade; create schema psc_pg;",
        )
        .await,
    );
    let dir = tempfile::tempdir().unwrap();
    let t = Target {
        mgr: &mgr,
        ds: "pg",
        driver: Driver::Postgres,
        schema: Some("psc_pg"),
    };
    matrix(&t, dir.path(), "duplicate key").await;
    assert_ok(&run(&mgr, &s, "drop schema if exists psc_pg cascade").await);
}

#[tokio::test]
async fn pg_dollar_quoted_function_and_a_dump_restore() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("PROMETEO_PG_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session("pg").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    assert_ok(
        &run(
            &mgr,
            &s,
            "drop schema if exists psc_fn cascade; drop schema if exists psc_dst cascade; drop schema if exists psc_src cascade; create schema psc_fn;",
        )
        .await,
    );
    let script = "create table t (id int, v text);\n\
                  create function add_row(n int) returns void language plpgsql as $$\n\
                  begin\n  insert into t values (n, 'a;b');\nend;\n$$;\n\
                  select add_row(1);\nselect add_row(2);\n";
    let path = write(dir.path(), "fn.sql", script);
    for single in [false, true] {
        assert_ok(&run(&mgr, &s, "drop table if exists psc_fn.t cascade").await);
        let sum = run_file(&mgr, "pg", Some("psc_fn"), &path, true, single).await;
        assert_eq!((sum.ok, sum.failed), (4, 0), "{sum:?}");
        assert_eq!(
            column(&mgr, &s, "select v from psc_fn.t order by id").await,
            vec!["a;b", "a;b"]
        );
        assert_ok(&run(&mgr, &s, "drop function if exists psc_fn.add_row(int)").await);
    }

    // a real dump restored through run_sql_file into a fresh schema
    assert_ok(
        &run(
            &mgr,
            &s,
            "create schema psc_src;\n\
             create table psc_src.parents (id serial primary key, name text not null unique, amount numeric(12,2) not null default 0);\n\
             create table psc_src.children (id serial primary key, parent_id int not null references psc_src.parents (id), label text, tags text[]);\n\
             insert into psc_src.parents (name, amount) values ('Alpha', 10.50), ('Bêta; ''q''', 20.25), ('Gamma', 0);\n\
             insert into psc_src.children (parent_id, label, tags) values (1, 'c1', array['a','b']), (2, 'héllo', array['x']), (3, null, null);\n",
        )
        .await,
    );
    let dump_file = dir.path().join("dump.sql");
    let res = mgr
        .dump_schema(
            "pg",
            "psc_src",
            &DumpOptions {
                target_schema: Some("psc_dst".into()),
                ..Default::default()
            },
            &CancellationToken::new(),
            &|_| {},
            std::fs::File::create(&dump_file).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!((res.tables, res.rows), (2, 6), "{res:?}");
    assert_ok(&run(&mgr, &s, "create schema psc_dst").await);
    for (stop, single) in [(true, true), (true, false)] {
        assert_ok(
            &run(
                &mgr,
                &s,
                "drop schema psc_dst cascade; create schema psc_dst",
            )
            .await,
        );
        let sum = run_file(&mgr, "pg", Some("psc_dst"), &dump_file, stop, single).await;
        assert_eq!(sum.failed, 0, "{sum:?}");
        same_counts(&mgr, &s, "psc_src.", "psc_dst.", &["parents", "children"]).await;
        assert_eq!(
            column(
                &mgr,
                &s,
                "select name || '/' || amount from psc_dst.parents order by id"
            )
            .await,
            column(
                &mgr,
                &s,
                "select name || '/' || amount from psc_src.parents order by id"
            )
            .await
        );
    }
    assert_ok(
        &run(
            &mgr,
            &s,
            "drop schema psc_dst cascade; drop schema psc_src cascade; drop schema psc_fn cascade",
        )
        .await,
    );
}

// ---------------------------------------------------------------- MySQL

#[tokio::test]
async fn mysql_every_combination_of_the_options() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("PROMETEO_MYSQL_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session("my").await.unwrap();
    assert_ok(
        &run(
            &mgr,
            &s,
            "drop database if exists psc_my; create database psc_my;",
        )
        .await,
    );
    let dir = tempfile::tempdir().unwrap();
    let t = Target {
        mgr: &mgr,
        ds: "my",
        driver: Driver::MySql,
        schema: Some("psc_my"),
    };
    matrix(&t, dir.path(), "Duplicate entry").await;
    assert_ok(&run(&mgr, &s, "drop database if exists psc_my").await);
}

#[tokio::test]
async fn mysql_delimiter_procedure_and_a_dump_restore() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("PROMETEO_MYSQL_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session("my").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    assert_ok(
        &run(
            &mgr,
            &s,
            "drop database if exists psc_pr; drop database if exists psc_dst; drop database if exists psc_src; create database psc_pr;",
        )
        .await,
    );
    let script = "create table t (id int, v varchar(20));\n\
                  DELIMITER ;;\n\
                  CREATE PROCEDURE add_row(IN n INT)\nBEGIN\n  INSERT INTO t VALUES (n, 'a;b');\nEND;;\n\
                  DELIMITER ;\n\
                  CALL add_row(1);\nCALL add_row(2);\n";
    let path = write(dir.path(), "proc.sql", script);
    for single in [false, true] {
        assert_ok(
            &run(
                &mgr,
                &s,
                "drop table if exists psc_pr.t; drop procedure if exists psc_pr.add_row",
            )
            .await,
        );
        let sum = run_file(&mgr, "my", Some("psc_pr"), &path, true, single).await;
        assert_eq!((sum.ok, sum.failed), (4, 0), "{sum:?}");
        assert_eq!(
            column(&mgr, &s, "select v from psc_pr.t order by id").await,
            vec!["a;b", "a;b"]
        );
    }

    assert_ok(
        &run(
            &mgr,
            &s,
            "create database psc_src;\n\
             create table psc_src.parents (id int auto_increment primary key, name varchar(50) not null unique, amount decimal(12,2) not null default 0, raw varbinary(8) null);\n\
             create table psc_src.children (id int auto_increment primary key, parent_id int not null, label varchar(50), constraint fk_p foreign key (parent_id) references psc_src.parents (id));\n\
             insert into psc_src.parents (name, amount, raw) values ('Alpha', 10.50, x'00ff10'), ('Bêta ''q''', 20.25, null), ('Gamma', 0, null);\n\
             insert into psc_src.children (parent_id, label) values (1, 'c1'), (2, 'héllo\\n'), (3, null);\n",
        )
        .await,
    );
    let dump_file = dir.path().join("dump.sql");
    let res = mgr
        .dump_schema(
            "my",
            "psc_src",
            &DumpOptions {
                target_schema: Some("psc_dst".into()),
                ..Default::default()
            },
            &CancellationToken::new(),
            &|_| {},
            std::fs::File::create(&dump_file).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!((res.tables, res.rows), (2, 6), "{res:?}");
    for (stop, single) in [(true, false), (true, true)] {
        assert_ok(
            &run(
                &mgr,
                &s,
                "drop database if exists psc_dst; create database psc_dst;",
            )
            .await,
        );
        let sum = run_file(&mgr, "my", Some("psc_dst"), &dump_file, stop, single).await;
        assert_eq!(sum.failed, 0, "{sum:?}");
        same_counts(&mgr, &s, "psc_src.", "psc_dst.", &["parents", "children"]).await;
        assert_eq!(
            column(&mgr, &s, "select concat(name, '/', amount, '/', hex(coalesce(raw, ''))) from psc_dst.parents order by id").await,
            column(&mgr, &s, "select concat(name, '/', amount, '/', hex(coalesce(raw, ''))) from psc_src.parents order by id").await
        );
    }
    assert_ok(
        &run(
            &mgr,
            &s,
            "drop database psc_dst; drop database psc_src; drop database psc_pr",
        )
        .await,
    );
}

// ---------------------------------------------------------------- Oracle

#[tokio::test]
async fn oracle_every_combination_of_the_options() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let dir = tempfile::tempdir().unwrap();
    let t = Target {
        mgr: &mgr,
        ds: "ora",
        driver: Driver::Oracle,
        schema: None,
    };
    matrix(&t, dir.path(), "ORA-00001").await;
}

#[tokio::test]
async fn oracle_plsql_blocks_procedures_and_a_dump_restore() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session("ora").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    // what an earlier run left
    for sql in [
        "drop table psc_r purge",
        "drop procedure psc_rp",
        "drop table psc_child purge",
        "drop table psc_parent purge",
    ] {
        run(&mgr, &s, sql).await;
    }
    let script = "create table psc_r (id number, v varchar2(20));\n\
                  create or replace procedure psc_rp (n in number) as\nbegin\n  insert into psc_r values (n, 'a;b');\nend;\n/\n\
                  begin\n  psc_rp(1);\n  psc_rp(2);\nend;\n/\n\
                  select count(*) from psc_r;\n";
    let path = write(dir.path(), "plsql.sql", script);
    let sum = run_file(&mgr, "ora", None, &path, true, false).await;
    assert_eq!((sum.ok, sum.failed), (4, 0), "{sum:?}");
    // committed by the run: another connection sees it
    assert_eq!(
        column(&mgr, &s, "select v from psc_r order by id").await,
        vec!["a;b", "a;b"]
    );
    run(&mgr, &s, "drop table psc_r purge").await;
    // CREATE OR REPLACE again, in a single transaction
    let sum = run_file(&mgr, "ora", None, &path, true, true).await;
    assert_eq!((sum.ok, sum.failed), (4, 0), "{sum:?}");
    assert_eq!(
        column(&mgr, &s, "select count(*) from psc_r").await,
        vec!["2"]
    );
    run(&mgr, &s, "drop table psc_r purge").await;
    run(&mgr, &s, "drop procedure psc_rp").await;

    // a real dump of two tables, restored after they were dropped
    assert_ok(
        &run(
            &mgr,
            &s,
            "create table psc_parent (id number primary key, name varchar2(50 char) not null, amount number(12,2) default 0 not null);\n\
             create table psc_child (id number primary key, parent_id number not null references psc_parent (id), label varchar2(30));\n\
             insert into psc_parent values (1, 'Alpha', 10.5);\n\
             insert into psc_parent values (2, 'Bêta ''q''; x', 20.25);\n\
             insert into psc_parent values (3, 'Gamma', 0);\n\
             insert into psc_child values (1, 1, 'c1');\n\
             insert into psc_child values (2, 2, 'héllo');\n\
             insert into psc_child values (3, 3, null);\n\
             commit;\n",
        )
        .await,
    );
    let schema = one(
        &mgr,
        &s,
        "select sys_context('USERENV', 'CURRENT_SCHEMA') from dual",
    )
    .await;
    let dump_file = dir.path().join("dump.sql");
    let res = mgr
        .dump_schema(
            "ora",
            &schema,
            &DumpOptions {
                drop_if_exists: true,
                tables: Some(vec!["PSC_PARENT".into(), "PSC_CHILD".into()]),
                ..Default::default()
            },
            &CancellationToken::new(),
            &|_| {},
            std::fs::File::create(&dump_file).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!((res.tables, res.rows), (2, 6), "{res:?}");
    let before = column(
        &mgr,
        &s,
        "select id || '/' || name || '/' || amount from psc_parent order by id",
    )
    .await;
    for (stop, single) in [(true, false), (true, true)] {
        run(&mgr, &s, "drop table psc_child purge").await;
        run(&mgr, &s, "drop table psc_parent purge").await;
        let sum = run_file(&mgr, "ora", None, &dump_file, stop, single).await;
        assert_eq!(sum.failed, 0, "{sum:?}");
        assert_eq!(one(&mgr, &s, "select count(*) from psc_parent").await, "3");
        assert_eq!(one(&mgr, &s, "select count(*) from psc_child").await, "3");
        assert_eq!(
            column(
                &mgr,
                &s,
                "select id || '/' || name || '/' || amount from psc_parent order by id"
            )
            .await,
            before
        );
    }
    run(&mgr, &s, "drop table psc_child purge").await;
    run(&mgr, &s, "drop table psc_parent purge").await;
}
