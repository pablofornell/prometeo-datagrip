//! On-disk stores of the app: data sources (+ passwords), generic UI state and console files.
//!
//! * `<config_dir>/data-sources.json`: data sources. Passwords live in the OS keyring (Secret
//!   Service on Linux) under service `dev.prometeo.datagrip`; when the keyring is not reachable
//!   the password is stored in the JSON file and the data source is flagged
//!   `passwordStorage: "file"`.
//! * `<config_dir>/ui-state.json`: `{ key: any json }`, written debounced.
//! * `<data_dir>/consoles/<dsId>/<name>.sql`: per data source console files.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dbcore::DataSourceConfig;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

/// Write `bytes` to `path` through a temp file + rename, so a crash never leaves half a file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Cannot replace {}: {e}", path.display())
    })
}

// ====================================================================== secrets

/// Where a data source password is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PasswordStorage {
    #[default]
    Keyring,
    File,
}

/// Secret storage backend (the OS keyring; replaceable in tests).
pub trait SecretStore: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&self, id: &str, password: &str) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

/// The OS keyring through the `keyring` crate.
pub struct OsKeyring;

const KEYRING_SERVICE: &str = "dev.prometeo.datagrip";

impl OsKeyring {
    fn entry(id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, &format!("data-source:{id}")).map_err(|e| e.to_string())
    }
}

impl SecretStore for OsKeyring {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match Self::entry(id)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, id: &str, password: &str) -> Result<(), String> {
        Self::entry(id)?.set_password(password).map_err(|e| e.to_string())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Always unavailable: passwords go to the JSON file (`PROMETEO_NO_KEYRING=1`, tests).
pub struct NoKeyring;

impl SecretStore for NoKeyring {
    fn get(&self, _: &str) -> Result<Option<String>, String> {
        Err("keyring disabled".into())
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("keyring disabled".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("keyring disabled".into())
    }
}

// ====================================================================== data sources

/// A data source as written to `data-sources.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDs {
    #[serde(flatten)]
    cfg: DataSourceConfig,
    #[serde(default)]
    password_storage: PasswordStorage,
    #[serde(default)]
    has_password: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcesFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    data_sources: Vec<StoredDs>,
}

/// What the UI gets: the config without password, plus password flags.
#[derive(Debug, Clone)]
pub struct DataSourceView {
    pub cfg: DataSourceConfig,
    pub has_password: bool,
    pub password_storage: PasswordStorage,
}

impl Serialize for DataSourceView {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::Error;
        let mut v = serde_json::to_value(&self.cfg).map_err(S::Error::custom)?;
        let m = v.as_object_mut().ok_or_else(|| S::Error::custom("data source is not an object"))?;
        m.remove("password");
        m.insert("hasPassword".into(), self.has_password.into());
        m.insert("passwordStorage".into(), serde_json::to_value(self.password_storage).map_err(S::Error::custom)?);
        v.serialize(s)
    }
}

impl From<&StoredDs> for DataSourceView {
    fn from(s: &StoredDs) -> Self {
        let mut cfg = s.cfg.clone();
        cfg.password = None;
        DataSourceView { cfg, has_password: s.has_password, password_storage: s.password_storage }
    }
}

const KEYRING_UNKNOWN: u8 = 0;
const KEYRING_OK: u8 = 1;
const KEYRING_DOWN: u8 = 2;

pub struct DataSourceStore {
    path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    keyring: AtomicU8,
    items: Mutex<Vec<StoredDs>>,
}

impl DataSourceStore {
    pub fn load(path: PathBuf, secrets: Arc<dyn SecretStore>) -> Result<Self, String> {
        let items = match fs::read(&path) {
            Ok(b) => serde_json::from_slice::<SourcesFile>(&b)
                .map_err(|e| format!("{} is not valid: {e}", path.display()))?
                .data_sources,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
        };
        Ok(DataSourceStore { path, secrets, keyring: AtomicU8::new(KEYRING_UNKNOWN), items: Mutex::new(items) })
    }

    /// Whether new passwords go to the OS keyring (probed once, on first use).
    pub fn keyring_available(&self) -> bool {
        match self.keyring.load(Ordering::Relaxed) {
            KEYRING_OK => true,
            KEYRING_DOWN => false,
            _ => {
                let ok = self.secrets.get("__probe__").is_ok();
                self.keyring.store(if ok { KEYRING_OK } else { KEYRING_DOWN }, Ordering::Relaxed);
                if !ok {
                    tracing::warn!("OS keyring not available: passwords will be stored in the data sources file");
                }
                ok
            }
        }
    }

    pub fn default_storage(&self) -> PasswordStorage {
        if self.keyring_available() {
            PasswordStorage::Keyring
        } else {
            PasswordStorage::File
        }
    }

