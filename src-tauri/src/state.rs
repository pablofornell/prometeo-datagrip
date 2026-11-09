//! Application state and the command logic behind `commands.rs`.
//!
//! Everything here is plain async Rust without a Tauri dependency, so it can be tested
//! without a webview (see `tests/`). `commands.rs` only adapts arguments and the
//! `tauri::ipc::Channel`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dbcore::import::CancellationToken;
use dbcore::{
    export_result_with, export_to_string, ApplyResult, ConnectInfo, ConnectionManager,
    DataSourceConfig, Driver, DumpOptions, DumpProgress, DumpResult, ExecEvent, ExecOptions,
    ExecutionId, ExplainPlan, ExportOptions, ExportProgress, ExportReport, FetchedRows,
    HistoryEntry, ImportFormat, ImportPreview, ImportProgress, ImportRequest, ImportResult,
    ObjectRef, QueryHistory, ResultSet, RowChange, ScriptOptions, ScriptProgress, ScriptSummary,
    SessionId, SessionState, SnapshotObject, Statement, TableDataRequest, TestResult, TreeNode,
    TxStatus,
};
use serde::Serialize;
use serde_json::Value;

use crate::files::FileAccess;
use crate::store::{
    redact, strip_url_password, ConsoleStore, DataSourceStore, DataSourceView, NoKeyring,
    OsKeyring, PasswordStorage, SecretStore, StartupNotice, UiStateStore,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub config_dir: String,
    pub data_dir: String,
    /// Where new passwords are stored: the OS keyring when reachable, otherwise the JSON file. `null` until
    /// something needed the keyring (a password was saved or migrated): the app does not probe it at every launch.
    pub password_storage: Option<PasswordStorage>,
    /// Files that were corrupt at startup and set aside (`<file>.corrupt-<ts>`); the app started with an
    /// empty one. Show them once. Empty in the normal case.
    pub startup_warnings: Vec<StartupNotice>,
}

/// How long a path chosen in the save dialog stays valid for `export_query` / `export_result`.
const EXPORT_PATH_TTL: Duration = Duration::from_secs(300);

/// How long a `cancel_import` for an unknown id waits for its `import_file`.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(30);

/// How many finished SQL dump files `open_dump_folder` may open the folder of.
const DUMPS_KEPT: usize = 20;

/// Permission to write one export file.
struct ExportGrant {
    at: Instant,
    /// Where to write: the path itself (save dialog), or the path with its folder resolved when the grant was
    /// given, so a folder swapped for a symlink afterwards is not followed.
    write_to: PathBuf,
    /// The user confirmed replacing an existing file (save dialog). A typed path must be a new file.
    replace: bool,
}

/// Where an approved export goes and whether an existing file there may be replaced.
pub struct ExportTarget {
    pub path: PathBuf,
    pub replace: bool,
}

impl ExportTarget {
    /// Opens the file without following a symlink at the end of the path; a new file unless `replace`.
    fn create(&self) -> Result<File, String> {
        let f = if self.replace {
            dbcore::fsutil::create_or_truncate_nofollow(&self.path)
        } else {
            dbcore::fsutil::create_new_nofollow(&self.path)
        };
        f.map_err(|e| format!("Cannot create {}: {e}", self.path.display()))
    }

    /// Opens the file the output is written to: a new one next to the target (see [`PartFile`]); the target itself is
    /// not touched before [`commit`](Self::commit). Refuses at once what `commit` would refuse: a target that exists
    /// unless `replace`.
    pub fn create_part(&self) -> Result<(File, PartFile), String> {
        if !self.replace && std::fs::symlink_metadata(&self.path).is_ok() {
            return Err(format!(
                "Cannot create {}: the file exists already",
                self.path.display()
            ));
        }
        let name = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "export".into());
        let part = self.path.with_file_name(format!(
            ".{name}.part-{}-{}",
            std::process::id(),
            PART_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let file = dbcore::fsutil::create_new_nofollow(&part)
            .map_err(|e| format!("Cannot create {}: {e}", self.path.display()))?;
        Ok((
            file,
            PartFile {
                path: part,
                committed: false,
            },
        ))
    }

    /// Puts the finished `part` (closed) in the place of the target. A new file never replaces one that appeared in
    /// the meantime. On an error `part` is removed and the target is as it was.
    pub fn commit(&self, mut part: PartFile) -> Result<(), String> {
        let fail = |e: std::io::Error| format!("Cannot write {}: {e}", self.path.display());
        if self.replace {
            std::fs::rename(&part.path, &self.path).map_err(fail)?;
            part.committed = true;
            return Ok(());
        }
        // the link fails when the name is taken, which `rename` would not
        match std::fs::hard_link(&part.path, &self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(fail(e)),
            // a file system without hard links: check, then move
            Err(_) if std::fs::symlink_metadata(&self.path).is_err() => {
                std::fs::rename(&part.path, &self.path).map_err(fail)?;
                part.committed = true;
                Ok(())
            }
            Err(e) => Err(fail(e)),
        }
    }
}

/// A file written next to its target (`.<name>.part-<n>`) and moved over the target only when the export succeeded: one
/// that fails or is cancelled must not take the file it was going to replace with it. Dropping a `PartFile` that was not
/// committed removes it (close the file first: Windows cannot remove an open one).
pub struct PartFile {
    path: PathBuf,
    committed: bool,
}

impl PartFile {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

static PART_SEQ: AtomicU64 = AtomicU64::new(0);

/// Removes an export id from the running exports however the export ends.
struct RegisteredExport<'a> {
    exports: &'a Mutex<HashMap<String, CancellationToken>>,
    id: String,
}

impl Drop for RegisteredExport<'_> {
    fn drop(&mut self) {
        self.exports.lock().unwrap().remove(&self.id);
    }
}

/// How long a file chosen in the import dialog may be previewed and imported (renewed by every use).
const IMPORT_PATH_TTL: Duration = Duration::from_secs(3600);

/// A running (or still pageable) execution.
#[derive(Debug, Clone)]
pub struct ExecMeta {
    pub ds_id: String,
    pub session_id: String,
}

/// Global application state shared with every Tauri command.
pub struct AppState {
    pub mgr: ConnectionManager,
    pub sources: Arc<DataSourceStore>,
    pub ui: Arc<UiStateStore>,
    pub history: Arc<QueryHistory>,
    pub consoles: Arc<ConsoleStore>,
    /// Scratch files, opened `.sql` files and attached folders of the Files tool window (`files.rs`).
    pub files: Arc<FileAccess>,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    /// session id -> data source id
    sessions: Mutex<HashMap<String, String>>,
    /// execution id -> meta; an entry lives until the execution task ends.
    executions: Arc<Mutex<HashMap<String, ExecMeta>>>,
    /// Export targets the user picked in a save dialog opened by the backend (`choose_export_path`), each
    /// valid once and for [`EXPORT_PATH_TTL`]. `export_query` / `export_result` write nowhere else.
    export_paths: Mutex<HashMap<PathBuf, ExportGrant>>,
    /// Files the user picked in the open dialog opened by the backend (`choose_import_file`): the only ones
    /// `import_preview` / `import_file` read.
    import_paths: Mutex<HashMap<PathBuf, Instant>>,
    /// import id -> cancellation token of a running import.
    imports: Mutex<HashMap<String, CancellationToken>>,
    /// export id -> cancellation token of a running export (`export_query` / `export_result` with an id).
    exports: Mutex<HashMap<String, CancellationToken>>,
    /// import or export id -> when `cancel_import` / `cancel_export` named it before its call registered it (see
    /// [`AppState::cancel_import`]).
    early_cancels: Mutex<HashMap<String, Instant>>,
    /// dump id -> cancellation token of a running SQL dump (`dump_schema`).
    dumps: Mutex<HashMap<String, CancellationToken>>,
    /// Files that finished SQL dumps wrote in this session: `open_dump_folder` opens only their folders.
    dumped: Mutex<Vec<PathBuf>>,
    /// script id -> cancellation token of a running SQL script (`run_sql_file`).
    scripts: Mutex<HashMap<String, CancellationToken>>,
}

