//! Schema model of "Compare schemas" (`ConnectionManager::schema_model`) against live databases.
//!
//! Oracle, PostgreSQL and MySQL need the variables of the other integration tests and skip without them; SQLite always
//! runs (a temporary file). Objects use their own names so other test files do not see them: the Oracle prefixes
//! `CMPOA_` / `CMPOB_` / `CMPOR_` in the demo user's schema (the second schema cannot be created there), the PostgreSQL
//! schemas `cmp_pg_a` / `cmp_pg_b`, the MySQL databases `cmp_my_a` / `cmp_my_b`.
//!
//!   PROMETEO_ORACLE_URL=oracle://demo:...@127.0.0.1:15219/FREEPDB1 PROMETEO_PG_URL=... \
//!   cargo test -p dbcore --test compare_db -- --nocapture

mod common;

use common::*;
use dbcore::compare::{RoutineModel, SchemaModel, TableModel};
use dbcore::*;

fn table<'a>(m: &'a SchemaModel, name: &str) -> &'a TableModel {
    m.tables.iter().find(|t| t.name == name).unwrap_or_else(|| {
        panic!(
            "no table {name} in {:?}",
            m.tables.iter().map(|t| &t.name).collect::<Vec<_>>()
        )
    })
}

fn table_names(m: &SchemaModel) -> Vec<String> {
    m.tables.iter().map(|t| t.name.clone()).collect()
}

fn routine<'a>(m: &'a SchemaModel, name: &str, kind: &str) -> Option<&'a RoutineModel> {
    m.routines.iter().find(|r| r.name == name && r.kind == kind)
}

/// The model with `prefix` removed from the object names (and from the referenced tables), so that two prefixed
/// sets compare by name.
fn unprefixed(mut m: SchemaModel, prefix: &str) -> SchemaModel {
    fn cut(n: &mut String, prefix: &str) {
        if let Some(rest) = n.strip_prefix(prefix) {
            let rest = rest.to_string();
            *n = rest;
        }
    }
    for t in &mut m.tables {
        cut(&mut t.name, prefix);
        for f in &mut t.foreign_keys {
            cut(&mut f.ref_table, prefix);
        }
    }
    for v in &mut m.views {
        cut(&mut v.name, prefix);
    }
    for s in &mut m.sequences {
        cut(&mut s.name, prefix);
    }
    for r in &mut m.routines {
        cut(&mut r.name, prefix);
    }
    m
}

// ---------------------------------------------------------------- Oracle

const ORA_SETUP_A: &str = "
create table CMPOA_DEPT (ID number(10) not null, NAME varchar2(40), constraint CMPOA_DEPT_PK primary key (ID));
create table CMPOA_EMP (
  ID number(10) not null,
  NAME varchar2(50) not null,
  SAL number(10,2) default 0,
  DEPT_ID number(10),
  constraint CMPOA_EMP_PK primary key (ID),
  constraint CMPOA_EMP_SAL_CK check (SAL > 0),
  constraint CMPOA_EMP_DEPT_FK foreign key (DEPT_ID) references CMPOA_DEPT (ID) on delete cascade
);
create index CMPOA_EMP_NAME_IX on CMPOA_EMP (NAME);
create table CMPOA_ITEM (
  ID number(10) not null primary key,
  NAME varchar2(20) default 'N' not null,
  CODE char(1) default null,
  TS timestamp default current_timestamp,
  constraint CMPOA_ITEM_CK check (ID > 0) disable
);
create index CMPOA_ITEM_DESC on CMPOA_ITEM (NAME desc);
create index CMPOA_ITEM_FDESC on CMPOA_ITEM (upper(NAME) desc);
create bitmap index CMPOA_ITEM_BM on CMPOA_ITEM (CODE);
create or replace view CMPOA_V_EMP as select ID, NAME from CMPOA_EMP;
create sequence CMPOA_SEQ start with 10 increment by 1;
create or replace procedure CMPOA_P(p_n in number) is begin null; end CMPOA_P;
/
";

