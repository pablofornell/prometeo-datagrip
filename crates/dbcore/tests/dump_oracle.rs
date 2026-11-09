//! Oracle whole-schema dump / restore round trip in the login user's own schema (no extra privileges): the
//! objects are named with a prefix and removed at the start and at the end. Run with:
//!   PROMETEO_ORACLE_URL=oracle://demo:prometeo@127.0.0.1:15219/FREEPDB1 cargo test -p dbcore --test dump_oracle -- --nocapture

mod common;

use common::*;
use dbcore::import::CancellationToken;
use dbcore::*;
use serde_json::Value;
use tokio::sync::Mutex;

/// The tests dump the whole schema or rebuild objects in it: one at a time.
static LOCK: Mutex<()> = Mutex::const_new(());

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

async fn exec_ok(mgr: &ConnectionManager, s: &SessionId, sql: &str) {
    assert_ok(&run(mgr, s, sql).await);
}

/// Drops every object whose name starts with `prefix` (tables with their constraints, sequences, views, units).
async fn clean(mgr: &ConnectionManager, s: &SessionId, prefix: &str) {
    exec_ok(
        mgr,
        s,
        &format!(
            r#"
begin
  for o in (select object_type, object_name from user_objects
             where object_name like '{prefix}\_%' escape '\'
               and object_type in ('VIEW', 'TABLE', 'SEQUENCE', 'FUNCTION', 'PROCEDURE', 'PACKAGE')
             order by decode(object_type, 'VIEW', 1, 'TABLE', 2, 3)) loop
    begin
      execute immediate 'drop ' || o.object_type || ' "' || o.object_name || '"'
        || case when o.object_type = 'TABLE' then ' cascade constraints purge' end;
    exception when others then null;
    end;
  end loop;
end;
/
"#
        ),
    )
    .await;
}

async fn current_schema(mgr: &ConnectionManager, s: &SessionId) -> String {
    one(
        mgr,
        s,
        "select sys_context('USERENV', 'CURRENT_SCHEMA') from dual",
    )
    .await
}

fn options(tables: Option<Vec<&str>>) -> DumpOptions {
    DumpOptions {
        drop_if_exists: true,
        tables: tables.map(|t| t.into_iter().map(String::from).collect()),
        ..Default::default()
    }
}

async fn dump(mgr: &ConnectionManager, schema: &str, opts: &DumpOptions) -> (String, DumpResult) {
    let mut buf = Vec::new();
    let res = mgr
        .dump_schema(
            "ora",
            schema,
            opts,
            &CancellationToken::new(),
            &|_| {},
            &mut buf,
        )
        .await
        .unwrap();
    assert!(!res.cancelled);
    (String::from_utf8(buf).unwrap(), res)
}