/// Run blocking work (file IO, keyring) off the async workers.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("internal error: {e}"))?
}

/// `options` keys that only the UI reads (the backend takes none of them into account when it connects), so
/// changing or removing them must not drop a live connection: `comment`; `visibleSchemas` (a legacy key the
/// frontend migrates to its own state); `showSystemSchemas` (introspection takes `show_system` per call, a tree
/// refresh is enough); `txMode` / `sessionControl` / `keepAliveSec` / `autoDisconnectSec` / `startupScript`
/// (applied by the frontend when it opens sessions), `switchSchema` / `autoSync` (console and explorer behaviour)
/// and `passwordSave` (reserved). The keys dbcore reads
/// (`sslmode`, `application_name`, `connectTimeout`, `create`, ...), `dbms`, `auth` and free driver
/// properties stay in the fingerprint.
const VIEW_ONLY_OPTIONS: [&str; 11] = [
    "comment",
    "visibleSchemas",
    "showSystemSchemas",
    "txMode",
    "sessionControl",
    "keepAliveSec",
    "autoDisconnectSec",
    "startupScript",
    "switchSchema",
    "autoSync",
    "passwordSave",
];

/// Fields whose change invalidates a live pool.
fn connection_fingerprint(c: &DataSourceConfig) -> Value {
    let mut v = serde_json::to_value(c).unwrap_or(Value::Null);
    if let Some(m) = v.as_object_mut() {
        for k in ["name", "color", "password"] {
            m.remove(k);
        }
        if let Some(opts) = m.get_mut("options").and_then(Value::as_object_mut) {
            for k in VIEW_ONLY_OPTIONS {
                opts.remove(k);
            }
        }
    }
    v
}

/// `msg` without the password of `cfg` (also when it sits in a URL): error texts reach the UI and logs.
fn redact_for(cfg: &DataSourceConfig, msg: &str) -> String {
    let url_pw = cfg
        .url_override
        .as_deref()
        .and_then(|u| strip_url_password(u).1);
    let known: Vec<&str> = cfg
        .password
        .as_deref()
        .into_iter()
        .chain(url_pw.as_deref())
        .collect();
    redact(msg, &known)
}

impl AppState {
    /// Production state: the OS keyring unless `PROMETEO_NO_KEYRING` is set.
    pub fn open(config_dir: PathBuf, data_dir: PathBuf) -> Result<Self, String> {
        let secrets: Arc<dyn SecretStore> = if std::env::var_os("PROMETEO_NO_KEYRING").is_some() {
            Arc::new(NoKeyring)
        } else {
            Arc::new(OsKeyring)
        };
        Self::with_secrets(config_dir, data_dir, secrets)
    }

    pub fn with_secrets(
        config_dir: PathBuf,
        data_dir: PathBuf,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Self, String> {
        Ok(AppState {
            mgr: ConnectionManager::new(),
            sources: Arc::new(DataSourceStore::load(
                config_dir.join("data-sources.json"),
                secrets,
            )?),
            ui: Arc::new(UiStateStore::load(
                config_dir.join("ui-state.json"),
                UiStateStore::DEFAULT_DEBOUNCE,
            )),
            history: Arc::new(QueryHistory::new(data_dir.join("history.jsonl"))),
            consoles: Arc::new(ConsoleStore::new(data_dir.join("consoles"))),
            files: Arc::new(FileAccess::new(
                data_dir.join("scratches"),
                config_dir.join("file-access.json"),
            )),
            config_dir,
            data_dir,
            sessions: Mutex::new(HashMap::new()),
            executions: Arc::new(Mutex::new(HashMap::new())),
            export_paths: Mutex::new(HashMap::new()),
            import_paths: Mutex::new(HashMap::new()),
            imports: Mutex::new(HashMap::new()),
            exports: Mutex::new(HashMap::new()),
            early_cancels: Mutex::new(HashMap::new()),
            dumps: Mutex::new(HashMap::new()),
            dumped: Mutex::new(Vec::new()),
            scripts: Mutex::new(HashMap::new()),
        })
    }

    pub async fn app_info(&self) -> Result<AppInfo, String> {
        let sources = self.sources.clone();
        let password_storage = blocking(move || Ok(sources.known_storage())).await?;
        Ok(AppInfo {
            name: "Prometeo DataGrip".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            config_dir: self.config_dir.display().to_string(),
            data_dir: self.data_dir.display().to_string(),
            password_storage,
            startup_warnings: self.startup_warnings(),
        })
    }

    /// Corrupt files set aside while the stores were loaded.
    pub fn startup_warnings(&self) -> Vec<StartupNotice> {
        let mut w = self.sources.notices();
        w.extend(self.ui.notices());
        w
    }

    // ------------------------------------------------------------ data sources

    pub async fn list_data_sources(&self) -> Result<Vec<DataSourceView>, String> {
        Ok(self.sources.list())
    }

    pub async fn save_data_source(&self, cfg: DataSourceConfig) -> Result<DataSourceView, String> {
        let prev = self
            .sources
            .view(&cfg.id)
            .map(|v| connection_fingerprint(&v.cfg));
        let password_given = cfg.password.is_some()
            || cfg
                .url_override
                .as_deref()
                .is_some_and(crate::store::url_has_password);
        let sources = self.sources.clone();
        let view = blocking(move || sources.save(cfg)).await?;
        let changed = prev
            .map(|p| p != connection_fingerprint(&view.cfg))
            .unwrap_or(false);
        if (changed || password_given) && self.mgr.is_connected(&view.cfg.id) {
            // the pool was built from the old config: the UI reconnects on demand
            self.disconnect(&view.cfg.id).await?;
        }
        Ok(view)
    }

    pub async fn delete_data_source(&self, id: &str) -> Result<(), String> {
        self.disconnect(id).await?;
        let (sources, consoles, id) = (self.sources.clone(), self.consoles.clone(), id.to_string());
        blocking(move || {
            sources.delete(&id)?;
            consoles.delete_all(&id)
        })
        .await
    }

    pub async fn duplicate_data_source(&self, id: &str) -> Result<DataSourceView, String> {
        let (sources, id) = (self.sources.clone(), id.to_string());
        blocking(move || sources.duplicate(&id)).await
    }

    pub async fn copy_data_source_password(
        &self,
        from: &str,
        to: &str,
    ) -> Result<DataSourceView, String> {
        let (sources, from, to) = (self.sources.clone(), from.to_string(), to.to_string());
        blocking(move || sources.copy_password(&from, &to)).await
    }

    // ------------------------------------------------------------ export / import of data sources and settings

    /// Write `text` to a file the user picked in the save dialog (`choose_export_path`).
    async fn write_export_text(&self, path: &Path, text: String) -> Result<(), String> {
        let target = self.take_export_path(path)?;
        blocking(move || {
            let mut file = target.create()?;
            file.write_all(text.as_bytes())
                .and_then(|_| file.flush())
                .map_err(|e| {
                    let _ = std::fs::remove_file(&target.path);
                    format!("Cannot write {}: {e}", target.path.display())
                })
        })
        .await
    }

    /// Read a JSON export file the user picked in the open dialog (`choose_open_json`).
    async fn read_export_text(&self, path: &str) -> Result<String, String> {
        let path = self.check_import_path(path)?;
        blocking(move || {
            let len = std::fs::metadata(&path)
                .map_err(|e| format!("Cannot read {}: {e}", path.display()))?
                .len();
            if len > crate::store::MAX_EXPORT_FILE {
                return Err(format!(
                    "{} is too big to be an export file.",
                    path.display()
                ));
            }
            std::fs::read_to_string(&path)
                .map_err(|e| format!("Cannot read {}: {e}", path.display()))
        })
        .await
    }

    /// Write the data sources `ids` (all when empty) to `path` (from `choose_export_path`) without passwords.
    /// Returns how many were written.
    pub async fn export_data_sources(
        &self,
        ids: Option<Vec<String>>,
        path: &Path,
    ) -> Result<usize, String> {
        let sources = self.sources.clone();
        let (text, n) = blocking(move || sources.export_json(ids.as_deref())).await?;
        self.write_export_text(path, text).await?;
        Ok(n)
    }

    /// Create data sources from an export file (from `choose_open_json`).
    pub async fn import_data_sources(
        &self,
        path: &str,
    ) -> Result<crate::store::ImportSummary, String> {
        let text = self.read_export_text(path).await?;
        self.import_data_sources_text(text).await
    }

    /// Create data sources from the text of an export file (the clipboard).
    pub async fn import_data_sources_text(
        &self,
        text: String,
    ) -> Result<crate::store::ImportSummary, String> {
        if text.len() as u64 > crate::store::MAX_EXPORT_FILE {
            return Err("The text is too big to be a data sources export.".into());
        }
        let sources = self.sources.clone();
        blocking(move || sources.import_json(&text)).await
    }

    /// Write the IDE settings the UI collected (settings, keymap, color scheme, layout) to `path`.
    pub async fn export_settings(&self, settings: Value, path: &Path) -> Result<(), String> {
        let text = crate::store::settings_document(settings)?;
        self.write_export_text(path, text).await
    }

    /// The settings object of a settings export file (from `choose_open_json`).
    pub async fn import_settings(&self, path: &str) -> Result<Value, String> {
        let text = self.read_export_text(path).await?;
        crate::store::parse_settings_document(&text)
    }

    pub async fn test_connection(&self, cfg: DataSourceConfig) -> Result<TestResult, String> {
        let sources = self.sources.clone();
        let cfg = blocking(move || sources.with_stored_password(cfg)).await?;
        let mut res = self.mgr.test_connection(&cfg).await;
        res.message = redact_for(&cfg, &res.message);
        Ok(res)
    }

    async fn config(&self, id: &str) -> Result<DataSourceConfig, String> {
        let (sources, id) = (self.sources.clone(), id.to_string());
        blocking(move || sources.get(&id)).await
    }

    pub async fn connect(&self, id: &str) -> Result<ConnectInfo, String> {
        let cfg = self.config(id).await?;
        self.mgr
            .connect(&cfg)
            .await
            .map_err(|e| redact_for(&cfg, &e.to_string()))
    }

    pub async fn disconnect(&self, id: &str) -> Result<(), String> {
        self.mgr.disconnect(id).await;
        self.sessions.lock().unwrap().retain(|_, ds| ds != id);
        self.executions.lock().unwrap().retain(|_, m| m.ds_id != id);
        Ok(())
    }

    pub fn connected_data_sources(&self) -> Vec<String> {
        self.sources
            .list()
            .into_iter()
            .map(|v| v.cfg.id)
            .filter(|id| self.mgr.is_connected(id))
            .collect()
    }

    // ------------------------------------------------------------ sessions

    pub async fn open_session(&self, ds_id: &str) -> Result<String, String> {
        self.open_session_with(ds_id, &[]).await
    }

    /// `init_sql`: statements run on the new connection before it is handed out (re-applies `SET search_path`,
    /// `USE db`, the isolation level, ... of a console that is reopened); if one fails, the session is not opened.
    pub async fn open_session_with(
        &self,
        ds_id: &str,
        init_sql: &[String],
    ) -> Result<String, String> {
        let s = self
            .mgr
            .open_session_with(ds_id, init_sql)
            .await
            .map_err(String::from)?;
        self.sessions
            .lock()
            .unwrap()
            .insert(s.0.clone(), ds_id.to_string());
        Ok(s.0)
    }

    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        self.mgr
            .close_session(&SessionId(session_id.to_string()))
            .await;
        self.sessions.lock().unwrap().remove(session_id);
        self.executions
            .lock()
            .unwrap()
            .retain(|_, m| m.session_id != session_id);
        Ok(())
    }

