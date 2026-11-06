//! Tauri commands: thin adapters over [`AppState`]. All are async, return
//! `Result<T, String>` (the string is the real server / OS message) and use camelCase JSON
//! (argument names are camelCase on the JS side: `ds_id` -> `dsId`).

use std::path::PathBuf;

use dbcore::{
    ApplyResult, ConnectInfo, DataSourceConfig, Driver, ExecEvent, ExecOptions, ExportFormat, ExportOptions, FetchedRows, HistoryEntry,
    ObjectRef, ResultSet, RowChange, SnapshotObject, Statement, TableDataRequest, TestResult, TreeNode, TxStatus,
};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use crate::state::{AppInfo, AppState};
use crate::store::DataSourceView;

type Res<T> = Result<T, String>;

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> Res<AppInfo> {
    state.app_info().await
}

// ---------------------------------------------------------------- data sources

#[tauri::command]
pub async fn list_data_sources(state: State<'_, AppState>) -> Res<Vec<DataSourceView>> {
    state.list_data_sources().await
}

/// Insert or update by `ds.id` (empty id = new). `ds.password`: null keeps, "" clears, text replaces.
#[tauri::command]
pub async fn save_data_source(state: State<'_, AppState>, ds: DataSourceConfig) -> Res<DataSourceView> {
    state.save_data_source(ds).await
}

#[tauri::command]
pub async fn delete_data_source(state: State<'_, AppState>, id: String) -> Res<()> {
    state.delete_data_source(&id).await
}

#[tauri::command]
pub async fn duplicate_data_source(state: State<'_, AppState>, id: String) -> Res<DataSourceView> {
    state.duplicate_data_source(&id).await
}