/// Runs a dump the way the app does: stop at the first error, statement by statement.
async fn restore(mgr: &ConnectionManager, s: &SessionId, dump: &str) {
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

/// `true` when the statement is a PL/SQL unit (ends at a `/` line).
fn is_plsql(sql: &str) -> bool {
    let up = sql.trim_start().to_ascii_uppercase();
    up.starts_with("BEGIN")
        || up.starts_with("DECLARE")
        || ["FUNCTION", "PROCEDURE", "PACKAGE", "TRIGGER"]
            .iter()
            .any(|k| up.starts_with(&format!("CREATE OR REPLACE {k}")))
}

/// The statements of a whole-schema dump that mention `prefix` (and the commits), as a script again.
fn only_prefix(dump: &str, prefix: &str) -> String {
    let mut out = String::new();
    for st in split_statements(dump, Driver::Oracle) {
        let up = st.text.to_ascii_uppercase();
        if !(up.contains(prefix) || up == "COMMIT") {
            continue;
        }
        if is_plsql(&st.text) {
            out.push_str(&format!("{}\n/\n", st.text));
        } else {
            out.push_str(&format!("{}\n;\n", st.text));
        }
    }
    out
}

// ---------------------------------------------------------------- tables, data, constraints

const SETUP_A: &str = r#"
create table zda_parent (
  id number generated always as identity primary key,
  parent_id number,
  code varchar2(20 char) not null,
  name nvarchar2(60),
  note varchar2(100 byte) default 'n/a',
  amount number(12,2) default 0 not null,
  big_num number,
  born date,
  seen timestamp(6),
  seen_tz timestamp(6) with time zone,
  bf binary_float,
  bd binary_double,
  token raw(16),
  doc clob,
  ndoc nclob,
  pic blob,
  span interval day(2) to second(3),
  age interval year(2) to month,
  upper_code varchar2(80) generated always as (upper(code)) virtual,
  constraint zda_parent_amount_ck check (amount >= 0),
  constraint zda_parent_code_uq unique (code),
  constraint zda_parent_self_fk foreign key (parent_id) references zda_parent (id)
);
comment on table zda_parent is 'It''s the parent';
comment on column zda_parent.code is 'unique code';
create table zda_child (
  id number generated by default on null as identity (start with 100 increment by 10) primary key,
  parent_id number not null,
  label varchar2(30),
  qty number(5) default 1,
  constraint zda_child_fk foreign key (parent_id) references zda_parent (id) on delete cascade,
  constraint zda_child_lbl_uq unique (parent_id, label)
);
create index zda_child_lbl_ix on zda_child (lower(label), qty desc);
create index zda_child_qty_ix on zda_child (qty);
create table zda_cyc_a (id number primary key, b_id number);
create table zda_cyc_b (id number primary key, a_id number);
alter table zda_cyc_a add constraint zda_cyc_a_fk foreign key (b_id) references zda_cyc_b (id);
alter table zda_cyc_b add constraint zda_cyc_b_fk foreign key (a_id) references zda_cyc_a (id) on delete set null;
create table zda_al (id number generated always as identity (start with 7), v varchar2(30));
create global temporary table zda_gtt (x number) on commit preserve rows;

insert into zda_parent (code, name, note, amount, big_num, born, seen, seen_tz, bf, bd, token, doc, ndoc, pic, span, age)
values ('alpha', n'Ünïcödé 日本語 😀', 'it''s', 1234567890.12, 12345678901234567890123456789012345678,
        to_date('2024-02-29 13:14:15', 'YYYY-MM-DD HH24:MI:SS'), timestamp '2024-05-01 10:20:30.123456',
        timestamp '2024-05-01 10:20:30.123456 +05:30', 1.5, 0.1, hextoraw('00FF10'), 'short clob', 'ñ', hextoraw('CAFE'),
        interval '3 04:05:06.789' day to second, interval '1-6' year to month);
insert into zda_parent (code) values ('beta');
insert into zda_parent (code, parent_id, name, amount) values ('gamma', 1, 'plain', 5);
insert into zda_parent (code, bf, bd) values ('nan', binary_float_infinity, binary_double_nan);
declare
  c clob; m clob; n nclob; b blob; mb blob;
begin
  dbms_lob.createtemporary(c, true);
  for i in 1 .. 45 loop dbms_lob.writeappend(c, 1000, rpad('ünï' || i || '-', 1000, 'é')); end loop;
  dbms_lob.createtemporary(m, true);
  for i in 1 .. 3 loop dbms_lob.writeappend(m, 3000, rpad('médium' || i, 3000, 'ab''&')); end loop;
  dbms_lob.createtemporary(n, true);
  for i in 1 .. 3 loop dbms_lob.append(n, to_nclob(rpad(unistr('\65E5'), 1000, unistr('\672C')))); end loop;
  dbms_lob.createtemporary(b, true);
  for i in 1 .. 8 loop dbms_lob.append(b, utl_raw.copies(hextoraw(lpad(to_char(i, 'FMXX'), 2, '0') || 'A5'), 7000)); end loop;
  dbms_lob.createtemporary(mb, true);
  for i in 1 .. 2 loop dbms_lob.append(mb, utl_raw.copies(hextoraw('0A0B0C'), 500)); end loop;
  update zda_parent set doc = c, pic = b, ndoc = n where code = 'gamma';
  update zda_parent set doc = m, pic = mb where code = 'beta';
end;
/
insert into zda_child (parent_id, label, qty) values (1, 'Ünï', 2);
insert into zda_child (parent_id, label) values (2, 'two');
insert into zda_child (id, parent_id, label, qty) values (5, 2, 'five', null);
insert into zda_cyc_b (id, a_id) values (1, null);
insert into zda_cyc_a (id, b_id) values (1, 1);
update zda_cyc_b set a_id = 1;
insert into zda_al (v) values ('a');
insert into zda_al (v) values ('b');
commit;
"#;

const TABLES_A: [&str; 6] = [
    "ZDA_PARENT",
    "ZDA_CHILD",
    "ZDA_CYC_A",
    "ZDA_CYC_B",
    "ZDA_AL",
    "ZDA_GTT",
];

/// Column kinds for the comparison: `v` value, `t` time zone timestamp, `l` LOB.
const COLS_A: [(&str, &[(&str, char)]); 5] = [
    (
        "ZDA_PARENT",
        &[
            ("id", 'v'),
            ("parent_id", 'v'),
            ("code", 'v'),
            ("name", 'v'),
            ("note", 'v'),
            ("amount", 'v'),
            ("big_num", 'v'),
            ("born", 'v'),
            ("seen", 'v'),
            ("seen_tz", 't'),
            ("bf", 'v'),
            ("bd", 'v'),
            ("token", 'v'),
            ("doc", 'l'),
            ("ndoc", 'l'),
            ("pic", 'l'),
            ("span", 'v'),
            ("age", 'v'),
            ("upper_code", 'v'),
        ],
    ),
    (
        "ZDA_CHILD",
        &[
            ("id", 'v'),
            ("parent_id", 'v'),
            ("label", 'v'),
            ("qty", 'v'),
        ],
    ),
    ("ZDA_CYC_A", &[("id", 'v'), ("b_id", 'v')]),
    ("ZDA_CYC_B", &[("id", 'v'), ("a_id", 'v')]),
    ("ZDA_AL", &[("id", 'v'), ("v", 'v')]),
];

async fn snapshot_a(mgr: &ConnectionManager, s: &SessionId) {
    for (t, _) in COLS_A {
        exec_ok(
            mgr,
            s,
            &format!("create table zda_snap_{} as select * from {t}", &t[4..]),
        )
        .await;
    }
}

/// Rows of `t` that are missing, extra or different compared to its snapshot (must be 0).
async fn differences(
    mgr: &ConnectionManager,
    s: &SessionId,
    t: &str,
    cols: &[(&str, char)],
) -> String {
    const TZ: &str = "'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM'";
    let diffs: Vec<String> = cols
        .iter()
        .map(|(c, k)| match k {
            't' => format!("decode(to_char(s.{c}, {TZ}), to_char(t.{c}, {TZ}), 0, 1) = 1"),
            'l' => format!(
                "(case when s.{c} is null and t.{c} is null then 0 when s.{c} is null or t.{c} is null then 1 \
                 else abs(dbms_lob.compare(s.{c}, t.{c})) end) <> 0"
            ),
            _ => format!("decode(s.{c}, t.{c}, 0, 1) = 1"),
        })
        .collect();
    one(
        mgr,
        s,
        &format!(
            "select count(*) from zda_snap_{} s full outer join {t} t on s.id = t.id \
             where s.id is null or t.id is null or {}",
            &t[4..],
            diffs.join(" or ")
        ),
    )
    .await
}

async fn assert_same_as_snapshot(mgr: &ConnectionManager, s: &SessionId, only: &[&str]) {
    for (t, cols) in COLS_A {
        if only.is_empty() || only.contains(&t) {
            assert_eq!(
                differences(mgr, s, t, cols).await,
                "0",
                "{t} differs from its snapshot"
            );
            let n = one(mgr, s, &format!("select count(*) from {t}")).await;
            assert_ne!(n, "0", "{t} has no rows");
        }
    }
}

/// What the restored objects must still do: identities continue, constraints hold.
async fn assert_behaviour(mgr: &ConnectionManager, s: &SessionId) {
    // identity ALWAYS stays ALWAYS and continues after the data
    assert_eq!(
        one(
            mgr,
            s,
            "select generation_type from user_tab_identity_cols where table_name = 'ZDA_PARENT'"
        )
        .await,
        "ALWAYS"
    );
    let max: i64 = one(mgr, s, "select max(id) from zda_parent")
        .await
        .parse()
        .unwrap();
    exec_ok(mgr, s, "insert into zda_parent (code) values ('delta')").await;
    let next: i64 = one(mgr, s, "select id from zda_parent where code = 'delta'")
        .await
        .parse()
        .unwrap();
    assert!(
        next > max,
        "identity continues after the data: {next} > {max}"
    );
    assert_eq!(
        one(
            mgr,
            s,
            "select upper_code from zda_parent where code = 'delta'"
        )
        .await,
        "DELTA"
    );
    let ev = run(
        mgr,
        s,
        "insert into zda_parent (id, code) values (999, 'explicit')",
    )
    .await;
    assert!(
        errors(&ev).iter().any(|e| e.contains("ORA-32795")),
        "ALWAYS refuses ids: {:?}",
        errors(&ev)
    );

    // identity BY DEFAULT ON NULL with its own start / step
    let max: i64 = one(mgr, s, "select max(id) from zda_child")
        .await
        .parse()
        .unwrap();
    exec_ok(
        mgr,
        s,
        "insert into zda_child (parent_id, label) values (1, 'next')",
    )
    .await;
    let next: i64 = one(mgr, s, "select id from zda_child where label = 'next'")
        .await
        .parse()
        .unwrap();
    assert!(next > max, "{next} > {max}");
    assert_eq!(
        one(mgr, s, "select default_on_null from user_tab_cols where table_name = 'ZDA_CHILD' and column_name = 'ID'").await,
        "YES"
    );

    // constraints
    let ev = run(
        mgr,
        s,
        "insert into zda_child (parent_id, label) values (424242, 'orphan')",
    )
    .await;
    assert!(
        errors(&ev).iter().any(|e| e.contains("ORA-02291")),
        "{:?}",
        errors(&ev)
    );
    let ev = run(
        mgr,
        s,
        "insert into zda_parent (code, amount) values ('neg', -1)",
    )
    .await;
    assert!(
        errors(&ev).iter().any(|e| e.contains("ORA-02290")),
        "{:?}",
        errors(&ev)
    );
    let ev = run(mgr, s, "insert into zda_parent (code) values ('alpha')").await;
    assert!(
        errors(&ev).iter().any(|e| e.contains("ORA-00001")),
        "{:?}",
        errors(&ev)
    );
    assert_eq!(
        one(
            mgr,
            s,
            "select delete_rule from user_constraints where constraint_name = 'ZDA_CHILD_FK'"
        )
        .await,
        "CASCADE"
    );
    assert_eq!(
        one(
            mgr,
            s,
            "select delete_rule from user_constraints where constraint_name = 'ZDA_CYC_B_FK'"
        )
        .await,
        "SET NULL"
    );
    assert_eq!(
        one(mgr, s, "select count(*) from user_constraints where constraint_type = 'R' and table_name like 'ZDA\\_%' escape '\\'").await,
        "4"
    );
    let before = one(mgr, s, "select count(*) from zda_child")
        .await
        .parse::<i64>()
        .unwrap();
    exec_ok(mgr, s, "delete from zda_parent where code = 'beta'").await;
    let after = one(mgr, s, "select count(*) from zda_child")
        .await
        .parse::<i64>()
        .unwrap();
    assert_eq!(
        before - after,
        2,
        "ON DELETE CASCADE removed the children of beta"
    );

    // indexes, comments, temporary table
    assert_eq!(
        one(mgr, s, "select count(*) from user_indexes where index_name in ('ZDA_CHILD_LBL_IX', 'ZDA_CHILD_QTY_IX')").await,
        "2"
    );
    assert!(one(
        mgr,
        s,
        "select column_expression from user_ind_expressions where index_name = 'ZDA_CHILD_LBL_IX'"
    )
    .await
    .contains("LOWER"));
    assert_eq!(
        one(
            mgr,
            s,
            "select comments from user_tab_comments where table_name = 'ZDA_PARENT'"
        )
        .await,
        "It's the parent"
    );
    assert_eq!(
        one(mgr, s, "select comments from user_col_comments where table_name = 'ZDA_PARENT' and column_name = 'CODE'").await,
        "unique code"
    );
    assert_eq!(
        one(
            mgr,
            s,
            "select temporary from user_tables where table_name = 'ZDA_GTT'"
        )
        .await,
        "Y"
    );
    assert_eq!(one(mgr, s, "select virtual_column from user_tab_cols where table_name = 'ZDA_PARENT' and column_name = 'UPPER_CODE'").await, "YES");
}

#[tokio::test]
async fn tables_round_trip_with_every_literal_kind() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let _guard = LOCK.lock().await;
    let mgr = &connected(&cfg).await;
    let s = mgr.open_session("ora").await.unwrap();
    let schema = current_schema(mgr, &s).await;
    clean(mgr, &s, "ZDA").await;
    exec_ok(mgr, &s, SETUP_A).await;
    snapshot_a(mgr, &s).await;

    // (batch_size, commit_every, target schema): single-row inserts, then INSERT ALL with commits
    for (batch_size, commit_every, target) in [(1, 0, None), (50, 2, Some(schema.clone()))] {
        let opts = DumpOptions {
            batch_size,
            commit_every,
            target_schema: target.clone(),
            ..options(Some(TABLES_A.to_vec()))
        };
        let (text, res) = dump(mgr, &schema, &opts).await;
        assert_eq!(res.tables, 6);
        assert_eq!(
            res.rows,
            4 + 3 + 1 + 1 + 2,
            "rows of the dumped tables (the temporary one has none)"
        );
        for needle in [
            "CREATE TABLE ZDA_PARENT",
            "GENERATED BY DEFAULT AS IDENTITY",
            "VIRTUAL",
            "TO_TIMESTAMP_TZ('2024-05-01 10:20:30.123456000 +05:30'",
            "TO_DATE('2024-02-29 13:14:15', 'YYYY-MM-DD HH24:MI:SS')",
            "N'Ünï",
            "HEXTORAW('00ff10')",
            "TO_BLOB(HEXTORAW('cafe'))",
            "TO_BINARY_FLOAT('1.5e0')",
            "BINARY_DOUBLE_NAN",
            "DBMS_LOB.APPEND",
            "TO_BLOB(HEXTORAW(",
            "TO_CLOB('",
            "TO_NCLOB(N'",
            "TO_DSINTERVAL('+03 04:05:06.789')",
            "TO_YMINTERVAL('+01-06')",
            "ON COMMIT PRESERVE ROWS",
            "COMMENT ON TABLE ZDA_PARENT IS 'It''s the parent'",
            "BEGIN\n    EXECUTE IMMEDIATE 'DROP TABLE ZDA_PARENT CASCADE CONSTRAINTS PURGE'",
            "ALTER TABLE ZDA_PARENT MODIFY (ID GENERATED ALWAYS AS IDENTITY);",
        ] {
            assert!(
                text.contains(needle),
                "{needle:?} missing in the dump:\n{}",
                &text[..text.len().min(4000)]
            );
        }
        assert_eq!(text.contains("INSERT ALL"), batch_size > 1);
        assert_eq!(
            text.contains("ALTER SESSION SET CURRENT_SCHEMA"),
            target.is_some()
        );
        assert!(text.contains("COMMIT;"));
        // the foreign keys come after the data and the indexes
        let at = |n: &str| text.find(n).unwrap_or_else(|| panic!("{n} missing"));
        assert!(
            at("INSERT INTO") < at("CREATE INDEX")
                && at("CREATE INDEX") < at("ADD CONSTRAINT ZDA_CYC_A_FK")
        );
        assert!(
            !text.contains("ZDA_SNAP"),
            "only the asked tables are dumped"
        );

        // drop the dumped tables (the snapshots stay)
        for t in [
            "ZDA_PARENT",
            "ZDA_CHILD",
            "ZDA_CYC_A",
            "ZDA_CYC_B",
            "ZDA_AL",
            "ZDA_GTT",
        ] {
            let _ = run(
                mgr,
                &s,
                &format!("drop table {t} cascade constraints purge"),
            )
            .await;
        }
        assert_eq!(
            one(
                mgr,
                &s,
                "select count(*) from user_tables where table_name in ('ZDA_PARENT', 'ZDA_CHILD')"
            )
            .await,
            "0"
        );

        // the app's path: a file run statement by statement
        let file = std::env::temp_dir().join(format!("prometeo-dump-oracle-{batch_size}.sql"));
        std::fs::write(&file, &text).unwrap();
        let sum = mgr
            .run_sql_file(
                "ora",
                None,
                &file,
                &ScriptOptions::default(),
                &CancellationToken::new(),
                |_| {},
            )
            .await
            .unwrap();
        let _ = std::fs::remove_file(&file);
        assert_eq!((sum.failed, sum.first_error.clone()), (0, None), "{sum:?}");
        assert_same_as_snapshot(mgr, &s, &[]).await;
        assert_behaviour(mgr, &s).await;

        // restoring again over the existing objects (drop_if_exists) works and gives the same content
        restore(mgr, &s, &text).await;
        assert_same_as_snapshot(mgr, &s, &[]).await;
    }

    // data only, into the existing tables: an ALWAYS identity takes the ids and continues
    let opts = DumpOptions {
        include_ddl: false,
        commit_every: 1000,
        tables: Some(vec!["ZDA_CHILD".into(), "ZDA_AL".into()]),
        ..Default::default()
    };
    let (text, res) = dump(mgr, &schema, &opts).await;
    assert_eq!((res.tables, res.rows), (2, 3 + 2));
    assert!(
        !text.contains("CREATE TABLE") && !text.contains("DROP TABLE"),
        "{text}"
    );
    exec_ok(
        mgr,
        &s,
        "delete from zda_child; delete from zda_al; commit;",
    )
    .await;
    restore(mgr, &s, &text).await;
    assert_same_as_snapshot(mgr, &s, &["ZDA_CHILD", "ZDA_AL"]).await;
    assert_eq!(
        one(
            mgr,
            &s,
            "select generation_type from user_tab_identity_cols where table_name = 'ZDA_AL'"
        )
        .await,
        "ALWAYS"
    );
    exec_ok(mgr, &s, "insert into zda_al (v) values ('c')").await;
    let ids = one(
        mgr,
        &s,
        "select listagg(id, ',') within group (order by id) from zda_al",
    )
    .await;
    let ids: Vec<i64> = ids.split(',').map(|x| x.parse().unwrap()).collect();
    assert_eq!(ids.len(), 3);
    assert!(ids[2] > ids[1], "{ids:?}");

    clean(mgr, &s, "ZDA").await;
    mgr.disconnect("ora").await;
}

