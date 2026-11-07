//! Tauri commands: thin adapters over [`AppState`]. All are async, return
//! `Result<T, String>` (the string is the real server / OS message) and use camelCase JSON
//! (argument names are camelCase on the JS side: `ds_id` -> `dsId`).

use std::path::PathBuf;

use dbcore::{
    ApplyResult, ConnectInfo, DataSourceConfig, Driver, ExecEvent, ExecOptions, ExportFormat,
    ExportOptions, FetchedRows, HistoryEntry, ImportFormat, ImportPreview, ImportProgress,
    ImportRequest, ImportResult, ObjectRef, ResultSet, RowChange, SessionState, SnapshotObject,
    Statement, TableDataRequest, TestResult, TreeNode, TxStatus,
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
pub async fn save_data_source(
    state: State<'_, AppState>,
    ds: DataSourceConfig,
) -> Res<DataSourceView> {
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
pub async fn open_session(
    state: State<'_, AppState>,
    ds_id: String,
    init_sql: Option<Vec<String>>,
) -> Res<String> {
    state
        .open_session_with(&ds_id, &init_sql.unwrap_or_default())
        .await
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
/// A session whose connection died is `"idle"` (the server rolled the transaction back): ask
/// [`session_state`] to tell it from a healthy idle one.
#[tauri::command]
pub async fn session_tx_status(state: State<'_, AppState>, session_id: String) -> Res<TxStatus> {
    state.session_tx_status(&session_id).await
}

/// `{ txStatus, inTransaction, connectionLost, transactionLost }`: the transaction status plus whether the
/// connection of the session is gone, and whether a transaction died with it (the session then refuses to
/// reconnect on its own: close it and open a new one).
#[tauri::command]
pub async fn session_state(state: State<'_, AppState>, session_id: String) -> Res<SessionState> {
    state.session_state(&session_id).await
}

// ---------------------------------------------------------------- introspection

#[tauri::command]
pub async fn introspect(
    state: State<'_, AppState>,
    ds_id: String,
    path: Vec<String>,
    show_system: Option<bool>,
) -> Res<Vec<TreeNode>> {
    state
        .introspect(&ds_id, path, show_system.unwrap_or(false))
        .await
}

#[tauri::command]
pub async fn get_ddl(state: State<'_, AppState>, ds_id: String, object: ObjectRef) -> Res<String> {
    state.get_ddl(&ds_id, object).await
}

#[tauri::command]
pub async fn schema_snapshot(
    state: State<'_, AppState>,
    ds_id: String,
    schema: Option<String>,
) -> Res<Vec<SnapshotObject>> {
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
pub async fn fetch_more(
    state: State<'_, AppState>,
    execution_id: String,
    result_index: usize,
    count: usize,
) -> Res<FetchedRows> {
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
pub async fn table_data(
    state: State<'_, AppState>,
    ds_id: String,
    table: ObjectRef,
    request: Option<TableDataRequest>,
) -> Res<ResultSet> {
    state
        .table_data(&ds_id, table, request.unwrap_or_default())
        .await
}

#[tauri::command]
pub async fn apply_changes(
    state: State<'_, AppState>,
    ds_id: String,
    table: ObjectRef,
    changes: Vec<RowChange>,
) -> Res<ApplyResult> {
    state.apply_changes(&ds_id, table, changes).await
}

#[tauri::command]
pub async fn table_data_in_session(
    state: State<'_, AppState>,
    session_id: String,
    table: ObjectRef,
    request: Option<TableDataRequest>,
) -> Res<ResultSet> {
    state
        .table_data_in_session(&session_id, table, request.unwrap_or_default())
        .await
}

#[tauri::command]
pub async fn apply_changes_in_session(
    state: State<'_, AppState>,
    session_id: String,
    table: ObjectRef,
    changes: Vec<RowChange>,
) -> Res<ApplyResult> {
    state
        .apply_changes_in_session(&session_id, table, changes)
        .await
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
    let mut dlg = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter(label, &[ext])
        .add_filter("All files", &["*"]);
    if let Some(name) = suggested_name.as_deref().filter(|n| !n.trim().is_empty()) {
        // a file name only: the dialog decides the folder
        let name = std::path::Path::new(name)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        dlg = dlg.set_file_name(name);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dlg.save_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(chosen) = rx
        .await
        .map_err(|_| "The save dialog was closed".to_string())?
    else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    state.allow_export_path(path.clone());
    Ok(Some(path.display().to_string()))
}

/// The user's home directory.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|h| h.is_absolute())
}

/// `<home>/<file name>`: the default of the Export Data dialog's "Output file" (only the file name of
/// `file_name` is used). `null` when the home directory is unknown.
#[tauri::command]
pub async fn default_export_path(file_name: String) -> Res<Option<String>> {
    let name = std::path::Path::new(&file_name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty() && !n.starts_with('.'));
    Ok(home_dir()
        .zip(name)
        .map(|(h, n)| h.join(n).display().to_string()))
}

/// May the backend write a NEW file at `path` without the save dialog? Only a file that does not exist yet,
/// directly inside an existing folder under `home`, with no hidden (dot) component below `home`: the user
/// typed it in the Export Data dialog, but it cannot overwrite anything or reach `~/.ssh`, `~/.bashrc`...
fn typed_export_path_ok(path: &std::path::Path, home: &std::path::Path) -> bool {
    use std::path::Component;
    let Ok(rel) = path.strip_prefix(home) else {
        return false;
    };
    if !path.is_absolute() || rel.as_os_str().is_empty() {
        return false;
    }
    let plain = rel.components().all(|c| match c {
        Component::Normal(n) => !n.to_string_lossy().starts_with('.'),
        _ => false,
    });
    plain && !path.exists() && path.parent().is_some_and(|d| d.is_dir())
}

/// The Export Data dialog's typed "Output file": permits `export_query` / `export_result` to write that path
/// when it is a new file under the home directory (see [`typed_export_path_ok`]). `false`: the caller must
/// go through `choose_export_path` (the save dialog asks before it overwrites).
#[tauri::command]
pub async fn approve_export_path(state: State<'_, AppState>, path: String) -> Res<bool> {
    let path = PathBuf::from(path);
    let ok = home_dir().is_some_and(|h| typed_export_path_ok(&path, &h));
    if ok {
        state.allow_export_path(path);
    }
    Ok(ok)
}

/// `path` must come from `choose_export_path`.
#[tauri::command]
pub async fn export_query(
    state: State<'_, AppState>,
    ds_id: String,
    sql: String,
    options: ExportOptions,
    path: String,
) -> Res<usize> {
    state
        .export_query(&ds_id, &sql, options, &PathBuf::from(path))
        .await
}

#[tauri::command]
pub async fn export_query_to_string(
    state: State<'_, AppState>,
    ds_id: String,
    sql: String,
    options: ExportOptions,
) -> Res<String> {
    state.export_query_to_string(&ds_id, &sql, options).await
}

/// `path` must come from `choose_export_path`.
#[tauri::command]
pub async fn export_result(
    state: State<'_, AppState>,
    result: ResultSet,
    options: ExportOptions,
    path: String,
) -> Res<usize> {
    state
        .export_result(result, options, PathBuf::from(path))
        .await
}

#[tauri::command]
pub async fn export_to_string(
    state: State<'_, AppState>,
    result: ResultSet,
    options: ExportOptions,
) -> Res<String> {
    state.export_to_string(result, options).await
}

// ---------------------------------------------------------------- import

/// The file picked in the import dialog.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Where the rows that fail are written unless the user picks another file.
    pub default_error_file: String,
}

/// Open the native "Open" dialog from the backend and return the chosen file (`null` = cancelled). Only a file
/// returned here is read by `import_preview` / `import_file`: the webview cannot make the backend read an
/// arbitrary path.
#[tauri::command]
pub async fn choose_import_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Res<Option<ImportSource>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter("Delimited text", &["csv", "tsv", "txt"])
        .add_filter("All files", &["*"])
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(chosen) = rx
        .await
        .map_err(|_| "The open dialog was closed".to_string())?
    else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let default_error_file = AppState::default_error_file(&path).display().to_string();
    state.allow_import_path(path.clone());
    Ok(Some(ImportSource {
        path: path.display().to_string(),
        name,
        size,
        default_error_file,
    }))
}

/// Column names, the first `limit` rows and an inferred type per column of a file from `choose_import_file`.
#[tauri::command]
pub async fn import_preview(
    state: State<'_, AppState>,
    path: String,
    format: ImportFormat,
    limit: Option<usize>,
) -> Res<ImportPreview> {
    state
        .import_preview(&path, format, limit.unwrap_or(10))
        .await
}

/// Streams the file into the table in one transaction; `on_progress` gets a progress event after every batch.
/// `request.path` must come from `choose_import_file`; `request.options.errorFile` must be the default error
/// file of that path or come from `choose_export_path`.
#[tauri::command]
pub async fn import_file(
    state: State<'_, AppState>,
    ds_id: String,
    import_id: String,
    request: ImportRequest,
    on_progress: Channel<ImportProgress>,
) -> Res<ImportResult> {
    state
        .import_file(&ds_id, &import_id, request, move |p| {
            let _ = on_progress.send(p);
        })
        .await
}

#[tauri::command]
pub async fn cancel_import(state: State<'_, AppState>, import_id: String) -> Res<()> {
    state.cancel_import(&import_id);
    Ok(())
}

// ---------------------------------------------------------------- splitter

#[tauri::command]
pub async fn split_statements(
    state: State<'_, AppState>,
    sql: String,
    driver: Driver,
) -> Res<Vec<Statement>> {
    Ok(state.split_statements(&sql, driver))
}

#[tauri::command]
pub async fn statement_at(
    state: State<'_, AppState>,
    sql: String,
    caret_utf16: usize,
    driver: Driver,
) -> Res<Option<Statement>> {
    Ok(state.statement_at(&sql, caret_utf16, driver))
}

// ---------------------------------------------------------------- history

#[tauri::command]
pub async fn history_list(
    state: State<'_, AppState>,
    ds_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Res<Vec<HistoryEntry>> {
    state
        .history_list(ds_id, offset.unwrap_or(0), limit.unwrap_or(200))
        .await
}

#[tauri::command]
pub async fn history_search(
    state: State<'_, AppState>,
    text: String,
    ds_id: Option<String>,
    limit: Option<usize>,
) -> Res<Vec<HistoryEntry>> {
    state
        .history_search(text, ds_id, limit.unwrap_or(200))
        .await
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
pub async fn write_console(
    state: State<'_, AppState>,
    ds_id: String,
    name: String,
    text: String,
) -> Res<()> {
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
pub async fn rename_console(
    state: State<'_, AppState>,
    ds_id: String,
    from: String,
    to: String,
) -> Res<()> {
    state.rename_console(&ds_id, &from, &to).await
}

#[cfg(test)]
mod tests {
    use super::typed_export_path_ok;

    #[test]
    fn typed_export_paths() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        std::fs::create_dir(h.join("docs")).unwrap();
        std::fs::create_dir(h.join(".ssh")).unwrap();
        std::fs::write(h.join("old.csv"), "x").unwrap();
        assert!(typed_export_path_ok(&h.join("new.csv"), h));
        assert!(typed_export_path_ok(&h.join("docs/new.csv"), h));
        // exists, hidden, missing folder, outside home, traversal, the home itself
        assert!(!typed_export_path_ok(&h.join("old.csv"), h));
        assert!(!typed_export_path_ok(&h.join(".bashrc"), h));
        assert!(!typed_export_path_ok(&h.join(".ssh/authorized_keys"), h));
        assert!(!typed_export_path_ok(&h.join("nope/new.csv"), h));
        assert!(!typed_export_path_ok(
            std::path::Path::new("/etc/new.csv"),
            h
        ));
        assert!(!typed_export_path_ok(&h.join("docs/../../x.csv"), h));
        assert!(!typed_export_path_ok(h, h));
    }
}