    fn persist(&self, items: &[StoredDs]) -> Result<(), String> {
        let file = SourcesFile { version: 1, data_sources: items.to_vec() };
        let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        write_atomic(&self.path, &json)
    }

    pub fn list(&self) -> Vec<DataSourceView> {
        self.items.lock().unwrap().iter().map(DataSourceView::from).collect()
    }

    pub fn view(&self, id: &str) -> Option<DataSourceView> {
        self.items.lock().unwrap().iter().find(|s| s.cfg.id == id).map(DataSourceView::from)
    }

    /// The config with its password filled in (from the keyring or the file).
    pub fn get(&self, id: &str) -> Result<DataSourceConfig, String> {
        let stored = self
            .items
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.cfg.id == id)
            .cloned()
            .ok_or_else(|| format!("Data source '{id}' does not exist"))?;
        let mut cfg = stored.cfg;
        if stored.has_password && stored.password_storage == PasswordStorage::Keyring {
            cfg.password = self
                .secrets
                .get(id)
                .map_err(|e| format!("Cannot read the password of '{}' from the OS keyring: {e}", cfg.name))?;
        }
        Ok(cfg)
    }

    /// Fill `cfg.password` from the stored one when the caller did not provide a password
    /// (the UI never sees stored passwords, so "unchanged" is `null`).
    pub fn with_stored_password(&self, mut cfg: DataSourceConfig) -> Result<DataSourceConfig, String> {
        if cfg.password.is_none() && !cfg.id.is_empty() && self.view(&cfg.id).is_some() {
            cfg.password = self.get(&cfg.id)?.password;
        }
        Ok(cfg)
    }

    /// Insert or update. `cfg.password`: `None` keeps the stored one, `Some("")` clears it,
    /// anything else replaces it.
    pub fn save(&self, mut cfg: DataSourceConfig) -> Result<DataSourceView, String> {
        if cfg.id.trim().is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        }
        if cfg.name.trim().is_empty() {
            cfg.name = "Unnamed".into();
        }
        let new_password = cfg.password.take();
        let mut items = self.items.lock().unwrap();
        let pos = items.iter().position(|s| s.cfg.id == cfg.id);
        let (mut has_password, mut storage, kept_file_pw) = match pos {
            Some(i) => (items[i].has_password, items[i].password_storage, items[i].cfg.password.clone()),
            None => (false, self.default_storage(), None),
        };
        match new_password.as_deref() {
            None => {
                if storage == PasswordStorage::File {
                    cfg.password = kept_file_pw;
                }
            }
            Some("") => {
                if storage == PasswordStorage::Keyring {
                    let _ = self.secrets.delete(&cfg.id);
                }
                has_password = false;
            }
            Some(pw) => {
                match self.keyring_available().then(|| self.secrets.set(&cfg.id, pw)) {
                    Some(Ok(())) => storage = PasswordStorage::Keyring,
                    other => {
                        if let Some(Err(e)) = other {
                            tracing::warn!("keyring write failed ({e}); storing the password in the data sources file");
                            self.keyring.store(KEYRING_DOWN, Ordering::Relaxed);
                        }
                        storage = PasswordStorage::File;
                        cfg.password = Some(pw.to_string());
                        let _ = self.secrets.delete(&cfg.id);
                    }
                }
                has_password = true;
            }
        }
        let stored = StoredDs { cfg, password_storage: storage, has_password };
        let view = DataSourceView::from(&stored);
        match pos {
            Some(i) => items[i] = stored,
            None => items.push(stored),
        }
        self.persist(&items)?;
        Ok(view)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut items = self.items.lock().unwrap();
        let Some(i) = items.iter().position(|s| s.cfg.id == id) else { return Ok(()) };
        let removed = items.remove(i);
        if removed.password_storage == PasswordStorage::Keyring && removed.has_password {
            let _ = self.secrets.delete(id);
        }
        self.persist(&items)
    }

    /// Copy of a data source with a new id and the name "<name> 1" (or the next free number).
    pub fn duplicate(&self, id: &str) -> Result<DataSourceView, String> {
        let mut cfg = self.get(id)?;
        let names: Vec<String> = self.items.lock().unwrap().iter().map(|s| s.cfg.name.clone()).collect();
        let base = cfg.name.clone();
        let mut n = 1;
        while names.contains(&format!("{base} {n}")) {
            n += 1;
        }
        cfg.name = format!("{base} {n}");
        cfg.id = uuid::Uuid::new_v4().to_string();
        // an empty string would clear; a missing password must stay missing
        self.save(cfg)
    }
}

// ====================================================================== ui state

/// Generic key -> JSON store (`ui-state.json`) with debounced writes.
pub struct UiStateStore {
    path: PathBuf,
    map: Mutex<BTreeMap<String, Value>>,
    generation: AtomicU64,
    debounce: Duration,
}

