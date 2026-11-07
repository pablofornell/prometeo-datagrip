//! Explain Plan / Explain Analyse: runs `EXPLAIN` on a console session and returns the plan as a tree.
//!
//! PostgreSQL: `EXPLAIN (FORMAT JSON)` / `EXPLAIN (ANALYZE, FORMAT JSON)`. MySQL: `EXPLAIN FORMAT=JSON` and, for
//! the analysed plan (only available as text there), `EXPLAIN ANALYZE`. SQLite: `EXPLAIN QUERY PLAN`. Oracle:
//! `EXPLAIN PLAN SET STATEMENT_ID = .. FOR`, then the rows of `PLAN_TABLE` (deleted again).

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{DbError, Result};
use crate::manager::{ConnectionManager, SessionId};
use crate::model::*;
use crate::split::split_statements;

/// One row of the plan: the columns of the `Query Plan` tab and the `Property | Value` pane.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    pub operation: String,
    /// `table: orders; index: orders_pkey;`
    pub params: String,
    pub rows: Option<f64>,
    pub total_cost: Option<f64>,
    pub startup_cost: Option<f64>,
    /// `Parallel Aware = false;Async Capable = false;...`
    pub raw: String,
    pub props: Vec<PlanProp>,
    pub children: Vec<PlanNode>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlanProp {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainPlan {
    pub driver: Driver,
    pub analyze: bool,
    /// The statement that was explained.
    pub sql: String,
    /// `Select` (or the statement kind), its child is the top of the plan.
    pub root: PlanNode,
    /// Time of the EXPLAIN statement (round trip).
    pub elapsed_ms: u64,
}

fn prop(name: &str, value: impl Into<String>) -> PlanProp {
    PlanProp {
        name: name.to_string(),
        value: value.into(),
    }
}

/// A JSON scalar / array as plain text (`None` for objects and null).
fn scalar_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Array(a) if a.iter().all(|x| !x.is_object() && !x.is_array()) => Some(
            a.iter()
                .filter_map(scalar_text)
                .collect::<Vec<_>>()
                .join(", "),
        ),
        Value::Array(_) | Value::Object(_) => Some(v.to_string()),
    }
}

fn num(o: &Map<String, Value>, key: &str) -> Option<f64> {
    match o.get(key)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn root_node(kind: &str, child: Vec<PlanNode>, mut props: Vec<PlanProp>) -> PlanNode {
    props.insert(0, prop("Operation", kind.to_lowercase()));
    PlanNode {
        operation: kind.to_string(),
        props,
        children: child,
        ..Default::default()
    }
}

/// `Kind` shown for the statement at the top of the tree.
fn statement_kind(sql: &str) -> &'static str {
    let w = sql
        .trim_start()
        .split(|c: char| !c.is_alphabetic())
        .next()
        .unwrap_or("")
        .to_lowercase();
    match w.as_str() {
        "insert" | "replace" => "Insert",
        "update" => "Update",
        "delete" => "Delete",
        _ => "Select",
    }
}

// ---------------------------------------------------------------- PostgreSQL

fn pg_operation(node_type: &str) -> String {
    match node_type {
        "Seq Scan" => "Full Scan (Seq Scan)".into(),
        "Hash" => "Transformation (Hash)".into(),
        other => other.to_string(),
    }
}