// ---------------------------------------------------------------- views, routines, sequences

const SETUP_B: &str = r#"
create sequence zdb_seq start with 10 increment by 5 cache 3 order;
create table zdb_t (
  id number default zdb_seq.nextval primary key,
  name varchar2(50) not null,
  note varchar2(20) default on null 'dflt'
);
comment on table zdb_t is 'rows';
create table zdb_log (id number generated always as identity, msg varchar2(200));
create view zdb_v_z as select id, upper(name) as uname from zdb_t;
create view zdb_v_a (shout) as select uname || '!' from zdb_v_z where id > 0 -- keep
;
create view zdb_v_ro as select id, name from zdb_t with read only;
create function zdb_fz (p varchar2) return varchar2 is begin return lower(p); end;
/
create function zdb_fa (p varchar2) return varchar2 is begin return zdb_fz(p) || '-a'; end;
/
create procedure zdb_p (p_msg varchar2) is begin insert into zdb_log (msg) values (p_msg); end;
/
create package zdb_pkg as
  c_k constant number := 7;
  function twice (n number) return number;
end zdb_pkg;
/
create package body zdb_pkg as
  function twice (n number) return number is begin return n * 2 + c_k - 7; end;
end zdb_pkg;
/
create trigger zdb_trg before insert on zdb_t for each row
begin
  :new.name := upper(:new.name);