const ORA_SETUP_B: &str = "
create table CMPOB_EMP (ID number(10) not null, NAME varchar2(80), EXTRA date, constraint CMPOB_EMP_PK primary key (ID));
create unique index CMPOB_EMP_NAME_IX on CMPOB_EMP (NAME);
create table CMPOB_AUDIT (ID number(10) not null, constraint CMPOB_AUDIT_PK primary key (ID));
";

/// One anonymous block per object, so a missing object is not an error.
fn ora_drop(objects: &[&str]) -> String {
    objects
        .iter()
        .map(|o| {
            format!(
                "begin execute immediate 'drop {o}'; exception when others then null; end;\n/\n"
            )
        })
        .collect()
}

const ORA_OBJECTS: [&str; 8] = [
    "view CMPOA_V_EMP",
    "table CMPOA_EMP purge",
    "table CMPOA_ITEM purge",
    "table CMPOA_DEPT purge",
    "sequence CMPOA_SEQ",
    "procedure CMPOA_P",
    "table CMPOB_EMP purge",
    "table CMPOB_AUDIT purge",
];

#[tokio::test]
async fn oracle_model_of_two_prefixed_sets() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let owner = cfg.user.to_uppercase();
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    assert_ok(&run(&mgr, &s, &ora_drop(&ORA_OBJECTS)).await);
    assert_ok(&run(&mgr, &s, ORA_SETUP_A).await);
    assert_ok(&run(&mgr, &s, ORA_SETUP_B).await);

    let a = unprefixed(
        mgr.schema_model(&cfg.id, &owner, Some("CMPOA_"))
            .await
            .expect("model of the A set"),
        "CMPOA_",
    );
    let b = unprefixed(
        mgr.schema_model(&cfg.id, &owner, Some("CMPOB_"))
            .await
            .expect("model of the B set"),
        "CMPOB_",
    );
    assert_eq!(a.driver, Driver::Oracle);
    assert_eq!(a.name_prefix.as_deref(), Some("CMPOA_"));

    // tables, columns, types, nullability, defaults
    assert_eq!(table_names(&a), ["DEPT", "EMP", "ITEM"]);
    assert_eq!(table_names(&b), ["AUDIT", "EMP"]);
    let emp = table(&a, "EMP");
    let cols: Vec<&str> = emp.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(cols, ["ID", "NAME", "SAL", "DEPT_ID"]);
    assert!(
        emp.columns[1].data_type.starts_with("VARCHAR2(50"),
        "{:?}",
        emp.columns[1]
    );
    assert!(!emp.columns[1].nullable);
    assert_eq!(emp.columns[2].data_type, "NUMBER(10,2)");
    assert_eq!(emp.columns[2].default.as_deref(), Some("0"));
    assert!(emp.columns[2].nullable);

    // keys: the primary key is read from its constraint, the NOT NULL checks (SYS_C...) are left out
    let pk = emp.primary_key.as_ref().expect("primary key");
    assert_eq!(
        (pk.name.as_str(), pk.columns.as_slice()),
        ("CMPOA_EMP_PK", ["ID".to_string()].as_slice())
    );
    assert_eq!(emp.checks.len(), 1, "{:?}", emp.checks);
    assert!(
        emp.checks[0].expression.contains("SAL > 0"),
        "{:?}",
        emp.checks[0]
    );
    assert_eq!(emp.foreign_keys.len(), 1);
    let fk = &emp.foreign_keys[0];
    assert_eq!(fk.columns, ["DEPT_ID"]);
    assert_eq!(fk.ref_table, "DEPT");
    assert_eq!(fk.ref_schema, None);
    assert_eq!(fk.on_delete, "CASCADE");
    assert_eq!(fk.ref_columns, ["ID"]);

    // indexes that no constraint owns
    assert_eq!(emp.indexes.len(), 1, "{:?}", emp.indexes);
    assert_eq!(emp.indexes[0].name, "CMPOA_EMP_NAME_IX");
    assert_eq!(emp.indexes[0].columns, ["NAME"]);
    assert!(!emp.indexes[0].unique);
    assert_eq!(emp.indexes[0].descending, [false]);
    assert!(!emp.indexes[0].bitmap && !emp.indexes[0].generated_name);

    // constraint flags: a named key is not generated, an enabled one is enabled
    assert!(!pk.generated_name && pk.enabled);
    assert!(emp.foreign_keys[0].enabled && !emp.foreign_keys[0].generated_name);
    assert!(emp.checks[0].enabled && !emp.checks[0].generated_name);

    // ITEM: an unnamed primary key (system name), a disabled check, a default literal and a NULL default, DESC and
    // bitmap indexes
    let item = table(&a, "ITEM");
    let ipk = item.primary_key.as_ref().expect("primary key of ITEM");
    assert!(
        ipk.name.starts_with("SYS_C") && ipk.generated_name && ipk.enabled,
        "{ipk:?}"
    );
    assert_eq!(ipk.columns, ["ID"]);
    assert_eq!(item.checks.len(), 1, "{:?}", item.checks);
    assert_eq!(
        (
            item.checks[0].name.as_str(),
            item.checks[0].enabled,
            item.checks[0].generated_name
        ),
        ("CMPOA_ITEM_CK", false, false)
    );
    let name_col = &item.columns[1];
    assert_eq!(
        (
            name_col.default.as_deref(),
            name_col.default_kind.as_deref()
        ),
        (Some("'N'"), Some("expression"))
    );
    let code_col = &item.columns[2];
    assert_eq!(
        (
            code_col.default.as_deref(),
            code_col.default_kind.as_deref()
        ),
        (None, None)
    );
    assert!(
        item.columns[3]
            .default
            .as_deref()
            .unwrap_or_default()
            .to_uppercase()
            .contains("CURRENT_TIMESTAMP"),
        "{:?}",
        item.columns[3]
    );
    let index = |name: &str| {
        item.indexes
            .iter()
            .find(|i| i.name == name)
            .unwrap_or_else(|| panic!("no index {name}: {:?}", item.indexes))
    };
    // a descending plain column: the column is the name, not the hidden SYS_NC column
    let desc = index("CMPOA_ITEM_DESC");
    assert_eq!(desc.columns, ["NAME"]);
    assert_eq!(desc.descending, [true]);
    assert_eq!(desc.method, "normal");
    assert!(!desc.bitmap && !desc.generated_name);
    // a descending expression
    let fdesc = index("CMPOA_ITEM_FDESC");
    assert_eq!(fdesc.columns, ["UPPER(\"NAME\")"]);
    assert_eq!(fdesc.descending, [true]);
    assert_eq!(fdesc.method, "function-based normal");
    // a bitmap index
    let bm = index("CMPOA_ITEM_BM");
    assert_eq!(bm.columns, ["CODE"]);
    assert_eq!(bm.descending, [false]);
    assert!(bm.bitmap);
    assert_eq!(bm.method, "bitmap");

    // the B side differs: a unique index, an extra column, no check, no foreign key
    let emp_b = table(&b, "EMP");
    assert!(emp_b.columns[1].data_type.starts_with("VARCHAR2(80"));
    assert!(emp_b.columns[1].nullable);
    assert_eq!(
        emp_b
            .columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["ID", "NAME", "EXTRA"]
    );
    assert!(emp_b.checks.is_empty() && emp_b.foreign_keys.is_empty());
    assert!(emp_b
        .indexes
        .iter()
        .any(|i| i.name == "CMPOB_EMP_NAME_IX" && i.unique));

    // views, sequences and stored code
    assert_eq!(a.views.len(), 1);
    assert_eq!(a.views[0].name, "V_EMP");
    assert!(
        a.views[0]
            .definition
            .to_lowercase()
            .contains("select id, name from"),
        "{:?}",
        a.views[0]
    );
    assert!(b.views.is_empty());
    assert_eq!(a.sequences.len(), 1);
    assert_eq!(a.sequences[0].name, "SEQ");
    assert_eq!(a.sequences[0].increment_by, "1");
    assert!(routine(&a, "P", "PROCEDURE").is_some(), "{:?}", a.routines);
    assert!(b.routines.is_empty());

    // the prefix is a real name filter (no LIKE wildcards): a prefix with % matches nothing
    let none = mgr
        .schema_model(&cfg.id, &owner, Some("CMPO%"))
        .await
        .unwrap();
    assert!(none.tables.is_empty(), "{:?}", table_names(&none));
    let one = mgr
        .schema_model(&cfg.id, &owner, Some("CMPOA_EMP"))
        .await
        .unwrap();
    assert_eq!(table_names(&one), ["CMPOA_EMP"]);

    assert_ok(&run(&mgr, &s, &ora_drop(&ORA_OBJECTS)).await);
    mgr.close_session(&s).await;
}

