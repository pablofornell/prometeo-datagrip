//! Query history: an append-only JSON-lines file, capped to the newest entries.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    /// Unix time in milliseconds.
    pub ts_ms: u64,
    pub data_source_id: String,
    pub sql: String,
    pub duration_ms: Option<u64>,
    pub ok: bool,
    pub error: Option<String>,
    pub rows: Option<u64>,
}

impl HistoryEntry {
    pub fn new(data_source_id: &str, sql: &str) -> Self {
        HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            ts_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            data_source_id: data_source_id.to_string(),
            sql: sql.to_string(),
            duration_ms: None,
            ok: true,
            error: None,
            rows: None,
        }
    }
}

/// What the file holds, as far as this process knows.
#[derive(Debug, Default)]
struct State {
    /// Number of valid entries; `None` until the file is counted for the first time.
    entries: Option<usize>,
    /// Size of the file in bytes after the last write.
    bytes: u64,
    /// Compactions performed; only observed by the tests.
    #[cfg(test)]
    compactions: usize,
}

pub struct QueryHistory {
    path: PathBuf,
    max_entries: usize,
    max_bytes: u64,
    state: Mutex<State>,
}

impl QueryHistory {
    /// Newest entries kept when the file is compacted.
    pub const DEFAULT_MAX_ENTRIES: usize = 5000;
    /// Size above which the file is compacted (once it exceeds it by the hysteresis margin).
    pub const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;

    pub fn new(path: impl AsRef<Path>) -> Self {
        Self::with_limits(path, Self::DEFAULT_MAX_ENTRIES, Self::DEFAULT_MAX_BYTES)
    }

    /// A history capped to `max_entries` entries and `max_bytes` bytes (the newest are kept).
    pub fn with_limits(path: impl AsRef<Path>, max_entries: usize, max_bytes: u64) -> Self {
        QueryHistory {
            path: path.as_ref().to_path_buf(),
            max_entries,
            max_bytes,
            state: Mutex::new(State::default()),
        }
    }

    pub fn append(&self, entry: &HistoryEntry) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if let Some(dir) = self.path.parent() {
            if !dir.as_os_str().is_empty() {
                fs::create_dir_all(dir)?;
            }
        }
        let mut line = serde_json::to_string(entry)?;
        line.push('\n');
        // A crash can leave a partial last line behind. Only the first append of a process can find
        // one; it must be terminated first, or the new entry would be glued to it and be lost.
        let separator = state.entries.is_none() && !ends_with_newline(&self.path)?;
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        if separator {
            f.write_all(b"\n")?;
        }
        f.write_all(line.as_bytes())?;
        // close before counting or compacting: Windows cannot rename a file that is still open
        drop(f);
        match state.entries {
            Some(n) => {
                state.entries = Some(n + 1);
                state.bytes += line.len() as u64;
            }
            None => {
                // first append of this process: count what was already on disk (the new line included)
                let (n, bytes) = count_and_size(&self.path)?;
                state.entries = Some(n);
                state.bytes = bytes;
            }
        }
        // Hysteresis: compact only once a limit is exceeded by a margin, then back down to the limit.
        // Otherwise every append would rewrite the whole file as soon as the cap is reached.
        let entries = state.entries.unwrap_or(0) as u64;
        if over_compaction_threshold(entries, self.max_entries as u64)
            || over_compaction_threshold(state.bytes, self.max_bytes)
        {
            self.compact(&mut state)?;
        }
        Ok(())
    }

    /// Rewrites the file with the newest entries that fit the limits, through a temp file + rename.
    fn compact(&self, state: &mut State) -> Result<()> {
        let entries = read_all(&self.path)?;
        let kept = newest_within_limits(entries, self.max_entries, self.max_bytes)?;
        let mut out = String::new();
        for e in &kept {
            out.push_str(&serde_json::to_string(e)?);
            out.push('\n');
        }
        write_atomic(&self.path, out.as_bytes())?;
        state.entries = Some(kept.len());
        state.bytes = out.len() as u64;
        #[cfg(test)]
        {
            state.compactions += 1;
        }
        Ok(())
    }

    fn read_all(&self) -> Result<Vec<HistoryEntry>> {
        let _g = self.state.lock().unwrap();
        read_all(&self.path)
    }

    /// Newest first.
    pub fn list(
        &self,
        data_source_id: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>> {
        Ok(self
            .read_all()?
            .into_iter()
            .rev()
            .filter(|e| {
                data_source_id
                    .map(|d| d == e.data_source_id)
                    .unwrap_or(true)
            })
            .skip(offset)
            .take(limit)
            .collect())
    }

    /// Case-insensitive substring search in the SQL text, newest first.
    pub fn search(
        &self,
        text: &str,
        data_source_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>> {
        let needle = text.to_lowercase();
        Ok(self
            .read_all()?
            .into_iter()
            .rev()
            .filter(|e| {
                data_source_id
                    .map(|d| d == e.data_source_id)
                    .unwrap_or(true)
            })
            .filter(|e| e.sql.to_lowercase().contains(&needle))
            .take(limit)
            .collect())
    }

    pub fn clear(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        *state = State::default();
        Ok(())
    }
}

/// Every valid entry of `path`, oldest first. Corrupt / partial lines are skipped.
fn read_all(path: &Path) -> Result<Vec<HistoryEntry>> {
    let f = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    Ok(BufReader::new(f)
        .lines()
        .map_while(|l| l.ok())
        .filter_map(|l| serde_json::from_str::<HistoryEntry>(&l).ok())
        .collect())
}

/// Number of valid entries and the size of the file in bytes.
fn count_and_size(path: &Path) -> Result<(usize, u64)> {
    let entries = read_all(path)?;
    let bytes = match fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e.into()),
    };
    Ok((entries.len(), bytes))
}