    pub async fn session_in_transaction(&self, session_id: &str) -> Result<bool, String> {
        self.mgr
            .session_in_transaction(&SessionId(session_id.to_string()))
            .map_err(String::from)
    }

    /// `idle` / `active` / `failed` (see `dbcore::TxStatus`).
    pub async fn session_tx_status(&self, session_id: &str) -> Result<TxStatus, String> {
        self.mgr
            .session_tx_status(&SessionId(session_id.to_string()))
            .map_err(String::from)
    }

    /// Transaction status and connection health (see `dbcore::SessionState`).
    pub async fn session_state(&self, session_id: &str) -> Result<SessionState, String> {
        self.mgr
            .session_state(&SessionId(session_id.to_string()))
            .map_err(String::from)
    }

    // ------------------------------------------------------------ introspection

    pub async fn introspect(
        &self,
        ds_id: &str,
        path: Vec<String>,
        show_system: bool,
    ) -> Result<Vec<TreeNode>, String> {
        self.mgr
            .introspect_with(ds_id, &path, &dbcore::IntrospectOptions { show_system })
            .await
            .map_err(String::from)
    }

    pub async fn get_ddl(&self, ds_id: &str, object: ObjectRef) -> Result<String, String> {
        self.get_ddl_with(ds_id, object, false).await
    }

    /// `unqualified`: names of the object's own schema without the schema (the DDL view, as in DataGrip).
    pub async fn get_ddl_with(
        &self,
        ds_id: &str,
        object: ObjectRef,
        unqualified: bool,
    ) -> Result<String, String> {
        self.mgr
            .ddl_with(ds_id, &object, unqualified)
            .await
            .map_err(String::from)
    }

    pub async fn schema_snapshot(
        &self,
        ds_id: &str,
        schema: Option<String>,
    ) -> Result<Vec<SnapshotObject>, String> {
        self.mgr
            .schema_snapshot(ds_id, schema.as_deref())
            .await
            .map_err(String::from)
    }

    // ------------------------------------------------------------ execution

    /// Start an execution and forward every [`ExecEvent`] to `sink` in order (from a spawned
    /// task, so this returns the execution id immediately). A history entry is appended when
    /// the `Done` event passes through.
    pub async fn execute(
        &self,
        session_id: &str,
        sql: &str,
        options: ExecOptions,
        sink: impl Fn(ExecEvent) + Send + 'static,
    ) -> Result<String, String> {
        let ds_id = self
            .sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        let mut handle = self
            .mgr
            .execute(&SessionId(session_id.to_string()), sql, options)
            .await
            .map_err(String::from)?;
        let exec_id = handle.id.0.clone();
        {
            // a new execution on the session releases the previous (paging) one
            let mut ex = self.executions.lock().unwrap();
            ex.retain(|_, m| m.session_id != session_id);
            ex.insert(
                exec_id.clone(),
                ExecMeta {
                    ds_id: ds_id.clone(),
                    session_id: session_id.to_string(),
                },
            );
        }

        let history = self.history.clone();
        let executions = self.executions.clone();
        let sql = sql.to_string();
        let id = exec_id.clone();
        tokio::spawn(async move {
            let mut entry = HistoryEntry::new(&ds_id, &sql);
            let mut rows: u64 = 0;
            while let Some(ev) = handle.events.recv().await {
                match &ev {
                    ExecEvent::ResultSet { rows: r, .. } => rows = r.len() as u64,
                    ExecEvent::Update { rows_affected, .. } => rows += rows_affected,
                    ExecEvent::Error { message, .. } if entry.ok => {
                        entry.ok = false;
                        entry.error = Some(message.clone());
                    }
                    ExecEvent::Done { elapsed_ms, .. } => {
                        entry.duration_ms = Some(*elapsed_ms);
                        entry.rows = Some(rows);
                        if !sql.trim().is_empty() {
                            if let Err(e) = history.append(&entry) {
                                tracing::warn!("cannot append to the query history: {e}");
                            }
                        }
                    }
                    _ => {}
                }
                sink(ev);
            }
            // the execution task ended (paging stream closed): forget it
            executions.lock().unwrap().remove(&id);
        });
        Ok(exec_id)
    }

    pub async fn fetch_more(
        &self,
        execution_id: &str,
        result_index: usize,
        count: usize,
    ) -> Result<FetchedRows, String> {
        self.mgr
            .fetch_more(&ExecutionId(execution_id.to_string()), result_index, count)
            .await
            .map_err(String::from)
    }