end;
/
create trigger zdb_trg2 after insert on zdb_t for each row
begin
  null;
end;
/
alter trigger zdb_trg2 disable;
insert into zdb_t (name) values ('one');
insert into zdb_t (name) values ('t''wo');
insert into zdb_t (name) values ('thrée');
commit;
"#;

async fn assert_units_work(mgr: &ConnectionManager, s: &SessionId) {
    assert_eq!(one(mgr, s, "select count(*) from zdb_t").await, "3");
    assert_eq!(
        one(
            mgr,
            s,
            "select listagg(name, '|') within group (order by id) from zdb_t"
        )
        .await,
        "ONE|T'WO|THRÉE"
    );
    assert_eq!(
        one(
            mgr,
            s,
            "select listagg(shout, '|') within group (order by shout) from zdb_v_a"
        )
        .await,
        "ONE!|T'WO!|THRÉE!"
    );
    assert_eq!(one(mgr, s, "select zdb_fa('XY') from dual").await, "xy-a");
    assert_eq!(
        one(mgr, s, "select zdb_pkg.twice(21) from dual").await,
        "42"
    );
    exec_ok(mgr, s, "begin zdb_p('hello'); end;\n/\ncommit;").await;
    assert_eq!(one(mgr, s, "select msg from zdb_log").await, "hello");
    // the trigger fires, the disabled one stays disabled
    exec_ok(mgr, s, "insert into zdb_t (name) values ('low')").await;
    assert_eq!(
        one(mgr, s, "select name from zdb_t where name like 'LOW'").await,
        "LOW"
    );
    assert_eq!(
        one(
            mgr,
            s,
            "select status from user_triggers where trigger_name = 'ZDB_TRG2'"
        )
        .await,
        "DISABLED"
    );
    assert_eq!(
        one(
            mgr,
            s,
            "select status from user_triggers where trigger_name = 'ZDB_TRG'"
        )
        .await,
        "ENABLED"
    );
    // read-only view, comment, nothing invalid
    let ev = run(mgr, s, "insert into zdb_v_ro (id, name) values (1000, 'x')").await;
    assert!(
        errors(&ev).iter().any(|e| e.contains("ORA-42399")),
        "{:?}",
        errors(&ev)
    );
    assert_eq!(
        one(
            mgr,
            s,
            "select comments from user_tab_comments where table_name = 'ZDB_T'"
        )
        .await,
        "rows"
    );
    assert_eq!(
        one(mgr, s, "select count(*) from user_objects where object_name like 'ZDB\\_%' escape '\\' and status = 'INVALID'").await,
        "0"
    );
    assert_eq!(
        one(
            mgr,
            s,
            "select count(*) from user_objects where object_name = 'ZDB_PKG'"
        )
        .await,
        "2"
    );
}

