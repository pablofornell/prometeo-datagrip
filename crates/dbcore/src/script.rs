//! Runs a SQL script file (a dump, a migration) on a data source, statement by statement.
//!
//! [`ConnectionManager::run_sql_file`] reads the file in pieces of about 1 MB (it is never loaded whole), cuts the
//! text into statements with the splitter of [`crate::split`] and runs them in order on a connection of its own.
//! A piece may end inside a statement, a `$$` body, a PL/SQL block or a UTF-8 character: the unfinished text waits
//! for the next piece. The last two statements of a piece are held back as well, because where a statement ends can
//! depend on the first word of the one after it (Oracle's `END;` followed by `PROCEDURE`), so a statement runs only
//! once the text that decides it has arrived.
//!
//! Failures are counted per statement. `stopOnError` stops at the first one; otherwise the run goes on. With
//! `singleTransaction` the run is one transaction: committed at the end, rolled back when it stops on an error or is
//! cancelled. When the run goes on after an error, each statement gets a savepoint so that one failing statement does
//! not abort the rest (PostgreSQL, SQLite). MySQL and Oracle get none: the server undoes a failing statement on its
//! own, and DDL commits the transaction at once (the savepoint would be gone), so the DDL of a "single transaction"
//! stays when the run is rolled back; [`ScriptSummary::ddl_committed`] says so. The savepoint statements are the
//! runner's own: when one fails the script is not charged with it. Oracle has no autocommit: outside a single
//! transaction each statement that succeeded is committed after it, as in the console's Auto mode.
//!
//! An unterminated string, comment or `$$` body makes the rest of the file one statement. The text kept for it is
//! capped at [`MAX_STATEMENT_BYTES`]; past that the run stops with "statement starting at line N is not terminated".

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::conn::{Conn, Live};
use crate::error::{DbError, Result};
use crate::exec::{conn_scalar, open_stream};
use crate::import::CancellationToken;
use crate::manager::{cancel_target_of, interrupt, ConnectionManager};
use crate::model::Driver;
use crate::quote::{first_keyword, quote_ident};
use crate::split::split_statements;

/// Bytes read from the file per piece.
pub const CHUNK_BYTES: usize = 1 << 20;
/// Longest statement the runner keeps in memory while it waits for the end of it.
pub const MAX_STATEMENT_BYTES: usize = 64 << 20;
/// Text of this size is cut on a blocking thread (a 1 MB piece takes a few ms; a huge open statement much more).
const CUT_OFF_THREAD_BYTES: usize = 256 << 10;
/// Pending text from this size on is cut again only after it has doubled (an open statement is not re-read at every piece).
const CUT_BACKOFF_BYTES: usize = 1 << 20;
/// Least time between two progress events.
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// How long closing an abandoned connection may take.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const SAVEPOINT: &str = "prometeo_script";

// ---------------------------------------------------------------- options / progress / result

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ScriptOptions {
    /// Stop at the first statement that fails (default). Off: the failures are counted and the run goes on.
    pub stop_on_error: bool,
    /// The run is one transaction (default): committed at the end, rolled back when it stops on an error or is
    /// cancelled. DDL on MySQL / Oracle is committed by the server itself and stays.
    pub single_transaction: bool,
    /// `UTF-8` (default; a byte order mark is dropped) or `ISO-8859-1`.
    pub encoding: String,
}