impl UiStateStore {
    pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(400);

    pub fn load(path: PathBuf, debounce: Duration) -> Self {
        let map = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<BTreeMap<String, Value>>(&b).ok())
            .unwrap_or_default();
        UiStateStore { path, map: Mutex::new(map), generation: AtomicU64::new(0), debounce }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.map.lock().unwrap().get(key).cloned()
    }

    /// Update memory now, write the file `debounce` after the last call. Must be called
    /// from inside a tokio runtime.
    pub fn set(self: &Arc<Self>, key: String, value: Value) {
        self.map.lock().unwrap().insert(key, value);
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(me.debounce).await;
            if me.generation.load(Ordering::SeqCst) == gen {
                if let Err(e) = me.flush() {
                    tracing::warn!("cannot save ui state: {e}");
                }
            }
        });
    }

    /// Write the file now.
    pub fn flush(&self) -> Result<(), String> {
        let json = serde_json::to_vec(&*self.map.lock().unwrap()).map_err(|e| e.to_string())?;
        write_atomic(&self.path, &json)
    }
}

// ====================================================================== consoles

/// Console files, `<root>/<dsId>/<name>.sql`.
pub struct ConsoleStore {
    root: PathBuf,
}

/// Ids and file names must be a single safe path component.
fn safe_component(kind: &str, s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.len() <= 120
        && !s.starts_with('.')
        && s.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ' ' | '(' | ')' | '@'));
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid {kind} '{s}'"))
    }
}

/// Sort key: "console" first, then "console_1", "console_2", ... then the rest by name.
fn console_order(name: &str) -> (u64, String) {
    if name == "console" {
        return (0, String::new());
    }
    match name.strip_prefix("console_").and_then(|n| n.parse::<u64>().ok()) {
        Some(n) => (n, String::new()),
        None => (u64::MAX, name.to_lowercase()),
    }
}

impl ConsoleStore {
    pub fn new(root: PathBuf) -> Self {
        ConsoleStore { root }
    }

    fn dir(&self, ds_id: &str) -> Result<PathBuf, String> {
        safe_component("data source id", ds_id)?;
        Ok(self.root.join(ds_id))
    }

    fn file(&self, ds_id: &str, name: &str) -> Result<PathBuf, String> {
        safe_component("console name", name)?;
        Ok(self.dir(ds_id)?.join(format!("{name}.sql")))
    }

