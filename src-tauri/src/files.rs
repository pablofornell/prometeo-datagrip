//! Files tool window backend: scratch files, `.sql` files opened from disk and attached folders.
//!
//! The webview never gets to read or write an arbitrary path. A path is accepted only when it is
//!
//! * inside the scratches directory (`<data_dir>/scratches`), or
//! * a file the user picked in the native open dialog (`choose_open_files`), or
//! * inside a folder the user attached in the native folder dialog (`choose_attach_folder`).
//!
//! Permissions come from the dialogs the backend itself opens, are stored in
//! `<config_dir>/file-access.json` (so tabs restored after a restart keep working) and are checked on the
//! canonical path, so `..` and symlinks cannot leave the allowed places.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::store::write_atomic;

/// Files bigger than this are not opened in the editor.
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Milliseconds since the epoch.
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: String,
    pub mtime_ms: u64,
}

/// Files the user opened and folders attached to the Files window.
#[derive(Debug, Clone, Serialize)]
pub struct FileRoots {
    pub files: Vec<FileInfo>,
    pub folders: Vec<FileInfo>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Registry {
    files: Vec<PathBuf>,
    folders: Vec<PathBuf>,
}

pub struct FileAccess {
    scratches: PathBuf,
    registry_path: PathBuf,
    reg: Mutex<Registry>,
}

fn info_of(path: &Path) -> Result<FileInfo, String> {
    let md = fs::metadata(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    Ok(FileInfo {
        path: path.display().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string()),
        is_dir: md.is_dir(),
        size: if md.is_dir() { 0 } else { md.len() },
        mtime_ms: mtime_of(&md),
    })
}

fn mtime_of(md: &fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A scratch file name: one path component, no leading dot.
fn safe_name(s: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.len() <= 120
        && !s.starts_with('.')
        && s.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ' ' | '(' | ')' | '@'));
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid file name '{s}'"))
    }
}

/// "scratch.sql" < "scratch_1.sql" < "scratch_2.sql" < ... < the rest by name.
fn scratch_order(name: &str) -> (u64, String) {
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    if stem == "scratch" {
        return (0, String::new());
    }
    match stem
        .strip_prefix("scratch_")
        .and_then(|n| n.parse::<u64>().ok())
    {
        Some(n) => (n, String::new()),
        None => (u64::MAX, name.to_lowercase()),
    }
}

impl FileAccess {
    pub fn new(scratches: PathBuf, registry_path: PathBuf) -> Self {
        let reg = fs::read(&registry_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Registry>(&b).ok())
            .unwrap_or_default();
        FileAccess {
            scratches,
            registry_path,
            reg: Mutex::new(reg),
        }
    }