/// The fingerprint of the procedure `CMPOR_P` of the model of `owner`.
async fn ora_routine_hash(mgr: &ConnectionManager, ds: &str, owner: &str) -> String {
    let m = mgr
        .schema_model(ds, owner, Some("CMPOR_"))
        .await
        .expect("model of the routines");
    routine(&m, "CMPOR_P", "PROCEDURE")
        .unwrap_or_else(|| panic!("no procedure CMPOR_P: {:?}", m.routines))
        .source_hash
        .clone()
}

#[tokio::test]
async fn oracle_routine_fingerprint_ignores_layout_case_and_owner() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let owner = cfg.user.to_uppercase();
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    let cleanup = ora_drop(&["procedure CMPOR_P"]);
    assert_ok(&run(&mgr, &s, &cleanup).await);

    assert_ok(
        &run(
            &mgr,
            &s,
            "create or replace procedure CMPOR_P(p_n in number) is begin null; end CMPOR_P;\n/\n",
        )
        .await,
    );
    let plain = ora_routine_hash(&mgr, &cfg.id, &owner).await;

    // the same code: other case, other white space, the owner in front of the name (comments are code text: not here)
    assert_ok(
        &run(
            &mgr,
            &s,
            &format!(
                "create or replace procedure {owner}.CMPOR_P(p_n IN   NUMBER)\nis\nbegin\n  NULL;\nend cmpor_p;\n/\n"
            ),
        )
        .await,
    );
    assert_eq!(ora_routine_hash(&mgr, &cfg.id, &owner).await, plain);

    // a different statement is a different routine
    assert_ok(
        &run(
            &mgr,
            &s,
            "create or replace procedure CMPOR_P(p_n in number) is begin null; null; end CMPOR_P;\n/\n",
        )
        .await,
    );
    assert_ne!(ora_routine_hash(&mgr, &cfg.id, &owner).await, plain);

    assert_ok(&run(&mgr, &s, &cleanup).await);
    mgr.close_session(&s).await;
}

