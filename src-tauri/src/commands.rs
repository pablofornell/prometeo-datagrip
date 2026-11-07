//! Tauri commands: thin adapters over [`AppState`]. All are async, return
//! `Result<T, String>` (the string is the real server / OS message) and use camelCase JSON
//! (argument names are camelCase on the JS side: `ds_id` -> `dsId`).

use std::path::PathBuf;

use dbcore::{
    ApplyResult, ConnectInfo, DataSourceConfig, Driver, ExecEvent, ExecOptions, ExplainPlan,
    ExportFormat, ExportOptions, FetchedRows, HistoryEntry, ImportFormat, ImportPreview,
    ImportProgress, ImportRequest, ImportResult, ObjectRef, ResultSet, RowChange, SessionState,
    SnapshotObject, Statement, TableDataRequest, TestResult, TreeNode, TxStatus,
};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use crate::files::{FileAccess, FileContent, FileInfo, FileRoots};
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
pub async fn get_ddl(
    state: State<'_, AppState>,
    ds_id: String,
    object: ObjectRef,
    unqualified: Option<bool>,
) -> Res<String> {
    state
        .get_ddl_with(&ds_id, object, unqualified.unwrap_or(false))
        .await
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

/// The plan of a statement (`EXPLAIN`); `analyze` runs it. Fails on SQLite when `analyze`.
#[tauri::command]
pub async fn explain_plan(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    analyze: bool,
) -> Res<ExplainPlan> {
    state.explain(&session_id, &sql, analyze).await
}

#[tauri::command]
pub async fn cancel_session(state: State<'_, AppState>, session_id: String) -> Res<()> {
    state.cancel_session(&session_id).await
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

/// File extension and dialog label of an export format (none: CSV).
fn export_extension(format: Option<ExportFormat>) -> (&'static str, &'static str) {
    match format {
        Some(ExportFormat::Tsv) => ("tsv", "TSV"),
        Some(ExportFormat::Json) => ("json", "JSON"),
        Some(ExportFormat::SqlInsert | ExportFormat::SqlUpdate | ExportFormat::WhereClause) => {
            ("sql", "SQL")
        }
        Some(ExportFormat::Markdown) => ("md", "Markdown"),
        Some(ExportFormat::JsonLines) => ("jsonl", "JSON Lines"),
        Some(ExportFormat::Html) => ("html", "HTML"),
        Some(ExportFormat::Xml) => ("xml", "XML"),
        Some(ExportFormat::Pretty) => ("txt", "Text"),
        _ => ("csv", "CSV"),
    }
}

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
    let (ext, label) = export_extension(format);
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

/// Folders below the home directory whose files programs run or load on their own (macOS agents and launch
/// items, Windows autostart and profile data).
const AUTORUN_HOME_DIRS: [&str; 2] = ["library", "appdata"];

/// May the backend write a NEW file at `path` without the save dialog? Only a file that does not exist yet
/// (not even as a dangling symlink), named with the extension of the export `format`, in an existing folder
/// that is, after resolving every symlink, below `home` with no hidden (dot) component and outside the
/// autostart folders: the user typed it in the Export Data dialog, but it cannot overwrite anything, run as
/// code (`.bashrc`, `conftest.py`, `LaunchAgents/*.plist`...) or leave the home folder through a link.
///
/// Returns the path to write: the resolved folder plus the file name (the caller writes there, so a folder
/// replaced by a symlink after this check is not followed).
fn typed_export_path_ok(
    path: &std::path::Path,
    home: &std::path::Path,
    format: Option<ExportFormat>,
) -> Option<PathBuf> {
    use std::path::Component;
    if !path.is_absolute() {
        return None;
    }
    // "..", "." and the like are never typed on purpose
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return None;
    }
    let name = path.file_name()?;
    let name_text = name.to_string_lossy();
    let (ext, _) = export_extension(format);
    let stem_ok = std::path::Path::new(name)
        .file_stem()
        .is_some_and(|s| !s.is_empty() && !s.to_string_lossy().starts_with('.'));
    let ext_ok = std::path::Path::new(name)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(ext));
    if name_text.starts_with('.') || !stem_ok || !ext_ok {
        return None;
    }
    let home = home.canonicalize().ok()?;
    let dir = path.parent()?.canonicalize().ok()?;
    if !dir.is_dir() {
        return None;
    }
    let rel = dir.strip_prefix(&home).ok()?;
    let plain = rel.components().enumerate().all(|(i, c)| match c {
        Component::Normal(n) => {
            let n = n.to_string_lossy();
            !n.starts_with('.')
                && !(i == 0 && AUTORUN_HOME_DIRS.contains(&n.to_lowercase().as_str()))
        }
        _ => false,
    });
    if !plain {
        return None;
    }
    let target = dir.join(name);
    // symlink_metadata: a dangling symlink "does not exist" for exists(), but File::create would follow it
    match std::fs::symlink_metadata(&target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(target),
        _ => None,
    }
}