    /// Cancelling an execution that already finished is not an error.
    pub async fn cancel(&self, execution_id: &str) -> Result<(), String> {
        let _ = self.mgr.cancel(&ExecutionId(execution_id.to_string()));
        Ok(())
    }

    pub async fn close_execution(&self, execution_id: &str) -> Result<(), String> {
        let _ = self
            .mgr
            .close_execution(&ExecutionId(execution_id.to_string()));
        Ok(())
    }

    /// Ids of executions that are running or still hold an open result for paging.
    pub fn running_executions(&self) -> Vec<String> {
        self.executions.lock().unwrap().keys().cloned().collect()
    }

    // ------------------------------------------------------------ table data

    pub async fn table_data(
        &self,
        ds_id: &str,
        table: ObjectRef,
        req: TableDataRequest,
    ) -> Result<ResultSet, String> {
        self.mgr
            .table_data(ds_id, &table, &req)
            .await
            .map_err(String::from)
    }

    /// Always `Ok` when the statements could be attempted: inspect `committed` and
    /// `results[i].error` (the server message of the failing change).
    pub async fn apply_changes(
        &self,
        ds_id: &str,
        table: ObjectRef,
        changes: Vec<RowChange>,
    ) -> Result<ApplyResult, String> {
        self.mgr
            .apply_changes(ds_id, &table, &changes)
            .await
            .map_err(String::from)
    }

    /// `table_data` on a session's connection: sees the session's uncommitted changes (manual transaction).
    pub async fn table_data_in_session(
        &self,
        session_id: &str,
        table: ObjectRef,
        req: TableDataRequest,
    ) -> Result<ResultSet, String> {
        self.mgr
            .table_data_in_session(&SessionId(session_id.to_string()), &table, &req)
            .await
            .map_err(String::from)
    }

    /// `apply_changes` on a session's connection: inside the session's open transaction the changes stay
    /// uncommitted (`committed == true` then means "applied").
    pub async fn apply_changes_in_session(
        &self,
        session_id: &str,
        table: ObjectRef,
        changes: Vec<RowChange>,
    ) -> Result<ApplyResult, String> {
        self.mgr
            .apply_changes_in_session(&SessionId(session_id.to_string()), &table, &changes)
            .await
            .map_err(String::from)
    }

    // ------------------------------------------------------------ export

    /// Remember `path` as chosen by the user in a save dialog: the next `export_query` / `export_result` to
    /// exactly this path is allowed (once, within five minutes).
    pub fn allow_export_path(&self, path: PathBuf) {
        self.grant_export(path.clone(), path, true);
    }

    /// Remember the typed `path` (a new file, already checked) to be written at `write_to`, once.
    pub fn allow_typed_export_path(&self, path: PathBuf, write_to: PathBuf) {
        self.grant_export(path, write_to, false);
    }

    fn grant_export(&self, path: PathBuf, write_to: PathBuf, replace: bool) {
        let mut m = self.export_paths.lock().unwrap();
        m.retain(|_, g| g.at.elapsed() < EXPORT_PATH_TTL);
        m.insert(
            path,
            ExportGrant {
                at: Instant::now(),
                write_to,
                replace,
            },
        );
    }

    /// Consume the permission for `path`; the frontend cannot make the backend write to a file the user did
    /// not pick.
    fn take_export_path(&self, path: &Path) -> Result<ExportTarget, String> {
        let mut m = self.export_paths.lock().unwrap();
        m.retain(|_, g| g.at.elapsed() < EXPORT_PATH_TTL);
        match m.remove(path) {
            Some(g) => Ok(ExportTarget {
                path: g.write_to,
                replace: g.replace,
            }),
            None => Err(format!(
                "Refusing to write {}: export targets must be chosen in the save dialog (choose_export_path)",
                path.display()
            )),
        }
    }

    /// Registers `export_id` as running (its token is cancelled at once when `cancel_export` named it before).
    /// An id that is running already is refused. `None`: nothing is registered and the export cannot be cancelled.
    fn begin_export(
        &self,
        export_id: Option<&str>,
    ) -> Result<(Option<RegisteredExport<'_>>, CancellationToken), String> {
        let token = CancellationToken::new();
        let Some(id) = export_id else {
            return Ok((None, token));
        };
        let mut exports = self.exports.lock().unwrap();
        if exports.contains_key(id) {
            return Err(format!("The export id {id} is in use already"));
        }
        exports.insert(id.to_string(), token.clone());
        let mut early = self.early_cancels.lock().unwrap();
        early.retain(|_, t| t.elapsed() < EARLY_CANCEL_TTL);
        if early.remove(id).is_some() {
            token.cancel();
        }
        let registered = RegisteredExport {
            exports: &self.exports,
            id: id.to_string(),
        };
        Ok((Some(registered), token))
    }

    /// Cancels the running export `export_id`, or remembers the cancel for a few seconds when it has not
    /// registered yet (see [`AppState::cancel_import`]). A no-op once the export ended.
    pub fn cancel_export(&self, export_id: &str) {
        let exports = self.exports.lock().unwrap();
        if let Some(t) = exports.get(export_id) {
            t.cancel();
            return;
        }
        let mut early = self.early_cancels.lock().unwrap();
        early.retain(|_, t| t.elapsed() < EARLY_CANCEL_TTL);
        if early.len() < 64 {
            early.insert(export_id.to_string(), Instant::now());
        }
    }

    /// Stream every row of `sql` to `path` (a path from [`allow_export_path`](Self::allow_export_path)).
    /// Returns the number of rows written.
    pub async fn export_query(
        &self,
        ds_id: &str,
        sql: &str,
        opts: ExportOptions,
        path: &Path,
    ) -> Result<usize, String> {
        Ok(self
            .export_query_with(ds_id, sql, opts, path, None, |_| {})
            .await?
            .rows)
    }

    /// `export_query` with an export id (for `cancel_export`), progress events and the report (rows written and
    /// the characters a Windows-1252 file could not hold). A cancelled or failed export leaves no file behind.
    pub async fn export_query_with(
        &self,
        ds_id: &str,
        sql: &str,
        opts: ExportOptions,
        path: &Path,
        export_id: Option<&str>,
        progress: impl Fn(ExportProgress) + Send + Sync,
    ) -> Result<ExportReport, String> {
        let (_registered, token) = self.begin_export(export_id)?;
        let target = self.take_export_path(path)?;
        let (file, part) = target.create_part()?;
        let mut w = BufWriter::new(file);
        let res = self
            .mgr
            .export_query_with(ds_id, sql, &opts, &mut w, &token, progress)
            .await;
        let res = res
            .map_err(String::from)
            .and_then(|r| w.flush().map(|_| r).map_err(|e| format!("I/O error: {e}")));
        // closed before it is moved (or removed) on Windows
        drop(w);
        res.and_then(|r| target.commit(part).map(|_| r))
    }

    pub async fn export_query_to_string(
        &self,
        ds_id: &str,
        sql: &str,
        opts: ExportOptions,
    ) -> Result<String, String> {
        let mut buf = Vec::new();
        self.mgr
            .export_query(ds_id, sql, &opts, &mut buf)
            .await
            .map_err(String::from)?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    /// Explain Plan / Explain Analyse of the first statement of `sql` on a console session (not recorded in the history).
    pub async fn explain(
        &self,
        session_id: &str,
        sql: &str,
        analyze: bool,
    ) -> Result<ExplainPlan, String> {
        self.mgr
            .explain(&SessionId(session_id.to_string()), sql, analyze)
            .await
            .map_err(String::from)
    }

    /// Stops the statement running on the session (an Explain Analyse has no execution id to `cancel`).
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        self.mgr
            .cancel_session(&SessionId(session_id.to_string()))
            .await
            .map_err(String::from)
    }

    pub async fn export_result(
        &self,
        rs: ResultSet,
        opts: ExportOptions,
        path: PathBuf,
    ) -> Result<usize, String> {
        Ok(self
            .export_result_with(rs, opts, path, None, |_| {})
            .await?
            .rows)
    }