impl Default for ScriptOptions {
    fn default() -> Self {
        ScriptOptions {
            stop_on_error: true,
            single_transaction: true,
            encoding: "UTF-8".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptProgress {
    pub statements_done: u64,
    /// Bytes of the file read so far.
    pub bytes_done: u64,
    pub bytes_total: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptError {
    pub message: String,
    /// 1-based line of the file where the failing statement starts.
    pub line: u64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSummary {
    /// Statements that ran without error (also those of a transaction rolled back afterwards).
    pub ok: u64,
    pub failed: u64,
    /// The first failure; later ones are only counted.
    pub first_error: Option<ScriptError>,
    pub cancelled: bool,
    /// The single transaction was rolled back (see `ddl_committed` for what stays).
    pub rolled_back: bool,
    /// MySQL / Oracle with a single transaction: a DDL statement ran, and the server commits those by itself, so
    /// they stay even when `rolled_back`.
    pub ddl_committed: bool,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------- reading the file as text

/// A script file read as text, one piece of `chunk` bytes at a time. A UTF-8 character cut by the end of a piece
/// waits for the next one; a byte order mark at the start is dropped (UTF-8 only).
struct TextReader<R> {
    src: R,
    latin1: bool,
    chunk: usize,
    /// Bytes of an incomplete UTF-8 character at the end of the last piece.
    carry: Vec<u8>,
    /// Bytes read from the file so far.
    read: u64,
    bom_checked: bool,
    done: bool,
}

impl<R: Read> TextReader<R> {
    fn new(src: R, latin1: bool, chunk: usize) -> Self {
        TextReader {
            src,
            latin1,
            chunk: chunk.max(1),
            carry: Vec::new(),
            read: 0,
            bom_checked: false,
            done: false,
        }
    }

    /// The next piece of text (possibly empty); `None` after the last one.
    fn next_text(&mut self) -> Result<Option<String>> {
        if self.done {
            return Ok(None);
        }
        let keep = self.carry.len();
        let mut buf = std::mem::take(&mut self.carry);
        buf.resize(keep + self.chunk, 0);
        let n = read_some(&mut self.src, &mut buf[keep..])?;
        buf.truncate(keep + n);
        self.read += n as u64;
        let eof = n == 0;
        self.done = eof;
        if buf.is_empty() {
            return Ok(None);
        }
        let mut text = if self.latin1 {
            buf.iter().map(|&b| char::from(b)).collect::<String>()
        } else {
            let valid = match std::str::from_utf8(&buf) {
                Ok(_) => buf.len(),
                Err(e) if e.error_len().is_none() && !eof => e.valid_up_to(),
                Err(e) => {
                    let at = self.read - (keep + n) as u64 + e.valid_up_to() as u64;
                    return Err(DbError::InvalidArgument(format!(
                        "The file is not valid UTF-8 (byte {at}); open it with the ISO-8859-1 encoding"
                    )));
                }
            };
            self.carry = buf.split_off(valid);
            String::from_utf8(buf)
                .map_err(|_| DbError::InvalidArgument("The file is not valid UTF-8".into()))?
        };
        if !self.bom_checked && !text.is_empty() {
            self.bom_checked = true;
            if !self.latin1 && text.starts_with('\u{feff}') {
                text.drain(..'\u{feff}'.len_utf8());
            }
        }
        Ok(Some(text))
    }
}

fn read_some(src: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        match src.read(buf) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            r => return r,
        }
    }
}

/// The file as text in pieces of `chunk` bytes, and its size. `encoding` as in [`ScriptOptions`].
fn open_script(path: &Path, opts: &ScriptOptions, chunk: usize) -> Result<(TextReader<File>, u64)> {
    let latin1 = match opts.encoding.trim().to_ascii_uppercase().as_str() {
        "" | "UTF-8" | "UTF8" => false,
        "ISO-8859-1" => true,
        _ => {
            return Err(DbError::InvalidArgument(format!(
                "Unsupported encoding {}",
                opts.encoding
            )))
        }
    };
    let file = File::open(path)
        .map_err(|e| DbError::InvalidArgument(format!("Cannot open {}: {e}", path.display())))?;
    let md = file.metadata()?;
    if !md.is_file() {
        return Err(DbError::InvalidArgument(format!(
            "{} is not a file",
            path.display()
        )));
    }
    Ok((TextReader::new(file, latin1, chunk), md.len()))
}

// ---------------------------------------------------------------- cutting the text into statements

/// A statement ready to run and the line of the file where it starts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Cut {
    text: String,
    line: u64,
}

/// Cuts the text of a script into statements as the text arrives in pieces (see the module docs).
struct Cutter {
    driver: Driver,
    /// Text not run yet. The splitter's state at its start is `delimiter`.
    pending: String,
    /// Line (1-based) of the first character of `pending`.
    line: u64,
    /// MySQL: the delimiter the last `DELIMITER` line set (`None` = `;`).
    delimiter: Option<String>,
    /// Longest `pending` allowed while no statement is complete.
    max_bytes: usize,
    /// A large `pending` that yielded no statement is cut again only once it is this long (`0`: always).
    retry_at: usize,
    /// The last cut of a piece found no complete statement.
    stuck: bool,
    /// Line of the last statement of `pending` (the open one when `stuck`).
    open_line: u64,
}

impl Cutter {
    fn new(driver: Driver) -> Self {
        Cutter {
            driver,
            pending: String::new(),
            line: 1,
            delimiter: None,
            max_bytes: MAX_STATEMENT_BYTES,
            retry_at: 0,
            stuck: false,
            open_line: 1,
        }
    }

    /// The line where the statement that has no end yet starts, once its text is longer than the cap.
    fn overflow(&self) -> Option<u64> {
        (self.stuck && self.pending.len() > self.max_bytes).then_some(self.open_line)
    }

    fn push(&mut self, text: &str) {
        self.pending.push_str(text);
    }

    /// The statements that are complete: all of them at the end of the file (`last`), else all but the last two.
    /// The text of the others is dropped from `pending`.
    fn cut(&mut self, last: bool) -> Vec<Cut> {
        // text that did not end a statement last time and has hardly grown: reading it again would find nothing
        // (an unterminated string makes every re-read as long as the file read so far)
        if !last && self.stuck && self.pending.len() < self.retry_at {
            return Vec::new();
        }
        // the splitter must see the delimiter that was in force where `pending` starts
        let prefix = match (self.driver, &self.delimiter) {
            (Driver::MySql, Some(d)) => format!("DELIMITER {d}\n"),
            _ => String::new(),
        };
        let src = format!("{prefix}{}", self.pending);
        let mut stmts = split_statements(&src, self.driver);
        let held = if last { 0 } else { stmts.len().min(2) };
        let cut_at = stmts.get(stmts.len() - held).map_or(src.len(), |s| s.start);
        let last_start = stmts.last().map(|s| s.start);
        stmts.truncate(stmts.len() - held);

        let mut out = Vec::with_capacity(stmts.len());
        let mut at = prefix.len();
        let mut line = self.line;
        let mut delimiter = self.delimiter.clone();
        for s in stmts {
            let gap = &src[at..s.start];
            line += newlines(gap);
            delimiter = scan_delimiter(gap, self.driver, delimiter);
            at = s.end;
            let inner = newlines(&s.text);
            out.push(Cut { text: s.text, line });
            line += inner;
        }
        let gap = &src[at..cut_at];
        line += newlines(gap);
        delimiter = scan_delimiter(gap, self.driver, delimiter);

        self.open_line = match last_start {
            Some(at) => self.line + src.get(prefix.len()..at).map_or(0, newlines),
            None => self.line,
        };
        self.pending = src[cut_at..].to_string();
        self.line = line;
        self.delimiter = delimiter;
        self.stuck = !last && out.is_empty();
        self.retry_at = if self.stuck && self.pending.len() >= CUT_BACKOFF_BYTES {
            self.pending.len().saturating_mul(2)
        } else {
            0
        };
        out
    }
}

fn newlines(s: &str) -> u64 {
    s.bytes().filter(|&b| b == b'\n').count() as u64
}

/// The delimiter that a MySQL `DELIMITER` line in `gap` sets (the last one wins; `None` = `;`). Other text and other
/// dialects leave `current` as it is. `gap` is the text between two statements, where the splitter reads these lines.
fn scan_delimiter(gap: &str, driver: Driver, current: Option<String>) -> Option<String> {
    if driver != Driver::MySql {
        return current;
    }
    let mut delimiter = current;
    for line in gap.lines() {
        let t = line.trim_start();
        let Some(word) = t.get(..9) else { continue };
        let rest = &t[9..];
        if !word.eq_ignore_ascii_case("delimiter")
            || !matches!(rest.chars().next(), Some(' ' | '\t'))
        {
            continue;
        }
        if let Some(tok) = rest.split_whitespace().next() {
            delimiter = (tok != ";").then(|| tok.to_string());
        }
    }
    delimiter
}

// ---------------------------------------------------------------- statements around the script

/// The statement that makes `schema` the one that unqualified names resolve to on the connection (none for SQLite,
/// which has one schema per file).
fn schema_sql(d: Driver, schema: Option<&str>) -> Option<String> {
    let s = schema.filter(|s| !s.trim().is_empty())?;
    match d {
        Driver::Postgres => Some(format!("SET search_path TO {}", quote_ident(d, s))),
        Driver::MySql => Some(format!("USE {}", quote_ident(d, s))),
        Driver::Oracle => Some(format!(
            "ALTER SESSION SET CURRENT_SCHEMA = \"{}\"",
            s.replace('"', "\"\"")
        )),
        Driver::Sqlite => None,
    }
}

/// Opens the single transaction. On Oracle the first statement starts it; that statement only makes it explicit.
///
/// SQLite resolves the parent table of every foreign key when a statement is prepared (with foreign keys on), so a
/// dump that fills a child table before its parent exists would fail. `PRAGMA foreign_keys` cannot change inside a
/// transaction, so it is switched off here, before `BEGIN`; [`commit`] checks the foreign keys instead.
async fn begin(conn: &mut Conn, d: Driver, cancel: &CancellationToken) -> Result<()> {
    if d == Driver::Sqlite {
        run_c(conn, "pragma foreign_keys = off", cancel).await?;
    }
    let sqls: &[&str] = match d {
        // autocommit off: a DDL statement commits what came before, and what follows must not commit itself
        Driver::MySql => &["set autocommit = 0", "start transaction"],
        Driver::Oracle => &["set transaction read write"],
        _ => &["begin"],
    };
    for sql in sqls {
        run_c(conn, sql, cancel).await?;
    }
    Ok(())
}

/// Commits the single transaction. SQLite ran it without foreign key checks (see [`begin`]): the data is checked
/// here, so a violation rolls the whole run back. The check covers the whole database, not only the rows of the run.
async fn commit(conn: &mut Conn, d: Driver) -> Result<()> {
    if d == Driver::Sqlite {
        let first = conn_scalar(
            conn,
            "select 'table ' || \"table\" || ', row ' || coalesce(rowid, '?') || ' refers to ' || \"parent\" \
             from pragma_foreign_key_check limit 1",
        )
        .await?;
        if let Some(v) = first {
            return Err(DbError::InvalidArgument(format!(
                "The data breaks a foreign key ({v}); nothing of the run is kept"
            )));
        }
    }
    run_one(conn, "commit").await
}

/// Does the server commit the transaction by itself when it runs `sql`? MySQL and Oracle do for DDL and privilege
/// statements (also when they fail); the first word decides, which misses DDL inside a PL/SQL block.
fn commits_implicitly(d: Driver, sql: &str) -> bool {
    matches!(d, Driver::MySql | Driver::Oracle)
        && matches!(
            first_keyword(sql).as_str(),
            "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" | "COMMENT"
        )
}

/// Oracle has no autocommit. Outside a single transaction a script commits every statement that succeeded (as the
/// console's Auto mode does; without it the work of a script with no `COMMIT` is gone when the connection closes). The
/// server undid a failed statement already: what is left open is rolled back.
async fn oracle_auto_commit(conn: &mut Conn, ok: bool) -> Result<()> {
    let Conn::Ora(c) = conn else { return Ok(()) };
    if !c.in_transaction() {
        return Ok(());
    }
    if ok {
        c.commit().await
    } else {
        let _ = c.rollback().await;
        Ok(())
    }
}

/// A statement of the runner itself (a savepoint): `true` when it ran. Its failure is not the script's, so it is not
/// an error of the run (a script that ends the transaction on its own leaves no savepoint to release); only a cancel
/// is passed on.
async fn run_aux(conn: &mut Conn, sql: &str, cancel: &CancellationToken) -> Result<bool> {
    match run_c(conn, sql, cancel).await {
        Ok(()) => Ok(true),
        Err(DbError::Cancelled) => Err(DbError::Cancelled),
        Err(_) => Ok(false),
    }
}

/// [`Cutter::cut`], on a blocking thread when there is much text (the splitter reads all of it).
async fn cut_text(mut cutter: Cutter, last: bool) -> Result<(Cutter, Vec<Cut>)> {
    if cutter.pending.len() < CUT_OFF_THREAD_BYTES {
        let cuts = cutter.cut(last);
        return Ok((cutter, cuts));
    }
    tokio::task::spawn_blocking(move || {
        let cuts = cutter.cut(last);
        (cutter, cuts)
    })
    .await
    .map_err(|e| DbError::InvalidArgument(format!("internal error: {e}")))
}

/// The rest of the file cannot be run (unreadable text, a statement that never ends). When nothing ran yet that is an
/// error of the call; after statements ran the summary still comes back, with this as a failure.
fn input_error(res: &mut ScriptSummary, e: DbError, line: u64) -> Result<()> {
    if res.ok + res.failed == 0 {
        return Err(e);
    }
    res.failed += 1;
    res.first_error.get_or_insert(ScriptError {
        message: first_line(&e),
        line,
    });
    Ok(())
}

/// Size of a statement in the file (Latin-1 text is one byte per character).
fn text_bytes(text: &str, latin1: bool) -> u64 {
    if latin1 {
        text.chars().count() as u64
    } else {
        text.len() as u64
    }
}

/// The first line of an error (the server's message; PostgreSQL adds details below it).
fn first_line(e: &DbError) -> String {
    e.to_string().lines().next().unwrap_or("").to_string()
}

/// Runs one statement and drains its rows.
async fn run_one(conn: &mut Conn, sql: &str) -> Result<()> {
    let mut stream = open_stream(conn, sql);
    while let Some(item) = stream.next().await {
        item?;
    }
    Ok(())
}

/// [`run_one`], abandoned with [`DbError::Cancelled`] as soon as `cancel` fires (a statement blocked on a lock does not
/// return by itself). The connection is in an unknown state then: the caller interrupts the server and closes it.
async fn run_c(conn: &mut Conn, sql: &str, cancel: &CancellationToken) -> Result<()> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(DbError::Cancelled),
        r = run_one(conn, sql) => r,
    }
}

// ---------------------------------------------------------------- the run

/// Runs the statements of `reader` on a new connection of `live`. `bytes_total` is the size of the file (progress).
#[allow(clippy::too_many_arguments)]
async fn run_script<R: Read, P: FnMut(ScriptProgress)>(
    live: &Live,
    schema: Option<&str>,
    mut reader: TextReader<R>,
    bytes_total: u64,
    opts: &ScriptOptions,
    cancel: &CancellationToken,
    mut progress: P,
) -> Result<ScriptSummary> {
    let started = Instant::now();
    let d = live.driver();
    let single = opts.single_transaction;
    // a savepoint per statement only where the run goes on after an error inside one transaction and the server needs
    // it: PostgreSQL aborts the transaction at an error. MySQL and Oracle undo the failing statement alone, and their
    // DDL commits the transaction, which would take the savepoint with it.
    let savepoints =
        single && !opts.stop_on_error && matches!(d, Driver::Postgres | Driver::Sqlite);
    let mut conn = live.new_conn().await?;
    let cancel_target = cancel_target_of(&mut conn).await?;
    let mut res = ScriptSummary::default();
    let mut last_report = Instant::now();
    // bytes of the statements run so far
    let mut done_bytes: u64 = 0;
    // the rest of the file was not read (unreadable text, a statement without an end)
    let mut aborted = false;
    let mut at_end = false;

    let outcome: Result<()> = async {
        if let Some(sql) = schema_sql(d, schema) {
            run_c(&mut conn, &sql, cancel).await?;
        }
        if single {
            begin(&mut conn, d, cancel).await?;
        }
        let mut cutter = Cutter::new(d);
        let mut stop = false;
        loop {
            // checked per piece too: a piece may hold one long statement and no statement ends for a while
            if cancel.is_cancelled() {
                res.cancelled = true;
                break;
            }
            let text = match reader.next_text() {
                Ok(t) => t,
                Err(e) => {
                    // unreadable text: after statements ran, the summary says how far the run got
                    input_error(&mut res, e, cutter.line + newlines(&cutter.pending))?;
                    aborted = true;
                    break;
                }
            };
            let more = text.is_some();
            if let Some(t) = &text {
                cutter.push(t);
            }
            let (c, cuts) = cut_text(cutter, !more).await?;
            cutter = c;
            if let Some(line) = cutter.overflow() {
                let e = DbError::InvalidArgument(format!(
                    "The statement starting at line {line} is not terminated (it is longer than {} MB)",
                    cutter.max_bytes >> 20
                ));
                input_error(&mut res, e, line)?;
                aborted = true;
                break;
            }
            for cut in cuts {
                if cancel.is_cancelled() {
                    res.cancelled = true;
                    break;
                }
                let sp = savepoints
                    && run_aux(&mut conn, &format!("savepoint {SAVEPOINT}"), cancel).await?;
                let mut ran = run_c(&mut conn, &cut.text, cancel).await;
                if d == Driver::Oracle && !single && !matches!(ran, Err(DbError::Cancelled)) {
                    let committed = oracle_auto_commit(&mut conn, ran.is_ok()).await;
                    ran = ran.and(committed);
                }
                if single && commits_implicitly(d, &cut.text) {
                    res.ddl_committed = true;
                }
                match ran {
                    Ok(()) => {
                        res.ok += 1;
                        if sp {
                            run_aux(
                                &mut conn,
                                &format!("release savepoint {SAVEPOINT}"),
                                cancel,
                            )
                            .await?;
                        }
                    }
                    Err(DbError::Cancelled) => return Err(DbError::Cancelled),
                    Err(e) => {
                        if sp {
                            run_aux(
                                &mut conn,
                                &format!("rollback to savepoint {SAVEPOINT}"),
                                cancel,
                            )
                            .await?;
                            run_aux(
                                &mut conn,
                                &format!("release savepoint {SAVEPOINT}"),
                                cancel,
                            )
                            .await?;
                        }
                        res.failed += 1;
                        res.first_error.get_or_insert(ScriptError {
                            message: first_line(&e),
                            line: cut.line,
                        });
                        // a connection that died cannot run the rest either
                        stop = opts.stop_on_error || e.is_connection_lost();
                    }
                }
                done_bytes += text_bytes(&cut.text, reader.latin1);
                if last_report.elapsed() >= PROGRESS_EVERY {
                    progress(ScriptProgress {
                        statements_done: res.ok + res.failed,
                        bytes_done: done_bytes.min(reader.read),
                        bytes_total,
                    });
                    last_report = Instant::now();
                }
                if stop {
                    break;
                }
            }
            if res.cancelled || stop || aborted || !more {
                at_end = !more && !res.cancelled && !stop && !aborted;
                break;
            }
        }
        Ok(())
    }
    .await;

    match outcome {
        Err(DbError::Cancelled) => {
            res.cancelled = true;
            // stop what the server is running (a statement waiting for a lock), then drop the connection: the
            // server rolls the open transaction back
            interrupt(&live.pool, &cancel_target).await;
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, conn.close()).await;
            res.rolled_back = single;
        }
        Err(e) => {
            if single {
                let _ = run_one(&mut conn, "rollback").await;
            }
            conn.close().await;
            return Err(e);
        }
        Ok(()) => {
            if single {
                let keep = !res.cancelled && !aborted && !(opts.stop_on_error && res.failed > 0);
                if keep {
                    if let Err(e) = commit(&mut conn, d).await {
                        let _ = run_one(&mut conn, "rollback").await;
                        conn.close().await;
                        return Err(e);
                    }
                } else {
                    let _ = run_one(&mut conn, "rollback").await;
                    res.rolled_back = true;
                }
            }
            conn.close().await;
        }
    }
    res.elapsed_ms = started.elapsed().as_millis() as u64;
    progress(ScriptProgress {
        statements_done: res.ok + res.failed,
        // the whole file when the run got to its end (comments and the gaps between statements are not counted
        // statement by statement)
        bytes_done: if at_end {
            reader.read
        } else {
            done_bytes.min(reader.read)
        },
        bytes_total,
    });
    Ok(res)
}

