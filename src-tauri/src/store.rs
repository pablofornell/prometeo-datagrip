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
    write_atomic_mode(path, bytes, false)
}

/// [`write_atomic`] for files that may hold secrets: created with mode `0600` on Unix (the temp file is
/// created with that mode, so the content is never readable by others, not even briefly).
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_mode(path, bytes, true)
}

/// Restrict an existing file to its owner (Unix; no-op elsewhere).
pub fn restrict_to_owner(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn write_atomic_mode(path: &Path, bytes: &[u8], private: bool) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write = opts.open(&tmp).and_then(|mut f| {
        use std::io::Write;
        f.write_all(bytes)
    });
    write.map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    if private {
        // a leftover temp file of an earlier run keeps its old mode
        restrict_to_owner(&tmp);
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Cannot replace {}: {e}", path.display())
    })
}

// ====================================================================== startup notices

/// Something the app repaired while starting (a corrupt file that was set aside). The UI shows these once.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupNotice {
    /// The file name inside the config directory (`data-sources.json`, `ui-state.json`).
    pub file: String,
    /// Human readable, ends with where the bad file went.
    pub message: String,
    /// Full path of the backup (`<file>.corrupt-<unix seconds>`), when it could be made.
    pub backup: Option<String>,
}

fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Move an unreadable `path` to `<path>.corrupt-<ts>` so the app can start with an empty file and the user
/// can still recover the content. `reason` is the parse error.
fn set_aside_corrupt(path: &Path, reason: &str) -> StartupNotice {
    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut backup = path.as_os_str().to_owned();
    backup.push(format!(".corrupt-{}", unix_secs()));
    let backup = PathBuf::from(backup);
    let moved = fs::rename(path, &backup).or_else(|_| fs::copy(path, &backup).map(|_| ()));
    let tail = match moved {
        Ok(()) => {
            restrict_to_owner(&backup);
            format!("The damaged file was saved as {}.", backup.display())
        }
        Err(e) => format!("The damaged file could not be saved ({e}); it will be overwritten."),
    };
    tracing::warn!("{file} is not valid ({reason}); starting empty");
    StartupNotice {
        file: file.clone(),
        message: format!(
            "{file} could not be read ({reason}), so Prometeo started with an empty one. {tail}"
        ),
        backup: moved_path(&backup),
    }
}

fn moved_path(p: &Path) -> Option<String> {
    p.exists().then(|| p.display().to_string())
}

