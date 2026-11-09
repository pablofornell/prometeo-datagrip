//! Find Usages (Alt+F7) integration tests: Oracle, PostgreSQL, MySQL and SQLite. Each test builds a small schema with
//! its own name prefix and removes it at the start and at the end. Run with the same variables as the other DB tests:
//!   PROMETEO_ORACLE_URL=oracle://demo:<password>@127.0.0.1:15219/FREEPDB1 cargo test -p dbcore --test usages_db -- --nocapture
//! The SQLite test always runs (it uses a temp file).

mod common;

use common::*;
use dbcore::*;

fn obj(schema: Option<&str>, name: &str, kind: NodeKind, table: Option<&str>) -> ObjectRef {
    ObjectRef {
        schema: schema.map(str::to_string),
        name: name.into(),
        kind,
        table: table.map(str::to_string),
        signature: None,
    }
}

/// The usage of `kind` called `name` (exact), if there is one.
fn find<'a>(us: &'a [Usage], kind: UsageKind, name: &str) -> Option<&'a Usage> {
    us.iter().find(|u| u.kind == kind && u.name == name)
}

fn must<'a>(us: &'a [Usage], kind: UsageKind, name: &str) -> &'a Usage {
    find(us, kind, name).unwrap_or_else(|| panic!("no {kind:?} {name} in {us:#?}"))
}

fn absent(us: &[Usage], kind: UsageKind, name: &str) {
    assert!(
        find(us, kind, name).is_none(),
        "{kind:?} {name} must not be listed: {us:#?}"
    );
}

/// Runs a script that must succeed.
async fn exec(mgr: &ConnectionManager, sess: &SessionId, sql: &str) {
    assert_ok(&run(mgr, sess, sql).await);
}

/// Drops whatever exists: every statement runs, errors (objects that are not there) are ignored.
async fn cleanup(mgr: &ConnectionManager, sess: &SessionId, stmts: &[&str]) {
    for s in stmts {
        let _ = run(mgr, sess, s).await;
    }
}

// ---------------------------------------------------------------- Oracle

const ORA_DROP: &[&str] = &[
    "drop synonym uf_syn",
    "drop view uf_v_orders",
    "drop trigger uf_trg",
    "drop package uf_pkg",
    "drop function uf_total",
    "drop table uf_orders purge",
    "drop table uf_customers purge",
];

/// Line numbers follow `ALL_SOURCE`: the text starts at `FUNCTION` / `PACKAGE BODY`, without `CREATE OR REPLACE`.
const ORA_SCRIPT: &str = r#"
create table uf_customers (id number primary key, name varchar2(40));
create table uf_orders (id number primary key, customer_id number references uf_customers (id), total number);
create or replace view uf_v_orders as select o.id, o.total from uf_orders o;
create or replace function uf_total (p_customer number) return number is
  r number;
begin
  select sum(total) into r from uf_orders where customer_id = p_customer;
  return r;
end;
/
create or replace package uf_pkg as
  function total_of (p number) return number;
end uf_pkg;
/
create or replace package body uf_pkg as
  function total_of (p number) return number is
    n number;
  begin
    select count(*) into n from uf_orders where customer_id = p;
    return n;
  end;
end uf_pkg;
/
create or replace trigger uf_trg before insert on uf_orders for each row
begin
  :new.total := nvl(:new.total, 0);
end;
/
create or replace synonym uf_syn for uf_orders;
"#;