#[tokio::test]
async fn views_routines_and_sequences_round_trip() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let _guard = LOCK.lock().await;
    let mgr = &connected(&cfg).await;
    let s = mgr.open_session("ora").await.unwrap();
    let schema = current_schema(mgr, &s).await;
    clean(mgr, &s, "ZDB").await;
    exec_ok(mgr, &s, SETUP_B).await;
    exec_ok(mgr, &s, "select zdb_seq.nextval from dual").await;
    let last: i64 = one(
        mgr,
        &s,
        "select last_number from user_sequences where sequence_name = 'ZDB_SEQ'",
    )
    .await
    .parse()
    .unwrap();

    let opts = DumpOptions {
        include_routines: true,
        ..options(None)
    };
    let (text, _res) = dump(mgr, &schema, &opts).await;
    for needle in [
        "CREATE SEQUENCE ZDB_SEQ START WITH ",
        "CREATE OR REPLACE FORCE VIEW ZDB_V_A (SHOUT) AS",
        "WITH READ ONLY;",
        "CREATE OR REPLACE FUNCTION zdb_fz",
        "CREATE OR REPLACE PACKAGE zdb_pkg",
        "CREATE OR REPLACE PACKAGE BODY zdb_pkg",
        "CREATE OR REPLACE TRIGGER zdb_trg",
        "ALTER TRIGGER ZDB_TRG2 DISABLE;",
        "\n/\n",
    ] {
        assert!(
            text.to_ascii_uppercase()
                .contains(&needle.to_ascii_uppercase()),
            "{needle:?} missing in the dump"
        );
    }
    // dependency order: the view a view selects from, the function a function calls, come first
    let up = text.to_ascii_uppercase();
    assert!(up.find("VIEW ZDB_V_Z").unwrap() < up.find("VIEW ZDB_V_A").unwrap());
    assert!(up.find("FUNCTION ZDB_FZ").unwrap() < up.find("FUNCTION ZDB_FA").unwrap());
    assert!(up.find("PACKAGE ZDB_PKG").unwrap() < up.find("FUNCTION ZDB_FZ").unwrap());
    assert!(up.find("FUNCTION ZDB_FA").unwrap() < up.find("PACKAGE BODY ZDB_PKG").unwrap());
    assert!(up.find("PACKAGE BODY ZDB_PKG").unwrap() < up.find("TRIGGER ZDB_TRG ").unwrap());

    // restore only the objects of this test (the schema may hold others)
    let script = only_prefix(&text, "ZDB_");
    clean(mgr, &s, "ZDB").await;
    assert_eq!(
        one(
            mgr,
            &s,
            "select count(*) from user_objects where object_name like 'ZDB\\_%' escape '\\'"
        )
        .await,
        "0"
    );
    restore(mgr, &s, &script).await;
    assert_eq!(
        one(
            mgr,
            &s,
            "select last_number from user_sequences where sequence_name = 'ZDB_SEQ'"
        )
        .await,
        last.to_string(),
        "the sequence continues where the source stood"
    );
    assert_units_work(mgr, &s).await;
    let next: i64 = one(mgr, &s, "select zdb_seq.nextval from dual")
        .await
        .parse()
        .unwrap();
    assert!(next >= last, "{next} >= {last}");

    // a second run over the existing objects (drop_if_exists) ends in the same state
    restore(mgr, &s, &script).await;
    exec_ok(
        mgr,
        &s,
        "delete from zdb_log; delete from zdb_t where name = 'LOW'; commit;",
    )
    .await;
    assert_eq!(one(mgr, &s, "select count(*) from zdb_t").await, "3");
    assert_eq!(one(mgr, &s, "select zdb_pkg.twice(1) from dual").await, "2");

    // without data and without drops: the same objects, empty tables
    let (text, res) = dump(
        mgr,
        &schema,
        &DumpOptions {
            data: false,
            drop_if_exists: false,
            include_routines: true,
            ..Default::default()
        },
    )
    .await;
    assert!(res.tables >= 2);
    assert!(!text.contains("DROP TABLE") && !text.contains("INSERT INTO ZDB_T"));
    clean(mgr, &s, "ZDB").await;
    restore(mgr, &s, &only_prefix(&text, "ZDB_")).await;
    assert_eq!(one(mgr, &s, "select count(*) from zdb_t").await, "0");
    assert_eq!(one(mgr, &s, "select zdb_fa('Q') from dual").await, "q-a");

    clean(mgr, &s, "ZDB").await;
    mgr.disconnect("ora").await;
}