// ====================================================================== secrets in URLs

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && b.len() >= i + 3 {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Query parameters that carry a password in connection URLs.
fn is_password_param(key: &str) -> bool {
    matches!(
        pct_decode(key).to_ascii_lowercase().as_str(),
        "password" | "passwd" | "pwd"
    )
}

/// Split the password out of a connection URL: `scheme://user:PASS@host/db?password=PASS&x=1` becomes
/// `scheme://user@host/db?x=1` plus `Some(PASS)` (percent-decoded). Everything else is kept byte for byte.
/// A URL without a password comes back unchanged with `None`.
pub fn strip_url_password(url: &str) -> (String, Option<String>) {
    let Some(i) = url.find("://") else {
        return (url.to_string(), None);
    };
    let (scheme, rest) = url.split_at(i + 3);
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (auth, tail) = rest.split_at(auth_end);
    let mut password = None;
    let mut auth_out = auth.to_string();
    if let Some(at) = auth.rfind('@') {
        let (userinfo, host) = auth.split_at(at);
        if let Some(c) = userinfo.find(':') {
            let pw = pct_decode(&userinfo[c + 1..]);
            if !pw.is_empty() {
                password = Some(pw);
            }
            auth_out = if c == 0 {
                host[1..].to_string()
            } else {
                format!("{}{host}", &userinfo[..c])
            };
        }
    }
    // path ? query # fragment
    let (before_frag, frag) = match tail.find('#') {
        Some(h) => tail.split_at(h),
        None => (tail, ""),
    };
    let (path, query) = match before_frag.find('?') {
        Some(q) => (&before_frag[..q], Some(&before_frag[q + 1..])),
        None => (before_frag, None),
    };
    let mut query_out = String::new();
    if let Some(q) = query {
        let kept: Vec<&str> = q
            .split('&')
            .filter(|pair| {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                if is_password_param(k) {
                    if !v.is_empty() {
                        password = Some(pct_decode(v));
                    }
                    false
                } else {
                    true
                }
            })
            .collect();
        if !kept.is_empty() {
            query_out = format!("?{}", kept.join("&"));
        }
    }
    if password.is_none()
        && auth_out == auth
        && query.map(|q| q.len() + 1).unwrap_or(0) == query_out.len()
    {
        return (url.to_string(), None);
    }
    (
        format!("{scheme}{auth_out}{path}{query_out}{frag}"),
        password,
    )
}

/// Does the URL carry a password?
pub fn url_has_password(url: &str) -> bool {
    strip_url_password(url).1.is_some()
}

/// Remove secrets from a message that is shown to the user or logged: `known` passwords, the password of any
/// `scheme://user:PASS@host` URL and `password=...` parameters in it.
pub fn redact(msg: &str, known: &[&str]) -> String {
    let mut out = msg.to_string();
    for k in known.iter().filter(|k| k.chars().count() >= 3) {
        out = out.replace(k, "***");
        let enc: String = k
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        if enc != *k {
            out = out.replace(&enc, "***");
        }
    }
    // scheme://user:pass@ -> scheme://user:***@
    let mut res = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        res.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '"' | '\''))
            .unwrap_or(tail.len());
        let (auth, after) = tail.split_at(end);
        match (auth.rfind('@'), auth.find(':')) {
            (Some(at), Some(c)) if c < at => {
                res.push_str(&auth[..c + 1]);
                res.push_str("***");
                res.push_str(&auth[at..]);
            }
            _ => res.push_str(auth),
        }
        rest = after;
    }
    res.push_str(rest);
    // password=... / passwd=... / pwd=... until the next separator
    let mut cleaned = String::with_capacity(res.len());
    let lower = res.to_ascii_lowercase();
    let mut i = 0;
    while i < res.len() {
        let hit = ["password=", "passwd=", "pwd="].iter().find(|k| {
            lower[i..].starts_with(**k)
                && (i == 0 || !lower.as_bytes()[i - 1].is_ascii_alphanumeric())
        });
        if let Some(k) = hit {
            cleaned.push_str(&res[i..i + k.len()]);
            cleaned.push_str("***");
            i += k.len();
            while i < res.len()
                && !matches!(res.as_bytes()[i], b'&' | b' ' | b'\n' | b'"' | b'\'' | b'#')
            {
                i += 1;
            }
        } else {
            let ch = res[i..].chars().next().unwrap();
            cleaned.push(ch);
            i += ch.len_utf8();
        }
    }
    cleaned
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
        keyring::Entry::new(KEYRING_SERVICE, &format!("data-source:{id}"))
            .map_err(|e| e.to_string())
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
        Self::entry(id)?
            .set_password(password)
            .map_err(|e| e.to_string())
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

/// Move the password out of `cfg.url_override` (PostgreSQL / MySQL URLs) and return it.
pub fn take_url_password(cfg: &mut DataSourceConfig) -> Option<String> {
    if cfg.driver == dbcore::Driver::Sqlite {
        return None;
    }
    let url = cfg.url_override.as_deref()?;
    let (clean, pw) = strip_url_password(url);
    cfg.url_override = Some(clean);
    pw
}

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
        let m = v
            .as_object_mut()
            .ok_or_else(|| S::Error::custom("data source is not an object"))?;
        m.remove("password");
        m.insert("hasPassword".into(), self.has_password.into());
        m.insert(
            "passwordStorage".into(),
            serde_json::to_value(self.password_storage).map_err(S::Error::custom)?,
        );
        v.serialize(s)
    }
}