// ---------------------------------------------------------------- PostgreSQL

const PG_CLEAN: &str =
    "drop schema if exists cmp_pg_a cascade; drop schema if exists cmp_pg_b cascade;";

const PG_SETUP_A: &str = "
create schema cmp_pg_a;
create table cmp_pg_a.customers (id integer primary key);
create table cmp_pg_a.orders (
  id integer primary key,
  name varchar(50) not null default 'x',
  total numeric(10,2),
  created timestamp with time zone,
  customer_id integer references cmp_pg_a.customers (id) on delete cascade,
  constraint orders_name_key unique (name),
  constraint orders_total_ck check (total >= 0)
);
create index orders_total_idx on cmp_pg_a.orders (total);
create table cmp_pg_a.items (
  id integer primary key,
  code char(1) default 'N',
  qty integer
);
alter table cmp_pg_a.items add constraint items_qty_ck check (qty > 0) not valid;
create index items_qty_desc on cmp_pg_a.items (qty desc);
create view cmp_pg_a.v_orders as select id, name from cmp_pg_a.orders;
create sequence cmp_pg_a.seq_custom increment by 2;
create function cmp_pg_a.f_double(a integer) returns integer language sql as 'select a * 2';
create function cmp_pg_a.trg_fn() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger trg_orders before insert on cmp_pg_a.orders for each row execute function cmp_pg_a.trg_fn();
";