#[tokio::test]
async fn cancel_stops_the_dump_and_progress_names_the_table() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let _guard = LOCK.lock().await;
    let mgr = &connected(&cfg).await;
    let s = mgr.open_session("ora").await.unwrap();
    let schema = current_schema(mgr, &s).await;
    clean(mgr, &s, "ZDC").await;
    exec_ok(mgr, &s, "create table zdc_t (id number primary key, v varchar2(10)); insert into zdc_t select level, 'x' from dual connect by level <= 50; commit;").await;

    let seen = std::sync::Mutex::new(Vec::<(String, Option<String>)>::new());
    let mut buf = Vec::new();
    let opts = DumpOptions {
        tables: Some(vec!["ZDC_T".into()]),
        ..Default::default()
    };
    let res = mgr
        .dump_schema(
            "ora",
            &schema,
            &opts,
            &CancellationToken::new(),
            &|p| seen.lock().unwrap().push((p.phase, p.table)),
            &mut buf,
        )
        .await
        .unwrap();
    assert_eq!((res.tables, res.rows), (1, 50));
    assert!(seen
        .lock()
        .unwrap()
        .iter()
        .any(|(ph, t)| ph == "tables" && t.as_deref() == Some("ZDC_T")));

    let cancel = CancellationToken::new();
    cancel.cancel();
    let res = mgr
        .dump_schema("ora", &schema, &opts, &cancel, &|_| {}, &mut Vec::new())
        .await
        .unwrap();
    assert!(res.cancelled);

    clean(mgr, &s, "ZDC").await;
    mgr.disconnect("ora").await;
}