impl From<&StoredDs> for DataSourceView {
    fn from(s: &StoredDs) -> Self {
        let mut cfg = s.cfg.clone();
        cfg.password = None;
        // never hand a password-bearing URL to the UI (stored URLs are clean, this is the safety net)
        cfg.url_override = cfg.url_override.map(|u| strip_url_password(&u).0);
        DataSourceView {
            cfg,
            has_password: s.has_password,
            password_storage: s.password_storage,
        }
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
    notices: Mutex<Vec<StartupNotice>>,
}

impl DataSourceStore {
    /// Load `data-sources.json`. A file that cannot be parsed is set aside as `data-sources.json.corrupt-<ts>`
    /// and the store starts empty (see [`notices`](Self::notices)); only an unreadable file is an error.
    /// URLs that still carry a password (written by an older version) are migrated: the password moves to the
    /// keyring (or the 0600 file) and the URL is stored without it.
    pub fn load(path: PathBuf, secrets: Arc<dyn SecretStore>) -> Result<Self, String> {
        let mut notices = Vec::new();
        let items = match fs::read(&path) {
            Ok(b) => match serde_json::from_slice::<SourcesFile>(&b) {
                Ok(f) => f.data_sources,
                Err(e) => {
                    notices.push(set_aside_corrupt(&path, &e.to_string()));
                    Vec::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
        };
        restrict_to_owner(&path);
        let legacy: Vec<DataSourceConfig> = items
            .iter()
            .filter(|s| s.cfg.url_override.as_deref().is_some_and(url_has_password))
            .map(|s| s.cfg.clone())
            .collect();
        let store = DataSourceStore {
            path,
            secrets,
            keyring: AtomicU8::new(KEYRING_UNKNOWN),
            items: Mutex::new(items),
            notices: Mutex::new(notices),
        };
        for cfg in legacy {
            let name = cfg.name.clone();
            // `save` takes the password out of the URL
            if let Err(e) = store.save(cfg) {
                tracing::warn!("cannot move the password of '{name}' out of its URL: {e}");
            }
        }
        Ok(store)
    }

    /// What was repaired while loading (a corrupt file that was set aside).
    pub fn notices(&self) -> Vec<StartupNotice> {
        self.notices.lock().unwrap().clone()
    }

    /// Whether new passwords go to the OS keyring (probed once, on first use).
    pub fn keyring_available(&self) -> bool {
        match self.keyring.load(Ordering::Relaxed) {
            KEYRING_OK => true,
            KEYRING_DOWN => false,
            _ => {
                let ok = self.secrets.get("__probe__").is_ok();
                self.keyring.store(
                    if ok { KEYRING_OK } else { KEYRING_DOWN },
                    Ordering::Relaxed,
                );
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
        let file = SourcesFile {
            version: 1,
            data_sources: items.to_vec(),
        };
        let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        // may hold a password (keyring fallback): owner only
        write_private(&self.path, &json)
    }

    pub fn list(&self) -> Vec<DataSourceView> {
        self.items
            .lock()
            .unwrap()
            .iter()
            .map(DataSourceView::from)
            .collect()
    }

    pub fn view(&self, id: &str) -> Option<DataSourceView> {
        self.items
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.cfg.id == id)
            .map(DataSourceView::from)
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
            cfg.password = self.secrets.get(id).map_err(|e| {
                format!(
                    "Cannot read the password of '{}' from the OS keyring: {e}",
                    cfg.name
                )
            })?;
        }
        Ok(cfg)
    }

    /// Fill `cfg.password` from the stored one when the caller did not provide a password
    /// (the UI never sees stored passwords, so "unchanged" is `null`).
    pub fn with_stored_password(
        &self,
        mut cfg: DataSourceConfig,
    ) -> Result<DataSourceConfig, String> {
        // a password typed into the URL of a draft wins over the stored one
        if let Some(pw) = take_url_password(&mut cfg) {
            cfg.password = Some(pw);
        }
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
        // a password in the URL moves to the password field (keyring); the stored URL never has one
        let from_url = take_url_password(&mut cfg);
        let new_password = from_url.or_else(|| cfg.password.take());
        cfg.password = None;
        let mut items = self.items.lock().unwrap();
        let pos = items.iter().position(|s| s.cfg.id == cfg.id);
        let (mut has_password, mut storage, kept_file_pw) = match pos {
            Some(i) => (
                items[i].has_password,
                items[i].password_storage,
                items[i].cfg.password.clone(),
            ),
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
                match self
                    .keyring_available()
                    .then(|| self.secrets.set(&cfg.id, pw))
                {
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
        let stored = StoredDs {
            cfg,
            password_storage: storage,
            has_password,
        };
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
        let Some(i) = items.iter().position(|s| s.cfg.id == id) else {
            return Ok(());
        };
        let removed = items.remove(i);
        if removed.password_storage == PasswordStorage::Keyring && removed.has_password {
            let _ = self.secrets.delete(id);
        }
        self.persist(&items)
    }

    /// Copy of a data source with a new id and the name "<name> 1" (or the next free number).
    pub fn duplicate(&self, id: &str) -> Result<DataSourceView, String> {
        let mut cfg = self.get(id)?;
        let names: Vec<String> = self
            .items
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.cfg.name.clone())
            .collect();
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

    /// Gives `to` a copy of the stored password of `from` (the dialog's Duplicate: the UI never sees passwords).
    /// A source without a password leaves `to` unchanged.
    pub fn copy_password(&self, from: &str, to: &str) -> Result<DataSourceView, String> {
        let password = self.get(from)?.password;
        let mut cfg = self.get(to)?;
        cfg.password = password.filter(|p| !p.is_empty());
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
    notices: Vec<StartupNotice>,
}

impl UiStateStore {
    pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(400);

    /// Load `ui-state.json`; a file that cannot be parsed is set aside as `ui-state.json.corrupt-<ts>` and
    /// the state starts empty (see [`notices`](Self::notices)).
    pub fn load(path: PathBuf, debounce: Duration) -> Self {
        let mut notices = Vec::new();
        let map = match fs::read(&path) {
            Ok(b) => match serde_json::from_slice::<BTreeMap<String, Value>>(&b) {
                Ok(m) => m,
                Err(e) => {
                    notices.push(set_aside_corrupt(&path, &e.to_string()));
                    BTreeMap::new()
                }
            },
            Err(_) => BTreeMap::new(),
        };
        UiStateStore {
            path,
            map: Mutex::new(map),
            generation: AtomicU64::new(0),
            debounce,
            notices,
        }
    }

    /// What was repaired while loading.
    pub fn notices(&self) -> Vec<StartupNotice> {
        self.notices.clone()
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
        // editor state can quote SQL (and so secrets): owner only
        write_private(&self.path, &json)
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
        && s.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ' ' | '(' | ')' | '@'));
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
    match name
        .strip_prefix("console_")
        .and_then(|n| n.parse::<u64>().ok())
    {
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
            let name = if i == 0 {
                "console".to_string()
            } else {
                format!("console_{i}")
            };
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dir.join(format!("{name}.sql")))
            {
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
        DataSourceConfig {
            name: name.into(),
            host: "h".into(),
            port: 5432,
            password: pw.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn passwords_go_to_keyring_and_never_to_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let secrets = Arc::new(MemSecrets::default());
        let store = DataSourceStore::load(path.clone(), secrets.clone()).unwrap();
        let v = store.save(cfg("a", Some("s3cret"))).unwrap();
        assert_eq!(
            (v.has_password, v.password_storage),
            (true, PasswordStorage::Keyring)
        );
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
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("\"password\": \"pw\""));
        assert_eq!(
            store.get(&v.cfg.id).unwrap().password.as_deref(),
            Some("pw")
        );
        // unchanged save keeps the file password
        let mut c = cfg("a", None);
        c.id = v.cfg.id.clone();
        store.save(c).unwrap();
        assert_eq!(
            store.get(&v.cfg.id).unwrap().password.as_deref(),
            Some("pw")
        );
        let dup = store.duplicate(&v.cfg.id).unwrap();
        assert_eq!(dup.cfg.name, "a 1");
        assert_eq!(
            store.get(&dup.cfg.id).unwrap().password.as_deref(),
            Some("pw")
        );
        // the dialog's Duplicate: a fresh source takes the stored password of the original
        let fresh = store.save(cfg("fresh", None)).unwrap();
        assert_eq!(store.get(&fresh.cfg.id).unwrap().password, None);
        let copied = store.copy_password(&v.cfg.id, &fresh.cfg.id).unwrap();
        assert!(copied.has_password);
        assert_eq!(
            store.get(&fresh.cfg.id).unwrap().password.as_deref(),
            Some("pw")
        );
        store.delete(&fresh.cfg.id).unwrap();
        store.delete(&v.cfg.id).unwrap();
        assert_eq!(store.list().len(), 1);
    }

    fn url_cfg(url: &str, pw: Option<&str>) -> DataSourceConfig {
        DataSourceConfig {
            name: "u".into(),
            driver: dbcore::Driver::Postgres,
            url_override: Some(url.into()),
            password: pw.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn url_password_is_split_off() {
        let cases = [
            (
                "postgres://u:s3cret@h:5432/db",
                "postgres://u@h:5432/db",
                Some("s3cret"),
            ),
            (
                "postgres://u:p%40ss%3Aw@h/db?sslmode=require",
                "postgres://u@h/db?sslmode=require",
                Some("p@ss:w"),
            ),
            (
                "postgres://u@h/db?password=s3cret&sslmode=require",
                "postgres://u@h/db?sslmode=require",
                Some("s3cret"),
            ),
            (
                "mysql://u@h/db?sslmode=x&PASSWORD=s%20x",
                "mysql://u@h/db?sslmode=x",
                Some("s x"),
            ),
            ("mysql://u@h/db?passwd=a", "mysql://u@h/db", Some("a")),
            ("postgres://:pw@h/db", "postgres://h/db", Some("pw")),
            ("postgres://u:@h/db", "postgres://u@h/db", None),
            (
                "postgres://u@h:5432/db#frag",
                "postgres://u@h:5432/db#frag",
                None,
            ),
            (
                "postgres://u@h/db?sslmode=require",
                "postgres://u@h/db?sslmode=require",
                None,
            ),
            (
                "postgres://u:pw@/db?host=%2Ftmp",
                "postgres://u@/db?host=%2Ftmp",
                Some("pw"),
            ),
            ("sqlite::memory:", "sqlite::memory:", None),
            ("not a url", "not a url", None),
        ];
        for (input, clean, pw) in cases {
            let (c, p) = strip_url_password(input);
            assert_eq!((c.as_str(), p.as_deref()), (clean, pw), "{input}");
        }
        assert!(url_has_password("postgres://u:x@h/d"));
        assert!(!url_has_password("postgres://u@h/d"));
    }

    #[test]
    fn redaction() {
        let m = redact("error connecting to postgres://bob:s3cret@db.example/x?password=s3cret&a=b: refused, tried s3cret", &["s3cret"]);
        assert!(!m.contains("s3cret"), "{m}");
        assert!(
            m.contains("postgres://bob:***@db.example/x?password=***&a=b"),
            "{m}"
        );
        let m = redact("see mysql://u:hunter2@h and PWD=zzz tail", &[]);
        assert_eq!(m, "see mysql://u:***@h and PWD=*** tail");
        // short passwords are not replaced blindly inside ordinary words, text without secrets is untouched
        assert_eq!(
            redact("connection refused (os error 111)", &["ab"]),
            "connection refused (os error 111)"
        );
    }

    #[test]
    fn url_password_goes_to_the_keyring_and_never_back_to_the_ui() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let secrets = Arc::new(MemSecrets::default());
        let store = DataSourceStore::load(path.clone(), secrets.clone()).unwrap();
        let v = store
            .save(url_cfg("postgres://bob:s3cret@db/x?sslmode=require", None))
            .unwrap();
        assert_eq!(
            v.cfg.url_override.as_deref(),
            Some("postgres://bob@db/x?sslmode=require")
        );
        assert!(v.has_password);
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("s3cret"), "{on_disk}");
        assert!(!serde_json::to_string(&store.list())
            .unwrap()
            .contains("s3cret"));
        let id = v.cfg.id.clone();
        let full = store.get(&id).unwrap();
        assert_eq!(
            (full.url_override.as_deref(), full.password.as_deref()),
            (Some("postgres://bob@db/x?sslmode=require"), Some("s3cret"))
        );

        // a password query parameter, and the URL password wins over the password field
        let mut c = url_cfg("postgres://bob@db/x?password=other", Some("ignored"));
        c.id = id.clone();
        store.save(c).unwrap();
        assert_eq!(store.get(&id).unwrap().password.as_deref(), Some("other"));
        assert!(!fs::read_to_string(&path).unwrap().contains("other"));

        // a draft in test_connection: the URL password wins over the stored one, and is not kept in the URL
        let draft = store
            .with_stored_password(url_cfg("postgres://bob:typed@db/x", None))
            .unwrap();
        assert_eq!(
            (draft.url_override.as_deref(), draft.password.as_deref()),
            (Some("postgres://bob@db/x"), Some("typed"))
        );

        // SQLite URLs are not touched
        let mut lite = url_cfg("sqlite:///tmp/a:b@c.db", None);
        lite.driver = dbcore::Driver::Sqlite;
        assert_eq!(
            store.save(lite).unwrap().cfg.url_override.as_deref(),
            Some("sqlite:///tmp/a:b@c.db")
        );
    }

    #[test]
    fn legacy_url_password_is_migrated_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        fs::write(
            &path,
            r#"{"version":1,"dataSources":[{"id":"a","name":"a","driver":"postgres","urlOverride":"postgres://bob:legacy@db/x"}]}"#,
        )
        .unwrap();
        let secrets = Arc::new(MemSecrets::default());
        let store = DataSourceStore::load(path.clone(), secrets.clone()).unwrap();
        let v = &store.list()[0];
        assert_eq!(v.cfg.url_override.as_deref(), Some("postgres://bob@db/x"));
        assert!(v.has_password);
        assert!(!fs::read_to_string(&path).unwrap().contains("legacy"));
        assert_eq!(store.get("a").unwrap().password.as_deref(), Some("legacy"));
    }

    #[cfg(unix)]
    #[test]
    fn files_with_secrets_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        // an old, world readable file is tightened when the store loads it
        fs::write(&path, b"{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let store = DataSourceStore::load(path.clone(), Arc::new(NoKeyring)).unwrap();
        assert_eq!(mode(&path), 0o600);
        // the plain-text password fallback file
        store.save(cfg("a", Some("pw"))).unwrap();
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("\"password\": \"pw\""));
        assert_eq!(mode(&path), 0o600);
        // ui state
        let ui = UiStateStore::load(dir.path().join("ui.json"), Duration::from_millis(10));
        ui.flush().unwrap();
        assert_eq!(mode(&dir.path().join("ui.json")), 0o600);
        // no temp file is left behind
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn corrupt_files_are_set_aside_and_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data-sources.json");
        fs::write(&path, b"{ this is not json").unwrap();
        let store = DataSourceStore::load(path.clone(), Arc::new(MemSecrets::default())).unwrap();
        assert!(store.list().is_empty());
        let n = store.notices();
        assert_eq!(n.len(), 1, "{n:?}");
        assert_eq!(n[0].file, "data-sources.json");
        let backup = PathBuf::from(n[0].backup.clone().expect("backup path"));
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("data-sources.json.corrupt-"));
        assert_eq!(fs::read(&backup).unwrap(), b"{ this is not json");
        assert!(
            n[0].message.contains("data-sources.json"),
            "{}",
            n[0].message
        );
        // the app keeps working: saving creates a fresh file next to the backup
        store.save(cfg("a", None)).unwrap();
        assert_eq!(
            DataSourceStore::load(path, Arc::new(MemSecrets::default()))
                .unwrap()
                .list()
                .len(),
            1
        );
        assert_eq!(fs::read(&backup).unwrap(), b"{ this is not json");

        // a healthy file produces no notice
        assert!(
            store.notices().len() == 1
                && DataSourceStore::load(
                    dir.path().join("none.json"),
                    Arc::new(MemSecrets::default())
                )
                .unwrap()
                .notices()
                .is_empty()
        );

        // ui-state.json: same treatment
        let ui_path = dir.path().join("ui-state.json");
        fs::write(&ui_path, b"[1,2").unwrap();
        let ui = UiStateStore::load(ui_path.clone(), Duration::from_millis(10));
        assert!(ui.get("x").is_none());
        let n = ui.notices();
        assert_eq!(n.len(), 1);
        assert_eq!(fs::read(n[0].backup.as_ref().unwrap()).unwrap(), b"[1,2");
        assert!(!ui_path.exists());
        // valid JSON of the wrong shape is corrupt too
        fs::write(&ui_path, b"[1,2]").unwrap();
        assert_eq!(
            UiStateStore::load(ui_path, Duration::from_millis(10))
                .notices()
                .len(),
            1
        );
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
        assert_eq!(
            cs.list("ds").unwrap()[..3],
            ["console", "console_1", "console_2"]
        );
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
