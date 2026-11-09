//! On-disk stores of the app: data sources (+ passwords), generic UI state and console files.
//!
//! * `<config_dir>/data-sources.json`: data sources, versioned (see [`SOURCES_VERSION`]; a file from a newer
//!   version is set aside, never overwritten). Passwords live in the OS keyring (Credential Manager on
//!   Windows, Keychain on macOS, Secret Service on Linux) under service `dev.prometeo.datagrip`; when the
//!   keyring is not reachable the password is stored in the JSON file (owner only) and the data source is
//!   flagged `passwordStorage: "file"`. Such passwords move to the keyring on the first start that has one.
//!   Data sources can be exported / imported as a JSON file that never holds a password.
//! * `<config_dir>/ui-state.json`: `{ key: any json }`, written debounced.
//! * `<data_dir>/consoles/<dsId>/<name>.sql`: per data source console files.

use std::collections::{BTreeMap, HashMap, HashSet};
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
    write_atomic_mode(path, bytes, Protect::None)
}

/// [`write_atomic`] for files that may hold secrets: created with mode `0600` on Unix (the temp file is
/// created with that mode, so the content is never readable by others, not even briefly).
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_mode(path, bytes, Protect::Private)
}

/// [`write_private`] for a file that holds plain-text passwords: on Windows the ACL is also cut down to the
/// current user (inheritance removed), the closest equivalent of `0600`.
fn write_secret(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_mode(path, bytes, Protect::Secret)
}

/// How much a written file is protected.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Protect {
    None,
    /// Owner only on Unix.
    Private,
    /// [`Protect::Private`] plus the Windows ACL.
    Secret,
}