/// The Export Data dialog's typed "Output file": permits `export_query` / `export_result` to write that path
/// when it is a new file of the right type under the home directory (see [`typed_export_path_ok`]). `false`:
/// the caller must go through `choose_export_path` (the save dialog asks before it overwrites).
#[tauri::command]
pub async fn approve_export_path(
    state: State<'_, AppState>,
    path: String,
    format: Option<ExportFormat>,
) -> Res<bool> {
    let path = PathBuf::from(path);
    let resolved = home_dir().and_then(|h| typed_export_path_ok(&path, &h, format));
    let ok = resolved.is_some();
    if let Some(resolved) = resolved {
        state.allow_typed_export_path(path, resolved);
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

// ---------------------------------------------------------------- files (scratches, opened .sql files, folders)

/// File IO off the async workers; `FileAccess` enforces the path policy (see `files.rs`).
async fn file_job<T: Send + 'static>(
    state: &State<'_, AppState>,
    f: impl FnOnce(&FileAccess) -> Res<T> + Send + 'static,
) -> Res<T> {
    let files = state.files.clone();
    tokio::task::spawn_blocking(move || f(&files))
        .await
        .map_err(|e| format!("internal error: {e}"))?
}

/// Native "Open" dialog (multi-select, `*.sql` first). The chosen files may be read and written afterwards;
/// the webview cannot reach any other path.
#[tauri::command]
pub async fn choose_open_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Res<Vec<FileInfo>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter("SQL files", &["sql"])
        .add_filter("All files", &["*"])
        .pick_files(move |p| {
            let _ = tx.send(p);
        });
    let Some(chosen) = rx
        .await
        .map_err(|_| "The open dialog was closed".to_string())?
    else {
        return Ok(Vec::new());
    };
    let paths: Vec<PathBuf> = chosen
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .collect();
    file_job(&state, move |f| {
        paths.iter().map(|p| f.approve_file(p)).collect()
    })
    .await
}

/// Native folder dialog; the folder joins the Files window and everything below it becomes readable.
#[tauri::command]
pub async fn choose_attach_folder(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Res<Option<FileInfo>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .pick_folder(move |p| {
            let _ = tx.send(p);
        });
    let Some(chosen) = rx
        .await
        .map_err(|_| "The folder dialog was closed".to_string())?
    else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    file_job(&state, move |f| f.attach_folder(&path).map(Some)).await
}

/// Forget an opened file / attached folder (the file stays on disk).
#[tauri::command]
pub async fn detach_file_root(state: State<'_, AppState>, path: String) -> Res<()> {
    file_job(&state, move |f| f.detach(&path)).await
}

#[tauri::command]
pub async fn file_roots(state: State<'_, AppState>) -> Res<FileRoots> {
    file_job(&state, |f| Ok(f.roots())).await
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, path: String) -> Res<FileContent> {
    file_job(&state, move |f| f.read(&path)).await
}

/// Returns the new modification time. `expected_mtime_ms`: refuse when the file changed on disk since.
#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    path: String,
    text: String,
    expected_mtime_ms: Option<u64>,
) -> Res<u64> {
    file_job(&state, move |f| f.write(&path, &text, expected_mtime_ms)).await
}

#[tauri::command]
pub async fn list_dir(state: State<'_, AppState>, path: String) -> Res<Vec<FileInfo>> {
    file_job(&state, move |f| f.list_dir(&path)).await
}

#[tauri::command]
pub async fn list_scratches(state: State<'_, AppState>) -> Res<Vec<FileInfo>> {
    file_job(&state, |f| f.list_scratches()).await
}

#[tauri::command]
pub async fn create_scratch(state: State<'_, AppState>) -> Res<FileInfo> {
    file_job(&state, |f| f.create_scratch()).await
}

#[tauri::command]
pub async fn delete_scratch(state: State<'_, AppState>, path: String) -> Res<()> {
    file_job(&state, move |f| f.delete_scratch(&path)).await
}

#[tauri::command]
pub async fn rename_scratch(state: State<'_, AppState>, path: String, to: String) -> Res<FileInfo> {
    file_job(&state, move |f| f.rename_scratch(&path, &to)).await
}

#[cfg(test)]
mod tests {
    use super::{typed_export_path_ok, ExportFormat};
    use std::path::Path;

    fn ok(p: &Path, h: &Path, f: Option<ExportFormat>) -> bool {
        typed_export_path_ok(p, h, f).is_some()
    }

