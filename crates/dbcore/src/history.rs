//! Query history: an append-only JSON-lines file.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
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
            ts_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            data_source_id: data_source_id.to_string(),
            sql: sql.to_string(),
            duration_ms: None,
            ok: true,
            error: None,
            rows: None,
        }
    }
}

pub struct QueryHistory {
    path: PathBuf,
    lock: Mutex<()>,
}

impl QueryHistory {
    pub fn new(path: impl AsRef<Path>) -> Self {
        QueryHistory { path: path.as_ref().to_path_buf(), lock: Mutex::new(()) }
    }

    pub fn append(&self, entry: &HistoryEntry) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        if let Some(dir) = self.path.parent() {
            if !dir.as_os_str().is_empty() {
                fs::create_dir_all(dir)?;
            }
        }
        let mut f = OpenOptions::new().create(true).append(true).open(&self.path)?;
        let mut line = serde_json::to_string(entry)?;
        line.push('\n');
        f.write_all(line.as_bytes())?;
        Ok(())
    }

    fn read_all(&self) -> Result<Vec<HistoryEntry>> {
        let _g = self.lock.lock().unwrap();
        let f = match fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        // corrupt / partial lines are skipped
        Ok(BufReader::new(f)
            .lines()
            .map_while(|l| l.ok())
            .filter_map(|l| serde_json::from_str::<HistoryEntry>(&l).ok())
            .collect())
    }

    /// Newest first.
    pub fn list(&self, data_source_id: Option<&str>, offset: usize, limit: usize) -> Result<Vec<HistoryEntry>> {
        Ok(self
            .read_all()?
            .into_iter()
            .rev()
            .filter(|e| data_source_id.map(|d| d == e.data_source_id).unwrap_or(true))
            .skip(offset)
            .take(limit)
            .collect())
    }

    /// Case-insensitive substring search in the SQL text, newest first.
    pub fn search(&self, text: &str, data_source_id: Option<&str>, limit: usize) -> Result<Vec<HistoryEntry>> {
        let needle = text.to_lowercase();
        Ok(self
            .read_all()?
            .into_iter()
            .rev()
            .filter(|e| data_source_id.map(|d| d == e.data_source_id).unwrap_or(true))
            .filter(|e| e.sql.to_lowercase().contains(&needle))
            .take(limit)
            .collect())
    }

    pub fn clear(&self) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_list_search_clear() {
        let dir = tempfile::tempdir().unwrap();
        let h = QueryHistory::new(dir.path().join("sub/history.jsonl"));
        assert!(h.list(None, 0, 10).unwrap().is_empty());
        for (ds, sql) in [("a", "select 1"), ("b", "SELECT * FROM Orders"), ("a", "update t set x = 1")] {
            h.append(&HistoryEntry::new(ds, sql)).unwrap();
        }
        let all = h.list(None, 0, 10).unwrap();
        assert_eq!(all.iter().map(|e| e.sql.as_str()).collect::<Vec<_>>(), vec!["update t set x = 1", "SELECT * FROM Orders", "select 1"]);
        assert_eq!(h.list(Some("a"), 0, 10).unwrap().len(), 2);
        assert_eq!(h.list(None, 1, 1).unwrap()[0].sql, "SELECT * FROM Orders");
        assert_eq!(h.search("orders", None, 10).unwrap().len(), 1);
        assert_eq!(h.search("orders", Some("a"), 10).unwrap().len(), 0);
        // garbage line is skipped
        let mut f = OpenOptions::new().append(true).open(dir.path().join("sub/history.jsonl")).unwrap();
        f.write_all(b"{not json\n").unwrap();
        assert_eq!(h.list(None, 0, 10).unwrap().len(), 3);
        h.clear().unwrap();
        assert!(h.list(None, 0, 10).unwrap().is_empty());
    }
}