const PG_SETUP_B: &str = "
create schema cmp_pg_b;
create table cmp_pg_b.orders (
  id integer primary key,
  name varchar(80),
  total numeric(10,2) not null,
  extra text
);
create view cmp_pg_b.v_orders as select id, name, total from cmp_pg_b.orders;
create function cmp_pg_b.f_double(a integer) returns integer language sql as 'select a * 2';
";

#[tokio::test]
async fn postgres_model_of_two_schemas() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("PROMETEO_PG_URL not set: skipping");
        return;
    };
    seed_pg(&cfg).await;
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    assert_ok(&run(&mgr, &s, PG_CLEAN).await);
    assert_ok(&run(&mgr, &s, PG_SETUP_A).await);
    assert_ok(&run(&mgr, &s, PG_SETUP_B).await);

    let a = mgr
        .schema_model(&cfg.id, "cmp_pg_a", None)
        .await
        .expect("model A");
    let b = mgr
        .schema_model(&cfg.id, "cmp_pg_b", None)
        .await
        .expect("model B");
    assert_eq!(a.driver, Driver::Postgres);
    assert_eq!(table_names(&a), ["customers", "items", "orders"]);
    assert_eq!(table_names(&b), ["orders"]);

    // a NOT VALID check is disabled; a DESC index column is flagged; the default text of a char column is SQL
    let it = table(&a, "items");
    assert_eq!(it.checks.len(), 1, "{:?}", it.checks);
    assert!(!it.checks[0].enabled && !it.checks[0].generated_name);
    assert_eq!(it.indexes.len(), 1, "{:?}", it.indexes);
    assert_eq!(it.indexes[0].columns, ["qty"]);
    assert_eq!(it.indexes[0].descending, [true]);
    assert_eq!(it.indexes[0].method, "btree");
    assert!(!it.indexes[0].bitmap && !it.indexes[0].generated_name);
    assert_eq!(it.columns[1].default_kind.as_deref(), Some("expression"));
    assert!(
        it.columns[1]
            .default
            .as_deref()
            .unwrap_or_default()
            .contains("'N'"),
        "{:?}",
        it.columns[1]
    );

    let o = table(&a, "orders");
    let types: Vec<(&str, &str, bool)> = o
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.data_type.as_str(), c.nullable))
        .collect();
    assert_eq!(
        types,
        [
            ("id", "integer", false),
            ("name", "varchar(50)", false),
            ("total", "numeric(10,2)", true),
            ("created", "timestamp with time zone", true),
            ("customer_id", "integer", true),
        ]
    );
    assert!(
        o.columns[1]
            .default
            .as_deref()
            .unwrap_or_default()
            .contains("'x'"),
        "{:?}",
        o.columns[1]
    );
    let pk = o.primary_key.as_ref().expect("primary key");
    assert_eq!(
        (pk.name.as_str(), pk.columns.as_slice()),
        ("orders_pkey", ["id".to_string()].as_slice())
    );
    // PostgreSQL names its constraints itself and enforces them all here
    assert!(!pk.generated_name && pk.enabled);
    assert!(o.checks[0].enabled && !o.checks[0].generated_name);
    // the unique constraint is a constraint, its index is not an index of its own
    assert_eq!(o.unique.len(), 1);
    assert_eq!(
        (o.unique[0].name.as_str(), o.unique[0].columns.as_slice()),
        ("orders_name_key", ["name".to_string()].as_slice())
    );
    assert_eq!(o.checks.len(), 1);
    assert!(
        o.checks[0].expression.contains("total >="),
        "{:?}",
        o.checks[0]
    );
    assert_eq!(o.foreign_keys.len(), 1);
    let fk = &o.foreign_keys[0];
    assert_eq!(
        (
            fk.ref_table.as_str(),
            fk.ref_schema.clone(),
            fk.on_delete.as_str()
        ),
        ("customers", None, "CASCADE")
    );
    assert_eq!(fk.columns, ["customer_id"]);
    assert_eq!(o.indexes.len(), 1, "{:?}", o.indexes);
    assert_eq!(o.indexes[0].name, "orders_total_idx");
    assert_eq!(o.indexes[0].method, "btree");
    assert!(!o.indexes[0].unique);

    assert!(table(&b, "orders").unique.is_empty());
    assert!(table(&b, "orders").foreign_keys.is_empty());

    // views keep their text with the schema removed
    assert_eq!(a.views.len(), 1);
    assert!(
        a.views[0].definition.to_lowercase().contains("from orders"),
        "{:?}",
        a.views[0]
    );
    assert!(
        !a.views[0].definition.contains("cmp_pg_a"),
        "{:?}",
        a.views[0]
    );
    assert!(b.views[0].definition.to_lowercase().contains("total"));

    // standalone sequences only (the serial / identity ones belong to their column)
    assert_eq!(a.sequences.len(), 1);
    assert_eq!(
        (
            a.sequences[0].name.as_str(),
            a.sequences[0].increment_by.as_str()
        ),
        ("seq_custom", "2")
    );
    assert!(b.sequences.is_empty());

    // functions and triggers: f_double is the same text in both schemas, so its fingerprint is the same
    let fa = routine(&a, "f_double", "FUNCTION").expect("f_double of A");
    let fb = routine(&b, "f_double", "FUNCTION").expect("f_double of B");
    assert!(fa.signature.contains("integer"), "{fa:?}");
    assert_eq!(fa.source_hash, fb.source_hash);
    let trg = routine(&a, "trg_orders", "TRIGGER").expect("trigger of A");
    assert_eq!(trg.signature, "orders");
    assert!(routine(&a, "trg_fn", "FUNCTION").is_some());

    assert_ok(&run(&mgr, &s, PG_CLEAN).await);
    mgr.close_session(&s).await;
}