fn pg_node(o: &Map<String, Value>, analyze: bool) -> PlanNode {
    let node_type = o.get("Node Type").and_then(Value::as_str).unwrap_or("?");
    let mut params = Vec::new();
    let mut put = |label: &str, key: &str| {
        if let Some(s) = o.get(key).and_then(Value::as_str) {
            params.push(format!("{label}: {s};"));
        }
    };
    put("table", "Relation Name");
    put("index", "Index Name");
    put("cte", "CTE Name");
    put("function", "Function Name");
    put("filter", "Filter");
    put("cond", "Index Cond");
    put("join", "Join Filter");
    put("hash cond", "Hash Cond");
    put("sort", "Sort Key");
    let mut operation = pg_operation(node_type);
    if let Some(j) = o.get("Join Type").and_then(Value::as_str) {
        if (node_type.ends_with("Join") || node_type == "Nested Loop") && j != "Inner" {
            operation = format!("{operation} ({j})");
        }
    }
    let mut props = vec![prop("Operation", node_type)];
    let mut raw = Vec::new();
    for (k, v) in o {
        if k == "Plans" || k == "Node Type" {
            continue;
        }
        if let Some(t) = scalar_text(v) {
            props.push(prop(k, t.clone()));
            raw.push(format!("{k} = {t}"));
        }
    }
    let children = o
        .get("Plans")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_object)
                .map(|c| pg_node(c, analyze))
                .collect()
        })
        .unwrap_or_default();
    PlanNode {
        operation,
        params: params.join(" "),
        rows: if analyze {
            num(o, "Actual Rows").or_else(|| num(o, "Plan Rows"))
        } else {
            num(o, "Plan Rows")
        },
        total_cost: num(o, "Total Cost"),
        startup_cost: num(o, "Startup Cost"),
        raw: raw.join(";"),
        props,
        children,
    }
}

fn parse_pg(doc: &Value, analyze: bool, sql: &str) -> Result<PlanNode> {
    let top = doc
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_object)
        .ok_or_else(|| DbError::InvalidArgument("The server returned no plan".into()))?;
    let plan = top
        .get("Plan")
        .and_then(Value::as_object)
        .ok_or_else(|| DbError::InvalidArgument("The server returned no plan".into()))?;
    let mut props = Vec::new();
    for k in ["Planning Time", "Execution Time"] {
        if let Some(n) = num(top, k) {
            props.push(prop(k, format!("{n} ms")));
        }
    }
    Ok(root_node(
        statement_kind(sql),
        vec![pg_node(plan, analyze)],
        props,
    ))
}

// ---------------------------------------------------------------- MySQL

fn my_table(o: &Map<String, Value>) -> PlanNode {
    let access = o.get("access_type").and_then(Value::as_str).unwrap_or("");
    let operation = match access {
        "ALL" => "Full Scan (ALL)".to_string(),
        "" => "Table".to_string(),
        a => format!("{} ({a})", my_access_name(a)),
    };
    let mut params = Vec::new();
    if let Some(t) = o.get("table_name").and_then(Value::as_str) {
        params.push(format!("table: {t};"));
    }
    if let Some(k) = o.get("key").and_then(Value::as_str) {
        params.push(format!("index: {k};"));
    }
    if let Some(c) = o.get("attached_condition").and_then(Value::as_str) {
        params.push(format!("filter: {c};"));
    }
    let cost = o.get("cost_info").and_then(Value::as_object);
    let mut props = vec![prop("Operation", access)];
    let mut raw = Vec::new();
    for (k, v) in o {
        match v {
            Value::Object(c) if k == "cost_info" => {
                for (ck, cv) in c {
                    if let Some(t) = scalar_text(cv) {
                        props.push(prop(&format!("cost_info.{ck}"), t.clone()));
                        raw.push(format!("{ck} = {t}"));
                    }
                }
            }
            Value::Object(_) => {}
            _ => {
                if let Some(t) = scalar_text(v) {
                    props.push(prop(k, t.clone()));
                    raw.push(format!("{k} = {t}"));
                }
            }
        }
    }
    let children = o
        .get("materialized_from_subquery")
        .and_then(|m| m.get("query_block"))
        .and_then(Value::as_object)
        .map(my_block)
        .unwrap_or_default();
    PlanNode {
        operation,
        params: params.join(" "),
        rows: num(o, "rows_examined_per_scan").or_else(|| num(o, "rows_produced_per_join")),
        total_cost: cost.and_then(|c| num(c, "prefix_cost")),
        startup_cost: None,
        raw: raw.join(";"),
        props,
        children,
    }
}

fn my_access_name(a: &str) -> &'static str {
    match a {
        "const" | "system" => "Constant Lookup",
        "eq_ref" => "Unique Index Lookup",
        "ref" | "ref_or_null" => "Index Lookup",
        "range" => "Index Range Scan",
        "index" => "Index Scan",
        "fulltext" => "Fulltext Search",
        _ => "Access",
    }
}