    /// `export_result` with an export id (for `cancel_export`), progress events and the report. A cancelled or
    /// failed export leaves no file behind.
    pub async fn export_result_with(
        &self,
        rs: ResultSet,
        opts: ExportOptions,
        path: PathBuf,
        export_id: Option<&str>,
        progress: impl Fn(ExportProgress) + Send + Sync + 'static,
    ) -> Result<ExportReport, String> {
        let (_registered, token) = self.begin_export(export_id)?;
        let target = self.take_export_path(&path)?;
        blocking(move || {
            let (file, part) = target.create_part()?;
            let mut w = BufWriter::new(file);
            let res =
                export_result_with(&rs, &opts, &mut w, &token, progress).map_err(String::from);
            let res = res.and_then(|r| w.flush().map(|_| r).map_err(|e| format!("I/O error: {e}")));
            drop(w);
            res.and_then(|r| target.commit(part).map(|_| r))
        })
        .await
    }

    pub async fn export_to_string(
        &self,
        rs: ResultSet,
        opts: ExportOptions,
    ) -> Result<String, String> {
        export_to_string(&rs, &opts).map_err(String::from)
    }

    // ------------------------------------------------------------ import

    /// Remember `path` as chosen by the user in the open dialog.
    pub fn allow_import_path(&self, path: PathBuf) {
        let mut m = self.import_paths.lock().unwrap();
        m.retain(|_, t| t.elapsed() < IMPORT_PATH_TTL);
        m.insert(path, Instant::now());
    }

    /// The path of a file picked by the user (its permission is renewed), or the reason it is refused.
    fn check_import_path(&self, path: &str) -> Result<PathBuf, String> {
        let path = PathBuf::from(path);
        let mut m = self.import_paths.lock().unwrap();
        m.retain(|_, t| t.elapsed() < IMPORT_PATH_TTL);
        match m.get_mut(&path) {
            Some(t) => {
                *t = Instant::now();
                Ok(path)
            }
            None => Err(format!(
                "Refusing to read {}: import files must be chosen in the open dialog (choose_import_file)",
                path.display()
            )),
        }
    }