impl ConnectionManager {
    /// Runs the SQL script in `path` on the data source `ds_id`. `schema` makes it the schema of unqualified names
    /// (PostgreSQL search path, MySQL database, Oracle current schema). `cancel` stops the run: the statement in
    /// progress is interrupted and the rest is not run (the summary says `cancelled`). `progress` is called about
    /// every 100 ms and once at the end. Errors of statements are counted in the summary, not returned.
    pub async fn run_sql_file(
        &self,
        ds_id: &str,
        schema: Option<&str>,
        path: &Path,
        opts: &ScriptOptions,
        cancel: &CancellationToken,
        progress: impl FnMut(ScriptProgress),
    ) -> Result<ScriptSummary> {
        let (reader, total) = open_script(path, opts, CHUNK_BYTES)?;
        let live = self.live(ds_id)?;
        run_script(&live, schema, reader, total, opts, cancel, progress).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pieces of `bytes` read `chunk` bytes at a time.
    fn pieces(bytes: &[u8], latin1: bool, chunk: usize) -> Result<Vec<String>> {
        let mut r = TextReader::new(bytes, latin1, chunk);
        let mut out = Vec::new();
        while let Some(t) = r.next_text()? {
            out.push(t);
        }
        Ok(out)
    }

    /// Statements of `sql` cut from pieces of `step` characters, as (text, line).
    fn cut_in_pieces(sql: &str, d: Driver, step: usize) -> Vec<(String, u64)> {
        let mut c = Cutter::new(d);
        let mut out = Vec::new();
        let chars: Vec<char> = sql.chars().collect();
        for piece in chars.chunks(step) {
            c.push(&piece.iter().collect::<String>());
            out.extend(c.cut(false).into_iter().map(|x| (x.text, x.line)));
        }
        out.extend(c.cut(true).into_iter().map(|x| (x.text, x.line)));
        out
    }

    /// The same statements from splitting the whole text at once, with their lines.
    fn whole(sql: &str, d: Driver) -> Vec<(String, u64)> {
        split_statements(sql, d)
            .into_iter()
            .map(|s| {
                let line = 1 + newlines(&sql[..s.start]);
                (s.text, line)
            })
            .collect()
    }

    #[test]
    fn utf8_pieces_join_to_the_text_at_every_piece_size() {
        let text = "select 'héllo 😀';\nselect 'é';";
        for chunk in 1..=7 {
            let joined: String = pieces(text.as_bytes(), false, chunk).unwrap().concat();
            assert_eq!(joined, text, "chunk {chunk}");
        }
    }

    #[test]
    fn a_byte_order_mark_is_dropped_from_utf8_only() {
        let bom = [0xEF, 0xBB, 0xBF];
        let mut bytes = bom.to_vec();
        bytes.extend_from_slice(b"select 1");
        for chunk in [1, 2, 3, 100] {
            assert_eq!(
                pieces(&bytes, false, chunk).unwrap().concat(),
                "select 1",
                "chunk {chunk}"
            );
        }
        // in Latin-1 these are three characters of text
        assert_eq!(pieces(&bom, true, 1).unwrap().concat(), "ï»¿");
    }

    #[test]
    fn latin1_decodes_every_byte() {
        assert_eq!(
            pieces(&[0x63, 0xE9, 0xFF], true, 2).unwrap().concat(),
            "cé\u{ff}"
        );
    }

    #[test]
    fn invalid_utf8_is_an_error_with_its_byte_offset() {
        let err = pieces(b"select 1;\xff", false, 3).unwrap_err();
        assert!(err.to_string().contains("byte 9"), "{err}");
        // a character cut at the very end of the file is invalid too
        let err = pieces(b"select '\xc3", false, 64).unwrap_err();
        assert!(err.to_string().contains("not valid UTF-8"), "{err}");
    }

    #[test]
    fn the_cut_statements_are_those_of_the_whole_file_at_every_piece_size() {
        let scripts = [
            (
                Driver::Postgres,
                "create function f() returns int as $$ begin; select 1; end; $$ language plpgsql;\n-- note; here\nselect 'a;b';\nselect E'x\\';y';\nselect $t$ $x$ ; $t$;\ncreate function g() returns int begin atomic select 1; end;\nselect 2;\n",
            ),
            (
                Driver::MySql,
                "DELIMITER //\ncreate procedure p() begin select 1; select 2; end//\nDELIMITER ;\nselect 3;\n/*!40101 SET NAMES utf8 */;\nselect 'x\\'y;';\n",
            ),
            (
                Driver::Sqlite,
                "create trigger tr after insert on t begin update x set a = 1; insert into log values (1); end;\nselect 'é;';\nselect 2;",
            ),
            (
                Driver::Oracle,
                "create or replace procedure p as\nbegin\n  null;\nend;\n/\nselect 4 / 2 from dual;\nbegin\n  insert into t values ('a;b');\nend;\n/\nselect 1 from dual\n/\ndeclare\n  procedure q is begin null; end;\nbegin\n  q;\nend;\n/\n",
            ),
        ];
        for (d, sql) in scripts {
            let expected = whole(sql, d);
            assert!(expected.len() >= 3, "{d:?}: {expected:?}");
            let n = sql.chars().count();
            for step in 1..=n {
                assert_eq!(
                    cut_in_pieces(sql, d, step),
                    expected,
                    "{d:?} piece of {step} characters"
                );
            }
        }
    }

    #[test]
    fn a_statement_across_a_piece_boundary_waits_for_its_end() {
        let mut c = Cutter::new(Driver::Postgres);
        c.push("select 1; select 2; select ");
        let first = c.cut(false);
        assert_eq!(
            first,
            vec![Cut {
                text: "select 1".into(),
                line: 1
            }]
        );
        c.push("3; select 4;");
        let next = c.cut(false);
        assert_eq!(
            next,
            vec![Cut {
                text: "select 2".into(),
                line: 1
            }]
        );
        let last = c.cut(true);
        assert_eq!(
            last,
            vec![
                Cut {
                    text: "select 3".into(),
                    line: 1
                },
                Cut {
                    text: "select 4".into(),
                    line: 1
                }
            ]
        );
    }

    #[test]
    fn lines_count_from_the_start_of_the_file() {
        let sql = "select 1;\n\nselect\n  2;\nselect 3";
        let lines: Vec<u64> = cut_in_pieces(sql, Driver::Postgres, 4)
            .iter()
            .map(|c| c.1)
            .collect();
        assert_eq!(lines, vec![1, 3, 5]);
    }

    #[test]
    fn scan_delimiter_follows_the_last_directive_of_mysql() {
        let g = "\n  DELIMITER //\n";
        assert_eq!(scan_delimiter(g, Driver::MySql, None), Some("//".into()));
        assert_eq!(
            scan_delimiter("delimiter ;;\nDelimiter ;\n", Driver::MySql, None),
            None
        );
        assert_eq!(scan_delimiter("delimiters x", Driver::MySql, None), None);
        assert_eq!(scan_delimiter(g, Driver::Sqlite, None), None);
        assert_eq!(
            scan_delimiter("select 1", Driver::MySql, Some("//".into())),
            Some("//".into())
        );
    }

    #[test]
    fn the_schema_statement_per_dialect() {
        assert_eq!(
            schema_sql(Driver::Postgres, Some("public")).as_deref(),
            Some("SET search_path TO \"public\"")
        );
        assert_eq!(
            schema_sql(Driver::MySql, Some("demo")).as_deref(),
            Some("USE `demo`")
        );
        assert_eq!(
            schema_sql(Driver::Oracle, Some("we\"ird")).as_deref(),
            Some("ALTER SESSION SET CURRENT_SCHEMA = \"we\"\"ird\"")
        );
        assert_eq!(schema_sql(Driver::Sqlite, Some("main")), None);
        assert_eq!(schema_sql(Driver::Postgres, None), None);
        assert_eq!(schema_sql(Driver::Postgres, Some("  ")), None);
    }

    #[test]
    fn ddl_of_mysql_and_oracle_commits_implicitly() {
        for d in [Driver::MySql, Driver::Oracle] {
            for sql in [
                "create table t (a int)",
                "  -- note\n ALTER TABLE t ADD b int",
                "/* c */ drop table t",
                "truncate table t",
                "grant select on t to u",
                "create or replace procedure p as begin null; end;",
            ] {
                assert!(commits_implicitly(d, sql), "{d:?}: {sql}");
            }
            for sql in [
                "insert into t values (1)",
                "select 1",
                "begin null; end;",
                "update t set a = 1",
            ] {
                assert!(!commits_implicitly(d, sql), "{d:?}: {sql}");
            }
        }
        // PostgreSQL and SQLite have transactional DDL
        assert!(!commits_implicitly(
            Driver::Postgres,
            "create table t (a int)"
        ));
        assert!(!commits_implicitly(Driver::Sqlite, "drop table t"));
    }

    #[test]
    fn a_statement_that_never_ends_is_refused_at_the_cap() {
        let mut c = Cutter::new(Driver::Postgres);
        c.max_bytes = 100;
        c.push("select 1;\nselect 'open ");
        assert_eq!(c.cut(false), vec![]);
        assert_eq!(c.overflow(), None, "still below the cap");
        c.push(&"x".repeat(200));
        assert_eq!(c.cut(false), vec![]);
        assert_eq!(c.overflow(), Some(2), "the open statement starts at line 2");
    }

    #[test]
    fn an_open_statement_is_not_read_again_at_every_piece() {
        let sql = format!(
            "select 'x{}';\nselect 2;\nselect 3;\nselect 4;\n",
            "a".repeat(CUT_BACKOFF_BYTES + 1000)
        );
        let mut c = Cutter::new(Driver::Postgres);
        let chars: Vec<char> = sql.chars().collect();
        let mut out = Vec::new();
        let mut skipped = 0;
        for piece in chars.chunks(CUT_BACKOFF_BYTES / 4) {
            c.push(&piece.iter().collect::<String>());
            let before = c.pending.len();
            let cuts = c.cut(false);
            if cuts.is_empty() && c.pending.len() == before && c.retry_at > 0 {
                skipped += 1;
            }
            out.extend(cuts.into_iter().map(|x| (x.text, x.line)));
        }
        out.extend(c.cut(true).into_iter().map(|x| (x.text, x.line)));
        // the statements come out the same, in order
        assert_eq!(out, whole(&sql, Driver::Postgres));
        assert!(c.retry_at == 0 && skipped >= 1, "skipped {skipped}");
    }

    // ------------------------------------------------------------ against SQLite (no server)

    async fn lite(dir: &Path) -> ConnectionManager {
        let mgr = ConnectionManager::new();
        let cfg = crate::DataSourceConfig {
            id: "lite".into(),
            name: "lite".into(),
            driver: Driver::Sqlite,
            file: dir.join("db.sqlite").display().to_string(),
            options: [("create".to_string(), "true".to_string())].into(),
            ..Default::default()
        };
        mgr.connect(&cfg).await.unwrap();
        mgr
    }

    fn script_file(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    /// Rows of a query on the test database (values as text, NULL = None).
    async fn rows(mgr: &ConnectionManager, sql: &str) -> Vec<Vec<Option<String>>> {
        mgr.live("lite")
            .unwrap()
            .pool
            .query_strings(sql)
            .await
            .unwrap()
    }

    fn texts(rows: &[Vec<Option<String>>]) -> Vec<String> {
        rows.iter()
            .map(|r| r[0].clone().unwrap_or_default())
            .collect()
    }

    async fn run_in_pieces(
        mgr: &ConnectionManager,
        path: &Path,
        opts: &ScriptOptions,
        chunk: usize,
        cancel: &CancellationToken,
    ) -> ScriptSummary {
        let (reader, total) = open_script(path, opts, chunk).unwrap();
        let live = mgr.live("lite").unwrap();
        run_script(&live, None, reader, total, opts, cancel, |_| {})
            .await
            .unwrap()
    }

    /// The default options without the single transaction: each statement stays when a later one fails.
    fn autocommit() -> ScriptOptions {
        ScriptOptions {
            single_transaction: false,
            ..Default::default()
        }
    }

    async fn run(mgr: &ConnectionManager, path: &Path, opts: &ScriptOptions) -> ScriptSummary {
        run_in_pieces(mgr, path, opts, CHUNK_BYTES, &CancellationToken::new()).await
    }

    #[tokio::test]
    async fn stop_on_error_stops_at_the_first_failing_statement() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        let path = script_file(
            dir.path(),
            "a.sql",
            b"create table t (a integer);\ninsert into t values (1);\ninsert into nope values (2);\ninsert into t values (3);\n",
        );
        let sum = run(&mgr, &path, &autocommit()).await;
        assert_eq!(
            (sum.ok, sum.failed, sum.cancelled, sum.rolled_back),
            (2, 1, false, false)
        );
        let e = sum.first_error.unwrap();
        assert_eq!(e.line, 3);
        assert!(e.message.contains("no such table"), "{}", e.message);
        assert_eq!(
            texts(&rows(&mgr, "select a from t order by a").await),
            vec!["1"]
        );
    }

    #[tokio::test]
    async fn continuing_after_errors_runs_the_rest_and_counts_them() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        let path = script_file(
            dir.path(),
            "b.sql",
            b"create table c (a integer);\ninsert into nope values (0);\ninsert into c values (1);\ninsert into c values (1, 2);\ninsert into c values (3);\n",
        );
        let opts = ScriptOptions {
            stop_on_error: false,
            ..Default::default()
        };
        let sum = run(&mgr, &path, &opts).await;
        assert_eq!((sum.ok, sum.failed), (3, 2));
        assert_eq!(sum.first_error.unwrap().line, 2);
        assert_eq!(
            texts(&rows(&mgr, "select a from c order by a").await),
            vec!["1", "3"]
        );
    }