    #[test]
    fn typed_export_paths() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let csv = Some(ExportFormat::Csv);
        std::fs::create_dir(h.join("docs")).unwrap();
        std::fs::create_dir(h.join(".ssh")).unwrap();
        std::fs::write(h.join("old.csv"), "x").unwrap();
        assert!(ok(&h.join("new.csv"), h, csv));
        assert!(ok(&h.join("docs/new.csv"), h, csv));
        assert!(ok(&h.join("NEW.CSV"), h, None));
        // exists, hidden, missing folder, outside home, traversal, the home itself
        assert!(!ok(&h.join("old.csv"), h, csv));
        assert!(!ok(&h.join(".bashrc"), h, csv));
        assert!(!ok(&h.join(".hidden.csv"), h, csv));
        assert!(!ok(&h.join(".ssh/authorized_keys"), h, csv));
        assert!(!ok(&h.join(".ssh/new.csv"), h, csv));
        assert!(!ok(&h.join("nope/new.csv"), h, csv));
        assert!(!ok(Path::new("/etc/new.csv"), h, csv));
        assert!(!ok(&h.join("docs/../../x.csv"), h, csv));
        assert!(!ok(h, h, csv));
        assert!(!ok(Path::new("new.csv"), h, csv));
    }

    #[test]
    fn typed_export_needs_the_extension_of_the_format() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let f = |fmt| Some(fmt);
        assert!(ok(&h.join("a.json"), h, f(ExportFormat::Json)));
        assert!(ok(&h.join("a.sql"), h, f(ExportFormat::SqlInsert)));
        assert!(ok(&h.join("a.md"), h, f(ExportFormat::Markdown)));
        assert!(ok(&h.join("a.csv"), h, f(ExportFormat::CsvSemicolon)));
        assert!(ok(&h.join("a.txt"), h, f(ExportFormat::Pretty)));
        assert!(!ok(&h.join("a.json"), h, f(ExportFormat::Csv)));
        assert!(!ok(&h.join("a.csv"), h, f(ExportFormat::Json)));
        assert!(!ok(&h.join("conftest.py"), h, f(ExportFormat::Csv)));
        assert!(!ok(&h.join("build.rs"), h, f(ExportFormat::Csv)));
        assert!(!ok(&h.join("job.plist"), h, f(ExportFormat::Xml)));
        assert!(!ok(&h.join("noext"), h, f(ExportFormat::Csv)));
        assert!(!ok(&h.join("a.csv.py"), h, f(ExportFormat::Csv)));
        assert!(ok(&h.join("a.csv"), h, None));
        assert!(!ok(&h.join("a.json"), h, None));
    }

    #[test]
    fn typed_export_returns_the_resolved_path() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path().canonicalize().unwrap();
        std::fs::create_dir(h.join("docs")).unwrap();
        let got = typed_export_path_ok(&h.join("docs/new.csv"), &h, None).unwrap();
        assert_eq!(got, h.join("docs/new.csv"));
    }

    #[test]
    fn typed_export_skips_autostart_folders() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        std::fs::create_dir_all(h.join("Library/LaunchAgents")).unwrap();
        std::fs::create_dir_all(h.join("AppData/Roaming")).unwrap();
        assert!(!ok(
            &h.join("Library/LaunchAgents/x.xml"),
            h,
            Some(ExportFormat::Xml)
        ));
        assert!(!ok(&h.join("AppData/Roaming/x.csv"), h, None));
    }

    #[cfg(unix)]
    #[test]
    fn typed_export_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let h = root.path().join("home");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(h.join("docs")).unwrap();
        std::fs::create_dir_all(h.join(".config")).unwrap();
        std::fs::create_dir(&outside).unwrap();
        // a folder link out of the home folder, and one into a hidden folder
        symlink(&outside, h.join("out")).unwrap();
        symlink(h.join(".config"), h.join("cfg")).unwrap();
        // a link to a folder inside the home folder is fine: it is judged by where it leads
        symlink(h.join("docs"), h.join("alias")).unwrap();
        assert!(!ok(&h.join("out/new.csv"), &h, None));
        assert!(!ok(&h.join("cfg/new.csv"), &h, None));
        assert_eq!(
            typed_export_path_ok(&h.join("alias/new.csv"), &h, None),
            Some(h.canonicalize().unwrap().join("docs/new.csv"))
        );
        // dangling and live links as the file itself
        symlink(outside.join("victim.csv"), h.join("dangling.csv")).unwrap();
        std::fs::write(outside.join("real.csv"), "x").unwrap();
        symlink(outside.join("real.csv"), h.join("live.csv")).unwrap();
        assert!(!ok(&h.join("dangling.csv"), &h, None));
        assert!(!ok(&h.join("live.csv"), &h, None));
        assert!(!outside.join("victim.csv").exists());
        // a home folder that is itself reached through a link
        symlink(&h, root.path().join("homelink")).unwrap();
        assert!(ok(
            &root.path().join("homelink/new.csv"),
            &root.path().join("homelink"),
            None
        ));
    }
}