/// Restrict an existing file to its owner (Unix; no-op elsewhere, see [`restrict_acl_to_user`]).
pub fn restrict_to_owner(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Windows: remove the inherited ACL entries of `path` and leave the current user as the only one with access
/// (`icacls`; best effort, a failure is logged). The folders under the user profile are already private to the
/// user, SYSTEM and administrators; this makes a file with plain-text passwords private to the user alone.
/// No-op elsewhere.
pub fn restrict_acl_to_user(path: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let Some(user) = std::env::var_os("USERNAME") else {
            tracing::warn!("cannot restrict {}: USERNAME is not set", path.display());
            return;
        };
        let mut who = std::env::var_os("USERDOMAIN").unwrap_or_default();
        if !who.is_empty() {
            who.push("\\");
        }
        who.push(user);
        who.push(":(F)");
        let icacls = std::env::var_os("SystemRoot")
            .map(|r| PathBuf::from(r).join("System32").join("icacls.exe"))
            .unwrap_or_else(|| PathBuf::from("icacls.exe"));
        let done = Command::new(icacls)
            .arg(path)
            .args(["/inheritance:r", "/grant:r"])
            .arg(who)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        if !matches!(done, Ok(s) if s.success()) {
            tracing::warn!(
                "cannot restrict the access to {} to the current user",
                path.display()
            );
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

fn write_atomic_mode(path: &Path, bytes: &[u8], protect: Protect) -> Result<(), String> {
    let private = protect != Protect::None;
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
    // The file is created EMPTY and restricted before the content goes in, so a secret is never readable by
    // others, not even briefly (the ACL travels with the file through the rename).
    let mut file = opts
        .open(&tmp)
        .map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    if private {
        // a leftover temp file of an earlier run keeps its old mode
        restrict_to_owner(&tmp);
    }
    if protect == Protect::Secret {
        restrict_acl_to_user(&tmp);
    }
    let written = {
        use std::io::Write;
        file.write_all(bytes).and_then(|_| file.flush())
    };
    drop(file);
    if let Err(e) = written {
        // never leave a half written (possibly secret) temp file behind
        let _ = fs::remove_file(&tmp);
        return Err(format!("Cannot write {}: {e}", tmp.display()));
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
    let file = file_name_of(path);
    let (backup, tail) = set_aside(path, "corrupt");
    tracing::warn!("{file} is not valid ({reason}); starting empty");
    StartupNotice {
        message: format!(
            "{file} could not be read ({reason}), so Prometeo started with an empty one. {tail}"
        ),
        file,
        backup,
    }
}

/// Move `path`, written by a NEWER format version than this build understands, to `<path>.newer-<ts>` instead of
/// overwriting it, and start empty: opening that file with the newer app again still finds everything.
fn set_aside_newer(path: &Path, found: u32, understood: u32) -> StartupNotice {
    let file = file_name_of(path);
    let (backup, tail) = set_aside(path, "newer");
    tracing::warn!("{file} has format version {found}, newer than {understood}; starting empty");
    StartupNotice {
        message: format!(
            "{file} was written by a newer version of Prometeo (file format {found}; this version understands up to {understood}), so it could not be read and Prometeo started with an empty one. {tail}"
        ),
        file,
        backup,
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Move (or copy) `path` to `<path>.<kind>-<ts>`: `(where it went, sentence for the user)`.
fn set_aside(path: &Path, kind: &str) -> (Option<String>, String) {
    let mut backup = path.as_os_str().to_owned();
    backup.push(format!(".{kind}-{}", unix_secs()));
    let backup = PathBuf::from(backup);
    let moved = fs::rename(path, &backup).or_else(|_| fs::copy(path, &backup).map(|_| ()));
    let tail = match moved {
        Ok(()) => {
            // the file may hold passwords: a copy made by the fallback gets the folder's ACL, not the original's
            restrict_to_owner(&backup);
            restrict_acl_to_user(&backup);
            format!("The original file was saved as {}.", backup.display())
        }
        Err(e) => format!("The original file could not be saved ({e}); it will be overwritten."),
    };
    (moved_path(&backup), tail)
}

/// Remove the `<name>.tmp<pid>` files a crashed run of ANOTHER process left next to `path` (the temp file of
/// [`write_atomic`]; for `data-sources.json` it may hold passwords).
fn sweep_stale_temp(path: &Path) {
    let (Some(dir), Some(stem)) = (path.parent(), path.file_stem()) else {
        return;
    };
    let prefix = format!("{}.tmp", stem.to_string_lossy());
    let own = format!("{prefix}{}", std::process::id());
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let pid = name.strip_prefix(&prefix).unwrap_or("");
        if !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()) && name != own {
            let _ = fs::remove_file(e.path());
        }
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

/// The Oracle thin form `[jdbc:]oracle:thin:user/PASS@target`: `(clean URL, password)` with the password taken out
/// (`...:user@target`). The password may hold '@' and '/', so the target starts after the LAST '@' and the user ends at
/// the first '/'. `None` when the URL is not of that form or has no password (`oracle:thin:@//host/svc`).
fn strip_oracle_thin_password(url: &str) -> Option<(String, String)> {
    let lower = url.to_ascii_lowercase();
    let prefix = ["jdbc:oracle:thin:", "oracle:thin:"]
        .into_iter()
        .find(|p| lower.starts_with(p))?
        .len();
    let at = url.rfind('@')?;
    if at < prefix {
        return None;
    }
    let cred = &url[prefix..at];
    let (user, pw) = cred.split_once('/')?;
    if pw.is_empty() {
        return None;
    }
    Some((
        format!("{}{user}{}", &url[..prefix], &url[at..]),
        pw.to_string(),
    ))
}

/// Split the password out of a connection URL: `scheme://user:PASS@host/db?password=PASS&x=1` becomes
/// `scheme://user@host/db?x=1` plus `Some(PASS)` (percent-decoded). Everything else is kept byte for byte.
/// A URL without a password comes back unchanged with `None`.
pub fn strip_url_password(url: &str) -> (String, Option<String>) {
    if let Some((clean, pw)) = strip_oracle_thin_password(url) {
        return (clean, Some(pw));
    }
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

/// `oracle:thin:user/PASS@target` -> `oracle:thin:user/***@target` wherever it appears in `msg`.
fn redact_oracle_thin(msg: &str) -> String {
    const KEY: &str = "oracle:thin:";
    let lower = msg.to_ascii_lowercase();
    let mut out = String::with_capacity(msg.len());
    let mut pos = 0;
    while let Some(i) = lower[pos..].find(KEY) {
        let start = pos + i + KEY.len();
        out.push_str(&msg[pos..start]);
        let end = msg[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\''))
            .map_or(msg.len(), |e| start + e);
        let token = &msg[start..end];
        match token.rfind('@').and_then(|at| Some((token.find('/')?, at))) {
            Some((slash, at)) if slash < at && slash + 1 < at => {
                out.push_str(&token[..slash + 1]);
                out.push_str("***");
                out.push_str(&token[at..]);
            }
            _ => out.push_str(token),
        }
        pos = end;
    }
    out.push_str(&msg[pos..]);
    out
}

/// Remove secrets from a message that is shown to the user or logged: `known` passwords, the password of any
/// `scheme://user:PASS@host` URL, of an Oracle `oracle:thin:user/PASS@host` URL and `password=...` parameters in it.
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
    // oracle:thin:user/pass@target -> oracle:thin:user/***@target
    let res = redact_oracle_thin(&res);
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

/// Format version of `data-sources.json` written by this build. Bump it together with a new entry at the end
/// of [`SOURCES_MIGRATIONS`].
pub const SOURCES_VERSION: u32 = 1;

/// One step of a file format migration: rewrites the JSON document from version `i` to `i + 1`.
type Migration = fn(&mut Value);

/// `SOURCES_MIGRATIONS[i]` migrates a `data-sources.json` document from version `i` to `i + 1`.
const SOURCES_MIGRATIONS: &[Migration] = &[migrate_sources_v0_to_v1];

/// Files written before the format was versioned (no `version`, read as 0): make sure the list exists.
fn migrate_sources_v0_to_v1(doc: &mut Value) {
    if let Some(m) = doc.as_object_mut() {
        m.entry("dataSources")
            .or_insert_with(|| Value::Array(Vec::new()));
    }
}

/// The `version` of a stored document (a missing or non-numeric one is 0).
fn doc_version(doc: &Value) -> u32 {
    doc.get("version")
        .and_then(Value::as_u64)
        .map_or(0, |v| u32::try_from(v).unwrap_or(u32::MAX))
}

/// Bring `doc` from its own version up to `current` through `steps` (`steps[i]`: version `i` to `i + 1`).
/// Returns the version it had, or `Err(found)` for a document from a NEWER version, left untouched.
fn migrate_document(doc: &mut Value, current: u32, steps: &[Migration]) -> Result<u32, u32> {
    debug_assert_eq!(steps.len(), current as usize, "one migration per version");
    let from = doc_version(doc);
    if from > current {
        return Err(from);
    }
    for step in &steps[from as usize..current as usize] {
        step(doc);
    }
    if from < current {
        if let Some(m) = doc.as_object_mut() {
            m.insert("version".into(), current.into());
        }
    }
    Ok(from)
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

/// Write, read back and delete a throw-away entry: `Ok` only when the keyring really keeps what it is given.
fn probe_keyring(secrets: &dyn SecretStore) -> Result<(), String> {
    // a fresh account per probe: it can never collide with a data source id or another probe
    let probe_id = format!("__probe__-{}", uuid::Uuid::new_v4());
    let token = uuid::Uuid::new_v4().to_string();
    secrets.set(&probe_id, &token)?;
    let back = secrets.get(&probe_id);
    let _ = secrets.delete(&probe_id);
    match back? {
        Some(b) if b == token => Ok(()),
        _ => Err("it does not keep the values written to it".into()),
    }
}

const KEYRING_UNKNOWN: u8 = 0;
const KEYRING_OK: u8 = 1;
const KEYRING_DOWN: u8 = 2;

pub struct DataSourceStore {
    path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    keyring: AtomicU8,
    /// Serializes the keyring probe (one at a time, the result is shared).
    probe: Mutex<()>,
    items: Mutex<Vec<StoredDs>>,
    notices: Mutex<Vec<StartupNotice>>,
}

impl DataSourceStore {
    /// Load `data-sources.json`. A file that cannot be parsed is set aside as `data-sources.json.corrupt-<ts>`
    /// and the store starts empty (see [`notices`](Self::notices)); only an unreadable file is an error. A file of
    /// an older format is migrated and rewritten; one from a NEWER version is set aside as
    /// `data-sources.json.newer-<ts>` (never overwritten) and the store starts empty.
    /// URLs that still carry a password (written by an older version) are migrated: the password moves to the
    /// keyring (or the owner-only file) and the URL is stored without it. Passwords kept in the file because the
    /// keyring was down move to the keyring as soon as it works.
    pub fn load(path: PathBuf, secrets: Arc<dyn SecretStore>) -> Result<Self, String> {
        let mut notices = Vec::new();
        let mut upgraded = false;
        sweep_stale_temp(&path);
        let items = match fs::read(&path) {
            Ok(b) => match serde_json::from_slice::<Value>(&b) {
                Ok(mut doc) => {
                    match migrate_document(&mut doc, SOURCES_VERSION, SOURCES_MIGRATIONS) {
                        Ok(from) => match serde_json::from_value::<SourcesFile>(doc) {
                            Ok(f) => {
                                upgraded = from < SOURCES_VERSION;
                                f.data_sources
                            }
                            Err(e) => {
                                notices.push(set_aside_corrupt(&path, &e.to_string()));
                                Vec::new()
                            }
                        },
                        Err(found) => {
                            notices.push(set_aside_newer(&path, found, SOURCES_VERSION));
                            Vec::new()
                        }
                    }
                }
                Err(e) => {
                    notices.push(set_aside_corrupt(&path, &e.to_string()));
                    Vec::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
        };
        restrict_to_owner(&path);
        if items.iter().any(holds_plain_secret) {
            restrict_acl_to_user(&path);
        }
        let legacy: Vec<DataSourceConfig> = items
            .iter()
            .filter(|s| s.cfg.url_override.as_deref().is_some_and(url_has_password))
            .map(|s| s.cfg.clone())
            .collect();
        let store = DataSourceStore {
            path,
            secrets,
            keyring: AtomicU8::new(KEYRING_UNKNOWN),
            probe: Mutex::new(()),
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
        store.move_file_passwords_to_keyring();
        if upgraded {
            let items = store.items.lock().unwrap();
            if let Err(e) = store.persist(&items) {
                tracing::warn!("cannot save the migrated data sources file: {e}");
            }
        }
        Ok(store)
    }

    /// Passwords stored in the JSON file (the keyring was down when they were saved) move to the OS keyring
    /// when it works now: each is written, read back and only then removed from the file. The file is
    /// rewritten atomically without them and no copy is kept. A password that cannot be moved stays where it is.
    fn move_file_passwords_to_keyring(&self) {
        let in_file = |s: &StoredDs| {
            s.password_storage == PasswordStorage::File
                && s.cfg.password.as_deref().is_some_and(|p| !p.is_empty())
        };
        if !self.items.lock().unwrap().iter().any(in_file) || !self.keyring_available() {
            return;
        }
        let mut items = self.items.lock().unwrap();
        let mut moved = 0;
        for s in items.iter_mut().filter(|s| in_file(s)) {
            let pw = s.cfg.password.clone().unwrap_or_default();
            let stored = self.secrets.set(&s.cfg.id, &pw).is_ok()
                && matches!(self.secrets.get(&s.cfg.id), Ok(Some(back)) if back == pw);
            if stored {
                s.cfg.password = None;
                s.password_storage = PasswordStorage::Keyring;
                s.has_password = true;
                moved += 1;
            } else {
                // a write that did not read back must not leave a stale entry in the keyring
                let _ = self.secrets.delete(&s.cfg.id);
                tracing::warn!(
                    "cannot move the password of '{}' to the OS keyring; it stays in the file",
                    s.cfg.name
                );
            }
        }
        if moved == 0 {
            return;
        }
        match self.persist(&items) {
            Ok(()) => tracing::info!("moved {moved} data source password(s) from the data sources file to the OS keyring"),
            Err(e) => tracing::warn!("cannot rewrite the data sources file after moving passwords to the keyring: {e}"),
        }
    }

    /// What was repaired while loading (a corrupt file that was set aside).
    pub fn notices(&self) -> Vec<StartupNotice> {
        self.notices.lock().unwrap().clone()
    }

    /// Whether new passwords go to the OS keyring (probed once, on first use). The probe writes, reads back and
    /// deletes a throw-away entry: a backend that accepts calls but keeps nothing (the `keyring` crate's mock
    /// store, a locked or missing Secret Service) is detected before a real password is trusted to it.
    pub fn keyring_available(&self) -> bool {
        match self.keyring.load(Ordering::Relaxed) {
            KEYRING_OK => true,
            KEYRING_DOWN => false,
            _ => {
                let _one_at_a_time = self.probe.lock().unwrap();
                // another thread may have finished the probe while this one waited
                match self.keyring.load(Ordering::Relaxed) {
                    KEYRING_OK => return true,
                    KEYRING_DOWN => return false,
                    _ => {}
                }
                let probe = probe_keyring(self.secrets.as_ref());
                let ok = probe.is_ok();
                self.keyring.store(
                    if ok { KEYRING_OK } else { KEYRING_DOWN },
                    Ordering::Relaxed,
                );
                if let Err(e) = probe {
                    tracing::warn!("OS keyring not available ({e}): passwords will be stored in the data sources file");
                }
                ok
            }
        }
    }

    /// Where new passwords go, probing the keyring if that has not happened yet.
    pub fn default_storage(&self) -> PasswordStorage {
        if self.keyring_available() {
            PasswordStorage::Keyring
        } else {
            PasswordStorage::File
        }
    }

    /// Where new passwords go as far as is known WITHOUT touching the keyring: `None` until something needed it
    /// (a password was saved or migrated). The app does not probe at every launch.
    pub fn known_storage(&self) -> Option<PasswordStorage> {
        match self.keyring.load(Ordering::Relaxed) {
            KEYRING_OK => Some(PasswordStorage::Keyring),
            KEYRING_DOWN => Some(PasswordStorage::File),
            _ => None,
        }
    }

    fn persist(&self, items: &[StoredDs]) -> Result<(), String> {
        let file = SourcesFile {
            version: SOURCES_VERSION,
            data_sources: items.to_vec(),
        };
        let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        // holds a secret only in the keyring fallback or in URL / option values: owner only, and the Windows ACL
        // cut down in that case
        if items.iter().any(holds_plain_secret) {
            write_secret(&self.path, &json)
        } else {
            write_private(&self.path, &json)
        }
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
            // no password yet: the keyring is only probed when one is saved
            None => (false, self.known_storage().unwrap_or_default(), None),
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
                            // the probe worked, so one failed write (a locked entry, a size limit) is not a reason to
                            // give up the keyring for the other data sources: this entry alone goes to the file
                            tracing::warn!("keyring write failed ({e}); storing the password of '{}' in the data sources file", cfg.name);
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

// ====================================================================== export / import

/// `format` of an exported data sources file.
pub const EXPORT_FORMAT: &str = "prometeo-datagrip/data-sources";
/// `version` of an exported data sources file written by this build (older versions are read, newer ones refused).
pub const EXPORT_VERSION: u32 = 1;
/// `format` of an exported settings file (UI settings, keymap, color scheme, layout; no data sources, no secrets).
pub const SETTINGS_FORMAT: &str = "prometeo-datagrip/settings";
/// `version` of an exported settings file written by this build.
pub const SETTINGS_VERSION: u32 = 1;
/// Largest export file the app reads back.
pub const MAX_EXPORT_FILE: u64 = 8 * 1024 * 1024;

/// Option keys and URL query parameters that hold a secret (never exported, dropped when imported): `password`,
/// `sslPassword`, `passphrase`, `access_token`, `apiKey`, `accessKey`, `privateKey`, `credentials`... Anything with
/// "key" in its name counts except the SSL file options, whose values are paths (and key store paths / types).
fn is_secret_option(key: &str) -> bool {
    let k: String = pct_decode(key)
        .chars()
        .filter(|c| !matches!(c, '_' | '-' | '.' | ' '))
        .collect::<String>()
        .to_ascii_lowercase();
    if [
        "password",
        "passwd",
        "pwd",
        "passphrase",
        "secret",
        "token",
        "credential",
    ]
    .iter()
    .any(|w| k.contains(w))
    {
        return true;
    }
    if matches!(
        k.as_str(),
        "sslkey" | "sslkeyfile" | "sslkeypath" | "sslcert" | "sslrootcert"
    ) || k.contains("keystore")
        || k.contains("truststore")
    {
        return false;
    }
    k.contains("key")
}

/// `url` without the query parameters that carry a secret (see [`is_secret_option`]); the flag says whether any was
/// dropped. A URL without a query comes back unchanged.
fn drop_secret_url_params(url: &str) -> (String, bool) {
    let (before_frag, frag) = match url.find('#') {
        Some(h) => url.split_at(h),
        None => (url, ""),
    };
    let Some(q) = before_frag.find('?') else {
        return (url.to_string(), false);
    };
    let (head, query) = (&before_frag[..q], &before_frag[q + 1..]);
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| !is_secret_option(pair.split_once('=').map_or(*pair, |(k, _)| k)))
        .collect();
    if kept.len() == query.split('&').count() {
        return (url.to_string(), false);
    }
    let query = if kept.is_empty() {
        String::new()
    } else {
        format!("?{}", kept.join("&"))
    };
    (format!("{head}{query}{frag}"), true)
}

/// Does `s` keep a secret in plain text in `data-sources.json`: a password in the file fallback, a secret option or
/// a secret query parameter in its URL? Such a file gets the strict (owner only) protection.
fn holds_plain_secret(s: &StoredDs) -> bool {
    s.cfg.password.is_some()
        || s.cfg
            .options
            .iter()
            .any(|(k, v)| is_secret_option(k) || url_has_password(v))
        || s.cfg
            .url_override
            .as_deref()
            .is_some_and(|u| url_has_password(u) || drop_secret_url_params(u).1)
}

/// A data source as written to an export file: everything of the connection except its secrets. A password is
/// only a `hasPassword` flag; paths of SSL files stay in `options` as they are.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ExportedDs {
    name: String,
    driver: dbcore::Driver,
    host: String,
    port: u16,
    database: String,
    user: String,
    file: String,
    url_override: Option<String>,
    options: BTreeMap<String, String>,
    color: Option<String>,
    read_only: bool,
    has_password: bool,
}

impl ExportedDs {
    /// Remove whatever could be a secret: a password or secret parameter in the URL, secret-looking options, a
    /// password inside the value of an option.
    fn scrubbed(mut self) -> Self {
        if self.driver != dbcore::Driver::Sqlite {
            self.url_override = self
                .url_override
                .map(|u| drop_secret_url_params(&strip_url_password(&u).0).0);
        }
        self.options.retain(|k, _| !is_secret_option(k));
        for v in self.options.values_mut() {
            *v = strip_url_password(v).0;
        }
        self
    }
}

impl From<&StoredDs> for ExportedDs {
    fn from(s: &StoredDs) -> Self {
        let c = &s.cfg;
        ExportedDs {
            name: c.name.clone(),
            driver: c.driver,
            host: c.host.clone(),
            port: c.port,
            database: c.database.clone(),
            user: c.user.clone(),
            file: c.file.clone(),
            url_override: c.url_override.clone(),
            options: c.options.clone(),
            color: c.color.clone(),
            read_only: c.read_only,
            has_password: s.has_password,
        }
        .scrubbed()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDoc {
    format: &'static str,
    version: u32,
    exported_at: u64,
    data_sources: Vec<ExportedDs>,
}

/// One data source created by an import.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDs {
    /// The new id.
    pub id: String,
    /// The name it got (renamed to `name (2)` when the name was taken).
    pub name: String,
    /// The name in the file.
    pub original_name: String,
    pub renamed: bool,
    /// The source had a password when exported: it is not in the file, the user has to enter it.
    pub needs_password: bool,
    /// Paths in the file that point at another machine (UNC or `//host/share`): the database file or an SSL file.
    /// Nothing connects or reads them on import; the UI tells the user to check them.
    pub remote_paths: Vec<String>,
}

/// An entry of the file that could not be imported.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedDs {
    pub name: String,
    pub reason: String,
}

/// Result of [`DataSourceStore::import_json`].
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: Vec<ImportedDs>,
    pub skipped: Vec<SkippedDs>,
}

/// Names in use while importing, compared case-insensitively, plus the next suffix to try per base name.
#[derive(Default)]
struct TakenNames {
    taken: HashSet<String>,
    next: HashMap<String, u32>,
}

impl TakenNames {
    fn new(names: impl IntoIterator<Item = String>) -> Self {
        TakenNames {
            taken: names.into_iter().map(|n| n.to_lowercase()).collect(),
            next: HashMap::new(),
        }
    }

    /// `name` when free, else `name (2)`, `name (3)`, ...; the name returned is taken from then on. The counter of
    /// a base name only moves forward, so a thousand entries with the same name cost a thousand steps, not a million.
    fn claim(&mut self, name: &str) -> String {
        let key = name.to_lowercase();
        if self.taken.insert(key.clone()) {
            return name.to_string();
        }
        let n = self.next.entry(key).or_insert(2);
        loop {
            let candidate = format!("{name} ({n})");
            *n += 1;
            if self.taken.insert(candidate.to_lowercase()) {
                return candidate;
            }
        }
    }
}

/// Most data sources one import file may hold.
pub const MAX_IMPORT_ENTRIES: usize = 1000;

/// A UNC path (two backslashes, host, share) or `//host/share`, not the local `?` and `.` device forms: opening it
/// reaches another machine.
fn is_remote_path(p: &str) -> bool {
    let mut c = p.trim().chars();
    match (c.next(), c.next(), c.next()) {
        (Some(a @ ('\\' | '/')), Some(b), Some(third)) => {
            a == b && !matches!(third, '?' | '.' | '\\' | '/')
        }
        _ => false,
    }
}

/// Check the `format` and `version` of an export document and return it. `what` names the kind of file.
fn check_export_header(
    text: &str,
    format: &str,
    max_version: u32,
    what: &str,
) -> Result<Value, String> {
    let doc: Value =
        serde_json::from_str(text).map_err(|e| format!("This is not a valid {what} file: {e}"))?;
    if doc.get("format").and_then(Value::as_str) != Some(format) {
        return Err(format!("This is not a Prometeo {what} file."));
    }
    match doc.get("version").and_then(Value::as_u64) {
        Some(v) if (1..=u64::from(max_version)).contains(&v) => Ok(doc),
        Some(v) if v > u64::from(max_version) => Err(format!(
            "This {what} file was written by a newer version of Prometeo (file format {v}; this version reads up to {max_version}). Update Prometeo to import it."
        )),
        _ => Err(format!("This {what} file has no valid version.")),
    }
}

impl DataSourceStore {
    /// The JSON text of an export file with the data sources `ids` (all when `None` or empty) and how many it
    /// holds. Never contains a password or token: only `hasPassword`.
    pub fn export_json(&self, ids: Option<&[String]>) -> Result<(String, usize), String> {
        let items = self.items.lock().unwrap();
        let chosen: Vec<ExportedDs> = items
            .iter()
            .filter(|s| ids.is_none_or(|ids| ids.is_empty() || ids.contains(&s.cfg.id)))
            .map(ExportedDs::from)
            .collect();
        if chosen.is_empty() {
            return Err("There are no data sources to export.".into());
        }
        let n = chosen.len();
        let doc = ExportDoc {
            format: EXPORT_FORMAT,
            version: EXPORT_VERSION,
            exported_at: unix_secs(),
            data_sources: chosen,
        };
        let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
        Ok((json, n))
    }

    /// Create data sources from the text of an export file (also the clipboard): every entry gets a new id and a
    /// free name, has no password (`needs_password` says which ones had one) and loses anything that looks like a
    /// secret. An entry that cannot be read is skipped and reported; a file of another format or a newer version
    /// is an error and changes nothing.
    pub fn import_json(&self, text: &str) -> Result<ImportSummary, String> {
        let doc = check_export_header(text, EXPORT_FORMAT, EXPORT_VERSION, "data sources")?;
        let entries = doc
            .get("dataSources")
            .and_then(Value::as_array)
            .ok_or("This data sources file has no data sources.")?;
        if entries.len() > MAX_IMPORT_ENTRIES {
            return Err(format!(
                "This file holds {} data sources; at most {MAX_IMPORT_ENTRIES} can be imported at once.",
                entries.len()
            ));
        }
        // no password is stored by an import: the keyring is not probed
        let storage = self.known_storage().unwrap_or_default();
        let mut items = self.items.lock().unwrap();
        let mut taken = TakenNames::new(items.iter().map(|s| s.cfg.name.clone()));
        let mut summary = ImportSummary::default();
        let mut added = Vec::new();
        for entry in entries {
            let label = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("<unnamed>")
                .to_string();
            let ds = match serde_json::from_value::<ExportedDs>(entry.clone()) {
                Ok(d) => d.scrubbed(),
                Err(e) => {
                    summary.skipped.push(SkippedDs {
                        name: label,
                        reason: e.to_string(),
                    });
                    continue;
                }
            };
            let original = if ds.name.trim().is_empty() {
                "Unnamed".to_string()
            } else {
                ds.name.trim().to_string()
            };
            let name = taken.claim(&original);
            let id = uuid::Uuid::new_v4().to_string();
            let remote_paths: Vec<String> = std::iter::once(&ds.file)
                .chain(ds.options.values())
                .filter(|v| is_remote_path(v))
                .cloned()
                .collect();
            let needs_password = ds.has_password && ds.driver != dbcore::Driver::Sqlite;
            added.push(StoredDs {
                cfg: DataSourceConfig {
                    id: id.clone(),
                    name: name.clone(),
                    driver: ds.driver,
                    host: ds.host,
                    port: ds.port,
                    database: ds.database,
                    user: ds.user,
                    password: None,
                    file: ds.file,
                    url_override: ds.url_override,
                    options: ds.options,
                    color: ds.color,
                    read_only: ds.read_only,
                },
                password_storage: storage,
                has_password: false,
            });
            summary.imported.push(ImportedDs {
                id,
                renamed: name != original,
                name,
                original_name: original,
                needs_password,
                remote_paths,
            });
        }
        if added.is_empty() {
            return Ok(summary);
        }
        let before = items.len();
        items.extend(added);
        if let Err(e) = self.persist(&items) {
            items.truncate(before);
            return Err(e);
        }
        Ok(summary)
    }
}

/// The JSON text of a settings export: `settings` (an object the UI builds from its settings, keymap, color
/// scheme and layout) under a format id and version.
pub fn settings_document(settings: Value) -> Result<String, String> {
    if !settings.is_object() {
        return Err("The settings to export must be an object.".into());
    }
    let doc = serde_json::json!({
        "format": SETTINGS_FORMAT,
        "version": SETTINGS_VERSION,
        "exportedAt": unix_secs(),
        "settings": settings,
    });
    serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
}

/// The `settings` object of a settings export file; refuses other files and newer versions.
pub fn parse_settings_document(text: &str) -> Result<Value, String> {
    let mut doc = check_export_header(text, SETTINGS_FORMAT, SETTINGS_VERSION, "settings")?;
    match doc.get_mut("settings").map(Value::take) {
        Some(s) if s.is_object() => Ok(s),
        _ => Err("This settings file has no settings.".into()),
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
            // Oracle thin: user/password@target, split at the last '@'
            (
                "jdbc:oracle:thin:scott/tiger@//db:1521/FREEPDB1",
                "jdbc:oracle:thin:scott@//db:1521/FREEPDB1",
                Some("tiger"),
            ),
            (
                "jdbc:oracle:thin:scott/p@ss/w@db:1521:ORCL",
                "jdbc:oracle:thin:scott@db:1521:ORCL",
                Some("p@ss/w"),
            ),
            (
                "oracle:thin:u/pw@(DESCRIPTION=(ADDRESS=(HOST=h)))",
                "oracle:thin:u@(DESCRIPTION=(ADDRESS=(HOST=h)))",
                Some("pw"),
            ),
            (
                "jdbc:oracle:thin:@//db:1521/FREEPDB1",
                "jdbc:oracle:thin:@//db:1521/FREEPDB1",
                None,
            ),
            (
                "jdbc:oracle:thin:scott@db:1521:ORCL",
                "jdbc:oracle:thin:scott@db:1521:ORCL",
                None,
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
        let m = redact(
            "bad url jdbc:oracle:thin:scott/p@ss@db:1521/svc: refused; jdbc:oracle:thin:@//h/s ok",
            &[],
        );
        assert_eq!(
            m,
            "bad url jdbc:oracle:thin:scott/***@db:1521/svc: refused; jdbc:oracle:thin:@//h/s ok"
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
    fn oracle_thin_url_password_goes_to_the_keyring() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let secrets = Arc::new(MemSecrets::default());
        let store = DataSourceStore::load(path.clone(), secrets).unwrap();
        let mut c = url_cfg("jdbc:oracle:thin:scott/s3cret@//db:1521/FREEPDB1", None);
        c.driver = dbcore::Driver::Oracle;
        let v = store.save(c).unwrap();
        assert_eq!(
            v.cfg.url_override.as_deref(),
            Some("jdbc:oracle:thin:scott@//db:1521/FREEPDB1")
        );
        assert!(v.has_password);
        assert!(!fs::read_to_string(&path).unwrap().contains("s3cret"));
        assert!(!serde_json::to_string(&store.list())
            .unwrap()
            .contains("s3cret"));
        assert_eq!(
            store.get(&v.cfg.id).unwrap().password.as_deref(),
            Some("s3cret")
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

    // ------------------------------------------------------------ keyring probe and password migration

    /// Accepts every call and keeps nothing: what the `keyring` crate's mock store does.
    struct ForgetfulSecrets;
    impl SecretStore for ForgetfulSecrets {
        fn get(&self, _: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn a_keyring_that_forgets_is_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let store = DataSourceStore::load(path.clone(), Arc::new(ForgetfulSecrets)).unwrap();
        assert!(!store.keyring_available());
        assert_eq!(store.default_storage(), PasswordStorage::File);
        let v = store.save(cfg("a", Some("pw"))).unwrap();
        assert_eq!(v.password_storage, PasswordStorage::File);
        assert_eq!(
            store.get(&v.cfg.id).unwrap().password.as_deref(),
            Some("pw")
        );
        assert!(
            DataSourceStore::load(dir.path().join("ok.json"), Arc::new(MemSecrets::default()))
                .unwrap()
                .keyring_available()
        );
    }

    #[test]
    fn file_passwords_move_to_the_keyring_when_it_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        // saved while the keyring was down: the password is in the file
        let id = {
            let store = DataSourceStore::load(path.clone(), Arc::new(NoKeyring)).unwrap();
            let v = store.save(cfg("a", Some("s3cret"))).unwrap();
            store.save(cfg("b", None)).unwrap();
            assert!(fs::read_to_string(&path).unwrap().contains("s3cret"));
            v.cfg.id
        };
        // the next start has a working keyring
        let secrets = Arc::new(MemSecrets::default());
        let store = DataSourceStore::load(path.clone(), secrets.clone()).unwrap();
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(
            !on_disk.contains("s3cret"),
            "the password must leave the file"
        );
        assert!(!on_disk.contains("\"password\": \""), "{on_disk}");
        let v = store.view(&id).unwrap();
        assert_eq!(
            (v.has_password, v.password_storage),
            (true, PasswordStorage::Keyring)
        );
        assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("s3cret"));
        assert_eq!(store.get(&id).unwrap().password.as_deref(), Some("s3cret"));
        // no second plain-text copy is left next to the file
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["ds.json"]);
        // and it stays that way
        let again = DataSourceStore::load(path, secrets).unwrap();
        assert_eq!(again.get(&id).unwrap().password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn file_passwords_stay_when_the_keyring_is_still_down() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let id = DataSourceStore::load(path.clone(), Arc::new(NoKeyring))
            .unwrap()
            .save(cfg("a", Some("pw")))
            .unwrap()
            .cfg
            .id;
        let store = DataSourceStore::load(path, Arc::new(ForgetfulSecrets)).unwrap();
        assert_eq!(store.get(&id).unwrap().password.as_deref(), Some("pw"));
        assert_eq!(
            store.view(&id).unwrap().password_storage,
            PasswordStorage::File
        );
    }

    /// The `keyring` crate falls back to a store that forgets everything unless a native backend is compiled in:
    /// on Windows the Credential Manager must be the one in use (so passwords do not land in the JSON file).
    #[cfg(windows)]
    #[test]
    fn the_windows_credential_manager_is_the_keyring() {
        // the environment of the automated runs says "no keyring": nothing to check then
        if std::env::var_os("PROMETEO_NO_KEYRING").is_some() {
            return;
        }
        /// Removes the entry even when an assertion fails.
        struct Cleanup(Mutex<Vec<String>>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for id in self.0.lock().unwrap().iter() {
                    let _ = OsKeyring.delete(id);
                }
            }
        }
        let cleanup = Cleanup(Mutex::new(Vec::new()));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let store = DataSourceStore::load(path.clone(), Arc::new(OsKeyring)).unwrap();
        assert!(
            store.keyring_available(),
            "Windows Credential Manager not reachable"
        );
        let v = store
            .save(cfg("os-keyring-test", Some("kr-secret-1")))
            .unwrap();
        cleanup.0.lock().unwrap().push(v.cfg.id.clone());
        assert_eq!(v.password_storage, PasswordStorage::Keyring);
        assert!(!fs::read_to_string(&path).unwrap().contains("kr-secret-1"));
        assert_eq!(
            OsKeyring.get(&v.cfg.id).unwrap().as_deref(),
            Some("kr-secret-1")
        );
        store.delete(&v.cfg.id).unwrap();
        assert_eq!(
            OsKeyring.get(&v.cfg.id).unwrap(),
            None,
            "the entry is removed with the data source"
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_password_file_is_restricted_to_the_current_user_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let store = DataSourceStore::load(path.clone(), Arc::new(NoKeyring)).unwrap();
        store.save(cfg("a", Some("pw"))).unwrap();
        let acl = std::process::Command::new("icacls")
            .arg(&path)
            .output()
            .unwrap();
        let acl = String::from_utf8_lossy(&acl.stdout).to_lowercase();
        let user = std::env::var("USERNAME").unwrap().to_lowercase();
        let entries = acl.matches(":(").count();
        assert_eq!(entries, 1, "exactly one ACL entry expected");
        assert!(
            acl.contains(&format!("{user}:(f)")),
            "the entry must be the current user's"
        );
    }

    // ------------------------------------------------------------ file format versions

    #[test]
    fn an_unversioned_file_is_migrated_and_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        fs::write(
            &path,
            r#"{"dataSources":[{"id":"a","name":"old","driver":"postgres","passwordStorage":"keyring","hasPassword":false}]}"#,
        )
        .unwrap();
        let store = DataSourceStore::load(path.clone(), Arc::new(MemSecrets::default())).unwrap();
        assert!(store.notices().is_empty());
        assert_eq!(store.list()[0].cfg.name, "old");
        let on_disk: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["version"], SOURCES_VERSION);
        // a file without even the list is an empty store, not a corrupt one
        fs::write(&path, "{}").unwrap();
        let empty = DataSourceStore::load(path, Arc::new(MemSecrets::default())).unwrap();
        assert!(empty.list().is_empty() && empty.notices().is_empty());
    }

    #[test]
    fn migration_steps_run_in_order_from_the_stored_version() {
        fn to_1(d: &mut Value) {
            d["trail"] = serde_json::json!(["to1"]);
        }
        fn to_2(d: &mut Value) {
            d["trail"].as_array_mut().unwrap().push("to2".into());
        }
        fn to_3(d: &mut Value) {
            d["trail"].as_array_mut().unwrap().push("to3".into());
        }
        let steps: &[Migration] = &[to_1, to_2, to_3];
        let mut v0 = serde_json::json!({});
        assert_eq!(migrate_document(&mut v0, 3, steps), Ok(0));
        assert_eq!(v0["trail"], serde_json::json!(["to1", "to2", "to3"]));
        assert_eq!(v0["version"], 3);
        // starts at the stored version, not at 0
        let mut v2 = serde_json::json!({ "version": 2, "trail": ["x"] });
        assert_eq!(migrate_document(&mut v2, 3, steps), Ok(2));
        assert_eq!(v2["trail"], serde_json::json!(["x", "to3"]));
        // current: untouched
        let mut v3 = serde_json::json!({ "version": 3 });
        assert_eq!(migrate_document(&mut v3, 3, steps), Ok(3));
        assert_eq!(v3, serde_json::json!({ "version": 3 }));
        // newer: refused and untouched
        let mut v9 = serde_json::json!({ "version": 9, "x": 1 });
        assert_eq!(migrate_document(&mut v9, 3, steps), Err(9));
        assert_eq!(v9, serde_json::json!({ "version": 9, "x": 1 }));
    }

    #[test]
    fn a_file_from_a_newer_version_is_set_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data-sources.json");
        let newer = format!(
            r#"{{"version":{},"dataSources":[{{"id":"a","name":"future","driver":"postgres","somethingNew":true}}]}}"#,
            SOURCES_VERSION + 1
        );
        fs::write(&path, &newer).unwrap();
        let store = DataSourceStore::load(path.clone(), Arc::new(MemSecrets::default())).unwrap();
        assert!(store.list().is_empty());
        let n = store.notices();
        assert_eq!(n.len(), 1, "{n:?}");
        assert_eq!(n[0].file, "data-sources.json");
        assert!(n[0].message.contains("newer version"), "{}", n[0].message);
        let backup = PathBuf::from(n[0].backup.clone().expect("backup path"));
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("data-sources.json.newer-"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), newer);
        assert!(
            !path.exists(),
            "the newer file was moved, nothing left to overwrite"
        );
        // the app keeps working and the backup stays as it was
        store.save(cfg("mine", None)).unwrap();
        assert_eq!(fs::read_to_string(&backup).unwrap(), newer);
        let again = DataSourceStore::load(path, Arc::new(MemSecrets::default())).unwrap();
        assert_eq!(again.list().len(), 1);
        assert!(again.notices().is_empty());
    }

    // ------------------------------------------------------------ export / import

    fn secret_source(store: &DataSourceStore, name: &str, pw: &str) -> DataSourceView {
        let mut c = cfg(name, Some(pw));
        c.user = "scott".into();
        c.options.insert("sslmode".into(), "verify-full".into());
        c.options
            .insert("sslrootcert".into(), "C:/certs/ca.pem".into());
        c.options.insert("sslPassword".into(), "key-pass-9".into());
        c.options
            .insert("wallet_password".into(), "wallet-pass-9".into());
        store.save(c).unwrap()
    }

    #[test]
    fn export_never_contains_a_password() {
        for secrets in [
            Arc::new(MemSecrets::default()) as Arc<dyn SecretStore>,
            Arc::new(NoKeyring),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let store = DataSourceStore::load(dir.path().join("ds.json"), secrets).unwrap();
            let v = secret_source(&store, "prod", "hunter2-xyz");
            // a URL with a password as the user typed it
            let mut u = url_cfg(
                "postgres://bob:url-pass-7@db/x?password=query-pass-7&sslmode=require&sslpassword=ssl-url-7&access_token=tok-7&token=tok-8&trustCertificateKeyStorePassword=ts-7&apiKey=ak-7&sslkey=C:/k.pem",
                None,
            );
            u.name = "by url".into();
            u.options.insert("apiKey".into(), "api-key-7".into());
            u.options.insert("accessKey".into(), "access-key-7".into());
            u.options
                .insert("privateKey".into(), "private-key-7".into());
            u.options
                .insert("db_credentials".into(), "credentials-7".into());
            u.options
                .insert("proxy".into(), "https://px:option-pass-7@proxy/x".into());
            u.options
                .insert("application_name".into(), "prometeo".into());
            store.save(u).unwrap();
            let (text, n) = store.export_json(None).unwrap();
            assert_eq!(n, 2);
            for secret in [
                "hunter2-xyz",
                "url-pass-7",
                "query-pass-7",
                "key-pass-9",
                "wallet-pass-9",
                "ssl-url-7",
                "tok-7",
                "tok-8",
                "ts-7",
                "ak-7",
                "api-key-7",
                "access-key-7",
                "private-key-7",
                "credentials-7",
                "option-pass-7",
            ] {
                assert!(!text.contains(secret), "export leaked a secret");
            }
            assert!(!text.contains("\"password\""), "no password field at all");
            let doc: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(doc["format"], EXPORT_FORMAT);
            assert_eq!(doc["version"], EXPORT_VERSION);
            let first = &doc["dataSources"][0];
            assert_eq!(first["hasPassword"], true);
            assert_eq!(first["user"], "scott");
            // SSL files stay paths, the other options are kept
            assert_eq!(first["options"]["sslrootcert"], "C:/certs/ca.pem");
            assert_eq!(first["options"]["sslmode"], "verify-full");
            assert!(first["options"].get("sslPassword").is_none());
            assert!(first.get("id").is_none(), "ids are not exported");
            assert_eq!(
                doc["dataSources"][1]["urlOverride"],
                "postgres://bob@db/x?sslmode=require&sslkey=C:/k.pem"
            );
            assert_eq!(
                doc["dataSources"][1]["options"]["application_name"],
                "prometeo"
            );
            assert_eq!(
                doc["dataSources"][1]["options"]["proxy"],
                "https://px@proxy/x"
            );
            // one source only
            let (_, one) = store
                .export_json(Some(std::slice::from_ref(&v.cfg.id)))
                .unwrap();
            assert_eq!(one, 1);
        }
        let dir = tempfile::tempdir().unwrap();
        let empty = DataSourceStore::load(dir.path().join("ds.json"), Arc::new(NoKeyring)).unwrap();
        assert!(empty.export_json(None).is_err());
    }

    #[test]
    fn import_creates_new_ids_renames_on_clash_and_asks_for_passwords() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemSecrets::default());
        let src = DataSourceStore::load(dir.path().join("src.json"), secrets.clone()).unwrap();
        let a = secret_source(&src, "prod", "hunter2-xyz");
        src.save(cfg("plain", None)).unwrap();
        let (text, _) = src.export_json(None).unwrap();

        let dst =
            DataSourceStore::load(dir.path().join("dst.json"), Arc::new(MemSecrets::default()))
                .unwrap();
        dst.save(cfg("PROD", None)).unwrap();
        let s = dst.import_json(&text).unwrap();
        assert!(s.skipped.is_empty());
        assert_eq!(s.imported.len(), 2);
        assert_eq!(s.imported[0].name, "prod (2)");
        assert_eq!(s.imported[0].original_name, "prod");
        assert!(s.imported[0].renamed && s.imported[0].needs_password);
        assert_eq!(s.imported[1].name, "plain");
        assert!(!s.imported[1].renamed && !s.imported[1].needs_password);
        assert_ne!(s.imported[0].id, a.cfg.id, "a new id");
        // the stored copy has no password, keeps the connection and the SSL path
        let imported = dst.view(&s.imported[0].id).unwrap();
        assert!(!imported.has_password);
        assert_eq!(imported.cfg.user, "scott");
        assert_eq!(imported.cfg.options["sslrootcert"], "C:/certs/ca.pem");
        assert!(!imported.cfg.options.contains_key("sslPassword"));
        assert_eq!(dst.get(&imported.cfg.id).unwrap().password, None);
        assert!(!fs::read_to_string(dir.path().join("dst.json"))
            .unwrap()
            .contains("hunter2-xyz"));
        // importing the same file again: the names keep counting
        let s2 = dst.import_json(&text).unwrap();
        assert_eq!(s2.imported[0].name, "prod (3)");
        assert_eq!(s2.imported[1].name, "plain (2)");
        assert_eq!(dst.list().len(), 5);
        // it survives a restart
        let again =
            DataSourceStore::load(dir.path().join("dst.json"), Arc::new(MemSecrets::default()))
                .unwrap();
        assert_eq!(again.list().len(), 5);
    }

    #[test]
    fn import_refuses_other_files_and_skips_bad_entries() {
        let dir = tempfile::tempdir().unwrap();
        let store = DataSourceStore::load(dir.path().join("ds.json"), Arc::new(NoKeyring)).unwrap();
        assert!(store
            .import_json("not json")
            .unwrap_err()
            .contains("not a valid"));
        let e = store
            .import_json(r#"{"format":"something-else","version":1,"dataSources":[]}"#)
            .unwrap_err();
        assert!(e.contains("not a Prometeo"), "{e}");
        let newer = format!(
            r#"{{"format":"{EXPORT_FORMAT}","version":{},"dataSources":[]}}"#,
            EXPORT_VERSION + 1
        );
        let e = store.import_json(&newer).unwrap_err();
        assert!(e.contains("newer version"), "{e}");
        let e = store
            .import_json(&format!(
                r#"{{"format":"{EXPORT_FORMAT}","dataSources":[]}}"#
            ))
            .unwrap_err();
        assert!(e.contains("version"), "{e}");
        // a password a hand-edited file carries is ignored, and so is the one in a URL
        let ok = format!(
            r#"{{"format":"{EXPORT_FORMAT}","version":1,"dataSources":[
                {{"name":"bad","driver":"nosuchdb"}},
                {{"name":"edited","driver":"postgres","password":"leaked-1","urlOverride":"postgres://u:leaked-2@h/d","options":{{"password":"leaked-3","sslmode":"require"}},"hasPassword":true}},
                {{"driver":"sqlite","file":"C:/data/app.db"}}
            ]}}"#
        );
        let s = store.import_json(&ok).unwrap();
        assert_eq!(s.skipped.len(), 1);
        assert_eq!(s.skipped[0].name, "bad");
        assert_eq!(s.imported.len(), 2);
        assert_eq!(s.imported[1].name, "Unnamed");
        let disk = fs::read_to_string(dir.path().join("ds.json")).unwrap();
        for leaked in ["leaked-1", "leaked-2", "leaked-3"] {
            assert!(!disk.contains(leaked), "{leaked} reached the file");
        }
        assert_eq!(
            store.list()[0].cfg.url_override.as_deref(),
            Some("postgres://u@h/d")
        );
        assert_eq!(store.list()[0].cfg.options.len(), 1);
        // nothing importable: no file write, an empty summary
        let none = store
            .import_json(&format!(
                r#"{{"format":"{EXPORT_FORMAT}","version":1,"dataSources":[]}}"#
            ))
            .unwrap();
        assert!(none.imported.is_empty());
    }

    #[test]
    fn unique_names_count_up() {
        let mut taken = TakenNames::new(["a", "a (2)", "B"].map(String::from));
        assert_eq!(taken.claim("c"), "c");
        assert_eq!(taken.claim("a"), "a (3)");
        assert_eq!(taken.claim("a"), "a (4)");
        assert_eq!(taken.claim("b"), "b (2)");
        assert_eq!(taken.claim("C"), "C (2)");
        // a thousand of the same name stay cheap and distinct
        let mut many = TakenNames::default();
        let names: HashSet<String> = (0..MAX_IMPORT_ENTRIES).map(|_| many.claim("x")).collect();
        assert_eq!(names.len(), MAX_IMPORT_ENTRIES);
        assert!(names.contains("x") && names.contains("x (1000)"));
    }

    #[test]
    fn secret_url_parameters_and_options() {
        for k in [
            "password",
            "sslPassword",
            "ssl_password",
            "access_token",
            "token",
            "apiKey",
            "api-key",
            "accessKey",
            "privateKey",
            "authKey",
            "credentials",
            "client_secret",
            "passphrase",
            "trustCertificateKeyStorePassword",
        ] {
            assert!(is_secret_option(k), "{k}");
        }
        for k in [
            "sslmode",
            "sslkey",
            "sslcert",
            "sslrootcert",
            "application_name",
            "connectTimeout",
            "keepAliveSec",
            "trustCertificateKeyStoreUrl",
            "oracleConnType",
            "visibleSchemas",
        ] {
            assert!(!is_secret_option(k), "{k}");
        }
        assert_eq!(
            drop_secret_url_params("postgres://u@h/d?a=1&sslpassword=x&token=y&b=2#f"),
            ("postgres://u@h/d?a=1&b=2#f".to_string(), true)
        );
        assert_eq!(
            drop_secret_url_params("postgres://u@h/d?token=y"),
            ("postgres://u@h/d".to_string(), true)
        );
        assert_eq!(
            drop_secret_url_params("postgres://u@h/d?a=1"),
            ("postgres://u@h/d?a=1".to_string(), false)
        );
        assert_eq!(
            drop_secret_url_params("postgres://u@h/d"),
            ("postgres://u@h/d".to_string(), false)
        );
    }

    #[test]
    fn a_file_with_a_secret_url_parameter_or_option_is_strictly_protected() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            DataSourceStore::load(dir.path().join("ds.json"), Arc::new(MemSecrets::default()))
                .unwrap();
        store.save(cfg("plain", None)).unwrap();
        assert!(!store.items.lock().unwrap().iter().any(holds_plain_secret));
        store
            .save(url_cfg("postgres://u@h/d?sslpassword=x", None))
            .unwrap();
        let mut o = cfg("opt", None);
        o.options.insert("apiKey".into(), "k".into());
        store.save(o).unwrap();
        let held: Vec<bool> = store
            .items
            .lock()
            .unwrap()
            .iter()
            .map(holds_plain_secret)
            .collect();
        assert_eq!(held, [false, true, true]);
    }

    #[test]
    fn import_drops_secret_url_parameters_and_options_and_flags_network_paths() {
        let dir = tempfile::tempdir().unwrap();
        let store = DataSourceStore::load(dir.path().join("ds.json"), Arc::new(NoKeyring)).unwrap();
        let text = format!(
            r#"{{"format":"{EXPORT_FORMAT}","version":1,"dataSources":[
                {{"name":"a","driver":"postgres","urlOverride":"postgres://u@h/d?sslpassword=leaked-1&sslmode=require","options":{{"accessKey":"leaked-2","sslrootcert":"\\\\fileserver\\certs\\ca.pem","x":"http://v:leaked-3@h"}}}},
                {{"name":"b","driver":"sqlite","file":"//nas/share/app.db"}},
                {{"name":"c","driver":"sqlite","file":"C:/local/app.db","options":{{"sslkey":"\\\\?\\C:\\k.pem"}}}}
            ]}}"#
        );
        let s = store.import_json(&text).unwrap();
        assert_eq!(s.imported.len(), 3);
        assert_eq!(
            s.imported[0].remote_paths,
            ["\\\\fileserver\\certs\\ca.pem"]
        );
        assert_eq!(s.imported[1].remote_paths, ["//nas/share/app.db"]);
        assert!(
            s.imported[2].remote_paths.is_empty(),
            "local paths are not flagged"
        );
        let disk = fs::read_to_string(dir.path().join("ds.json")).unwrap();
        for leaked in ["leaked-1", "leaked-2", "leaked-3"] {
            assert!(!disk.contains(leaked), "{leaked} reached the file");
        }
        assert_eq!(
            store.list()[0].cfg.url_override.as_deref(),
            Some("postgres://u@h/d?sslmode=require")
        );
        assert!(is_remote_path("\\\\host\\share") && is_remote_path("//host/share"));
        assert!(
            !is_remote_path("\\\\?\\C:\\x")
                && !is_remote_path("\\\\.\\pipe")
                && !is_remote_path("///x")
        );
        assert!(!is_remote_path("C:\\x") && !is_remote_path("/home/u") && !is_remote_path(""));
    }

    #[test]
    fn import_refuses_too_many_entries() {
        let dir = tempfile::tempdir().unwrap();
        let store = DataSourceStore::load(dir.path().join("ds.json"), Arc::new(NoKeyring)).unwrap();
        let doc = |n: usize| {
            let entries = vec![r#"{"name":"same","driver":"sqlite"}"#; n].join(",");
            format!(r#"{{"format":"{EXPORT_FORMAT}","version":1,"dataSources":[{entries}]}}"#)
        };
        let e = store.import_json(&doc(MAX_IMPORT_ENTRIES + 1)).unwrap_err();
        assert!(e.contains("at most 1000"), "{e}");
        assert!(store.list().is_empty());
        let s = store.import_json(&doc(MAX_IMPORT_ENTRIES)).unwrap();
        assert_eq!(s.imported.len(), MAX_IMPORT_ENTRIES);
        assert_eq!(s.imported[MAX_IMPORT_ENTRIES - 1].name, "same (1000)");
    }

    // ------------------------------------------------------------ keyring probe: lazy, serialized, per-entry fallback

    /// Counts calls, can fail the writes of data source entries (never the probe's) and can return wrong values.
    #[derive(Default)]
    struct ScriptedSecrets {
        map: Mutex<HashMap<String, String>>,
        sets: std::sync::atomic::AtomicUsize,
        deleted: Mutex<Vec<String>>,
        fail_entry_writes: std::sync::atomic::AtomicBool,
        wrong_entry_reads: std::sync::atomic::AtomicBool,
    }
    impl SecretStore for ScriptedSecrets {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            if !id.starts_with("__probe__") && self.wrong_entry_reads.load(Ordering::SeqCst) {
                return Ok(Some("something else".into()));
            }
            Ok(self.map.lock().unwrap().get(id).cloned())
        }
        fn set(&self, id: &str, p: &str) -> Result<(), String> {
            self.sets.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(20));
            if !id.starts_with("__probe__") && self.fail_entry_writes.load(Ordering::SeqCst) {
                return Err("entry is locked".into());
            }
            self.map.lock().unwrap().insert(id.into(), p.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.deleted.lock().unwrap().push(id.into());
            self.map.lock().unwrap().remove(id);
            Ok(())
        }
    }

    #[test]
    fn the_keyring_is_probed_lazily_and_once_even_from_many_threads() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(ScriptedSecrets::default());
        let store =
            Arc::new(DataSourceStore::load(dir.path().join("ds.json"), secrets.clone()).unwrap());
        // starting, saving and importing sources without a password never touch the keyring
        assert_eq!(store.known_storage(), None);
        store.save(cfg("a", None)).unwrap();
        let doc = format!(
            r#"{{"format":"{EXPORT_FORMAT}","version":1,"dataSources":[{{"name":"b","driver":"sqlite"}}]}}"#
        );
        store.import_json(&doc).unwrap();
        assert_eq!(secrets.sets.load(Ordering::SeqCst), 0);
        assert_eq!(store.known_storage(), None);
        // concurrent first uses: one probe (one write), everybody gets the answer
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let st = store.clone();
                std::thread::spawn(move || st.keyring_available())
            })
            .collect();
        assert!(threads.into_iter().all(|t| t.join().unwrap()));
        assert_eq!(secrets.sets.load(Ordering::SeqCst), 1, "one probe write");
        assert!(
            secrets.map.lock().unwrap().is_empty(),
            "the probe entry is deleted"
        );
        assert!(secrets.deleted.lock().unwrap()[0].starts_with("__probe__-"));
        assert_eq!(store.known_storage(), Some(PasswordStorage::Keyring));
    }

    #[test]
    fn a_start_with_file_passwords_probes_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let id = DataSourceStore::load(path.clone(), Arc::new(NoKeyring))
            .unwrap()
            .save(cfg("a", Some("pw")))
            .unwrap()
            .cfg
            .id;
        let secrets = Arc::new(ScriptedSecrets::default());
        let store = DataSourceStore::load(path, secrets).unwrap();
        assert_eq!(
            store.known_storage(),
            Some(PasswordStorage::Keyring),
            "probed because a password had to move"
        );
        assert_eq!(
            store.view(&id).unwrap().password_storage,
            PasswordStorage::Keyring
        );
    }

    #[test]
    fn one_failed_keyring_write_keeps_the_keyring_for_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(ScriptedSecrets::default());
        let store = DataSourceStore::load(dir.path().join("ds.json"), secrets.clone()).unwrap();
        let first = store.save(cfg("ok", Some("one"))).unwrap();
        assert_eq!(first.password_storage, PasswordStorage::Keyring);
        secrets.fail_entry_writes.store(true, Ordering::SeqCst);
        let flaky = store.save(cfg("flaky", Some("two"))).unwrap();
        assert_eq!(
            flaky.password_storage,
            PasswordStorage::File,
            "this entry alone falls back to the file"
        );
        assert_eq!(
            store.get(&flaky.cfg.id).unwrap().password.as_deref(),
            Some("two")
        );
        secrets.fail_entry_writes.store(false, Ordering::SeqCst);
        assert!(store.keyring_available());
        let next = store.save(cfg("later", Some("three"))).unwrap();
        assert_eq!(next.password_storage, PasswordStorage::Keyring);
        assert_eq!(store.known_storage(), Some(PasswordStorage::Keyring));
    }

    #[test]
    fn a_migration_write_that_does_not_read_back_leaves_nothing_in_the_keyring() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ds.json");
        let id = DataSourceStore::load(path.clone(), Arc::new(NoKeyring))
            .unwrap()
            .save(cfg("a", Some("pw")))
            .unwrap()
            .cfg
            .id;
        let secrets = Arc::new(ScriptedSecrets::default());
        secrets.wrong_entry_reads.store(true, Ordering::SeqCst);
        let store = DataSourceStore::load(path.clone(), secrets.clone()).unwrap();
        assert_eq!(
            store.view(&id).unwrap().password_storage,
            PasswordStorage::File,
            "the password stays in the file"
        );
        assert!(
            secrets.deleted.lock().unwrap().contains(&id),
            "the stale entry is deleted"
        );
        assert!(!secrets.map.lock().unwrap().contains_key(&id));
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("\"password\": \"pw\""));
    }

    #[test]
    fn stale_temp_files_of_other_processes_are_swept_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data-sources.json");
        let stale = dir.path().join("data-sources.tmp99999999");
        let other = dir.path().join("data-sources.tmpfile.txt");
        let unrelated = dir.path().join("ui-state.tmp1");
        for f in [&stale, &other, &unrelated] {
            fs::write(f, "secret").unwrap();
        }
        DataSourceStore::load(path, Arc::new(NoKeyring)).unwrap();
        assert!(!stale.exists());
        assert!(
            other.exists() && unrelated.exists(),
            "only <name>.tmp<digits> files go"
        );
    }

    #[test]
    fn settings_documents_round_trip_and_refuse_newer_versions() {
        let settings = serde_json::json!({ "settings": { "gridPageSize": 100 }, "theme": "dark" });
        let text = settings_document(settings.clone()).unwrap();
        assert_eq!(parse_settings_document(&text).unwrap(), settings);
        assert!(settings_document(serde_json::json!([1])).is_err());
        let doc: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["format"], SETTINGS_FORMAT);
        let newer = text.replace("\"version\": 1", "\"version\": 2");
        assert!(parse_settings_document(&newer)
            .unwrap_err()
            .contains("newer version"));
        // a data sources export is not a settings file
        let ds = format!(r#"{{"format":"{EXPORT_FORMAT}","version":1,"dataSources":[]}}"#);
        assert!(parse_settings_document(&ds)
            .unwrap_err()
            .contains("not a Prometeo settings"));
        assert!(
            parse_settings_document(r#"{"format":"prometeo-datagrip/settings","version":1}"#)
                .is_err()
        );
    }
}