#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>, ds: DataSourceConfig) -> Res<TestResult> {
    state.test_connection(ds).await
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> Res<ConnectInfo> {
    state.connect(&id).await
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> Res<()> {
    state.disconnect(&id).await
}

#[tauri::command]
pub async fn connected_data_sources(state: State<'_, AppState>) -> Res<Vec<String>> {
    Ok(state.connected_data_sources())
}

// ---------------------------------------------------------------- sessions

/// `init_sql` (optional): statements run, in order, on the new connection before the session is returned, to
/// re-apply per-session settings (`SET search_path`, `USE db`, isolation level) of a reopened console.
/// The backend does not remember them. A failing statement fails the call and no session is left behind.
#[tauri::command]
pub async fn open_session(state: State<'_, AppState>, ds_id: String, init_sql: Option<Vec<String>>) -> Res<String> {
    state.open_session_with(&ds_id, &init_sql.unwrap_or_default()).await
}

#[tauri::command]
pub async fn close_session(state: State<'_, AppState>, session_id: String) -> Res<()> {
    state.close_session(&session_id).await
}

/// True while a transaction is open (`active` or `failed` in [`session_tx_status`]).
#[tauri::command]
pub async fn session_in_transaction(state: State<'_, AppState>, session_id: String) -> Res<bool> {
    state.session_in_transaction(&session_id).await
}

/// `"idle"`, `"active"` or `"failed"` (PostgreSQL: the transaction was aborted; `COMMIT` would roll back).
#[tauri::command]
pub async fn session_tx_status(state: State<'_, AppState>, session_id: String) -> Res<TxStatus> {
    state.session_tx_status(&session_id).await
}

// ---------------------------------------------------------------- introspection

#[tauri::command]
pub async fn introspect(state: State<'_, AppState>, ds_id: String, path: Vec<String>, show_system: Option<bool>) -> Res<Vec<TreeNode>> {
    state.introspect(&ds_id, path, show_system.unwrap_or(false)).await
}

#[tauri::command]
pub async fn get_ddl(state: State<'_, AppState>, ds_id: String, object: ObjectRef) -> Res<String> {
    state.get_ddl(&ds_id, object).await
}

#[tauri::command]
pub async fn schema_snapshot(state: State<'_, AppState>, ds_id: String, schema: Option<String>) -> Res<Vec<SnapshotObject>> {
    state.schema_snapshot(&ds_id, schema).await
}

// ---------------------------------------------------------------- execution

/// Returns the execution id immediately. Every [`ExecEvent`] (statement, resultset, update,
/// error, message, done) is pushed, in order, through `on_event`.
#[tauri::command]
pub async fn execute(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    options: Option<ExecOptions>,
    on_event: Channel<ExecEvent>,
) -> Res<String> {
    state
        .execute(&session_id, &sql, options.unwrap_or_default(), move |ev| {
            // a closed channel (webview reloaded) only means nobody listens any more
            let _ = on_event.send(ev);
        })
        .await
}

#[tauri::command]
pub async fn fetch_more(state: State<'_, AppState>, execution_id: String, result_index: usize, count: usize) -> Res<FetchedRows> {
    state.fetch_more(&execution_id, result_index, count).await
}

#[tauri::command]
pub async fn cancel(state: State<'_, AppState>, execution_id: String) -> Res<()> {
    state.cancel(&execution_id).await
}

#[tauri::command]
pub async fn close_execution(state: State<'_, AppState>, execution_id: String) -> Res<()> {
    state.close_execution(&execution_id).await
}

// ---------------------------------------------------------------- table data

#[tauri::command]
pub async fn table_data(state: State<'_, AppState>, ds_id: String, table: ObjectRef, request: Option<TableDataRequest>) -> Res<ResultSet> {
    state.table_data(&ds_id, table, request.unwrap_or_default()).await
}

#[tauri::command]
pub async fn apply_changes(state: State<'_, AppState>, ds_id: String, table: ObjectRef, changes: Vec<RowChange>) -> Res<ApplyResult> {
    state.apply_changes(&ds_id, table, changes).await
}

#[tauri::command]
pub async fn table_data_in_session(
    state: State<'_, AppState>,
    session_id: String,
    table: ObjectRef,
    request: Option<TableDataRequest>,
) -> Res<ResultSet> {
    state.table_data_in_session(&session_id, table, request.unwrap_or_default()).await
}

#[tauri::command]
pub async fn apply_changes_in_session(state: State<'_, AppState>, session_id: String, table: ObjectRef, changes: Vec<RowChange>) -> Res<ApplyResult> {
    state.apply_changes_in_session(&session_id, table, changes).await
}

// ---------------------------------------------------------------- export

/// Open the native "Save" dialog from the backend and return the chosen path (`null` = cancelled). Only a path
/// returned here is accepted by `export_query` / `export_result` (once, for five minutes): the webview cannot
/// make the backend write to an arbitrary file.
#[tauri::command]
pub async fn choose_export_path(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    suggested_name: Option<String>,
    format: Option<ExportFormat>,
) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (ext, label) = match format {
        Some(ExportFormat::Tsv) => ("tsv", "TSV"),
        Some(ExportFormat::Json) => ("json", "JSON"),
        Some(ExportFormat::SqlInsert) => ("sql", "SQL"),
        Some(ExportFormat::Markdown) => ("md", "Markdown"),
        _ => ("csv", "CSV"),
    };
    let mut dlg = app.dialog().file().set_parent(&window).add_filter(label, &[ext]).add_filter("All files", &["*"]);
    if let Some(name) = suggested_name.as_deref().filter(|n| !n.trim().is_empty()) {
        // a file name only: the dialog decides the folder
        let name = std::path::Path::new(name).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        dlg = dlg.set_file_name(name);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dlg.save_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(chosen) = rx.await.map_err(|_| "The save dialog was closed".to_string())? else { return Ok(None) };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    state.allow_export_path(path.clone());
    Ok(Some(path.display().to_string()))
}

/// `path` must come from `choose_export_path`.
#[tauri::command]
pub async fn export_query(state: State<'_, AppState>, ds_id: String, sql: String, options: ExportOptions, path: String) -> Res<usize> {
    state.export_query(&ds_id, &sql, options, &PathBuf::from(path)).await
}

#[tauri::command]
pub async fn export_query_to_string(state: State<'_, AppState>, ds_id: String, sql: String, options: ExportOptions) -> Res<String> {
    state.export_query_to_string(&ds_id, &sql, options).await
}

/// `path` must come from `choose_export_path`.
#[tauri::command]
pub async fn export_result(state: State<'_, AppState>, result: ResultSet, options: ExportOptions, path: String) -> Res<usize> {
    state.export_result(result, options, PathBuf::from(path)).await
}

#[tauri::command]
pub async fn export_to_string(state: State<'_, AppState>, result: ResultSet, options: ExportOptions) -> Res<String> {
    state.export_to_string(result, options).await
}

// ---------------------------------------------------------------- splitter

#[tauri::command]
pub async fn split_statements(state: State<'_, AppState>, sql: String, driver: Driver) -> Res<Vec<Statement>> {
    Ok(state.split_statements(&sql, driver))
}

#[tauri::command]
pub async fn statement_at(state: State<'_, AppState>, sql: String, caret_utf16: usize, driver: Driver) -> Res<Option<Statement>> {
    Ok(state.statement_at(&sql, caret_utf16, driver))
}

// ---------------------------------------------------------------- history

#[tauri::command]
pub async fn history_list(state: State<'_, AppState>, ds_id: Option<String>, offset: Option<usize>, limit: Option<usize>) -> Res<Vec<HistoryEntry>> {
    state.history_list(ds_id, offset.unwrap_or(0), limit.unwrap_or(200)).await
}

#[tauri::command]
pub async fn history_search(state: State<'_, AppState>, text: String, ds_id: Option<String>, limit: Option<usize>) -> Res<Vec<HistoryEntry>> {
    state.history_search(text, ds_id, limit.unwrap_or(200)).await
}

#[tauri::command]
pub async fn history_clear(state: State<'_, AppState>) -> Res<()> {
    state.history_clear().await
}

// ---------------------------------------------------------------- ui state

#[tauri::command]
pub async fn get_ui_state(state: State<'_, AppState>, key: String) -> Res<Option<Value>> {
    Ok(state.get_ui_state(&key))
}

#[tauri::command]
pub async fn set_ui_state(state: State<'_, AppState>, key: String, value: Value) -> Res<()> {
    state.set_ui_state(key, value);
    Ok(())
}

#[tauri::command]
pub async fn flush_ui_state(state: State<'_, AppState>) -> Res<()> {
    state.flush_ui_state().await
}

// ---------------------------------------------------------------- consoles

#[tauri::command]
pub async fn list_consoles(state: State<'_, AppState>, ds_id: String) -> Res<Vec<String>> {
    state.list_consoles(&ds_id).await
}

#[tauri::command]
pub async fn read_console(state: State<'_, AppState>, ds_id: String, name: String) -> Res<String> {
    state.read_console(&ds_id, &name).await
}

#[tauri::command]
pub async fn write_console(state: State<'_, AppState>, ds_id: String, name: String, text: String) -> Res<()> {
    state.write_console(&ds_id, &name, text).await
}

#[tauri::command]
pub async fn create_console(state: State<'_, AppState>, ds_id: String) -> Res<String> {
    state.create_console(&ds_id).await
}

#[tauri::command]
pub async fn delete_console(state: State<'_, AppState>, ds_id: String, name: String) -> Res<()> {
    state.delete_console(&ds_id, &name).await
}

#[tauri::command]
pub async fn rename_console(state: State<'_, AppState>, ds_id: String, from: String, to: String) -> Res<()> {
    state.rename_console(&ds_id, &from, &to).await
}