// ---------------------------------------------------------------- MySQL

const MY_CLEAN: &str = "drop database if exists cmp_my_a; drop database if exists cmp_my_b;";

const MY_SETUP_A: &str = "
create database cmp_my_a;
create table cmp_my_a.customers (id int not null primary key) engine = innodb;
create table cmp_my_a.orders (
  id int not null primary key,
  name varchar(50) not null default 'x',
  total decimal(10,2),
  customer_id int,
  constraint orders_name_uq unique (name),
  constraint orders_total_ck check (total >= 0),
  constraint orders_customer_fk foreign key (customer_id) references cmp_my_a.customers (id) on delete cascade,
  index orders_total_ix (total)
) engine = innodb;
create table cmp_my_a.items (
  id int not null primary key,
  code char(1) default 'N',
  qty int default 5,
  created timestamp default current_timestamp,
  index items_qty_desc (qty desc)
) engine = innodb;
create view cmp_my_a.v_orders as select id, name from cmp_my_a.orders;
create trigger cmp_my_a.trg_orders before insert on cmp_my_a.orders for each row set new.total = coalesce(new.total, 0);
";

const MY_SETUP_B: &str = "
create database cmp_my_b;
create table cmp_my_b.orders (id int not null primary key, name varchar(80), total decimal(10,2) not null, extra text) engine = innodb;
create view cmp_my_b.v_orders as select id, name, total from cmp_my_b.orders;
";