    #[tokio::test]
    async fn a_single_transaction_is_rolled_back_when_the_run_stops_on_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        mgr.live("lite")
            .unwrap()
            .pool
            .exec("create table s (a integer)")
            .await
            .unwrap();
        let path = script_file(
            dir.path(),
            "s.sql",
            b"insert into s values (1);\ninsert into nope values (2);\ninsert into s values (3);\n",
        );
        let opts = ScriptOptions {
            single_transaction: true,
            ..Default::default()
        };
        let sum = run(&mgr, &path, &opts).await;
        assert_eq!((sum.ok, sum.failed, sum.rolled_back), (1, 1, true));
        assert!(rows(&mgr, "select a from s").await.is_empty());
    }

    #[tokio::test]
    async fn a_single_transaction_that_goes_on_after_errors_is_committed() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        mgr.live("lite")
            .unwrap()
            .pool
            .exec("create table g (a integer)")
            .await
            .unwrap();
        let path = script_file(
            dir.path(),
            "g.sql",
            b"insert into g values (1);\ninsert into nope values (2);\ninsert into g values (3);\n",
        );
        let opts = ScriptOptions {
            single_transaction: true,
            stop_on_error: false,
            ..Default::default()
        };
        let sum = run(&mgr, &path, &opts).await;
        assert_eq!((sum.ok, sum.failed, sum.rolled_back), (2, 1, false));
        assert_eq!(
            texts(&rows(&mgr, "select a from g order by a").await),
            vec!["1", "3"]
        );
    }

    #[tokio::test]
    async fn a_single_transaction_checks_foreign_keys_at_the_commit() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        let live = mgr.live("lite").unwrap();
        live.pool
            .exec("create table fp (id integer primary key)")
            .await
            .unwrap();
        live.pool
            .exec("create table fc (p integer references fp (id))")
            .await
            .unwrap();
        let opts = ScriptOptions {
            single_transaction: true,
            ..Default::default()
        };
        // the child row comes first: fine, its parent exists at the commit
        let path = script_file(
            dir.path(),
            "fk1.sql",
            b"insert into fc values (1);\ninsert into fp values (1);\n",
        );
        let sum = run(&mgr, &path, &opts).await;
        assert_eq!(
            (sum.ok, sum.failed, sum.rolled_back),
            (2, 0, false),
            "{:?}",
            sum.first_error
        );
        assert_eq!(texts(&rows(&mgr, "select p from fc").await), vec!["1"]);

        // a child without a parent fails the commit: the run is rolled back as a whole, error returned
        let path = script_file(
            dir.path(),
            "fk2.sql",
            b"insert into fp values (2);\ninsert into fc values (9);\n",
        );
        let (reader, total) = open_script(&path, &opts, CHUNK_BYTES).unwrap();
        let err = run_script(
            &live,
            None,
            reader,
            total,
            &opts,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("foreign key"), "{err}");
        assert_eq!(
            texts(&rows(&mgr, "select id from fp order by id").await),
            vec!["1"]
        );
    }

    #[tokio::test]
    async fn a_byte_order_mark_and_multi_byte_text_survive_every_piece_size() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        for chunk in [1usize, 2, 3, 5, 64 << 10] {
            // one table and one trigger per run: the runs share the database
            let name = format!("m{chunk}");
            let script = format!(
                "create table {name} (id integer, s text);\ninsert into {name} values (1, 'héllo 😀;');\n\
                 create trigger t_{name} after insert on {name} begin update {name} set s = s || ' é' where id = new.id; end;\n\
                 insert into {name} values (2, 'ü');\n"
            );
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(script.as_bytes());
            let path = script_file(dir.path(), &format!("{name}.sql"), &bytes);
            let sum = run_in_pieces(
                &mgr,
                &path,
                &ScriptOptions::default(),
                chunk,
                &CancellationToken::new(),
            )
            .await;
            assert_eq!(
                (sum.ok, sum.failed),
                (4, 0),
                "chunk {chunk}: {:?}",
                sum.first_error
            );
            assert_eq!(
                texts(&rows(&mgr, &format!("select s from {name} order by id")).await),
                // row 1 was inserted before the trigger existed; row 2 went through it
                vec!["héllo 😀;", "ü é"],
                "chunk {chunk}"
            );
        }
    }

    #[tokio::test]
    async fn latin1_files_are_decoded_with_the_encoding_option() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        mgr.live("lite")
            .unwrap()
            .pool
            .exec("create table l (s text)")
            .await
            .unwrap();
        let path = script_file(dir.path(), "l.sql", b"insert into l values ('caf\xe9');\n");
        let opts = ScriptOptions {
            encoding: "ISO-8859-1".into(),
            ..Default::default()
        };
        let sum = run(&mgr, &path, &opts).await;
        assert_eq!(sum.ok, 1);
        assert_eq!(texts(&rows(&mgr, "select s from l").await), vec!["café"]);
    }

    #[tokio::test]
    async fn a_cancel_before_the_run_runs_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        mgr.live("lite")
            .unwrap()
            .pool
            .exec("create table x (a integer)")
            .await
            .unwrap();
        let path = script_file(
            dir.path(),
            "x.sql",
            b"insert into x values (1);\ninsert into x values (2);\n",
        );
        let cancel = CancellationToken::new();
        cancel.cancel();
        let sum = run_in_pieces(&mgr, &path, &ScriptOptions::default(), CHUNK_BYTES, &cancel).await;
        assert_eq!((sum.ok, sum.failed, sum.cancelled), (0, 0, true));
        assert!(rows(&mgr, "select a from x").await.is_empty());
    }

    #[tokio::test]
    async fn a_cancel_stops_the_statement_that_is_running() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        // never ends on its own: only the interrupt stops it
        let path = script_file(
            dir.path(),
            "forever.sql",
            b"with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c;\n",
        );
        let cancel = CancellationToken::new();
        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            stopper.cancel();
        });
        let sum = tokio::time::timeout(
            Duration::from_secs(20),
            run_in_pieces(&mgr, &path, &ScriptOptions::default(), CHUNK_BYTES, &cancel),
        )
        .await
        .expect("the cancel did not stop the statement");
        assert_eq!((sum.ok, sum.failed, sum.cancelled), (0, 0, true));
    }

    #[tokio::test]
    async fn progress_reports_the_bytes_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        let text = "select 1;\nselect 2;\nselect 3;\n";
        let path = script_file(dir.path(), "p.sql", text.as_bytes());
        let live = mgr.live("lite").unwrap();
        let opts = ScriptOptions::default();
        let (reader, total) = open_script(&path, &opts, 4).unwrap();
        let mut seen = Vec::new();
        let sum = run_script(
            &live,
            None,
            reader,
            total,
            &opts,
            &CancellationToken::new(),
            |p| seen.push(p),
        )
        .await
        .unwrap();
        assert_eq!(sum.ok, 3);
        let last = seen.last().unwrap();
        assert_eq!(
            (last.statements_done, last.bytes_done, last.bytes_total),
            (3, text.len() as u64, text.len() as u64)
        );
    }

    #[tokio::test]
    async fn invalid_text_after_statements_ran_still_returns_the_summary() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        let mut bytes = b"create table if not exists u (a integer);\n".to_vec();
        for i in 1..=4 {
            bytes.extend_from_slice(format!("insert into u values ({i});\n").as_bytes());
        }
        let first = bytes.len();
        bytes.extend_from_slice(b"insert into u values (9);\n\xff\xfe broken\n");
        let path = script_file(dir.path(), "bad.sql", &bytes);
        let sum = run_in_pieces(&mgr, &path, &autocommit(), first, &CancellationToken::new()).await;
        // five statements fit the first piece; the last two wait for the next one, which cannot be read
        assert_eq!((sum.ok, sum.failed), (3, 1));
        let e = sum.first_error.unwrap();
        assert!(e.message.contains("UTF-8"), "{}", e.message);
        assert_eq!(e.line, 6);
        assert_eq!(
            texts(&rows(&mgr, "select a from u order by a").await),
            vec!["1", "2"]
        );

        // in a single transaction nothing of a run cut short stays
        let single = ScriptOptions {
            single_transaction: true,
            ..Default::default()
        };
        mgr.live("lite")
            .unwrap()
            .pool
            .exec("delete from u")
            .await
            .unwrap();
        let sum = run_in_pieces(&mgr, &path, &single, first, &CancellationToken::new()).await;
        assert_eq!((sum.ok, sum.failed, sum.rolled_back), (3, 1, true));
        assert!(rows(&mgr, "select a from u").await.is_empty());
    }

    #[tokio::test]
    async fn an_open_statement_past_the_cap_ends_the_run_with_its_line() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        let mut text = String::from("create table o (a integer);\n");
        for i in 0..4 {
            text.push_str(&format!("insert into o values ({i});\n"));
        }
        text.push_str("insert into o values ('never closed\n");
        // 65 MB with no closing quote: more than the cap
        let mut bytes = text.into_bytes();
        bytes.extend(std::iter::repeat_n(b'y', MAX_STATEMENT_BYTES + (1 << 20)));
        let path = script_file(dir.path(), "open.sql", &bytes);
        let started = Instant::now();
        let sum = run(&mgr, &path, &ScriptOptions::default()).await;
        // the statements before it ran (the last two of the first piece wait for their end: one is the open one)
        assert_eq!((sum.ok, sum.failed), (4, 1), "{:?}", sum.first_error);
        let e = sum.first_error.unwrap();
        assert!(e.message.contains("is not terminated"), "{}", e.message);
        assert_eq!(e.line, 6);
        // read again only when the text has doubled, not at every piece
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn progress_is_reported_per_statement_not_per_piece() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = lite(dir.path()).await;
        // each statement takes well over 100 ms; the file is one piece
        let slow = "with recursive c(x) as (select 1 union all select x + 1 from c where x < 3000000) select count(*) from c;\n";
        let text = slow.repeat(4);
        let path = script_file(dir.path(), "slow.sql", text.as_bytes());
        let live = mgr.live("lite").unwrap();
        let opts = ScriptOptions::default();
        let (reader, total) = open_script(&path, &opts, CHUNK_BYTES).unwrap();
        let mut seen = Vec::new();
        let sum = run_script(
            &live,
            None,
            reader,
            total,
            &opts,
            &CancellationToken::new(),
            |p| seen.push(p),
        )
        .await
        .unwrap();
        assert_eq!(sum.ok, 4);
        assert!(seen.len() >= 3, "{seen:?}");
        assert!(
            seen.windows(2).all(|w| w[0].bytes_done <= w[1].bytes_done),
            "{seen:?}"
        );
        assert!(
            seen[0].bytes_done < total,
            "an early event is below the size of the file: {seen:?}"
        );
        let last = seen.last().unwrap();
        assert_eq!((last.statements_done, last.bytes_done), (4, total));
    }

    #[test]
    fn a_missing_file_and_an_unknown_encoding_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.sql");
        assert!(open_script(&missing, &ScriptOptions::default(), 10).is_err());
        let path = script_file(dir.path(), "e.sql", b"select 1");
        let opts = ScriptOptions {
            encoding: "EBCDIC".into(),
            ..Default::default()
        };
        let err = open_script(&path, &opts, 10).err().unwrap();
        assert!(err.to_string().contains("Unsupported encoding"), "{err}");
    }
}
