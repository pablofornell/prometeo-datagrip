//! Compile-time check: every public async API returns a `Send` future (Tauri commands
//! require it). Nothing is executed.

use dbcore::*;

fn is_send<T: Send>(_: T) {}

#[allow(dead_code)]
fn all_futures_are_send(m: &ConnectionManager, cfg: &DataSourceConfig, sid: &SessionId, eid: &ExecutionId) {
    let obj = ObjectRef::table(Some("s"), "t");
    is_send(m.test_connection(cfg));
    is_send(m.connect(cfg));
    is_send(m.reconnect(cfg));
    is_send(m.disconnect("x"));
    is_send(m.open_session("x"));
    is_send(m.close_session(sid));
    is_send(m.introspect("x", &[]));
    is_send(m.introspect_with("x", &[], &IntrospectOptions::default()));
    is_send(m.schema_snapshot("x", None));
    is_send(m.ddl("x", &obj));
    is_send(m.execute(sid, "select 1", ExecOptions::default()));
    is_send(m.execute_collect(sid, "select 1", ExecOptions::default()));
    is_send(m.fetch_more(eid, 0, 10));
    is_send(m.table_data("x", &obj, &TableDataRequest::default()));
    is_send(m.apply_changes("x", &obj, &[]));
    is_send(m.table_data_in_session(sid, &obj, &TableDataRequest::default()));
    is_send(m.apply_changes_in_session(sid, &obj, &[]));
    is_send(m.export_query("x", "select 1", &ExportOptions::default(), Vec::<u8>::new()));
}

#[test]
fn futures_are_send() {}