#[tokio::test]
async fn mysql_model_of_two_databases() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("PROMETEO_MYSQL_URL not set: skipping");
        return;
    };
    seed_mysql(&cfg).await;
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    assert_ok(&run(&mgr, &s, MY_CLEAN).await);
    assert_ok(&run(&mgr, &s, MY_SETUP_A).await);
    assert_ok(&run(&mgr, &s, MY_SETUP_B).await);

    let a = mgr
        .schema_model(&cfg.id, "cmp_my_a", None)
        .await
        .expect("model A");
    let b = mgr
        .schema_model(&cfg.id, "cmp_my_b", None)
        .await
        .expect("model B");
    assert_eq!(a.driver, Driver::MySql);
    assert_eq!(table_names(&a), ["customers", "items", "orders"]);
    assert_eq!(table_names(&b), ["orders"]);

    // defaults: a quoted literal is the value without quotes (kind literal), CURRENT_TIMESTAMP is an expression
    let it = table(&a, "items");
    let kind_of = |name: &str| {
        let c = it.columns.iter().find(|c| c.name == name).expect("column");
        (c.default.clone(), c.default_kind.clone())
    };
    assert_eq!(kind_of("code"), (Some("N".into()), Some("literal".into())));
    assert_eq!(kind_of("qty"), (Some("5".into()), Some("literal".into())));
    assert_eq!(
        kind_of("created"),
        (Some("CURRENT_TIMESTAMP".into()), Some("expression".into()))
    );
    assert_eq!(kind_of("id").1, None);
    // a DESC key part
    assert_eq!(it.indexes.len(), 1, "{:?}", it.indexes);
    assert_eq!(it.indexes[0].name, "items_qty_desc");
    assert_eq!(it.indexes[0].columns, ["qty"]);
    assert_eq!(it.indexes[0].descending, [true]);
    assert!(!it.indexes[0].bitmap && !it.indexes[0].generated_name);

    let o = table(&a, "orders");
    let types: Vec<(&str, &str, bool)> = o
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.data_type.as_str(), c.nullable))
        .collect();
    assert_eq!(
        types,
        [
            ("id", "int", false),
            ("name", "varchar(50)", false),
            ("total", "decimal(10,2)", true),
            ("customer_id", "int", true)
        ]
    );
    assert_eq!(
        o.columns[1].default.as_deref(),
        Some("x"),
        "{:?}",
        o.columns[1]
    );
    let pk = o.primary_key.as_ref().expect("primary key");
    assert_eq!(
        (pk.name.as_str(), pk.columns.as_slice()),
        ("PRIMARY", ["id".to_string()].as_slice())
    );
    assert_eq!(o.unique.len(), 1);
    assert_eq!(o.unique[0].columns, ["name"]);
    assert!(o.unique[0].enabled && !o.unique[0].generated_name);
    assert_eq!(o.checks.len(), 1, "{:?}", o.checks);
    assert!(o.checks[0].enabled && !o.checks[0].generated_name);
    assert!(
        o.checks[0].expression.contains("total") && o.checks[0].expression.contains(">= 0"),
        "{:?}",
        o.checks[0]
    );
    assert_eq!(o.foreign_keys.len(), 1);
    assert_eq!(
        (
            o.foreign_keys[0].ref_table.as_str(),
            o.foreign_keys[0].on_delete.as_str()
        ),
        ("customers", "CASCADE")
    );
    // the index of the unique constraint and of the foreign key are constraints, not indexes
    assert_eq!(o.indexes.len(), 1, "{:?}", o.indexes);
    assert_eq!(
        (
            o.indexes[0].name.as_str(),
            o.indexes[0].method.as_str(),
            o.indexes[0].unique
        ),
        ("orders_total_ix", "btree", false)
    );

    assert!(table(&b, "orders").unique.is_empty() && table(&b, "orders").checks.is_empty());
    assert_eq!(a.views.len(), 1);
    assert!(
        a.views[0]
            .definition
            .to_lowercase()
            .contains("from `orders`")
            || a.views[0].definition.to_lowercase().contains("from orders"),
        "{:?}",
        a.views[0]
    );
    assert!(
        !a.views[0].definition.contains("cmp_my_a"),
        "{:?}",
        a.views[0]
    );
    let trg = routine(&a, "trg_orders", "TRIGGER").expect("trigger of A");
    assert_eq!(trg.signature, "orders");
    assert!(b.routines.is_empty());
    assert!(
        a.sequences.is_empty(),
        "MySQL has no sequences in this model"
    );

    assert_ok(&run(&mgr, &s, MY_CLEAN).await);
    mgr.close_session(&s).await;
}

// ---------------------------------------------------------------- SQLite (always runs)

