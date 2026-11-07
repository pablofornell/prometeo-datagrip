//! Application state and the command logic behind `commands.rs`.
//!
//! Everything here is plain async Rust without a Tauri dependency, so it can be tested
//! without a webview (see `tests/`). `commands.rs` only adapts arguments and the
//! `tauri::ipc::Channel`.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dbcore::import::CancellationToken;
use dbcore::{
    export_result, export_to_string, ApplyResult, ConnectInfo, ConnectionManager, DataSourceConfig,
    Driver, ExecEvent, ExecOptions, ExecutionId, ExplainPlan, ExportOptions, FetchedRows,
    HistoryEntry, ImportFormat, ImportPreview, ImportProgress, ImportRequest, ImportResult,
    ObjectRef, QueryHistory, ResultSet, RowChange, SessionId, SessionState, SnapshotObject,
    Statement, TableDataRequest, TestResult, TreeNode, TxStatus,
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
    /// Where new passwords are stored: the OS keyring when reachable, otherwise the JSON file.
    pub password_storage: PasswordStorage,
    /// Files that were corrupt at startup and set aside (`<file>.corrupt-<ts>`); the app started with an
    /// empty one. Show them once. Empty in the normal case.
    pub startup_warnings: Vec<StartupNotice>,
}

/// How long a path chosen in the save dialog stays valid for `export_query` / `export_result`.
const EXPORT_PATH_TTL: Duration = Duration::from_secs(300);

/// How long a `cancel_import` for an unknown id waits for its `import_file`.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(30);

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
    /// import id -> when `cancel_import` named it before `import_file` registered it (see [`AppState::cancel_import`]).
    early_cancels: Mutex<HashMap<String, Instant>>,
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
            early_cancels: Mutex::new(HashMap::new()),
        })
    }

    pub async fn app_info(&self) -> Result<AppInfo, String> {
        let sources = self.sources.clone();
        let password_storage = blocking(move || Ok(sources.default_storage())).await?;
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

    /// Stream every row of `sql` to `path` (a path from [`allow_export_path`](Self::allow_export_path)).
    /// Returns the number of rows written.
    pub async fn export_query(
        &self,
        ds_id: &str,
        sql: &str,
        opts: ExportOptions,
        path: &Path,
    ) -> Result<usize, String> {
        let target = self.take_export_path(path)?;
        let path = target.path.as_path();
        let file = target.create()?;
        let mut w = BufWriter::new(file);
        let res = self.mgr.export_query(ds_id, sql, &opts, &mut w).await;
        let res = res
            .map_err(String::from)
            .and_then(|n| w.flush().map(|_| n).map_err(|e| format!("I/O error: {e}")));
        if res.is_err() {
            drop(w);
            let _ = std::fs::remove_file(path);
        }
        res
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
        let target = self.take_export_path(&path)?;
        blocking(move || {
            let file = target.create()?;
            let mut w = BufWriter::new(file);
            let n = export_result(&rs, &opts, &mut w).map_err(String::from)?;
            w.flush().map_err(|e| format!("I/O error: {e}"))?;
            Ok(n)
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
}