/// Whether a line can be appended to `path` as is: the file is empty or ends with a newline.
fn ends_with_newline(path: &Path) -> Result<bool> {
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(e.into()),
    };
    let len = f.metadata()?.len();
    if len == 0 {
        return Ok(true);
    }
    f.seek(SeekFrom::Start(len - 1))?;
    let mut last = [0u8; 1];
    f.read_exact(&mut last)?;
    Ok(last[0] == b'\n')
}

/// Whether `value` is far enough over `max` to justify a compaction: one fifth of the limit.
fn over_compaction_threshold(value: u64, max: u64) -> bool {
    value > max.saturating_add((max / 5).max(1))
}

/// The newest entries that fit `max_entries` and `max_bytes`, oldest first. The newest entry is always
/// kept, even when it alone is larger than `max_bytes`.
fn newest_within_limits(
    entries: Vec<HistoryEntry>,
    max_entries: usize,
    max_bytes: u64,
) -> Result<Vec<HistoryEntry>> {
    let mut kept = Vec::new();
    let mut bytes = 0u64;
    for e in entries.into_iter().rev() {
        if kept.len() >= max_entries {
            break;
        }
        let size = serde_json::to_string(&e)?.len() as u64 + 1;
        if !kept.is_empty() && bytes + size > max_bytes {
            break;
        }
        bytes += size;
        kept.push(e);
    }
    kept.reverse();
    Ok(kept)
}

