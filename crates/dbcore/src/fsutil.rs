//! Opening output files without following symbolic links or replacing something by accident.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

/// `O_NOFOLLOW` on unix (a symlink as the last component fails instead of being followed); nothing elsewhere.
fn no_follow(opts: &mut OpenOptions) -> &mut OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    opts
}

/// A new file: fails when `path` exists in any form (a file, a symlink, a dangling symlink).
pub fn create_new_nofollow(path: &Path) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    no_follow(&mut opts).open(path)
}

/// The file at `path`, created or emptied; fails when the last component is a symlink. For a place the user
/// picked in a save dialog (which asked before replacing).
pub fn create_or_truncate_nofollow(path: &Path) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    no_follow(&mut opts).open(path)
}

/// Creates a new file at `path`, or at the first free `name-2.ext`, `name-3.ext`... next to it when the file
/// exists. Returns the file and the path it got.
pub fn create_new_unique(path: &Path) -> io::Result<(File, PathBuf)> {
    match create_new_nofollow(path) {
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        other => return other.map(|f| (f, path.to_path_buf())),
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().into_owned());
    for n in 2..1000 {
        let name = match &ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        let p = path.with_file_name(name);
        match create_new_nofollow(&p) {
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            other => return other.map(|f| (f, p)),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "no free file name next to the existing one",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_new_refuses_existing_files_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        create_new_nofollow(&a).unwrap();
        assert_eq!(
            create_new_nofollow(&a).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        #[cfg(unix)]
        {
            let dangling = dir.path().join("dangling.txt");
            std::os::unix::fs::symlink(dir.path().join("target.txt"), &dangling).unwrap();
            assert!(create_new_nofollow(&dangling).is_err());
            assert!(!dir.path().join("target.txt").exists());
            let link = dir.path().join("link.txt");
            std::os::unix::fs::symlink(&a, &link).unwrap();
            assert!(create_or_truncate_nofollow(&link).is_err());
        }
    }

    #[test]
    fn unique_names_skip_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x_errors.txt");
        std::fs::write(&p, "mine").unwrap();
        let (_, p2) = create_new_unique(&p).unwrap();
        assert_eq!(p2, dir.path().join("x_errors-2.txt"));
        let (_, p3) = create_new_unique(&p).unwrap();
        assert_eq!(p3, dir.path().join("x_errors-3.txt"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "mine");
    }
}