    pub fn list(&self, ds_id: &str) -> Result<Vec<String>, String> {
        let dir = self.dir(ds_id)?;
        let rd = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("Cannot list {}: {e}", dir.display())),
        };
        let mut names: Vec<String> = rd
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter_map(|f| f.strip_suffix(".sql").map(str::to_string))
            .collect();
        names.sort_by_key(|n| console_order(n));
        Ok(names)
    }

    pub fn read(&self, ds_id: &str, name: &str) -> Result<String, String> {
        let p = self.file(ds_id, name)?;
        fs::read_to_string(&p).map_err(|e| format!("Cannot read console '{name}': {e}"))
    }

    pub fn write(&self, ds_id: &str, name: &str, text: &str) -> Result<(), String> {
        write_atomic(&self.file(ds_id, name)?, text.as_bytes())
    }

    /// Creates an empty file named "console", then "console_1", "console_2", ...
    pub fn create(&self, ds_id: &str) -> Result<String, String> {
        let dir = self.dir(ds_id)?;
        fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
        for i in 0u32.. {
            let name = if i == 0 { "console".to_string() } else { format!("console_{i}") };
            match fs::OpenOptions::new().write(true).create_new(true).open(dir.join(format!("{name}.sql"))) {
                Ok(_) => return Ok(name),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("Cannot create console: {e}")),
            }
        }
        unreachable!()
    }

    pub fn delete(&self, ds_id: &str, name: &str) -> Result<(), String> {
        match fs::remove_file(self.file(ds_id, name)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Cannot delete console '{name}': {e}")),
        }
    }

    pub fn rename(&self, ds_id: &str, from: &str, to: &str) -> Result<(), String> {
        let (a, b) = (self.file(ds_id, from)?, self.file(ds_id, to)?);
        if b.exists() {
            return Err(format!("Console '{to}' already exists"));
        }
        fs::rename(&a, &b).map_err(|e| format!("Cannot rename console '{from}': {e}"))
    }

    /// Remove all consoles of a data source (used when the data source is deleted).
    pub fn delete_all(&self, ds_id: &str) -> Result<(), String> {
        let dir = self.dir(ds_id)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Cannot delete {}: {e}", dir.display())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// In-memory secret store.
    #[derive(Default)]
    struct MemSecrets(Mutex<HashMap<String, String>>);
    impl SecretStore for MemSecrets {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        fn set(&self, id: &str, p: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), p.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn cfg(name: &str, pw: Option<&str>) -> DataSourceConfig {
        DataSourceConfig { name: name.into(), host: "h".into(), port: 5432, password: pw.map(Into::into), ..Default::default() }
    }

    #[test]
    fn passwords_go_to_keyring_and_never_to_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let secrets = Arc::new(MemSecrets::default());
        let store = DataSourceStore::load(path.clone(), secrets.clone()).unwrap();
        let v = store.save(cfg("a", Some("s3cret"))).unwrap();
        assert_eq!((v.has_password, v.password_storage), (true, PasswordStorage::Keyring));
        let id = v.cfg.id.clone();
        assert!(!fs::read_to_string(&path).unwrap().contains("s3cret"));
        assert_eq!(store.get(&id).unwrap().password.as_deref(), Some("s3cret"));
        // the view never carries the password
        assert!(serde_json::to_value(&v).unwrap().get("password").is_none());

        // None keeps, "" clears
        let mut c = cfg("a2", None);
        c.id = id.clone();
        store.save(c.clone()).unwrap();
        assert_eq!(store.get(&id).unwrap().password.as_deref(), Some("s3cret"));
        c.password = Some(String::new());
        assert!(!store.save(c).unwrap().has_password);
        assert_eq!(store.get(&id).unwrap().password, None);

        // reload from disk
        let again = DataSourceStore::load(path, secrets).unwrap();
        assert_eq!(again.list().len(), 1);
        assert_eq!(again.list()[0].cfg.name, "a2");
    }

    #[test]
    fn falls_back_to_file_when_keyring_is_down() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let store = DataSourceStore::load(path.clone(), Arc::new(NoKeyring)).unwrap();
        assert!(!store.keyring_available());
        let v = store.save(cfg("a", Some("pw"))).unwrap();
        assert_eq!(v.password_storage, PasswordStorage::File);
        assert!(fs::read_to_string(&path).unwrap().contains("\"password\": \"pw\""));
        assert_eq!(store.get(&v.cfg.id).unwrap().password.as_deref(), Some("pw"));
        // unchanged save keeps the file password
        let mut c = cfg("a", None);
        c.id = v.cfg.id.clone();
        store.save(c).unwrap();
        assert_eq!(store.get(&v.cfg.id).unwrap().password.as_deref(), Some("pw"));
        let dup = store.duplicate(&v.cfg.id).unwrap();
        assert_eq!(dup.cfg.name, "a 1");
        assert_eq!(store.get(&dup.cfg.id).unwrap().password.as_deref(), Some("pw"));
        store.delete(&v.cfg.id).unwrap();
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn console_names_and_safety() {
        let dir = tempfile::tempdir().unwrap();
        let cs = ConsoleStore::new(dir.path().join("consoles"));
        assert!(cs.list("ds").unwrap().is_empty());
        assert_eq!(cs.create("ds").unwrap(), "console");
        assert_eq!(cs.create("ds").unwrap(), "console_1");
        assert_eq!(cs.create("ds").unwrap(), "console_2");
        for _ in 0..8 {
            cs.create("ds").unwrap();
        }
        assert_eq!(cs.list("ds").unwrap()[..3], ["console", "console_1", "console_2"]);
        assert_eq!(cs.list("ds").unwrap().last().unwrap(), "console_10");
        cs.write("ds", "console_1", "select 1;").unwrap();
        assert_eq!(cs.read("ds", "console_1").unwrap(), "select 1;");
        cs.rename("ds", "console_1", "mine").unwrap();
        assert!(cs.list("ds").unwrap().contains(&"mine".to_string()));
        assert!(cs.read("../x", "console").is_err());
        assert!(cs.read("ds", "../../etc/passwd").is_err());
        assert!(cs.write("ds", "a/b", "").is_err());
        cs.delete("ds", "mine").unwrap();
        cs.delete_all("ds").unwrap();
        assert!(cs.list("ds").unwrap().is_empty());
    }

    #[tokio::test]
    async fn ui_state_is_debounced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ui.json");
        let ui = Arc::new(UiStateStore::load(path.clone(), Duration::from_millis(60)));
        for i in 0..20 {
            ui.set("layout".into(), serde_json::json!({ "w": i }));
        }
        ui.set("other".into(), serde_json::json!("x"));
        assert_eq!(ui.get("layout").unwrap()["w"], 19);
        assert!(!path.exists(), "must not write before the debounce delay");
        tokio::time::sleep(Duration::from_millis(250)).await;
        let on_disk: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["layout"]["w"], 19);
        assert_eq!(on_disk["other"], "x");
        let reloaded = UiStateStore::load(path, Duration::from_millis(60));
        assert_eq!(reloaded.get("other").unwrap(), "x");
    }
}