#[tokio::test]
async fn oracle_usages() {
    let Some(cfg) = oracle_cfg() else {
        eprintln!("PROMETEO_ORACLE_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    let owner = cfg.user.to_uppercase();
    let sc = Some(owner.as_str());
    cleanup(&mgr, &s, ORA_DROP).await;
    exec(&mgr, &s, ORA_SCRIPT).await;

    // a table: its view, the routine and the package body whose text names it, its trigger and its synonym
    let us = mgr
        .find_usages(&cfg.id, &obj(sc, "UF_ORDERS", NodeKind::Table, None))
        .await
        .unwrap();
    assert_eq!(
        must(&us, UsageKind::View, "UF_V_ORDERS").detail,
        "references UF_ORDERS"
    );
    let f = must(&us, UsageKind::Function, "UF_TOTAL");
    assert_eq!(f.line, Some(4), "{f:?}");
    assert!(f.detail.to_lowercase().contains("uf_orders"), "{f:?}");
    let b = must(&us, UsageKind::PackageBody, "UF_PKG");
    assert_eq!(b.line, Some(5), "{b:?}");
    absent(&us, UsageKind::Package, "UF_PKG");
    // the trigger's header names the table: that line is the usage (its text lines replace the unit row)
    let t = must(&us, UsageKind::Trigger, "UF_TRG");
    assert_eq!(t.table.as_deref(), Some("UF_ORDERS"), "{t:?}");
    assert_eq!(t.line, Some(1), "{t:?}");
    assert!(t.detail.to_lowercase().contains("on uf_orders"), "{t:?}");
    assert_eq!(
        must(&us, UsageKind::Synonym, "UF_SYN").detail,
        "synonym for UF_ORDERS"
    );
    assert!(
        us.iter().all(|u| u.kind != UsageKind::ForeignKey),
        "{us:#?}"
    );

    // a parent table: the foreign key of the child that references it
    let us = mgr
        .find_usages(&cfg.id, &obj(sc, "UF_CUSTOMERS", NodeKind::Table, None))
        .await
        .unwrap();
    let fk = must(&us, UsageKind::ForeignKey, "UF_ORDERS");
    assert_eq!(fk.table.as_deref(), Some("UF_ORDERS"));
    assert!(
        fk.detail
            .ends_with("(CUSTOMER_ID) references UF_CUSTOMERS (ID)"),
        "{fk:?}"
    );

    // a column: the foreign key on it, and the routines whose text names it inside the same table
    let us = mgr
        .find_usages(
            &cfg.id,
            &obj(sc, "CUSTOMER_ID", NodeKind::Column, Some("UF_ORDERS")),
        )
        .await
        .unwrap();
    must(&us, UsageKind::ForeignKey, "UF_ORDERS");
    assert_eq!(must(&us, UsageKind::Function, "UF_TOTAL").line, Some(4));
    assert_eq!(must(&us, UsageKind::PackageBody, "UF_PKG").line, Some(5));
    absent(&us, UsageKind::View, "UF_V_ORDERS");
    absent(&us, UsageKind::Trigger, "UF_TRG");

    // a routine does not list itself
    let us = mgr
        .find_usages(&cfg.id, &obj(sc, "UF_TOTAL", NodeKind::Function, None))
        .await
        .unwrap();
    absent(&us, UsageKind::Function, "UF_TOTAL");

    cleanup(&mgr, &s, ORA_DROP).await;
    mgr.close_session(&s).await;
}

// ---------------------------------------------------------------- PostgreSQL

const PG_SCRIPT: &str = r#"
create schema uf_usages;
create table uf_usages.customers (id int primary key, name text);
create table uf_usages.orders (id int primary key, customer_id int references uf_usages.customers (id), total int);
create index uf_orders_customer_idx on uf_usages.orders (customer_id);
create view uf_usages.v_orders as select id, total from uf_usages.orders;
create view uf_usages.v_customer_ids as select customer_id from uf_usages.orders;
create function uf_usages.total_of(p int) returns int language plpgsql as $$
begin
  return (select sum(total) from uf_usages.orders where customer_id = p);
end $$;
create function uf_usages.count_orders() returns int language sql as $$ select count(*)::int from uf_usages.orders $$;
create function uf_usages.audit() returns trigger language plpgsql as $$
begin
  new.total := coalesce(new.total, 0);
  return new;
end $$;
create trigger uf_orders_audit before insert on uf_usages.orders for each row execute function uf_usages.audit();
"#;

#[tokio::test]
async fn postgres_usages() {
    let Some(cfg) = pg_cfg() else {
        eprintln!("PROMETEO_PG_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    cleanup(&mgr, &s, &["drop schema if exists uf_usages cascade"]).await;
    exec(&mgr, &s, PG_SCRIPT).await;
    let sc = Some("uf_usages");

    let us = mgr
        .find_usages(&cfg.id, &obj(sc, "orders", NodeKind::Table, None))
        .await
        .unwrap();
    assert_eq!(
        must(&us, UsageKind::View, "v_orders").detail,
        "references orders"
    );
    must(&us, UsageKind::View, "v_customer_ids");
    let t = must(&us, UsageKind::Trigger, "uf_orders_audit");
    assert_eq!(t.table.as_deref(), Some("orders"));
    assert_eq!(t.detail, "on orders");
    assert_eq!(must(&us, UsageKind::Function, "total_of").line, Some(3));
    assert_eq!(must(&us, UsageKind::Function, "count_orders").line, Some(1));
    absent(&us, UsageKind::ForeignKey, "orders");

    let us = mgr
        .find_usages(&cfg.id, &obj(sc, "customers", NodeKind::Table, None))
        .await
        .unwrap();
    let fk = must(&us, UsageKind::ForeignKey, "orders");
    assert_eq!(fk.table.as_deref(), Some("orders"));
    assert!(fk.detail.contains("FOREIGN KEY (customer_id)"), "{fk:?}");

    let us = mgr
        .find_usages(
            &cfg.id,
            &obj(sc, "customer_id", NodeKind::Column, Some("orders")),
        )
        .await
        .unwrap();
    must(&us, UsageKind::Index, "uf_orders_customer_idx");
    must(&us, UsageKind::ForeignKey, "orders");
    assert_eq!(
        must(&us, UsageKind::View, "v_customer_ids").detail,
        "references column customer_id"
    );
    absent(&us, UsageKind::View, "v_orders");
    assert_eq!(must(&us, UsageKind::Function, "total_of").line, Some(3));
    absent(&us, UsageKind::Function, "count_orders");

    let us = mgr
        .find_usages(&cfg.id, &obj(sc, "total_of", NodeKind::Function, None))
        .await
        .unwrap();
    absent(&us, UsageKind::Function, "total_of");

    cleanup(&mgr, &s, &["drop schema if exists uf_usages cascade"]).await;
    mgr.close_session(&s).await;
}

// ---------------------------------------------------------------- MySQL

const MY_DROP: &[&str] = &[
    "drop trigger if exists uf_orders_bi",
    "drop view if exists uf_v_orders",
    "drop procedure if exists uf_total",
    "drop table if exists uf_orders",
    "drop table if exists uf_customers",
];

const MY_SCRIPT: &str = r#"
create table uf_customers (id int primary key, name varchar(40)) engine=InnoDB;
create table uf_orders (id int primary key, customer_id int, total int,
  constraint uf_orders_customer_fk foreign key (customer_id) references uf_customers (id)) engine=InnoDB;
create index uf_orders_customer_idx on uf_orders (customer_id);
create view uf_v_orders as select id, total from uf_orders;
DELIMITER //
create procedure uf_total(in p int)
begin
  select sum(total) from uf_orders where customer_id = p;
end//
create trigger uf_orders_bi before insert on uf_orders for each row set new.total = coalesce(new.total, 0)//
DELIMITER ;
"#;

#[tokio::test]
async fn mysql_usages() {
    let Some(cfg) = mysql_cfg() else {
        eprintln!("PROMETEO_MYSQL_URL not set: skipping");
        return;
    };
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    cleanup(&mgr, &s, MY_DROP).await;
    exec(&mgr, &s, MY_SCRIPT).await;

    let us = mgr
        .find_usages(&cfg.id, &obj(None, "uf_orders", NodeKind::Table, None))
        .await
        .unwrap();
    assert_eq!(
        must(&us, UsageKind::View, "uf_v_orders").detail,
        "references uf_orders"
    );
    let p = must(&us, UsageKind::Procedure, "uf_total");
    assert!(p.line.is_some() && p.detail.contains("uf_orders"), "{p:?}");
    let t = must(&us, UsageKind::Trigger, "uf_orders_bi");
    assert_eq!(t.table.as_deref(), Some("uf_orders"));
    assert_eq!(t.detail, "INSERT on uf_orders");
    absent(&us, UsageKind::ForeignKey, "uf_orders");

    let us = mgr
        .find_usages(&cfg.id, &obj(None, "uf_customers", NodeKind::Table, None))
        .await
        .unwrap();
    let fk = must(&us, UsageKind::ForeignKey, "uf_orders");
    assert_eq!(fk.table.as_deref(), Some("uf_orders"));
    assert_eq!(
        fk.detail,
        "uf_orders_customer_fk (customer_id) references uf_customers (id)"
    );

    let us = mgr
        .find_usages(
            &cfg.id,
            &obj(None, "customer_id", NodeKind::Column, Some("uf_orders")),
        )
        .await
        .unwrap();
    must(&us, UsageKind::Index, "uf_orders_customer_idx");
    must(&us, UsageKind::ForeignKey, "uf_orders");
    assert!(must(&us, UsageKind::Procedure, "uf_total").line.is_some());
    absent(&us, UsageKind::View, "uf_v_orders");

    cleanup(&mgr, &s, MY_DROP).await;
    mgr.close_session(&s).await;
}

// ---------------------------------------------------------------- SQLite

const LITE_SCRIPT: &str = r#"
create table customers (id integer primary key, name text);
create table orders (id integer primary key, customer_id integer references customers (id), total integer);
create index orders_customer_idx on orders (customer_id);
create view v_orders as select id, total from orders;
create trigger orders_bi before insert on orders begin select 1; end;
create table notes (id integer primary key, order_id integer, foreign key (order_id) references orders (id));
"#;

#[tokio::test]
async fn sqlite_usages() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = lite_cfg(&dir.path().join("usages.db"));
    let mgr = connected(&cfg).await;
    let s = mgr.open_session(&cfg.id).await.unwrap();
    exec(&mgr, &s, LITE_SCRIPT).await;

    // a table: the view and trigger that name it, and the foreign keys that reference it (no constraint names here)
    let us = mgr
        .find_usages(&cfg.id, &obj(None, "orders", NodeKind::Table, None))
        .await
        .unwrap();
    assert_eq!(
        must(&us, UsageKind::View, "v_orders").detail,
        "references orders"
    );
    let t = must(&us, UsageKind::Trigger, "orders_bi");
    assert_eq!(t.table.as_deref(), Some("orders"));
    assert_eq!(t.detail, "on orders");
    let fk = must(&us, UsageKind::ForeignKey, "notes");
    assert_eq!(fk.detail, "(order_id) references orders (id)");
    assert_eq!(fk.table.as_deref(), Some("notes"));

    let us = mgr
        .find_usages(&cfg.id, &obj(None, "customers", NodeKind::Table, None))
        .await
        .unwrap();
    assert_eq!(
        must(&us, UsageKind::ForeignKey, "orders").detail,
        "(customer_id) references customers (id)"
    );

    // a column: the key on it; the view that selects it (the view names the table and the column)
    let us = mgr
        .find_usages(
            &cfg.id,
            &obj(None, "customer_id", NodeKind::Column, Some("orders")),
        )
        .await
        .unwrap();
    must(&us, UsageKind::ForeignKey, "orders");
    absent(&us, UsageKind::View, "v_orders");
    let us = mgr
        .find_usages(
            &cfg.id,
            &obj(None, "total", NodeKind::Column, Some("orders")),
        )
        .await
        .unwrap();
    assert_eq!(
        must(&us, UsageKind::View, "v_orders").detail,
        "references column total"
    );

    // a view does not list itself; kinds without usages give nothing
    let us = mgr
        .find_usages(&cfg.id, &obj(None, "v_orders", NodeKind::View, None))
        .await
        .unwrap();
    assert!(us.is_empty(), "{us:#?}");
    let us = mgr
        .find_usages(
            &cfg.id,
            &obj(None, "orders_customer_idx", NodeKind::Index, Some("orders")),
        )
        .await
        .unwrap();
    assert!(us.is_empty(), "{us:#?}");

    mgr.close_session(&s).await;
}