    /// `<folder of the file>/<name of the file>_errors.txt`: where the rows that fail are written unless the user
    /// picks another place.
    pub fn default_error_file(path: &Path) -> PathBuf {
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "import".into());
        path.with_file_name(format!("{stem}_errors.txt"))
    }

    pub async fn import_preview(
        &self,
        path: &str,
        format: ImportFormat,
        limit: usize,
    ) -> Result<ImportPreview, String> {
        let path = self.check_import_path(path)?;
        blocking(move || dbcore::import::preview(&path, &format, limit).map_err(String::from)).await
    }

    /// Runs the import; `import_id` (chosen by the caller, unique per import) lets
    /// [`cancel_import`](Self::cancel_import) stop it. The id is registered before anything else happens, so a
    /// cancel cannot slip between the call and the start; an id that is running already is refused.
    pub async fn import_file(
        &self,
        ds_id: &str,
        import_id: &str,
        mut req: ImportRequest,
        progress: impl Fn(ImportProgress) + Send + Sync,
    ) -> Result<ImportResult, String> {
        let token = CancellationToken::new();
        {
            let mut imports = self.imports.lock().unwrap();
            if imports.contains_key(import_id) {
                return Err(format!("The import id {import_id} is in use already"));
            }
            imports.insert(import_id.to_string(), token.clone());
            let mut early = self.early_cancels.lock().unwrap();
            early.retain(|_, t| t.elapsed() < EARLY_CANCEL_TTL);
            if early.remove(import_id).is_some() {
                token.cancel();
            }
        }
        // removes the registration however this function ends
        struct Registered<'a>(&'a Mutex<HashMap<String, CancellationToken>>, &'a str);
        impl Drop for Registered<'_> {
            fn drop(&mut self) {
                self.0.lock().unwrap().remove(self.1);
            }
        }
        let _registered = Registered(&self.imports, import_id);

        req.path = self.check_import_path(&req.path.to_string_lossy())?;
        if let Some(p) = req.options.error_file.clone() {
            // the default place (never replaces a file), or a file the user picked in a save dialog
            if p != Self::default_error_file(&req.path) {
                let target = self.take_export_path(&p)?;
                req.options.error_file = Some(target.path);
                req.options.error_file_replace = target.replace;
            } else {
                req.options.error_file_replace = false;
            }
        }
        let res = self.mgr.import_file(ds_id, &req, &token, &progress).await;
        res.map_err(String::from)
    }

    /// Rolls a running import back. An id that is not running (yet) is remembered for a few seconds, so a cancel
    /// that overtakes its `import_file` still stops it; a no-op once the import ended.
    pub fn cancel_import(&self, import_id: &str) {
        // the `imports` lock is held while the id is noted, as in `import_file`: no gap to fall into
        let imports = self.imports.lock().unwrap();
        if let Some(t) = imports.get(import_id) {
            t.cancel();
            return;
        }
        let mut early = self.early_cancels.lock().unwrap();
        early.retain(|_, t| t.elapsed() < EARLY_CANCEL_TTL);
        if early.len() < 64 {
            early.insert(import_id.to_string(), Instant::now());
        }
    }

    // ------------------------------------------------------------ SQL dump

    /// Dumps the objects of `schema` to `path` (a path from [`allow_export_path`](Self::allow_export_path), once).
    /// `dump_id` (unique per dump) lets [`cancel_dump`](Self::cancel_dump) stop it. A cancelled or failed dump
    /// leaves no file behind; `progress` gets one event per phase and per data batch.
    pub async fn dump_schema(
        &self,
        ds_id: &str,
        schema: &str,
        opts: DumpOptions,
        dump_id: &str,
        path: &Path,
        progress: impl Fn(DumpProgress) + Send + Sync,
    ) -> Result<DumpResult, String> {
        let token = CancellationToken::new();
        {
            // the `dumps` lock is held while the id is registered, as in `import_file`
            let mut dumps = self.dumps.lock().unwrap();
            if dumps.contains_key(dump_id) {
                return Err(format!("The dump id {dump_id} is in use already"));
            }
            dumps.insert(dump_id.to_string(), token.clone());
            let mut early = self.early_cancels.lock().unwrap();
            early.retain(|_, t| t.elapsed() < EARLY_CANCEL_TTL);
            if early.remove(dump_id).is_some() {
                token.cancel();
            }
        }
        // removes the registration however this function ends
        struct Registered<'a>(&'a Mutex<HashMap<String, CancellationToken>>, &'a str);
        impl Drop for Registered<'_> {
            fn drop(&mut self) {
                self.0.lock().unwrap().remove(self.1);
            }
        }
        let _registered = Registered(&self.dumps, dump_id);

        let target = self.take_export_path(path)?;
        let (file, part) = target.create_part()?;
        // `file` is moved into the dump and closed when it returns, so the part can be moved or removed on Windows too
        let res = self
            .mgr
            .dump_schema(ds_id, schema, &opts, &token, &progress, file)
            .await
            .map_err(String::from);
        match res {
            Ok(r) if !r.cancelled => {
                target.commit(part)?;
                let mut dumped = self.dumped.lock().unwrap();
                dumped.push(target.path.clone());
                let excess = dumped.len().saturating_sub(DUMPS_KEPT);
                dumped.drain(..excess);
                Ok(r)
            }
            // a cancelled or failed dump: `part` is removed when it goes out of scope, the target stays as it was
            other => other,
        }
    }

    /// Rolls a running dump back (its file is removed). Like [`cancel_import`](Self::cancel_import), an id that is
    /// not running (yet) is remembered for a few seconds; a no-op once the dump ended.
    pub fn cancel_dump(&self, dump_id: &str) {
        let dumps = self.dumps.lock().unwrap();
        if let Some(t) = dumps.get(dump_id) {
            t.cancel();
            return;
        }
        let mut early = self.early_cancels.lock().unwrap();
        early.retain(|_, t| t.elapsed() < EARLY_CANCEL_TTL);
        if early.len() < 64 {
            early.insert(dump_id.to_string(), Instant::now());
        }
    }

    /// The folder of a file that a finished dump of this session wrote (the "Open Folder" action of its
    /// notification). Any other path is refused.
    pub fn dump_folder(&self, path: &str) -> Result<PathBuf, String> {
        let dumped = self.dumped.lock().unwrap();
        dumped
            .iter()
            .find(|p| p.as_path() == Path::new(path))
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .ok_or_else(|| format!("Refusing to open the folder of {path}: no SQL dump of this session wrote that file"))
    }

    // ------------------------------------------------------------ SQL scripts

    /// Runs the script file `path` on a data source. `path` must be a file the user granted (opened in the open
    /// dialog, or inside an attached folder, see `files.rs`). `script_id` (unique per run) lets
    /// [`cancel_script`](Self::cancel_script) stop it. Like `dump_schema`, the id is registered before anything else
    /// happens, so a cancel cannot slip in between.
    pub async fn run_sql_file(
        &self,
        ds_id: &str,
        script_id: &str,
        schema: Option<&str>,
        path: &str,
        opts: ScriptOptions,
        progress: impl FnMut(ScriptProgress),
    ) -> Result<ScriptSummary, String> {
        let token = CancellationToken::new();
        {
            // the `scripts` lock is held while the id is registered, as in `dump_schema`
            let mut scripts = self.scripts.lock().unwrap();
            if scripts.contains_key(script_id) {
                return Err(format!("The script id {script_id} is in use already"));
            }
            scripts.insert(script_id.to_string(), token.clone());
            let mut early = self.early_cancels.lock().unwrap();
            early.retain(|_, t| t.elapsed() < EARLY_CANCEL_TTL);
            if early.remove(script_id).is_some() {
                token.cancel();
            }
        }
        // removes the registration however this function ends
        struct Registered<'a>(&'a Mutex<HashMap<String, CancellationToken>>, &'a str);
        impl Drop for Registered<'_> {
            fn drop(&mut self) {
                self.0.lock().unwrap().remove(self.1);
            }
        }
        let _registered = Registered(&self.scripts, script_id);

        let path = self.files.resolve(path)?;
        self.mgr
            .run_sql_file(ds_id, schema, &path, &opts, &token, progress)
            .await
            .map_err(String::from)
    }

    /// Stops a running script: the statement in progress is interrupted and the rest is not run. Like
    /// [`cancel_dump`](Self::cancel_dump), an id that is not running (yet) is remembered for a few seconds; a no-op
    /// once the script ended.
    pub fn cancel_script(&self, script_id: &str) {
        let scripts = self.scripts.lock().unwrap();
        if let Some(t) = scripts.get(script_id) {
            t.cancel();
            return;
        }
        let mut early = self.early_cancels.lock().unwrap();
        early.retain(|_, t| t.elapsed() < EARLY_CANCEL_TTL);
        if early.len() < 64 {
            early.insert(script_id.to_string(), Instant::now());
        }
    }

    // ------------------------------------------------------------ splitter

    pub fn split_statements(&self, sql: &str, driver: Driver) -> Vec<Statement> {
        dbcore::split_statements(sql, driver)
    }

    pub fn statement_at(&self, sql: &str, caret_utf16: usize, driver: Driver) -> Option<Statement> {
        dbcore::statement_at_utf16(sql, caret_utf16, driver)
    }

    // ------------------------------------------------------------ history

    pub async fn history_list(
        &self,
        ds_id: Option<String>,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>, String> {
        let h = self.history.clone();
        blocking(move || {
            h.list(ds_id.as_deref(), offset, limit)
                .map_err(String::from)
        })
        .await
    }

    pub async fn history_search(
        &self,
        text: String,
        ds_id: Option<String>,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>, String> {
        let h = self.history.clone();
        blocking(move || {
            h.search(&text, ds_id.as_deref(), limit)
                .map_err(String::from)
        })
        .await
    }

    pub async fn history_clear(&self) -> Result<(), String> {
        let h = self.history.clone();
        blocking(move || h.clear().map_err(String::from)).await
    }

    // ------------------------------------------------------------ ui state

    pub fn get_ui_state(&self, key: &str) -> Option<Value> {
        self.ui.get(key)
    }

    pub fn set_ui_state(&self, key: String, value: Value) {
        self.ui.set(key, value);
    }

    pub async fn flush_ui_state(&self) -> Result<(), String> {
        let ui = self.ui.clone();
        blocking(move || ui.flush()).await
    }

    // ------------------------------------------------------------ consoles

    pub async fn list_consoles(&self, ds_id: &str) -> Result<Vec<String>, String> {
        let (c, ds) = (self.consoles.clone(), ds_id.to_string());
        blocking(move || c.list(&ds)).await
    }

    pub async fn read_console(&self, ds_id: &str, name: &str) -> Result<String, String> {
        let (c, ds, n) = (self.consoles.clone(), ds_id.to_string(), name.to_string());
        blocking(move || c.read(&ds, &n)).await
    }

    pub async fn write_console(&self, ds_id: &str, name: &str, text: String) -> Result<(), String> {
        let (c, ds, n) = (self.consoles.clone(), ds_id.to_string(), name.to_string());
        blocking(move || c.write(&ds, &n, &text)).await
    }

    pub async fn create_console(&self, ds_id: &str) -> Result<String, String> {
        let (c, ds) = (self.consoles.clone(), ds_id.to_string());
        blocking(move || c.create(&ds)).await
    }

    pub async fn delete_console(&self, ds_id: &str, name: &str) -> Result<(), String> {
        let (c, ds, n) = (self.consoles.clone(), ds_id.to_string(), name.to_string());
        blocking(move || c.delete(&ds, &n)).await
    }

    pub async fn rename_console(&self, ds_id: &str, from: &str, to: &str) -> Result<(), String> {
        let (c, ds, a, b) = (
            self.consoles.clone(),
            ds_id.to_string(),
            from.to_string(),
            to.to_string(),
        );
        blocking(move || c.rename(&ds, &a, &b)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let s = AppState::open(dir.path().join("config"), dir.path().join("data")).unwrap();
        (s, dir)
    }

    #[test]
    fn errors_do_not_show_the_password_of_an_oracle_thin_url() {
        let cfg = DataSourceConfig {
            driver: dbcore::Driver::Oracle,
            url_override: Some("jdbc:oracle:thin:scott/p@ss@db:1521/svc".into()),
            ..Default::default()
        };
        let m = redact_for(&cfg, "cannot parse jdbc:oracle:thin:scott/p@ss@db:1521/svc");
        assert_eq!(m, "cannot parse jdbc:oracle:thin:scott/***@db:1521/svc");
    }

    #[test]
    fn a_cancel_before_the_import_is_remembered_and_applied() {
        let (s, _dir) = state();
        s.cancel_import("early");
        assert!(s.early_cancels.lock().unwrap().contains_key("early"));
        // `import_file` registers the token first and consumes the early cancel
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let req: ImportRequest = serde_json::from_value(serde_json::json!({
            "path": "/nonexistent.csv", "table": "t", "createTable": false, "columns": []
        }))
        .unwrap();
        let err = rt
            .block_on(s.import_file("ds", "early", req, |_| {}))
            .unwrap_err();
        assert!(err.contains("Refusing to read"), "{err}");
        assert!(s.early_cancels.lock().unwrap().is_empty());
        // the registration is gone again, whatever the outcome
        assert!(s.imports.lock().unwrap().is_empty());
    }

    #[test]
    fn a_running_import_id_is_refused_and_cancelled_by_id() {
        let (s, _dir) = state();
        let token = CancellationToken::new();
        s.imports
            .lock()
            .unwrap()
            .insert("run".into(), token.clone());
        s.cancel_import("run");
        assert!(token.is_cancelled());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let req: ImportRequest = serde_json::from_value(serde_json::json!({
            "path": "/x.csv", "table": "t", "createTable": false, "columns": []
        }))
        .unwrap();
        let err = rt
            .block_on(s.import_file("ds", "run", req, |_| {}))
            .unwrap_err();
        assert!(err.contains("in use already"), "{err}");
        // the refused call did not drop the first import's registration
        assert!(s.imports.lock().unwrap().contains_key("run"));
    }

    #[test]
    fn a_script_runs_only_from_a_granted_file_and_leaves_no_registration() {
        let (s, dir) = state();
        let script = dir.path().join("dump.sql");
        std::fs::write(&script, "select 1;").unwrap();
        let rt = runtime();
        // not granted: refused before anything connects
        let path = script.display().to_string();
        let err = rt
            .block_on(s.run_sql_file("ds", "s1", None, &path, Default::default(), |_| {}))
            .unwrap_err();
        assert!(err.contains("Refusing"), "{err}");
        assert!(s.scripts.lock().unwrap().is_empty());
        // granted, but the data source is not connected
        s.files.approve_file(&script).unwrap();
        let path = script.display().to_string();
        let err = rt
            .block_on(s.run_sql_file("ds", "s2", None, &path, Default::default(), |_| {}))
            .unwrap_err();
        assert!(err.contains("not connected"), "{err}");
        assert!(s.scripts.lock().unwrap().is_empty());
    }

    #[test]
    fn a_cancel_before_the_script_is_remembered_and_applied() {
        let (s, dir) = state();
        let rt = runtime();
        let cfg = DataSourceConfig {
            id: "lite".into(),
            name: "lite".into(),
            driver: dbcore::Driver::Sqlite,
            file: dir.path().join("db.sqlite").display().to_string(),
            options: [("create".to_string(), "true".to_string())].into(),
            ..Default::default()
        };
        rt.block_on(s.mgr.connect(&cfg)).unwrap();
        let script = dir.path().join("late.sql");
        std::fs::write(&script, "create table t (a integer);\n").unwrap();
        s.files.approve_file(&script).unwrap();
        // the cancel overtakes the run: the run starts already cancelled and runs nothing
        s.cancel_script("early");
        assert!(s.early_cancels.lock().unwrap().contains_key("early"));
        let path = script.display().to_string();
        let sum = rt
            .block_on(s.run_sql_file("lite", "early", None, &path, Default::default(), |_| {}))
            .unwrap();
        assert!(sum.cancelled);
        assert_eq!(sum.ok, 0);
        assert!(s.early_cancels.lock().unwrap().is_empty());
        assert!(s.scripts.lock().unwrap().is_empty());
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// One column, two rows: `café` (in Windows-1252) and `中` (not in it).
    fn accented_result() -> ResultSet {
        serde_json::from_value(serde_json::json!({
            "columns": [{ "name": "name", "typeName": "text", "nullable": true, "isPk": false }],
            "rows": [["café"], ["中"]],
            "hasMore": false,
            "totalHint": null
        }))
        .unwrap()
    }

    #[test]
    fn a_cancel_before_the_export_is_remembered_and_applied() {
        let (s, dir) = state();
        s.cancel_export("early-export");
        assert!(s.early_cancels.lock().unwrap().contains_key("early-export"));
        let path = dir.path().join("out.csv");
        s.allow_export_path(path.clone());
        let err = runtime()
            .block_on(s.export_result_with(
                accented_result(),
                ExportOptions::default(),
                path.clone(),
                Some("early-export"),
                |_| {},
            ))
            .unwrap_err();
        assert!(err.contains("cancelled"), "{err}");
        assert!(!path.exists(), "a cancelled export leaves no file behind");
        assert!(s.early_cancels.lock().unwrap().is_empty());
        assert!(s.exports.lock().unwrap().is_empty());
    }

    #[test]
    fn a_running_export_is_cancelled_by_id_and_its_id_is_refused_meanwhile() {
        let (s, dir) = state();
        let token = CancellationToken::new();
        s.exports
            .lock()
            .unwrap()
            .insert("run-export".into(), token.clone());
        s.cancel_export("run-export");
        assert!(token.is_cancelled());
        let err = runtime()
            .block_on(s.export_result_with(
                accented_result(),
                ExportOptions::default(),
                dir.path().join("x.csv"),
                Some("run-export"),
                |_| {},
            ))
            .unwrap_err();
        assert!(err.contains("in use already"), "{err}");
        // the refused call did not drop the first export's registration
        assert!(s.exports.lock().unwrap().contains_key("run-export"));
    }

    #[test]
    fn a_windows_1252_export_reports_the_characters_it_replaced() {
        let (s, dir) = state();
        let path = dir.path().join("out.csv");
        s.allow_export_path(path.clone());
        let opts = ExportOptions {
            encoding: dbcore::ExportEncoding::Windows1252,
            ..ExportOptions::default()
        };
        let report = runtime()
            .block_on(s.export_result_with(
                accented_result(),
                opts,
                path.clone(),
                Some("cp1252"),
                |_| {},
            ))
            .unwrap();
        assert_eq!((report.rows, report.unmappable), (2, 1));
        assert_eq!(std::fs::read(&path).unwrap(), b"name\ncaf\xe9\n?\n");
        // the registration ends with the export
        assert!(s.exports.lock().unwrap().is_empty());
    }

    // ---------------------------------------------------------------- SQL dump

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// Connects a SQLite file in `dir` (id `lite`) and creates two tables with one row each.
    async fn lite_with_tables(s: &AppState, dir: &tempfile::TempDir) {
        let cfg = DataSourceConfig {
            id: "lite".into(),
            name: "lite".into(),
            driver: Driver::Sqlite,
            file: dir.path().join("src.db").display().to_string(),
            options: [("create".to_string(), "true".to_string())].into(),
            ..Default::default()
        };
        s.mgr.connect(&cfg).await.unwrap();
        let sid = s.mgr.open_session("lite").await.unwrap();
        s.mgr
            .execute_collect(
                &sid,
                "create table t (id integer primary key, name text); insert into t values (1, 'a'); \
                 create table u (id integer primary key); insert into u values (7);",
                ExecOptions {
                    max_rows: 10,
                    stop_on_error: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        s.mgr.close_session(&sid).await;
    }

    #[test]
    fn a_dump_writes_the_granted_file_and_keeps_it() {
        let (s, dir) = state();
        rt().block_on(async {
            lite_with_tables(&s, &dir).await;
            let out = dir.path().join("out.sql");
            s.allow_export_path(out.clone());
            let res = s
                .dump_schema("lite", "main", DumpOptions::default(), "d1", &out, |_| {})
                .await
                .unwrap();
            assert_eq!((res.tables, res.rows, res.cancelled), (2, 2, false));
            let text = std::fs::read_to_string(&out).unwrap();
            assert!(text.contains("CREATE TABLE t ("), "{text}");
            // the folder of the file is the one "Open Folder" opens
            assert_eq!(
                s.dump_folder(&out.display().to_string()).unwrap(),
                dir.path().to_path_buf()
            );
            // no registration is left behind
            assert!(s.dumps.lock().unwrap().is_empty());
            // the grant is used up: a second dump to the same path is refused
            let err = s
                .dump_schema("lite", "main", DumpOptions::default(), "d2", &out, |_| {})
                .await
                .unwrap_err();
            assert!(err.contains("Refusing to write"), "{err}");
        });
    }

    #[test]
    fn a_dump_to_a_path_nobody_chose_is_refused_and_writes_nothing() {
        let (s, dir) = state();
        rt().block_on(async {
            lite_with_tables(&s, &dir).await;
            let out = dir.path().join("typed.sql");
            let err = s
                .dump_schema("lite", "main", DumpOptions::default(), "d3", &out, |_| {})
                .await
                .unwrap_err();
            assert!(err.contains("Refusing to write"), "{err}");
            assert!(!out.exists());
            assert!(s.dumps.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn a_running_dump_id_is_refused_and_the_running_one_stays_registered() {
        let (s, dir) = state();
        s.dumps
            .lock()
            .unwrap()
            .insert("run".into(), CancellationToken::new());
        let out = dir.path().join("second.sql");
        s.allow_export_path(out.clone());
        let err = rt()
            .block_on(s.dump_schema("lite", "main", DumpOptions::default(), "run", &out, |_| {}))
            .unwrap_err();
        assert!(err.contains("in use already"), "{err}");
        assert!(s.dumps.lock().unwrap().contains_key("run"));
        // the refused call did not consume the grant
        assert!(s.export_paths.lock().unwrap().contains_key(&out));
    }

    #[test]
    fn a_cancel_that_overtakes_the_dump_stops_it_and_removes_the_file() {
        let (s, dir) = state();
        rt().block_on(async {
            lite_with_tables(&s, &dir).await;
            s.cancel_dump("early");
            let out = dir.path().join("early.sql");
            s.allow_export_path(out.clone());
            let res = s
                .dump_schema(
                    "lite",
                    "main",
                    DumpOptions::default(),
                    "early",
                    &out,
                    |_| {},
                )
                .await
                .unwrap();
            assert!(res.cancelled, "{res:?}");
            assert!(!out.exists());
            assert!(s.early_cancels.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn a_cancel_during_the_dump_stops_it_and_removes_the_file() {
        let (s, dir) = state();
        rt().block_on(async {
            lite_with_tables(&s, &dir).await;
            let out = dir.path().join("running.sql");
            s.allow_export_path(out.clone());
            // cancel as soon as the first table is written: the second table is not dumped
            let res = s
                .dump_schema("lite", "main", DumpOptions::default(), "run2", &out, |p| {
                    if p.phase == "tables" && p.tables_done == 1 {
                        s.cancel_dump("run2");
                    }
                })
                .await
                .unwrap();
            assert!(res.cancelled, "{res:?}");
            assert!(res.tables < 2, "{res:?}");
            assert!(!out.exists());
            assert!(s.dumps.lock().unwrap().is_empty());
            // the folder of a cancelled dump is not offered
            assert!(s.dump_folder(&out.display().to_string()).is_err());
        });
    }

    #[test]
    fn a_failed_dump_removes_its_file() {
        let (s, dir) = state();
        rt().block_on(async {
            lite_with_tables(&s, &dir).await;
            let out = dir.path().join("failed.sql");
            s.allow_export_path(out.clone());
            // no data source of that id: the dump fails before it writes anything
            assert!(s
                .dump_schema("nope", "main", DumpOptions::default(), "d4", &out, |_| {})
                .await
                .is_err());
            assert!(!out.exists());
            assert!(s.dumps.lock().unwrap().is_empty());
        });
    }

    /// What is in `dir` besides the files named in `known` (leftover `.part` files show up here).
    fn strays(dir: &Path, known: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !known.contains(&n.as_str()))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn a_cancelled_or_failed_dump_leaves_the_file_it_was_to_replace_alone() {
        let (s, dir) = state();
        rt().block_on(async {
            lite_with_tables(&s, &dir).await;
            let out = dir.path().join("keep.sql");
            std::fs::write(&out, "ORIGINAL").unwrap();
            // the user confirmed replacing it in the save dialog; the dump is cancelled before it starts
            s.cancel_dump("c1");
            s.allow_export_path(out.clone());
            let res = s
                .dump_schema("lite", "main", DumpOptions::default(), "c1", &out, |_| {})
                .await
                .unwrap();
            assert!(res.cancelled);
            assert_eq!(std::fs::read_to_string(&out).unwrap(), "ORIGINAL");
            // a failing dump
            s.allow_export_path(out.clone());
            assert!(s
                .dump_schema("nope", "main", DumpOptions::default(), "c2", &out, |_| {})
                .await
                .is_err());
            assert_eq!(std::fs::read_to_string(&out).unwrap(), "ORIGINAL");
            assert_eq!(
                strays(dir.path(), &["keep.sql", "src.db", "config", "data"]),
                Vec::<String>::new()
            );
            // a dump that finishes replaces it
            s.allow_export_path(out.clone());
            s.dump_schema("lite", "main", DumpOptions::default(), "c3", &out, |_| {})
                .await
                .unwrap();
            assert!(std::fs::read_to_string(&out)
                .unwrap()
                .contains("CREATE TABLE t ("));
            assert_eq!(
                strays(dir.path(), &["keep.sql", "src.db", "config", "data"]),
                Vec::<String>::new()
            );
        });
    }

    #[test]
    fn a_cancelled_or_failed_export_leaves_the_file_it_was_to_replace_alone() {
        let (s, dir) = state();
        rt().block_on(async {
            lite_with_tables(&s, &dir).await;
            let out = dir.path().join("keep.csv");
            std::fs::write(&out, "ORIGINAL").unwrap();
            let known = ["keep.csv", "src.db", "config", "data"];
            let opts = dbcore::ExportOptions::default();
            // cancelled before it starts
            s.cancel_export("e1");
            s.allow_export_path(out.clone());
            let err = s
                .export_query_with(
                    "lite",
                    "select * from t",
                    opts.clone(),
                    &out,
                    Some("e1"),
                    |_| {},
                )
                .await
                .unwrap_err();
            assert!(err.to_lowercase().contains("cancel"), "{err}");
            assert_eq!(std::fs::read_to_string(&out).unwrap(), "ORIGINAL");
            // a statement that fails
            s.allow_export_path(out.clone());
            assert!(s
                .export_query_with(
                    "lite",
                    "select * from nope",
                    opts.clone(),
                    &out,
                    None,
                    |_| {}
                )
                .await
                .is_err());
            assert_eq!(std::fs::read_to_string(&out).unwrap(), "ORIGINAL");
            // the same for an in-memory result
            s.cancel_export("e2");
            s.allow_export_path(out.clone());
            let rs = dbcore::ResultSet {
                columns: vec![dbcore::ColumnMeta {
                    name: "a".into(),
                    type_name: "text".into(),
                    nullable: true,
                    is_pk: false,
                    table_ref: None,
                }],
                rows: vec![vec![serde_json::json!(1)]],
                ..Default::default()
            };
            assert!(s
                .export_result_with(rs.clone(), opts.clone(), out.clone(), Some("e2"), |_| {})
                .await
                .is_err());
            assert_eq!(std::fs::read_to_string(&out).unwrap(), "ORIGINAL");
            assert_eq!(strays(dir.path(), &known), Vec::<String>::new());
            // one that finishes replaces it, and leaves nothing else behind
            s.allow_export_path(out.clone());
            let n = s
                .export_query_with("lite", "select * from t", opts.clone(), &out, None, |_| {})
                .await
                .unwrap()
                .rows;
            assert_eq!(n, 1);
            assert_eq!(std::fs::read_to_string(&out).unwrap(), "id,name\n1,a\n");
            assert_eq!(strays(dir.path(), &known), Vec::<String>::new());
            // a typed path is a new file: written once, never over an existing one
            let typed = dir.path().join("typed.csv");
            s.allow_typed_export_path(typed.clone(), typed.clone());
            s.export_query_with(
                "lite",
                "select * from t",
                opts.clone(),
                &typed,
                None,
                |_| {},
            )
            .await
            .unwrap();
            assert!(typed.exists());
            s.allow_typed_export_path(typed.clone(), typed.clone());
            let err = s
                .export_query_with("lite", "select * from u", opts, &typed, None, |_| {})
                .await
                .unwrap_err();
            assert!(err.contains("exists already"), "{err}");
            assert_eq!(std::fs::read_to_string(&typed).unwrap(), "id,name\n1,a\n");
            assert_eq!(
                strays(
                    dir.path(),
                    &["keep.csv", "typed.csv", "src.db", "config", "data"]
                ),
                Vec::<String>::new()
            );
        });
    }

    #[test]
    fn open_dump_folder_opens_only_the_folder_of_a_finished_dump() {
        let (s, dir) = state();
        let out = dir.path().join("mine.sql");
        assert!(s.dump_folder(&out.display().to_string()).is_err());
        s.dumped.lock().unwrap().push(out.clone());
        assert_eq!(
            s.dump_folder(&out.display().to_string()).unwrap(),
            dir.path().to_path_buf()
        );
        // another file in the same folder is not a dump of this session
        let other = dir.path().join("other.sql");
        assert!(s.dump_folder(&other.display().to_string()).is_err());
    }
}
