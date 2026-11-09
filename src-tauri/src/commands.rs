//! Tauri commands: thin adapters over [`AppState`]. All are async, return
//! `Result<T, String>` (the string is the real server / OS message) and use camelCase JSON
//! (argument names are camelCase on the JS side: `ds_id` -> `dsId`).

use std::path::PathBuf;

use dbcore::compare::SchemaModel;
use dbcore::{
    ApplyResult, ConnectInfo, DataSourceConfig, Driver, DumpOptions, DumpProgress, DumpResult,
    ExecEvent, ExecOptions, ExplainPlan, ExportFormat, ExportOptions, ExportProgress, ExportReport,
    FetchedRows, HistoryEntry, ImportFormat, ImportPreview, ImportProgress, ImportRequest,
    ImportResult, ObjectRef, ResultSet, RowChange, ScriptOptions, ScriptProgress, ScriptSummary,
    SessionState, SnapshotObject, Statement, TableDataRequest, TestResult, TreeNode, TxStatus,
    Usage,
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
pub async fn copy_data_source_password(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Res<DataSourceView> {
    state.copy_data_source_password(&from, &to).await
}

/// Write the data sources `ids` (all when absent or empty) to `path`, a path from `choose_export_path`. The file
/// never holds a password or token, only a `hasPassword` flag. Returns how many were written.
#[tauri::command]
pub async fn export_data_sources(
    state: State<'_, AppState>,
    ids: Option<Vec<String>>,
    path: String,
) -> Res<usize> {
    state.export_data_sources(ids, &PathBuf::from(path)).await
}

/// Create data sources from an export file, a path from `choose_open_json`: new ids, names made unique
/// (`name (2)`), no passwords (the summary says which ones need one).
#[tauri::command]
pub async fn import_data_sources(
    state: State<'_, AppState>,
    path: String,
) -> Res<crate::store::ImportSummary> {
    state.import_data_sources(&path).await
}

/// Same as `import_data_sources` for the text of an export (the clipboard).
#[tauri::command]
pub async fn import_data_sources_text(
    state: State<'_, AppState>,
    text: String,
) -> Res<crate::store::ImportSummary> {
    state.import_data_sources_text(text).await
}

/// Write the IDE settings object the UI built (settings, keymap, color scheme, layout; no data sources, no
/// secrets) to `path`, a path from `choose_export_path`.
#[tauri::command]
pub async fn export_settings(state: State<'_, AppState>, settings: Value, path: String) -> Res<()> {
    state.export_settings(settings, &PathBuf::from(path)).await
}

/// The settings object of a settings export file, a path from `choose_open_json`.
#[tauri::command]
pub async fn import_settings(state: State<'_, AppState>, path: String) -> Res<Value> {
    state.import_settings(&path).await
}

/// Open the native "Open" dialog for a JSON export file and return the chosen path (`null` = cancelled). Only a
/// path returned here is read by `import_data_sources` / `import_settings`.
#[tauri::command]
pub async fn choose_open_json(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter("JSON", &["json"])
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
    state.allow_import_path(path.clone());
    Ok(Some(path.display().to_string()))
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

/// Find Usages (Alt+F7): what refers to the object (`dbcore::usages`).
#[tauri::command]
pub async fn find_usages(
    state: State<'_, AppState>,
    ds_id: String,
    object_ref: ObjectRef,
) -> Res<Vec<Usage>> {
    state.find_usages(&ds_id, object_ref).await
}

#[tauri::command]
pub async fn schema_snapshot(
    state: State<'_, AppState>,
    ds_id: String,
    schema: Option<String>,
) -> Res<Vec<SnapshotObject>> {
    state.schema_snapshot(&ds_id, schema).await
}

/// Normalized model of `schema` for "Compare schemas"; `name_prefix` keeps the objects whose name starts with it.
#[tauri::command]
pub async fn schema_model(
    state: State<'_, AppState>,
    ds_id: String,
    schema: String,
    name_prefix: Option<String>,
) -> Res<SchemaModel> {
    state
        .schema_model(&ds_id, &schema, name_prefix.as_deref())
        .await
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

// ---------------------------------------------------------------- cell values

/// The full value of one cell of a table row. `keys`: primary key column -> value (the row's key). `maxBytes` caps
/// what is read; absent or `0` means the cap of 32 MB.
#[tauri::command]
pub async fn fetch_cell(
    state: State<'_, AppState>,
    ds_id: String,
    table: ObjectRef,
    keys: std::collections::BTreeMap<String, Value>,
    column: String,
    max_bytes: Option<u64>,
) -> Res<dbcore::cell::CellContent> {
    state
        .fetch_cell(&ds_id, table, keys, &column, max_bytes.unwrap_or(0))
        .await
}

/// Open the native "Save" dialog for a cell value and return the chosen path (`null` = cancelled). Only that path is
/// written by `write_value_file`, once.
#[tauri::command]
pub async fn choose_value_save_path(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    suggested_name: Option<String>,
    extension: Option<String>,
) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let mut dlg = app.dialog().file().set_parent(&window);
    if let Some(ext) = extension.as_deref().filter(|e| !e.is_empty()) {
        dlg = dlg.add_filter(ext.to_uppercase(), &[ext]);
    }
    dlg = dlg.add_filter("All files", &["*"]);
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

/// Writes a cell value to `path` (from `choose_value_save_path`). `base64`: the bytes, standard base64.
#[tauri::command]
pub async fn write_value_file(state: State<'_, AppState>, path: String, base64: String) -> Res<()> {
    let bytes = dbcore::cell::base64_decode(&base64)
        .ok_or_else(|| "The value to save is not valid base64".to_string())?;
    if bytes.len() as u64 > dbcore::cell::MAX_CELL_BYTES {
        return Err("The value is larger than 32 MB".into());
    }
    state.write_value_file(&PathBuf::from(path), &bytes)
}

/// A file picked for a cell value (`choose_value_file`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// Open the native "Open" dialog for a file to load into a cell and return it (`null` = cancelled). Only that file is
/// read by `read_value_file`.
#[tauri::command]
pub async fn choose_value_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Res<Option<ValueFile>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
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
    state.allow_import_path(path.clone());
    Ok(Some(ValueFile {
        path: path.display().to_string(),
        name,
        size,
    }))
}

/// The bytes of a file from `choose_value_file`, standard base64 (at most 32 MB).
#[tauri::command]
pub async fn read_value_file(state: State<'_, AppState>, path: String) -> Res<String> {
    let bytes = state.read_value_file(&path)?;
    Ok(dbcore::cell::base64_encode(&bytes))
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
        Some(ExportFormat::Xlsx) => ("xlsx", "Excel"),
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
    folder: Option<String>,
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
    // the folder the user typed in the Export Data dialog (only used when it exists)
    if let Some(dir) = folder
        .map(PathBuf::from)
        .filter(|d| d.is_absolute() && d.is_dir())
    {
        dlg = dlg.set_directory(dir);
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

/// `<home>/Downloads/<file name>` (`<home>/<file name>` without a Downloads folder): the default of the Export
/// Data dialog's "Output file" (only the file name of `file_name` is used). `null` when the home directory is
/// unknown.
#[tauri::command]
pub async fn default_export_path(file_name: String) -> Res<Option<String>> {
    let name = std::path::Path::new(&file_name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty() && !n.starts_with('.'));
    Ok(home_dir().zip(name).map(|(h, n)| {
        let downloads = h.join("Downloads");
        let dir = if downloads.is_dir() { downloads } else { h };
        dir.join(n).display().to_string()
    }))
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
fn typed_export_path_check(
    path: &std::path::Path,
    home: &std::path::Path,
    format: Option<ExportFormat>,
) -> Result<PathBuf, String> {
    use std::path::Component;
    if !path.is_absolute() {
        return Err("The output file must be an absolute path.".into());
    }
    // "..", "." and the like are never typed on purpose
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("The output file must not contain \".\" or \"..\" components.".into());
    }
    let name = path
        .file_name()
        .ok_or_else(|| "The output file has no file name.".to_string())?;
    let name_text = name.to_string_lossy();
    let (ext, label) = export_extension(format);
    let stem_ok = std::path::Path::new(name)
        .file_stem()
        .is_some_and(|s| !s.is_empty() && !s.to_string_lossy().starts_with('.'));
    let ext_ok = std::path::Path::new(name)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(ext));
    if name_text.starts_with('.') || !stem_ok || !ext_ok {
        return Err(format!(
            "The file name must end with .{ext} ({label}) and must not start with a dot."
        ));
    }
    let home = home
        .canonicalize()
        .map_err(|_| "The home folder is not available.".to_string())?;
    let dir = path
        .parent()
        .and_then(|d| d.canonicalize().ok())
        .filter(|d| d.is_dir())
        .ok_or_else(|| "The folder of the output file does not exist.".to_string())?;
    let rel = dir.strip_prefix(&home).map_err(|_| {
        format!(
            "Only folders below your home folder ({}) are accepted here.",
            home.display()
        )
    })?;
    let plain = rel.components().enumerate().all(|(i, c)| match c {
        Component::Normal(n) => {
            let n = n.to_string_lossy();
            !n.starts_with('.')
                && !(i == 0 && AUTORUN_HOME_DIRS.contains(&n.to_lowercase().as_str()))
        }
        _ => false,
    });
    if !plain {
        return Err("Hidden and autostart folders are not allowed as an output folder.".into());
    }
    let target = dir.join(name);
    // symlink_metadata: a dangling symlink "does not exist" for exists(), but File::create would follow it
    match std::fs::symlink_metadata(&target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(target),
        _ => Err("The file already exists. Choose it in the save dialog to overwrite it.".into()),
    }
}

/// The Export Data dialog's typed "Output file": permits `export_query` / `export_result` to write that path
/// when it is a new file of the right type under the home directory (see [`typed_export_path_check`]).
/// Returns `null` when approved, else the reason it is refused: the dialog shows it and offers the save
/// dialog (`choose_export_path`, which asks before it overwrites).
#[tauri::command]
pub async fn approve_export_path(
    state: State<'_, AppState>,
    path: String,
    format: Option<ExportFormat>,
) -> Res<Option<String>> {
    let path = PathBuf::from(path);
    let checked = home_dir()
        .ok_or_else(|| "The home folder is not known.".to_string())
        .and_then(|h| typed_export_path_check(&path, &h, format));
    match checked {
        Ok(resolved) => {
            state.allow_typed_export_path(path, resolved);
            Ok(None)
        }
        Err(reason) => Ok(Some(reason)),
    }
}

/// `path` must come from `choose_export_path`. `exportId` (unique per export) lets `cancel_export` stop it;
/// `onProgress` gets the rows written at most every 100 ms or 1000 rows, and once at the end. The report counts the characters a Windows-1252 file
/// could not hold (written as `?`).
#[tauri::command]
pub async fn export_query(
    state: State<'_, AppState>,
    ds_id: String,
    sql: String,
    options: ExportOptions,
    path: String,
    export_id: String,
    on_progress: Channel<ExportProgress>,
) -> Res<ExportReport> {
    state
        .export_query_with(
            &ds_id,
            &sql,
            options,
            &PathBuf::from(path),
            Some(&export_id),
            move |p| {
                let _ = on_progress.send(p);
            },
        )
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

/// `path` must come from `choose_export_path`. `exportId` / `onProgress` / the report as in `export_query`.
#[tauri::command]
pub async fn export_result(
    state: State<'_, AppState>,
    result: ResultSet,
    options: ExportOptions,
    path: String,
    export_id: String,
    on_progress: Channel<ExportProgress>,
) -> Res<ExportReport> {
    state
        .export_result_with(
            result,
            options,
            PathBuf::from(path),
            Some(&export_id),
            move |p| {
                let _ = on_progress.send(p);
            },
        )
        .await
}

/// Stops the export `export_id` (its `export_query` / `export_result` then fails and leaves no file behind).
#[tauri::command]
pub async fn cancel_export(state: State<'_, AppState>, export_id: String) -> Res<()> {
    state.cancel_export(&export_id);
    Ok(())
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

// ---------------------------------------------------------------- SQL dump

/// Dumps the objects of `schema` (PostgreSQL schema, MySQL database, SQLite `main`) to `path`, a file from
/// `choose_export_path` (format `sqlInsert`). `dump_id` (unique per dump) lets `cancel_dump` stop it; `progress`
/// gets a [`DumpProgress`] per phase and per data batch. A cancelled or failed dump leaves no file.
#[tauri::command]
pub async fn dump_schema(
    state: State<'_, AppState>,
    ds_id: String,
    schema: String,
    options: DumpOptions,
    path: String,
    dump_id: String,
    progress: Channel<DumpProgress>,
) -> Res<DumpResult> {
    state
        .dump_schema(
            &ds_id,
            &schema,
            options,
            &dump_id,
            &PathBuf::from(path),
            move |p| {
                let _ = progress.send(p);
            },
        )
        .await
}

#[tauri::command]
pub async fn cancel_dump(state: State<'_, AppState>, dump_id: String) -> Res<()> {
    state.cancel_dump(&dump_id);
    Ok(())
}

/// Opens the folder of a file that a finished dump of this session wrote ("Open Folder" of its notification).
/// Any other path is refused: the webview cannot make the backend open an arbitrary folder.
#[tauri::command]
pub async fn open_dump_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let folder = state.dump_folder(&path)?;
    app.opener()
        .open_path(folder.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- SQL scripts (run a script file)

/// Runs the SQL script file `path` on a data source, in `schema` when given. `path` must be a file the user granted
/// (`choose_open_files`, or a file of an attached folder or of the scratches). `script_id` (unique per run) lets
/// `cancel_script` stop it; `on_progress` gets a [`ScriptProgress`] about every 100 ms. The summary counts the
/// statements that ran and that failed, and gives the first error with its line.
#[tauri::command]
pub async fn run_sql_file(
    state: State<'_, AppState>,
    ds_id: String,
    script_id: String,
    schema: Option<String>,
    path: String,
    opts: ScriptOptions,
    on_progress: Channel<ScriptProgress>,
) -> Res<ScriptSummary> {
    state
        .run_sql_file(
            &ds_id,
            &script_id,
            schema.as_deref(),
            &path,
            opts,
            move |p| {
                let _ = on_progress.send(p);
            },
        )
        .await
}

#[tauri::command]
pub async fn cancel_script(state: State<'_, AppState>, script_id: String) -> Res<()> {
    state.cancel_script(&script_id);
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
    use super::{typed_export_path_check, ExportFormat};
    use std::path::{Path, PathBuf};

    fn typed_export_path_ok(p: &Path, h: &Path, f: Option<ExportFormat>) -> Option<PathBuf> {
        typed_export_path_check(p, h, f).ok()
    }

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
        assert!(ok(&h.join("a.xlsx"), h, f(ExportFormat::Xlsx)));
        assert!(!ok(&h.join("a.csv"), h, f(ExportFormat::Xlsx)));
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
    fn typed_export_refusals_say_why() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(h.join("taken.csv"), "x").unwrap();
        let why = |p: &Path| typed_export_path_check(p, h, None).unwrap_err();
        assert!(why(Path::new("rel.csv")).contains("absolute"));
        assert!(why(&outside.path().join("a.csv")).contains("home folder"));
        assert!(why(&h.join("a.txt")).contains(".csv"));
        assert!(why(&h.join("missing/a.csv")).contains("does not exist"));
        assert!(why(&h.join("taken.csv")).contains("already exists"));
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