/// Replace `path` through a temp file + rename, so a crash never leaves a half-written history.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compactions performed by `h` so far.
    fn compactions(h: &QueryHistory) -> usize {
        h.state.lock().unwrap().compactions
    }

    #[test]
    fn append_list_search_clear() {
        let dir = tempfile::tempdir().unwrap();
        let h = QueryHistory::new(dir.path().join("sub/history.jsonl"));
        assert!(h.list(None, 0, 10).unwrap().is_empty());
        for (ds, sql) in [
            ("a", "select 1"),
            ("b", "SELECT * FROM Orders"),
            ("a", "update t set x = 1"),
        ] {
            h.append(&HistoryEntry::new(ds, sql)).unwrap();
        }
        let all = h.list(None, 0, 10).unwrap();
        assert_eq!(
            all.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(),
            vec!["update t set x = 1", "SELECT * FROM Orders", "select 1"]
        );
        assert_eq!(h.list(Some("a"), 0, 10).unwrap().len(), 2);
        assert_eq!(h.list(None, 1, 1).unwrap()[0].sql, "SELECT * FROM Orders");
        assert_eq!(h.search("orders", None, 10).unwrap().len(), 1);
        assert_eq!(h.search("orders", Some("a"), 10).unwrap().len(), 0);
        // garbage line is skipped
        let mut f = OpenOptions::new()
            .append(true)
            .open(dir.path().join("sub/history.jsonl"))
            .unwrap();
        f.write_all(b"{not json\n").unwrap();
        assert_eq!(h.list(None, 0, 10).unwrap().len(), 3);
        h.clear().unwrap();
        assert!(h.list(None, 0, 10).unwrap().is_empty());
    }

    #[test]
    fn history_keeps_the_newest_entries_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        let h = QueryHistory::with_limits(&path, 3, u64::MAX);
        for i in 0..10 {
            h.append(&HistoryEntry::new("a", &format!("select {i}")))
                .unwrap();
        }
        let all = h.list(None, 0, 100).unwrap();
        // the newest entries, plus at most one compaction margin (3/5 rounds to 0, the margin is 1)
        assert_eq!(
            all.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(),
            vec!["select 9", "select 8", "select 7", "select 6"]
        );
        // the file itself was compacted, not just the view
        assert_eq!(
            fs::read_to_string(&path).unwrap().lines().count(),
            all.len()
        );
        assert!(all.len() < 10);
    }

    #[test]
    fn history_is_capped_by_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        let h = QueryHistory::with_limits(&path, usize::MAX, 600);
        let mut last = String::new();
        for i in 0..30 {
            last = format!("select {i} -- {}", "x".repeat(40));
            h.append(&HistoryEntry::new("a", &last)).unwrap();
        }
        let all = h.list(None, 0, 100).unwrap();
        assert!(all.len() < 30, "{}", all.len());
        assert_eq!(all[0].sql, last);
        // the file may overshoot the cap by the hysteresis margin before it is compacted again
        let margin = 600 + 600 / 5;
        assert!(fs::metadata(&path).unwrap().len() <= margin);
    }

    #[test]
    fn compaction_drops_corrupt_lines_and_keeps_the_file_readable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        let h = QueryHistory::with_limits(&path, 2, u64::MAX);
        h.append(&HistoryEntry::new("a", "select 1")).unwrap();
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{not json\n").unwrap();
        drop(f);
        h.append(&HistoryEntry::new("a", "select 2")).unwrap();
        h.append(&HistoryEntry::new("a", "select 3")).unwrap();
        // one append past the cap + margin, so the compaction runs and drops the corrupt line
        h.append(&HistoryEntry::new("a", "select 4")).unwrap();
        let all = h.list(None, 0, 10).unwrap();
        assert_eq!(
            all.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(),
            vec!["select 4", "select 3"]
        );
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
        // no temp file is left behind
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn the_newest_entry_survives_a_limit_smaller_than_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        let h = QueryHistory::with_limits(&path, 100, 1);
        h.append(&HistoryEntry::new("a", "select 1")).unwrap();
        h.append(&HistoryEntry::new("a", "select 2")).unwrap();
        let all = h.list(None, 0, 10).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].sql, "select 2");
    }

    #[test]
    fn the_compaction_threshold_leaves_a_fifth_of_the_limit_as_margin() {
        assert!(!over_compaction_threshold(5000, 5000));
        assert!(!over_compaction_threshold(6000, 5000));
        assert!(over_compaction_threshold(6001, 5000));
        assert!(!over_compaction_threshold(2, 1));
        assert!(over_compaction_threshold(3, 1));
        assert!(!over_compaction_threshold(u64::MAX, u64::MAX));
    }

    #[test]
    fn being_at_the_cap_does_not_rewrite_the_file_on_every_append() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        let h = QueryHistory::with_limits(&path, 10, u64::MAX);
        // 10 entries + a fifth of the cap fit before the first compaction
        for i in 0..12 {
            h.append(&HistoryEntry::new("a", &format!("select {i}")))
                .unwrap();
        }
        assert_eq!(compactions(&h), 0);
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 12);
        h.append(&HistoryEntry::new("a", "select 12")).unwrap();
        assert_eq!(compactions(&h), 1);
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 10);
    }

    #[test]
    fn appends_past_the_cap_compact_only_once_per_margin() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        let h = QueryHistory::with_limits(&path, 10, u64::MAX);
        for i in 0..100 {
            h.append(&HistoryEntry::new("a", &format!("select {i}")))
                .unwrap();
        }
        // the 13th entry crosses 10 + 10/5, then every third one crosses it again: 13, 16, .., 100
        assert_eq!(compactions(&h), 30);
        let all = h.list(None, 0, 1000).unwrap();
        assert_eq!(all.len(), 10);
        assert_eq!(all[0].sql, "select 99");
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 10);
    }

    #[test]
    fn counting_is_lazy_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        {
            let h = QueryHistory::with_limits(&path, 10, u64::MAX);
            for i in 0..13 {
                h.append(&HistoryEntry::new("a", &format!("select {i}")))
                    .unwrap();
            }
            assert_eq!(compactions(&h), 1);
        }
        // a new process recounts the file instead of trusting a stale in-memory count
        let h = QueryHistory::with_limits(&path, 10, u64::MAX);
        assert_eq!(h.list(None, 0, 100).unwrap().len(), 10);
        for i in 13..15 {
            h.append(&HistoryEntry::new("a", &format!("select {i}")))
                .unwrap();
        }
        assert_eq!(
            compactions(&h),
            0,
            "no compaction before the margin is crossed again"
        );
        h.append(&HistoryEntry::new("a", "select 15")).unwrap();
        assert_eq!(compactions(&h), 1);
        let all = h.list(None, 0, 100).unwrap();
        assert_eq!(all.len(), 10);
        assert_eq!(all[0].sql, "select 15");
    }

    #[test]
    fn a_partial_last_line_does_not_swallow_the_next_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        // what a crash in the middle of a write leaves behind
        fs::write(&path, "{\"id\":\"crash\"\n{\"id\":\"cut").unwrap();
        let h = QueryHistory::with_limits(&path, 2, u64::MAX);
        for i in 0..4 {
            h.append(&HistoryEntry::new("a", &format!("select {i}")))
                .unwrap();
        }
        let all = h.list(None, 0, 100).unwrap();
        assert_eq!(
            all.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(),
            vec!["select 3", "select 2"]
        );
        // the compaction dropped the partial lines instead of gluing them to an entry
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
    }
}