    fn save(&self, reg: &Registry) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(reg).map_err(|e| e.to_string())?;
        write_atomic(&self.registry_path, &json)
    }

    /// The canonical scratches directory (created on demand).
    fn scratch_dir(&self) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.scratches)
            .map_err(|e| format!("Cannot create {}: {e}", self.scratches.display()))?;
        fs::canonicalize(&self.scratches)
            .map_err(|e| format!("Cannot resolve {}: {e}", self.scratches.display()))
    }

    // ---------------------------------------------------------------- permissions

    /// The user picked `path` in the open dialog: it may be read and written from now on.
    pub fn approve_file(&self, path: &Path) -> Result<FileInfo, String> {
        let canon =
            fs::canonicalize(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        if !canon.is_file() {
            return Err(format!("{} is not a file", canon.display()));
        }
        let mut reg = self.reg.lock().unwrap();
        if !reg.files.contains(&canon) {
            reg.files.push(canon.clone());
            self.save(&reg)?;
        }
        info_of(&canon)
    }

    /// The user picked `path` in the folder dialog: its files may be listed, read and written.
    pub fn attach_folder(&self, path: &Path) -> Result<FileInfo, String> {
        let canon =
            fs::canonicalize(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        if !canon.is_dir() {
            return Err(format!("{} is not a folder", canon.display()));
        }
        let mut reg = self.reg.lock().unwrap();
        if !reg.folders.contains(&canon) {
            reg.folders.push(canon.clone());
            self.save(&reg)?;
        }
        info_of(&canon)
    }

    /// Forget an opened file or attached folder (the file on disk stays).
    pub fn detach(&self, path: &str) -> Result<(), String> {
        let p = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
        let mut reg = self.reg.lock().unwrap();
        reg.files.retain(|f| *f != p);
        reg.folders.retain(|f| *f != p);
        self.save(&reg)
    }

    /// Opened files and attached folders that still exist.
    pub fn roots(&self) -> FileRoots {
        let reg = self.reg.lock().unwrap();
        let infos = |l: &[PathBuf]| l.iter().filter_map(|p| info_of(p).ok()).collect();
        FileRoots {
            files: infos(&reg.files),
            folders: infos(&reg.folders),
        }
    }

    /// The canonical path of `path` when the policy allows it, else the reason it is refused.
    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let canon = fs::canonicalize(path).map_err(|e| format!("Cannot open {path}: {e}"))?;
        if canon.starts_with(self.scratch_dir()?) {
            return Ok(canon);
        }
        let reg = self.reg.lock().unwrap();
        if reg.files.contains(&canon) || reg.folders.iter().any(|f| canon.starts_with(f)) {
            return Ok(canon);
        }
        Err(format!(
            "Refusing to access {}: files must be opened with the Open dialog, attached as a folder, or live in the scratches folder",
            canon.display()
        ))
    }

    // ---------------------------------------------------------------- content

    pub fn read(&self, path: &str) -> Result<FileContent, String> {
        let p = self.resolve(path)?;
        let md = fs::metadata(&p).map_err(|e| format!("Cannot read {}: {e}", p.display()))?;
        if !md.is_file() {
            return Err(format!("{} is not a file", p.display()));
        }
        if md.len() > MAX_FILE_BYTES {
            return Err(format!(
                "{} is too large to open ({} MB)",
                p.display(),
                md.len() >> 20
            ));
        }
        let bytes = fs::read(&p).map_err(|e| format!("Cannot read {}: {e}", p.display()))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| format!("{} is not a UTF-8 text file", p.display()))?;
        Ok(FileContent {
            text,
            mtime_ms: mtime_of(&md),
        })
    }

    /// Writes `text`; with `expected_mtime_ms` the write is refused when the file changed on disk since.
    /// Returns the new modification time.
    pub fn write(
        &self,
        path: &str,
        text: &str,
        expected_mtime_ms: Option<u64>,
    ) -> Result<u64, String> {
        let p = self.resolve(path)?;
        let md = fs::metadata(&p).map_err(|e| format!("Cannot write {}: {e}", p.display()))?;
        if !md.is_file() {
            return Err(format!("{} is not a file", p.display()));
        }
        if let Some(exp) = expected_mtime_ms {
            if mtime_of(&md) != exp {
                return Err(format!("{} was changed on disk", p.display()));
            }
        }
        write_atomic(&p, text.as_bytes())?;
        let md = fs::metadata(&p).map_err(|e| e.to_string())?;
        Ok(mtime_of(&md))
    }

    /// The entries of an attached folder (or of a folder below it): folders first, hidden entries left out.
    pub fn list_dir(&self, path: &str) -> Result<Vec<FileInfo>, String> {
        let p = self.resolve(path)?;
        let rd = fs::read_dir(&p).map_err(|e| format!("Cannot list {}: {e}", p.display()))?;
        let mut out: Vec<FileInfo> = rd
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|e| info_of(&e.path()).ok())
            .collect();
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    // ---------------------------------------------------------------- scratches

    pub fn list_scratches(&self) -> Result<Vec<FileInfo>, String> {
        let dir = self.scratch_dir()?;
        let mut out: Vec<FileInfo> = fs::read_dir(&dir)
            .map_err(|e| format!("Cannot list {}: {e}", dir.display()))?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file() && !e.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|e| info_of(&e.path()).ok())
            .collect();
        out.sort_by_key(|f| scratch_order(&f.name));
        Ok(out)
    }

    /// Creates an empty `scratch.sql`, then `scratch_1.sql`, `scratch_2.sql`, ...
    pub fn create_scratch(&self) -> Result<FileInfo, String> {
        let dir = self.scratch_dir()?;
        for i in 0u32.. {
            let name = if i == 0 {
                "scratch.sql".to_string()
            } else {
                format!("scratch_{i}.sql")
            };
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dir.join(&name))
            {
                Ok(_) => return info_of(&dir.join(name)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("Cannot create scratch file: {e}")),
            }
        }
        unreachable!()
    }

    fn scratch_path(&self, path: &str) -> Result<PathBuf, String> {
        let p = fs::canonicalize(path).map_err(|e| format!("Cannot open {path}: {e}"))?;
        if p.parent() == Some(self.scratch_dir()?.as_path()) {
            Ok(p)
        } else {
            Err(format!("{} is not a scratch file", p.display()))
        }
    }

    pub fn delete_scratch(&self, path: &str) -> Result<(), String> {
        let p = self.scratch_path(path)?;
        fs::remove_file(&p).map_err(|e| format!("Cannot delete {}: {e}", p.display()))
    }

    pub fn rename_scratch(&self, path: &str, to: &str) -> Result<FileInfo, String> {
        safe_name(to)?;
        let p = self.scratch_path(path)?;
        let target = p.with_file_name(to);
        if target.exists() {
            return Err(format!("'{to}' already exists"));
        }
        fs::rename(&p, &target).map_err(|e| format!("Cannot rename {}: {e}", p.display()))?;
        info_of(&target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(dir: &Path) -> FileAccess {
        FileAccess::new(
            dir.join("scratches"),
            dir.join("cfg").join("file-access.json"),
        )
    }

    #[test]
    fn scratches_are_created_listed_renamed_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let fa = access(dir.path());
        assert!(fa.list_scratches().unwrap().is_empty());
        let a = fa.create_scratch().unwrap();
        let b = fa.create_scratch().unwrap();
        assert_eq!(
            (a.name.as_str(), b.name.as_str()),
            ("scratch.sql", "scratch_1.sql")
        );
        assert_eq!(fa.write(&a.path, "select 1;", None).map(|_| ()), Ok(()));
        assert_eq!(fa.read(&a.path).unwrap().text, "select 1;");
        let r = fa.rename_scratch(&b.path, "report.sql").unwrap();
        assert_eq!(r.name, "report.sql");
        assert!(fa.rename_scratch(&a.path, "../x.sql").is_err());
        assert!(fa.rename_scratch(&a.path, "report.sql").is_err());
        let names: Vec<_> = fa
            .list_scratches()
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, ["scratch.sql", "report.sql"]);
        fa.delete_scratch(&r.path).unwrap();
        assert_eq!(fa.list_scratches().unwrap().len(), 1);
    }

    #[test]
    fn only_approved_paths_are_reachable() {
        let dir = tempfile::tempdir().unwrap();
        let fa = access(dir.path());
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.sql");
        fs::write(&secret, "select 'x';").unwrap();
        let secret_s = secret.display().to_string();
        // not approved: neither read nor written nor listed
        assert!(fa.read(&secret_s).unwrap_err().contains("Refusing"));
        assert!(fa.write(&secret_s, "drop table t;", None).is_err());
        assert!(fa.list_dir(&outside.display().to_string()).is_err());
        assert_eq!(fs::read_to_string(&secret).unwrap(), "select 'x';");
        // a scratch cannot reach out through `..` or a symlink
        let s = fa.create_scratch().unwrap();
        let dotdot = format!(
            "{}/../../outside/secret.sql",
            Path::new(&s.path).parent().unwrap().display()
        );
        assert!(fa.read(&dotdot).is_err());
        #[cfg(unix)]
        {
            let link = Path::new(&s.path).with_file_name("link.sql");
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            assert!(fa.read(&link.display().to_string()).is_err());
            assert!(fa.delete_scratch(&link.display().to_string()).is_err());
        }
        // approved by the dialog: that file only
        fa.approve_file(&secret).unwrap();
        assert_eq!(fa.read(&secret_s).unwrap().text, "select 'x';");
        let sibling = outside.join("other.sql");
        fs::write(&sibling, "select 2;").unwrap();
        assert!(fa.read(&sibling.display().to_string()).is_err());
        // the permission survives a restart
        let again = access(dir.path());
        assert_eq!(again.read(&secret_s).unwrap().text, "select 'x';");
        assert_eq!(again.roots().files.len(), 1);
        // detached: gone
        again.detach(&secret_s).unwrap();
        assert!(again.read(&secret_s).is_err());
    }

    #[test]
    fn attached_folder_covers_its_files_and_lists_them() {
        let dir = tempfile::tempdir().unwrap();
        let fa = access(dir.path());
        let proj = dir.path().join("proj");
        fs::create_dir_all(proj.join("sub")).unwrap();
        fs::write(proj.join("b.sql"), "b").unwrap();
        fs::write(proj.join("A.sql"), "a").unwrap();
        fs::write(proj.join(".hidden"), "h").unwrap();
        fs::write(proj.join("sub").join("c.sql"), "c").unwrap();
        let p = proj.display().to_string();
        assert!(fa.list_dir(&p).is_err());
        fa.attach_folder(&proj).unwrap();
        let names: Vec<_> = fa
            .list_dir(&p)
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, ["sub", "A.sql", "b.sql"]);
        assert_eq!(
            fa.read(&proj.join("sub").join("c.sql").display().to_string())
                .unwrap()
                .text,
            "c"
        );
        let m = fa
            .read(&proj.join("b.sql").display().to_string())
            .unwrap()
            .mtime_ms;
        let path = proj.join("b.sql").display().to_string();
        assert!(fa
            .write(&path, "bb", Some(m + 1))
            .unwrap_err()
            .contains("changed on disk"));
        fa.write(&path, "bb", Some(m)).unwrap();
        assert_eq!(fs::read_to_string(proj.join("b.sql")).unwrap(), "bb");
    }

    #[test]
    fn non_utf8_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let fa = access(dir.path());
        let s = fa.create_scratch().unwrap();
        fs::write(&s.path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(fa.read(&s.path).unwrap_err().contains("UTF-8"));
    }
}