const MY_OPERATIONS: &[(&str, &str)] = &[
    ("ordering_operation", "Sort"),
    ("grouping_operation", "Group"),
    ("duplicates_removal", "Remove Duplicates"),
    ("buffer_result", "Buffer Result"),
    ("windowing", "Window"),
];

/// The nodes a `query_block` / operation object contains.
fn my_block(o: &Map<String, Value>) -> Vec<PlanNode> {
    let mut out = Vec::new();
    if let Some(t) = o.get("table").and_then(Value::as_object) {
        out.push(my_table(t));
    }
    if let Some(a) = o.get("nested_loop").and_then(Value::as_array) {
        let inner: Vec<PlanNode> = a
            .iter()
            .filter_map(Value::as_object)
            .flat_map(my_block)
            .collect();
        out.push(PlanNode {
            operation: "Nested Loop".into(),
            props: vec![prop("Operation", "nested_loop")],
            children: inner,
            ..Default::default()
        });
    }
    for (key, name) in MY_OPERATIONS {
        if let Some(inner) = o.get(*key).and_then(Value::as_object) {
            let mut props = vec![prop("Operation", *key)];
            for (k, v) in inner {
                if !v.is_object() && !v.is_array() {
                    if let Some(t) = scalar_text(v) {
                        props.push(prop(k, t));
                    }
                }
            }
            out.push(PlanNode {
                operation: format!("{name} ({key})"),
                props,
                children: my_block(inner),
                ..Default::default()
            });
        }
    }
    if let Some(u) = o.get("union_result").and_then(Value::as_object) {
        let specs: Vec<PlanNode> = u
            .get("query_specifications")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.get("query_block").and_then(Value::as_object))
                    .flat_map(my_block)
                    .collect()
            })
            .unwrap_or_default();
        out.push(PlanNode {
            operation: "Union".into(),
            props: vec![prop("Operation", "union_result")],
            children: specs,
            ..Default::default()
        });
    }
    if let Some(m) = o.get("message").and_then(Value::as_str) {
        out.push(PlanNode {
            operation: m.to_string(),
            props: vec![prop("Operation", "message"), prop("message", m)],
            ..Default::default()
        });
    }
    out
}

fn parse_mysql_json(doc: &Value, sql: &str) -> Result<PlanNode> {
    let block = doc
        .get("query_block")
        .and_then(Value::as_object)
        .ok_or_else(|| DbError::InvalidArgument("The server returned no plan".into()))?;
    let mut props = Vec::new();
    if let Some(c) = block
        .get("cost_info")
        .and_then(|c| c.get("query_cost"))
        .and_then(scalar_text)
    {
        props.push(prop("query_cost", c));
    }
    let mut root = root_node(statement_kind(sql), my_block(block), props);
    root.total_cost = block
        .get("cost_info")
        .and_then(Value::as_object)
        .and_then(|c| num(c, "query_cost"));
    Ok(root)
}