const LITE_SETUP: &str = "
create table customers (id integer primary key);
create table orders (
    id integer primary key,
    name text not null,
    total numeric(10,2),
    customer_id integer references customers (id) on delete cascade,
    unique (name),
    check (total >= 0)
);
create index orders_total_idx on orders (total);
create view v_orders as select id, name from orders;
create trigger trg_orders after insert on orders begin select 1; end;
create table items (
    id integer primary key,
    code text default 'N',
    qty integer default 5,
    created text default CURRENT_TIMESTAMP,
    note text default 'it''s',
    gone text default NULL
);
create index items_qty_desc on items (qty desc);
";

#[tokio::test]
async fn sqlite_model_of_the_main_schema() {
    let dir = tempfile::tempdir().expect("temp dir");
    let file = dir.path().join("compare.db");
    let cfg = lite_cfg(&file);
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    assert_ok(&run(&mgr, &s, LITE_SETUP).await);

    let m = mgr
        .schema_model(&cfg.id, "main", None)
        .await
        .expect("model");
    assert_eq!(m.driver, Driver::Sqlite);
    assert_eq!(m.schema, "main");
    assert_eq!(table_names(&m), ["customers", "items", "orders"]);

    // defaults: a string literal is the value without its quotes, CURRENT_TIMESTAMP is an expression, NULL is none
    let it = table(&m, "items");
    let kind_of = |name: &str| {
        let c = it.columns.iter().find(|c| c.name == name).expect("column");
        (c.default.clone(), c.default_kind.clone())
    };
    assert_eq!(kind_of("code"), (Some("N".into()), Some("literal".into())));
    assert_eq!(kind_of("qty"), (Some("5".into()), Some("literal".into())));
    assert_eq!(
        kind_of("note"),
        (Some("it's".into()), Some("literal".into()))
    );
    assert_eq!(
        kind_of("created"),
        (Some("CURRENT_TIMESTAMP".into()), Some("expression".into()))
    );
    assert_eq!(kind_of("gone"), (None, None));
    // a descending key column; the primary key is enabled and not generated
    assert_eq!(it.indexes.len(), 1, "{:?}", it.indexes);
    assert_eq!(it.indexes[0].columns, ["qty"]);
    assert_eq!(it.indexes[0].descending, [true]);
    assert!(!it.indexes[0].bitmap && !it.indexes[0].generated_name);
    assert!(it
        .primary_key
        .as_ref()
        .is_some_and(|k| k.enabled && !k.generated_name));

    let o = table(&m, "orders");
    let types: Vec<(&str, &str, bool)> = o
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.data_type.as_str(), c.nullable))
        .collect();
    assert_eq!(
        types,
        [
            ("id", "integer", true),
            ("name", "text", false),
            ("total", "numeric(10,2)", true),
            ("customer_id", "integer", true)
        ]
    );
    // the primary key is the columns of the table; the unique index is the constraint of `name`
    assert_eq!(
        o.primary_key.as_ref().map(|k| k.columns.clone()),
        Some(vec!["id".to_string()])
    );
    assert_eq!(o.unique.len(), 1);
    assert_eq!(o.unique[0].columns, ["name"]);
    assert!(
        o.unique[0].name.starts_with("sqlite_autoindex"),
        "{:?}",
        o.unique[0]
    );
    assert_eq!(o.foreign_keys.len(), 1);
    assert_eq!(
        (
            o.foreign_keys[0].ref_table.as_str(),
            o.foreign_keys[0].on_delete.as_str()
        ),
        ("customers", "CASCADE")
    );
    assert_eq!(o.indexes.len(), 1, "{:?}", o.indexes);
    assert_eq!(o.indexes[0].name, "orders_total_idx");
    assert_eq!(m.views.len(), 1);
    assert!(
        m.views[0]
            .definition
            .contains("select id, name from orders"),
        "{:?}",
        m.views[0]
    );
    let trg = routine(&m, "trg_orders", "TRIGGER").expect("trigger");
    assert_eq!(trg.signature, "orders");

    // an empty schema name is the main database
    let same = mgr.schema_model(&cfg.id, "", None).await.expect("model");
    assert_eq!(same.schema, "main");
    assert_eq!(table_names(&same), table_names(&m));

    mgr.close_session(&s).await;
    mgr.disconnect(&cfg.id).await;
}