/// The text of `EXPLAIN ANALYZE` (`-> Table scan on t  (cost=0.35 rows=3) (actual time=0.02..0.03 rows=3 loops=1)`).
fn parse_mysql_tree(text: &str, sql: &str) -> Result<PlanNode> {
    fn number(s: &str, key: &str) -> Option<f64> {
        let i = s.find(key)? + key.len();
        let rest = &s[i..];
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '-' | 'e' | 'E' | '+')))
            .unwrap_or(rest.len());
        rest[..end].parse().ok()
    }
    let mut stack: Vec<(usize, PlanNode)> = Vec::new();
    let mut top: Vec<PlanNode> = Vec::new();
    fn close(stack: &mut Vec<(usize, PlanNode)>, top: &mut Vec<PlanNode>, keep: usize) {
        while stack.len() > keep {
            let (_, n) = stack.pop().unwrap();
            match stack.last_mut() {
                Some((_, p)) => p.children.push(n),
                None => top.push(n),
            }
        }
    }
    for line in text.lines() {
        let Some(at) = line.find("-> ") else { continue };
        let depth = at / 4;
        let body = line[at + 3..].trim_end();
        let (head, tail) = match body.find("  (") {
            Some(i) => (&body[..i], &body[i..]),
            None => (body, ""),
        };
        let (operation, params) = match head.find(" on ") {
            Some(i) => (
                head[..i].to_string(),
                format!("table: {};", head[i + 4..].trim()),
            ),
            None => (head.to_string(), String::new()),
        };
        let mut props = vec![prop("Operation", head)];
        for (name, key) in [
            ("cost", "cost="),
            ("rows (estimated)", "rows="),
            ("actual time (ms)", "actual time="),
            ("actual rows", "actual rows="),
            ("loops", "loops="),
        ] {
            if let Some(i) = tail.find(key) {
                let rest = &tail[i + key.len()..];
                let end = rest.find([' ', ')']).unwrap_or(rest.len());
                props.push(prop(name, &rest[..end]));
            }
        }
        let actual = tail.find("(actual").map(|i| &tail[i..]);
        let node = PlanNode {
            operation,
            params,
            rows: actual
                .and_then(|a| number(a, "rows="))
                .or_else(|| number(tail, "rows=")),
            total_cost: number(tail, "cost="),
            startup_cost: None,
            raw: tail.trim().to_string(),
            props,
            children: Vec::new(),
        };
        close(&mut stack, &mut top, depth);
        stack.push((depth, node));
    }
    close(&mut stack, &mut top, 0);
    if top.is_empty() {
        return Err(DbError::InvalidArgument(
            "The server returned no plan".into(),
        ));
    }
    Ok(root_node(statement_kind(sql), top, Vec::new()))
}

// ---------------------------------------------------------------- SQLite

fn parse_sqlite(rows: &[Vec<Cell>], sql: &str) -> Result<PlanNode> {
    // rows: id, parent, notused, detail
    struct Raw {
        id: i64,
        parent: i64,
        detail: String,
    }
    let raws: Vec<Raw> = rows
        .iter()
        .map(|r| Raw {
            id: r.first().and_then(Value::as_i64).unwrap_or(0),
            parent: r.get(1).and_then(Value::as_i64).unwrap_or(0),
            detail: r
                .get(3)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .collect();
    fn build(raws: &[Raw], parent: i64) -> Vec<PlanNode> {
        raws.iter()
            .filter(|r| r.parent == parent && r.id != parent)
            .map(|r| {
                let d = r.detail.as_str();
                let (kind, rest) = d.split_once(' ').unwrap_or((d, ""));
                let (operation, params) = match kind {
                    "SCAN" => ("Full Scan (SCAN)".to_string(), sqlite_params(rest)),
                    "SEARCH" => ("Index Search (SEARCH)".to_string(), sqlite_params(rest)),
                    _ => (d.to_string(), String::new()),
                };
                PlanNode {
                    operation,
                    params,
                    raw: d.to_string(),
                    props: vec![prop("Operation", kind), prop("detail", d)],
                    children: build(raws, r.id),
                    ..Default::default()
                }
            })
            .collect()
    }
    let top = build(&raws, 0);
    if top.is_empty() {
        return Err(DbError::InvalidArgument(
            "The server returned no plan".into(),
        ));
    }
    Ok(root_node(statement_kind(sql), top, Vec::new()))
}

/// `products USING INDEX idx_x (category_id=?)` -> `table: products; index: idx_x; (category_id=?)`.
fn sqlite_params(rest: &str) -> String {
    let (table, using) = match rest.split_once(" USING ") {
        Some((t, u)) => (t, Some(u)),
        None => (rest, None),
    };
    let mut out = format!("table: {};", table.trim());
    if let Some(u) = using {
        let u = u
            .trim_start_matches("COVERING INDEX ")
            .trim_start_matches("INDEX ")
            .trim_start_matches("INTEGER PRIMARY KEY");
        if !u.trim().is_empty() {
            out.push_str(&format!(" index: {};", u.trim()));
        }
    }
    out
}

// ---------------------------------------------------------------- Oracle

/// `PLAN_TABLE` rows as the `select` of [`ORA_PLAN_SQL`] returns them (all text).
const ORA_PLAN_COLS: &str = "to_char(id), to_char(parent_id), operation, options, object_owner, object_name, object_type, \
    to_char(cost), to_char(cardinality), to_char(bytes), to_char(time), access_predicates, filter_predicates, \
    partition_start, partition_stop, to_char(cpu_cost), to_char(io_cost), object_alias";

struct OraRow {
    id: i64,
    parent: Option<i64>,
    cells: Vec<Option<String>>,
}

fn ora_text(c: &Cell) -> Option<String> {
    match c {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn ora_num(v: &Option<String>) -> Option<f64> {
    v.as_deref().and_then(|s| s.trim().parse().ok())
}

/// The `PLAN_TABLE` rows of one explained statement as a tree: the row with id 0 (`SELECT STATEMENT`, ...) becomes the
/// root, its cost and the like its properties.
fn parse_oracle(rows: &[Vec<Cell>], sql: &str) -> Result<PlanNode> {
    let raws: Vec<OraRow> = rows
        .iter()
        .map(|r| {
            let cells: Vec<Option<String>> = r.iter().map(ora_text).collect();
            OraRow {
                id: ora_num(&cells.first().cloned().flatten()).unwrap_or(0.0) as i64,
                parent: cells
                    .get(1)
                    .cloned()
                    .flatten()
                    .and_then(|s| s.trim().parse().ok()),
                cells,
            }
        })
        .collect();
    let cell = |r: &OraRow, i: usize| -> Option<String> {
        r.cells
            .get(i)
            .cloned()
            .flatten()
            .filter(|s| !s.trim().is_empty())
    };
    fn build(
        raws: &[OraRow],
        parent: i64,
        cell: &dyn Fn(&OraRow, usize) -> Option<String>,
    ) -> Vec<PlanNode> {
        raws.iter()
            .filter(|r| r.parent == Some(parent))
            .map(|r| {
                let op = cell(r, 2).unwrap_or_default();
                let options = cell(r, 3);
                let operation = match &options {
                    Some(o) => format!("{op} {o}"),
                    None => op.clone(),
                };
                let owner = cell(r, 4);
                let name = cell(r, 5);
                let otype = cell(r, 6);
                let mut params = Vec::new();
                if let Some(nm) = &name {
                    let full = match &owner {
                        Some(o) => format!("{o}.{nm}"),
                        None => nm.clone(),
                    };
                    let label = if otype.as_deref().is_some_and(|t| t.starts_with("INDEX")) {
                        "index"
                    } else {
                        "table"
                    };
                    params.push(format!("{label}: {full};"));
                }
                if let Some(a) = cell(r, 11) {
                    params.push(format!("access: {a};"));
                }
                if let Some(f) = cell(r, 12) {
                    params.push(format!("filter: {f};"));
                }
                let mut props = vec![prop("Operation", op)];
                let mut raw = Vec::new();
                for (label, i) in [
                    ("Options", 3),
                    ("Object owner", 4),
                    ("Object name", 5),
                    ("Object type", 6),
                    ("Cost", 7),
                    ("Cardinality", 8),
                    ("Bytes", 9),
                    ("Time (s)", 10),
                    ("Access predicates", 11),
                    ("Filter predicates", 12),
                    ("Partition start", 13),
                    ("Partition stop", 14),
                    ("CPU cost", 15),
                    ("IO cost", 16),
                    ("Object alias", 17),
                ] {
                    if let Some(v) = cell(r, i) {
                        props.push(prop(label, v.clone()));
                        raw.push(format!("{label} = {v}"));
                    }
                }
                PlanNode {
                    operation,
                    params: params.join(" "),
                    rows: ora_num(&cell(r, 8)),
                    total_cost: ora_num(&cell(r, 7)),
                    startup_cost: None,
                    raw: raw.join(";"),
                    props,
                    children: build(raws, r.id, cell),
                }
            })
            .collect()
    }
    let Some(root_row) = raws.iter().find(|r| r.parent.is_none()) else {
        return Err(DbError::InvalidArgument(
            "The server returned no plan".into(),
        ));
    };
    let top = build(&raws, root_row.id, &cell);
    if top.is_empty() {
        return Err(DbError::InvalidArgument(
            "The server returned no plan".into(),
        ));
    }
    let mut props = Vec::new();
    for (label, i) in [
        ("Cost", 7),
        ("Cardinality", 8),
        ("Bytes", 9),
        ("Time (s)", 10),
    ] {
        if let Some(v) = cell(root_row, i) {
            props.push(prop(label, v));
        }
    }
    let mut root = root_node(statement_kind(sql), top, props);
    root.total_cost = ora_num(&cell(root_row, 7));
    root.rows = ora_num(&cell(root_row, 8));
    Ok(root)
}

// ---------------------------------------------------------------- entry point

/// The cell as JSON: a JSON text column arrives as a string.
fn cell_doc(c: &Cell) -> Value {
    match c {
        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
        other => other.clone(),
    }
}

impl ConnectionManager {
    /// Explain the first statement of `sql` on the session. `analyze` actually runs it (not available on SQLite).
    pub async fn explain(
        &self,
        session: &SessionId,
        sql: &str,
        analyze: bool,
    ) -> Result<ExplainPlan> {
        let driver = self.session(session)?.live.driver();
        let stmt = split_statements(sql, driver)
            .into_iter()
            .find(|s| !s.text.trim().is_empty())
            .ok_or_else(|| DbError::InvalidArgument("There is no statement to explain".into()))?
            .text;
        if analyze && driver == Driver::Sqlite {
            return Err(DbError::Unsupported("SQLite has no EXPLAIN ANALYZE".into()));
        }
        if driver == Driver::Oracle {
            return self.explain_oracle(session, &stmt, analyze).await;
        }
        let wrapped = match (driver, analyze) {
            (Driver::Postgres, false) => format!("EXPLAIN (FORMAT JSON) {stmt}"),
            (Driver::Postgres, true) => format!("EXPLAIN (ANALYZE, FORMAT JSON) {stmt}"),
            (Driver::MySql, false) => format!("EXPLAIN FORMAT=JSON {stmt}"),
            (Driver::MySql, true) => format!("EXPLAIN ANALYZE {stmt}"),
            (Driver::Sqlite, _) => format!("EXPLAIN QUERY PLAN {stmt}"),
            (Driver::Oracle, _) => unreachable!("explained by explain_oracle"),
        };
        let events = self
            .execute_collect(
                session,
                &wrapped,
                ExecOptions {
                    max_rows: 10_000,
                    stop_on_error: true,
                    keep_open_secs: 1,
                    auto_commit: false,
                },
            )
            .await?;
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        let mut elapsed_ms = 0;
        for e in events {
            match e {
                ExecEvent::ResultSet { rows: r, .. } => rows = r,
                ExecEvent::Error { message, .. } => return Err(DbError::InvalidArgument(message)),
                ExecEvent::Done { elapsed_ms: ms, .. } => elapsed_ms = ms,
                _ => {}
            }
        }
        let root = match (driver, analyze) {
            (Driver::Postgres, _) => {
                let doc = rows.first().and_then(|r| r.first()).map(cell_doc);
                parse_pg(&doc.unwrap_or(Value::Null), analyze, &stmt)?
            }
            (Driver::MySql, false) => {
                let doc = rows.first().and_then(|r| r.first()).map(cell_doc);
                parse_mysql_json(&doc.unwrap_or(Value::Null), &stmt)?
            }
            (Driver::MySql, true) => {
                let text = rows
                    .iter()
                    .filter_map(|r| r.first().and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                parse_mysql_tree(&text, &stmt)?
            }
            (Driver::Sqlite, _) => parse_sqlite(&rows, &stmt)?,
            (Driver::Oracle, _) => unreachable!("explained by explain_oracle"),
        };
        Ok(ExplainPlan {
            driver,
            analyze,
            sql: stmt,
            root,
            elapsed_ms,
        })
    }

    /// Oracle: `EXPLAIN PLAN` writes into the session's `PLAN_TABLE` (a private temporary table), which is read and
    /// emptied of this statement's rows again. `PLAN_TABLE` is a plain table in a few old setups: the delete keeps it
    /// from filling up there too.
    async fn explain_oracle(
        &self,
        session: &SessionId,
        stmt: &str,
        analyze: bool,
    ) -> Result<ExplainPlan> {
        if analyze {
            return Err(DbError::Unsupported(
                "Oracle has no EXPLAIN ANALYZE; use Explain Plan".into(),
            ));
        }
        let id = format!("PRM{}", &uuid::Uuid::new_v4().simple().to_string()[..12]).to_uppercase();
        let run = |sql: String| async move {
            self.execute_collect(
                session,
                &sql,
                ExecOptions {
                    max_rows: 10_000,
                    stop_on_error: true,
                    keep_open_secs: 1,
                    auto_commit: false,
                },
            )
            .await
        };
        let mut elapsed_ms = 0;
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        let mut failure: Option<String> = None;
        for (i, sql) in [
            format!("explain plan set statement_id = '{id}' for {stmt}"),
            format!(
                "select {ORA_PLAN_COLS} from plan_table where statement_id = '{id}' order by id"
            ),
        ]
        .into_iter()
        .enumerate()
        {
            for e in run(sql).await? {
                match e {
                    ExecEvent::ResultSet { rows: r, .. } => rows = r,
                    ExecEvent::Error { message, .. } => failure = Some(message),
                    ExecEvent::Done { elapsed_ms: ms, .. } if i == 0 => elapsed_ms = ms,
                    _ => {}
                }
            }
            if failure.is_some() {
                break;
            }
        }
        let _ = run(format!(
            "delete from plan_table where statement_id = '{id}'"
        ))
        .await;
        if let Some(m) = failure {
            return Err(DbError::InvalidArgument(m));
        }
        let root = parse_oracle(&rows, stmt)?;
        Ok(ExplainPlan {
            driver: Driver::Oracle,
            analyze: false,
            sql: stmt.to_string(),
            root,
            elapsed_ms,
        })
    }

    /// Ask the server to stop the statement that runs on the session (an Explain Analyse, which has no execution id).
    pub async fn cancel_session(&self, session: &SessionId) -> Result<()> {
        self.session(session)?.cancel_running().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pg_plan_tree() {
        let doc = json!([{"Plan": {
            "Node Type": "Hash Join", "Join Type": "Inner", "Startup Cost": 11.14, "Total Cost": 34.07, "Plan Rows": 510,
            "Plans": [
                {"Node Type": "Seq Scan", "Relation Name": "orders", "Startup Cost": 0, "Total Cost": 20.2, "Plan Rows": 1020, "Parent Relationship": "Outer"},
                {"Node Type": "Hash", "Startup Cost": 10.7, "Total Cost": 10.7, "Plan Rows": 35, "Plans": [
                    {"Node Type": "Seq Scan", "Relation Name": "customers", "Plan Rows": 35, "Total Cost": 10.7, "Startup Cost": 0}
                ]}
            ]},
            "Planning Time": 0.2}]);
        let root = parse_pg(&doc, false, "select 1").unwrap();
        assert_eq!(root.operation, "Select");
        let join = &root.children[0];
        assert_eq!(join.operation, "Hash Join");
        assert_eq!(join.rows, Some(510.0));
        assert_eq!(join.total_cost, Some(34.07));
        assert_eq!(join.children[0].operation, "Full Scan (Seq Scan)");
        assert_eq!(join.children[0].params, "table: orders;");
        assert_eq!(join.children[1].operation, "Transformation (Hash)");
        assert_eq!(join.children[1].children[0].params, "table: customers;");
        assert!(join.raw.starts_with("Join Type = Inner;"), "{}", join.raw);
        assert!(root.props.iter().any(|p| p.name == "Planning Time"));
    }

    #[test]
    fn mysql_json_plan() {
        let doc = json!({"query_block": {"select_id": 1, "cost_info": {"query_cost": "2.50"},
        "nested_loop": [
            {"table": {"table_name": "o", "access_type": "ALL", "rows_examined_per_scan": 10, "cost_info": {"prefix_cost": "1.25"}}},
            {"table": {"table_name": "c", "access_type": "eq_ref", "key": "PRIMARY", "rows_examined_per_scan": 1, "cost_info": {"prefix_cost": "2.50"}}}
        ]}});
        let root = parse_mysql_json(&doc, "select 1").unwrap();
        assert_eq!(root.total_cost, Some(2.5));
        let nl = &root.children[0];
        assert_eq!(nl.operation, "Nested Loop");
        assert_eq!(nl.children.len(), 2);
        assert_eq!(nl.children[0].operation, "Full Scan (ALL)");
        assert_eq!(nl.children[0].params, "table: o;");
        assert_eq!(nl.children[1].operation, "Unique Index Lookup (eq_ref)");
        assert!(nl.children[1].params.contains("index: PRIMARY;"));
    }

    #[test]
    fn mysql_analyze_text_tree() {
        let text = "-> Nested loop inner join  (cost=2.5 rows=10) (actual time=0.1..0.3 rows=10 loops=1)\n    -> Table scan on o  (cost=1.2 rows=10) (actual time=0.05..0.1 rows=10 loops=1)\n    -> Single-row index lookup on c using PRIMARY (id=o.customer_id)  (cost=0.1 rows=1) (actual time=0.01..0.01 rows=1 loops=10)\n";
        let root = parse_mysql_tree(text, "select 1").unwrap();
        let nl = &root.children[0];
        assert_eq!(nl.operation, "Nested loop inner join");
        assert_eq!(nl.rows, Some(10.0));
        assert_eq!(nl.children.len(), 2);
        assert_eq!(nl.children[0].operation, "Table scan");
        assert_eq!(nl.children[0].params, "table: o;");
        assert_eq!(nl.children[1].rows, Some(1.0));
    }

    #[test]
    fn oracle_plan_tree() {
        let row = |id: &str,
                   parent: Option<&str>,
                   op: &str,
                   opt: Option<&str>,
                   name: Option<&str>,
                   cost: &str,
                   card: &str| {
            vec![
                json!(id),
                parent.map(|p| json!(p)).unwrap_or(Value::Null),
                json!(op),
                opt.map(|o| json!(o)).unwrap_or(Value::Null),
                name.map(|_| json!("DEMO")).unwrap_or(Value::Null),
                name.map(|n| json!(n)).unwrap_or(Value::Null),
                name.map(|_| json!("TABLE")).unwrap_or(Value::Null),
                json!(cost),
                json!(card),
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
            ]
        };
        let rows = vec![
            row("0", None, "SELECT STATEMENT", None, None, "7", "7"),
            row("1", Some("0"), "HASH JOIN", None, None, "6", "7"),
            row(
                "2",
                Some("1"),
                "TABLE ACCESS",
                Some("FULL"),
                Some("ORDERS"),
                "3",
                "7",
            ),
            row(
                "3",
                Some("1"),
                "TABLE ACCESS",
                Some("FULL"),
                Some("CUSTOMERS"),
                "3",
                "10",
            ),
        ];
        let root = parse_oracle(&rows, "select 1").unwrap();
        assert_eq!(root.operation, "Select");
        assert_eq!(root.total_cost, Some(7.0));
        let join = &root.children[0];
        assert_eq!(join.operation, "HASH JOIN");
        assert_eq!(join.children.len(), 2);
        assert_eq!(join.children[0].operation, "TABLE ACCESS FULL");
        assert_eq!(join.children[0].params, "table: DEMO.ORDERS;");
        assert_eq!(join.children[1].rows, Some(10.0));
        assert!(parse_oracle(&[], "select 1").is_err());
    }

    #[test]
    fn sqlite_plan_tree() {
        let rows = vec![
            vec![json!(2), json!(0), json!(0), json!("SCAN orders")],
            vec![
                json!(5),
                json!(2),
                json!(0),
                json!("SEARCH products USING INDEX idx_p (category_id=?)"),
            ],
            vec![
                json!(7),
                json!(0),
                json!(0),
                json!("USE TEMP B-TREE FOR ORDER BY"),
            ],
        ];
        let root = parse_sqlite(&rows, "select 1").unwrap();
        assert_eq!(root.children.len(), 2);
        assert_eq!(root.children[0].operation, "Full Scan (SCAN)");
        assert_eq!(root.children[0].params, "table: orders;");
        let s = &root.children[0].children[0];
        assert_eq!(s.operation, "Index Search (SEARCH)");
        assert_eq!(s.params, "table: products; index: idx_p (category_id=?);");
        assert_eq!(root.children[1].operation, "USE TEMP B-TREE FOR ORDER BY");
    }
}
