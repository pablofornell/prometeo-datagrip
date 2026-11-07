//! SQL statement splitter and "statement at caret" lookup.
//!
//! Dialect aware, best effort. Handled:
//! * all: `'..'` strings, `"..'"` identifiers, `--` and `/* */` comments;
//! * PostgreSQL: `$tag$ ... $tag$` dollar quoting, `E'..\'..'` escape strings, nested block
//!   comments, `CREATE FUNCTION .. BEGIN ATOMIC .. END`, `;` inside parentheses
//!   (`CREATE RULE .. DO ALSO (a; b)`) does not separate statements;
//! * MySQL: backticks, `#` and `-- ` comments, backslash escapes, `DELIMITER xx` lines,
//!   `BEGIN .. END` bodies of `CREATE [DEFINER = ..] PROCEDURE/FUNCTION/TRIGGER/EVENT` (a
//!   column called `begin` or `event` is not a body);
//! * SQLite: backticks, `[bracket]` identifiers, `CREATE TRIGGER .. BEGIN .. END;` bodies;
//! * Oracle: `q'[..]'` literals, PL/SQL blocks and `CREATE PROCEDURE | FUNCTION | PACKAGE | TRIGGER | TYPE` units end
//!   with a line holding only `/` (their `;` belong to them), plain statements end at `;` or `/`.
//!
//! Offsets are reported as byte offsets, `char` (Unicode scalar) offsets and UTF-16 code
//! unit offsets (what CodeMirror / JavaScript use).

use serde::{Deserialize, Serialize};

use crate::model::{Driver, StatementRange};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    pub index: usize,
    /// Statement text without the trailing delimiter and surrounding whitespace.
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub start_char: usize,
    pub end_char: usize,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

impl Statement {
    pub fn range(&self) -> StatementRange {
        StatementRange {
            start: self.start,
            end: self.end,
            start_char: self.start_char,
            end_char: self.end_char,
            start_utf16: self.start_utf16,
            end_utf16: self.end_utf16,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Raw {
    start: usize,
    end: usize,
    /// End including the delimiter that terminated the statement.
    full_end: usize,
}

/// True when `sql` (a `WHERE` / `ORDER BY` fragment) contains a statement separator outside
/// quotes and comments, i.e. it would not stay a single expression.
pub(crate) fn has_statement_separator(sql: &str, dialect: Driver) -> bool {
    let raws = split_raw(sql, dialect);
    raws.len() > 1 || raws.iter().any(|r| sql[r.end..r.full_end].contains(';'))
}

pub fn split_statements(sql: &str, dialect: Driver) -> Vec<Statement> {
    let raws = split_raw(sql, dialect);
    to_statements(sql, &raws)
}

/// The statement containing `caret` (a byte offset). When the caret sits in the blank
/// space between statements the preceding statement wins (the following one if there is
/// no preceding statement), matching DataGrip's "execute current statement".
pub fn statement_at(sql: &str, caret: usize, dialect: Driver) -> Option<Statement> {
    let raws = split_raw(sql, dialect);
    let i = pick(&raws, caret)?;
    to_statements(sql, &raws).into_iter().nth(i)
}

/// Same as [`statement_at`] but `caret` is a UTF-16 code unit offset (JavaScript).
pub fn statement_at_utf16(sql: &str, caret_utf16: usize, dialect: Driver) -> Option<Statement> {
    let mut units = 0usize;
    let mut byte = sql.len();
    for (b, ch) in sql.char_indices() {
        if units >= caret_utf16 {
            byte = b;
            break;
        }
        units += ch.len_utf16();
    }
    statement_at(sql, byte, dialect)
}

fn pick(raws: &[Raw], caret: usize) -> Option<usize> {
    if raws.is_empty() {
        return None;
    }
    if let Some(i) = raws
        .iter()
        .position(|r| caret >= r.start && caret < r.full_end)
    {
        return Some(i);
    }
    if let Some(i) = raws.iter().position(|r| caret == r.full_end) {
        return Some(i);
    }
    match raws.iter().rposition(|r| r.full_end < caret) {
        Some(i) => Some(i),
        None => Some(0),
    }
}

fn to_statements(sql: &str, raws: &[Raw]) -> Vec<Statement> {
    let mut out = Vec::with_capacity(raws.len());
    // monotonic byte -> (char, utf16) conversion
    let (mut pos, mut chars, mut u16s) = (0usize, 0usize, 0usize);
    let mut conv = |target: usize| -> (usize, usize) {
        if target < pos {
            pos = 0;
            chars = 0;
            u16s = 0;
        }
        for ch in sql[pos..target].chars() {
            chars += 1;
            u16s += ch.len_utf16();
        }
        pos = target;
        (chars, u16s)
    };
    for (index, r) in raws.iter().enumerate() {
        let (sc, su) = conv(r.start);
        let (ec, eu) = conv(r.end);
        out.push(Statement {
            index,
            text: sql[r.start..r.end].to_string(),
            start: r.start,
            end: r.end,
            start_char: sc,
            end_char: ec,
            start_utf16: su,
            end_utf16: eu,
        });
    }
    out
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c >= 0x80
}
fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
}

/// Placeholder token for a quoted string / identifier among the first words of a statement.
const QUOTED: &str = "<q>";

/// Decide from the leading tokens of a `CREATE ...` statement whether it defines something
/// with a `BEGIN .. END` body. `None` while the object kind has not been seen yet.
fn create_is_compound(words: &[String], d: Driver) -> Option<bool> {
    let mut i = 1;
    while i < words.len() {
        match words[i].as_str() {
            "OR" | "REPLACE" | "TEMP" | "TEMPORARY" | "AGGREGATE" | "UNIQUE" => i += 1,
            // ALGORITHM = value
            "ALGORITHM" => i += 2,
            // SQL SECURITY {DEFINER | INVOKER}
            "SQL" => i += 3,
            // DEFINER = user [@host]: `user` and `host` may be quoted or bare words
            "DEFINER" => {
                i += 2;
                while i < words.len() && (words[i] == QUOTED || words[i].starts_with('@')) {
                    i += 1;
                }
            }
            kind => {
                let kinds: &[&str] = match d {
                    Driver::Sqlite | Driver::Oracle => &["TRIGGER"],
                    Driver::MySql => &["PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"],
                    Driver::Postgres => &["FUNCTION", "PROCEDURE"],
                };
                return Some(kinds.contains(&kind));
            }
        }
    }
    None
}

pub(crate) struct Scanner<'a> {
    b: &'a [u8],
    d: Driver,
    delimiter: Vec<u8>,
}

impl<'a> Scanner<'a> {
    /// A scanner over `sql` with the default `;` delimiter (also used by the transaction tracker's tokenizer).
    pub(crate) fn new(sql: &'a str, d: Driver) -> Self {
        Scanner {
            b: sql.as_bytes(),
            d,
            delimiter: vec![b';'],
        }
    }

    /// Skip a quoted run starting at `i` (which points at the opening quote). Handles the
    /// doubled-quote escape and optionally backslash escapes. Returns the index after the
    /// closing quote (or EOF).
    pub(crate) fn skip_quoted(&self, mut i: usize, q: u8, backslash: bool) -> usize {
        i += 1;
        let n = self.b.len();
        while i < n {
            let c = self.b[i];
            if backslash && c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                if i + 1 < n && self.b[i + 1] == q {
                    i += 2;
                    continue;
                }
                return i + 1;
            }
            i += 1;
        }
        n
    }

    fn skip_line(&self, mut i: usize) -> usize {
        while i < self.b.len() && self.b[i] != b'\n' {
            i += 1;
        }
        i
    }

    pub(crate) fn skip_block_comment(&self, mut i: usize) -> usize {
        // i points at "/*"
        let n = self.b.len();
        let nested = self.d == Driver::Postgres;
        let mut depth = 1;
        i += 2;
        while i < n {
            if self.b[i] == b'*' && i + 1 < n && self.b[i + 1] == b'/' {
                depth -= 1;
                i += 2;
                if depth == 0 {
                    return i;
                }
            } else if nested && self.b[i] == b'/' && i + 1 < n && self.b[i + 1] == b'*' {
                depth += 1;
                i += 2;
            } else {
                i += 1;
            }
        }
        n
    }

    /// If a comment starts at `i`, return the index after it.
    pub(crate) fn comment_end(&self, i: usize, at_stmt_start: bool) -> Option<usize> {
        let b = self.b;
        let n = b.len();
        let c = b[i];
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            if self.d == Driver::MySql {
                // MySQL requires whitespace / control char / EOL after "--"
                let ok = i + 2 >= n || b[i + 2].is_ascii_whitespace() || b[i + 2] < 0x20;
                if !ok {
                    return None;
                }
            }
            return Some(self.skip_line(i));
        }
        if c == b'#' && self.d == Driver::MySql {
            return Some(self.skip_line(i));
        }
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            // `/*! ... */` is executed by MySQL: it is code, not a comment, at statement start
            if self.d == Driver::MySql && at_stmt_start && i + 2 < n && b[i + 2] == b'!' {
                return None;
            }
            return Some(self.skip_block_comment(i));
        }
        None
    }

    fn word_at(&self, i: usize) -> (&'a [u8], usize) {
        let mut j = i;
        while j < self.b.len() && is_ident(self.b[j]) && self.b[j] != b'$' {
            j += 1;
        }
        (&self.b[i..j], j)
    }

    /// Next word after `i`, skipping whitespace (no comments handling needed here).
    fn peek_word(&self, mut i: usize) -> Option<String> {
        while i < self.b.len() && self.b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < self.b.len() && is_ident_start(self.b[i]) {
            let (w, _) = self.word_at(i);
            return Some(String::from_utf8_lossy(w).to_ascii_uppercase());
        }
        None
    }
}

fn split_raw(sql: &str, d: Driver) -> Vec<Raw> {
    if d == Driver::Oracle {
        return split_oracle(sql);
    }
    let b = sql.as_bytes();
    let n = b.len();
    let mut sc = Scanner {
        b,
        d,
        delimiter: vec![b';'],
    };
    let mut out = Vec::new();

    let mut i = 0usize;
    let mut start: Option<usize> = None;
    let mut first_words: Vec<String> = Vec::new();
    let mut compound = false; // statement is a CREATE of something with a BEGIN..END body
    let mut compound_known = false;
    let mut depth: i32 = 0;
    let mut paren: i32 = 0; // PG: `;` inside parentheses does not end the statement
    let mut prev_word = String::new();

    macro_rules! finish {
        ($end:expr, $full:expr) => {{
            if let Some(s) = start.take() {
                let mut e: usize = $end;
                while e > s && b[e - 1].is_ascii_whitespace() {
                    e -= 1;
                }
                out.push(Raw {
                    start: s,
                    end: e,
                    full_end: $full,
                });
            }
            first_words.clear();
            compound = false;
            compound_known = false;
            depth = 0;
            paren = 0;
            prev_word.clear();
            let _ = (&compound, &compound_known, &depth, &paren);
        }};
    }

    while i < n {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if let Some(e) = sc.comment_end(i, start.is_none()) {
            i = e;
            continue;
        }
        // statement terminator
        if b[i..].starts_with(&sc.delimiter)
            && !(depth > 0 && sc.delimiter == b";")
            && !(paren > 0 && d == Driver::Postgres && sc.delimiter == b";")
        {
            let dl = sc.delimiter.len();
            finish!(i, i + dl);
            i += dl;
            continue;
        }
        // MySQL client command: DELIMITER xx
        if start.is_none() && d == Driver::MySql && is_ident_start(c) {
            let (w, e) = sc.word_at(i);
            if w.eq_ignore_ascii_case(b"delimiter") && e < n && (b[e] == b' ' || b[e] == b'\t') {
                let mut j = e;
                while j < n && (b[j] == b' ' || b[j] == b'\t') {
                    j += 1;
                }
                let ds = j;
                while j < n && !b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j > ds {
                    sc.delimiter = b[ds..j].to_vec();
                    i = sc.skip_line(j);
                    continue;
                }
            }
        }
        if start.is_none() {
            start = Some(i);
        }
        if matches!(c, b'\'' | b'"' | b'`') && first_words.len() < 12 {
            first_words.push(QUOTED.to_string());
        }
        match c {
            b'(' if d == Driver::Postgres => {
                paren += 1;
                i += 1;
            }
            b')' if d == Driver::Postgres => {
                paren = (paren - 1).max(0);
                i += 1;
            }
            b'\'' => {
                let backslash = match d {
                    Driver::MySql => true,
                    Driver::Postgres => {
                        i > 0
                            && (b[i - 1] == b'E' || b[i - 1] == b'e')
                            && (i < 2 || !is_ident(b[i - 2]))
                    }
                    Driver::Sqlite | Driver::Oracle => false,
                };
                i = sc.skip_quoted(i, b'\'', backslash);
            }
            b'"' => {
                i = sc.skip_quoted(i, b'"', d == Driver::MySql);
            }
            b'`' if d != Driver::Postgres => {
                i = sc.skip_quoted(i, b'`', false);
            }
            b'[' if d == Driver::Sqlite => {
                while i < n && b[i] != b']' {
                    i += 1;
                }
                i = (i + 1).min(n);
            }
            b'$' if d == Driver::Postgres => {
                let prev_ident = i > 0 && is_ident(b[i - 1]);
                if prev_ident || i + 1 >= n || b[i + 1].is_ascii_digit() {
                    i += 1;
                    continue;
                }
                // $tag$
                let mut j = i + 1;
                if b[j] != b'$' {
                    if !is_ident_start(b[j]) {
                        i += 1;
                        continue;
                    }
                    while j < n && is_ident(b[j]) && b[j] != b'$' {
                        j += 1;
                    }
                }
                if j < n && b[j] == b'$' {
                    let tag = &b[i..=j];
                    let mut k = j + 1;
                    let mut found = None;
                    while k + tag.len() <= n {
                        if b[k] == b'$' && &b[k..k + tag.len()] == tag {
                            found = Some(k + tag.len());
                            break;
                        }
                        k += 1;
                    }
                    i = found.unwrap_or(n);
                } else {
                    i += 1;
                }
            }
            _ if is_ident_start(c) => {
                let (w, e) = sc.word_at(i);
                // a word glued to a preceding '.' or '$' is still an identifier part; fine
                let mut upper = String::from_utf8_lossy(w).to_ascii_uppercase();
                if i > 0 && b[i - 1] == b'@' {
                    upper.insert(0, '@'); // host part of DEFINER = user@host
                }
                if first_words.len() < 12 {
                    first_words.push(upper.clone());
                }
                if !compound_known && first_words.first().map(String::as_str) == Some("CREATE") {
                    match create_is_compound(&first_words, d) {
                        Some(c) => {
                            compound = c;
                            compound_known = true;
                        }
                        None if first_words.len() >= 12 => compound_known = true,
                        None => {}
                    }
                }
                if sc.delimiter == b";" && compound {
                    match upper.as_str() {
                        "BEGIN" => {
                            if d != Driver::Postgres || sc.peek_word(e).as_deref() == Some("ATOMIC")
                            {
                                depth += 1;
                            }
                        }
                        "CASE" if depth > 0 && prev_word != "END" => depth += 1,
                        "END" if depth > 0 => {
                            let next = sc.peek_word(e);
                            let closes_other = matches!(
                                next.as_deref(),
                                Some("IF") | Some("LOOP") | Some("WHILE") | Some("REPEAT")
                            );
                            if !closes_other {
                                depth -= 1;
                            }
                        }
                        _ => {}
                    }
                }
                prev_word = upper;
                i = e;
            }
            _ => {
                i += 1;
            }
        }
    }
    finish!(n, n);
    out
}

// ------------------------------------------------------------------ Oracle

impl Scanner<'_> {
    /// An alternative-quoting literal `q'[..]'` / `nq'{..}'` starting at `i` (which points at the `q` or `n`):
    /// the index after its closing quote (EOF when unterminated), `None` when `i` does not start one.
    pub(crate) fn oracle_q_quote_end(&self, i: usize) -> Option<usize> {
        let b = self.b;
        let n = b.len();
        let mut j = i;
        if j < n && b[j].eq_ignore_ascii_case(&b'n') {
            j += 1;
        }
        if !(j + 2 < n && b[j].eq_ignore_ascii_case(&b'q') && b[j + 1] == b'\'') {
            return None;
        }
        let open = b[j + 2];
        if open.is_ascii_whitespace() {
            return None;
        }
        let close = match open {
            b'[' => b']',
            b'{' => b'}',
            b'(' => b')',
            b'<' => b'>',
            c => c,
        };
        let mut k = j + 3;
        while k + 1 < n {
            if b[k] == close && b[k + 1] == b'\'' {
                return Some(k + 2);
            }
            k += 1;
        }
        Some(n)
    }

    /// Is the `/` at `i` alone on its line (the SQL*Plus terminator of a PL/SQL unit)? Returns the index of the end
    /// of that line.
    fn slash_line_end(&self, i: usize) -> Option<usize> {
        let b = self.b;
        let mut j = i;
        while j > 0 && matches!(b[j - 1], b' ' | b'\t') {
            j -= 1;
        }
        if j > 0 && b[j - 1] != b'\n' {
            return None;
        }
        let mut k = i + 1;
        while k < b.len() && matches!(b[k], b' ' | b'\t' | b'\r') {
            k += 1;
        }
        if k < b.len() && b[k] != b'\n' {
            return None;
        }
        Some(k)
    }
}

/// Words after which a PL/SQL unit goes on at depth 0 (`END;` of a local subprogram, then more declarations).
const ORACLE_CONTINUES: [&str; 7] = [
    "BEGIN",
    "PROCEDURE",
    "FUNCTION",
    "PRAGMA",
    "CURSOR",
    "SUBTYPE",
    "TYPE",
];

/// What a statement is, from its first words: `Some(true)` = PL/SQL unit (ends at a `/` line, its `;` stay), `Some(false)`
/// = plain SQL, `None` = not known yet. The second flag: only a `/` line (or the end of the text) ends it.
fn oracle_unit(words: &[String]) -> Option<(bool, bool)> {
    match words.first().map(String::as_str)? {
        "BEGIN" | "DECLARE" => Some((true, false)),
        "CREATE" => {
            let mut i = 1;
            while i < words.len() {
                match words[i].as_str() {
                    "OR" | "REPLACE" | "NO" | "FORCE" | "EDITIONABLE" | "NONEDITIONABLE" => i += 1,
                    "FUNCTION" | "PROCEDURE" | "TRIGGER" => return Some((true, false)),
                    "PACKAGE" => {
                        // the body has subprograms and variables in any order: only `/` can end it
                        return match words.get(i + 1).map(String::as_str) {
                            Some("BODY") => Some((true, true)),
                            Some(_) => Some((true, false)),
                            None => None,
                        };
                    }
                    "TYPE" => {
                        return match words.get(i + 1) {
                            Some(_) if words.iter().any(|w| w == "BODY") => Some((true, true)),
                            Some(_) if words.iter().any(|w| w == "OBJECT" || w == "UNDER") => {
                                Some((true, true))
                            }
                            Some(_) if words.len() > i + 3 => Some((false, false)),
                            _ => None,
                        };
                    }
                    _ => return Some((false, false)),
                }
            }
            None
        }
        _ => Some((false, false)),
    }
}

/// Oracle: `;` ends a SQL statement (and is not part of it); PL/SQL units (`BEGIN`/`DECLARE` blocks and
/// `CREATE [OR REPLACE] PROCEDURE | FUNCTION | PACKAGE [BODY] | TRIGGER | TYPE [BODY]`) end at a line holding only `/`,
/// keep their `;`, and also end after the `END ...;` that closes their outermost block when nothing that continues
/// the unit follows. A `/` line also ends plain SQL (SQL*Plus). Strings, `q'[..]'` literals, quoted identifiers and
/// comments hide terminators.
fn split_oracle(sql: &str) -> Vec<Raw> {
    let b = sql.as_bytes();
    let n = b.len();
    let sc = Scanner {
        b,
        d: Driver::Oracle,
        delimiter: vec![b';'],
    };
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut start: Option<usize> = None;
    let mut words: Vec<String> = Vec::new();
    let mut unit: Option<(bool, bool)> = None;
    let mut depth = 0i32;
    let mut pending_end = false;
    let mut prev_word = String::new();

    macro_rules! finish {
        ($end:expr, $full:expr) => {{
            if let Some(s) = start.take() {
                let mut e: usize = $end;
                while e > s && b[e - 1].is_ascii_whitespace() {
                    e -= 1;
                }
                out.push(Raw {
                    start: s,
                    end: e,
                    full_end: $full,
                });
            }
            words.clear();
            unit = None;
            depth = 0;
            pending_end = false;
            prev_word.clear();
            let _ = (&unit, &depth, &pending_end);
        }};
    }

    while i < n {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if let Some(e) = sc.comment_end(i, start.is_none()) {
            i = e;
            continue;
        }
        if c == b'/' {
            if let Some(eol) = sc.slash_line_end(i) {
                finish!(i, eol);
                i = eol;
                continue;
            }
        }
        if c == b';' {
            match unit {
                Some((true, slash_only)) if !(pending_end && !slash_only) => {
                    // a `;` inside a PL/SQL unit
                    i += 1;
                }
                Some((true, _)) => {
                    // `END ...;` of the outermost block: the unit ends here unless more of it follows
                    let mut j = i + 1;
                    loop {
                        while j < n && b[j].is_ascii_whitespace() {
                            j += 1;
                        }
                        if j >= n {
                            break;
                        }
                        match sc.comment_end(j, false) {
                            Some(e) => j = e,
                            None => break,
                        }
                    }
                    if j < n && b[j] == b'/' {
                        if let Some(eol) = sc.slash_line_end(j) {
                            finish!(i + 1, eol);
                            i = eol;
                            continue;
                        }
                    }
                    let next = sc.peek_word(j);
                    if next
                        .as_deref()
                        .is_some_and(|w| ORACLE_CONTINUES.contains(&w))
                    {
                        pending_end = false;
                        i += 1;
                    } else {
                        finish!(i + 1, i + 1);
                        i += 1;
                    }
                }
                _ => {
                    finish!(i, i + 1);
                    i += 1;
                }
            }
            continue;
        }
        if start.is_none() {
            start = Some(i);
        }
        match c {
            b'\'' => i = sc.skip_quoted(i, b'\'', false),
            b'"' => i = sc.skip_quoted(i, b'"', false),
            _ if is_ident_start(c) => {
                if let Some(e) = sc.oracle_q_quote_end(i) {
                    i = e;
                    continue;
                }
                let (w, e) = sc.word_at(i);
                let upper = String::from_utf8_lossy(w).to_ascii_uppercase();
                let glued = i > 0 && matches!(b[i - 1], b'$' | b'.' | b'#' | b':');
                if words.len() < 12 && !glued {
                    words.push(upper.clone());
                    if unit.is_none() {
                        unit = oracle_unit(&words);
                        if unit.is_none() && words.len() >= 12 {
                            unit = Some((false, false));
                        }
                    }
                }
                if matches!(unit, Some((true, _))) && !glued {
                    match upper.as_str() {
                        "BEGIN" => {
                            depth += 1;
                            pending_end = false;
                        }
                        "CASE" if prev_word != "END" => depth += 1,
                        "END" => match sc.peek_word(e).as_deref() {
                            Some("IF") | Some("LOOP") => {}
                            Some("CASE") => depth = (depth - 1).max(0),
                            _ => {
                                if depth > 0 {
                                    depth -= 1;
                                }
                                if depth == 0 {
                                    pending_end = true;
                                }
                            }
                        },
                        _ => {}
                    }
                }
                prev_word = upper;
                i = e;
            }
            _ => i += 1,
        }
    }
    finish!(n, n);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str, d: Driver) -> Vec<String> {
        split_statements(sql, d)
            .into_iter()
            .map(|s| s.text)
            .collect()
    }

    #[test]
    fn basic_split() {
        let t = texts("select 1; select 2;\n\nselect 3", Driver::Postgres);
        assert_eq!(t, vec!["select 1", "select 2", "select 3"]);
    }

    #[test]
    fn empty_and_comment_only() {
        assert!(texts("", Driver::Postgres).is_empty());
        assert!(texts(" ;; -- hi\n /* x */ ; ", Driver::Postgres).is_empty());
    }

    #[test]
    fn semicolon_in_strings_and_idents() {
        let t = texts(r#"select 'a;b', "c;d" ; select 'it''s;'"#, Driver::Postgres);
        assert_eq!(t, vec![r#"select 'a;b', "c;d""#, "select 'it''s;'"]);
    }

    #[test]
    fn comments_hide_semicolons() {
        let sql = "select 1 -- not; here\n; /* a; /* nested; */ still; */ select 2";
        let t = texts(sql, Driver::Postgres);
        assert_eq!(t, vec!["select 1 -- not; here", "select 2"]);
        // MySQL block comments do not nest: the ';' after the first */ ends the statement
        let t = texts("select /* a; */ 1; select 2", Driver::MySql);
        assert_eq!(t, vec!["select /* a; */ 1", "select 2"]);
    }

    #[test]
    fn leading_comments_are_not_part_of_the_statement() {
        let s = split_statements("-- hello\n/* x */ select 1;", Driver::Postgres);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].text, "select 1");
        assert_eq!(s[0].start, 17);
    }

    #[test]
    fn pg_dollar_quoting() {
        let sql = "create function f() returns int as $$ begin; select 1; end; $$ language plpgsql; select 2;";
        let t = texts(sql, Driver::Postgres);
        assert_eq!(t.len(), 2);
        assert!(t[0].ends_with("language plpgsql"));
        let sql = "do $body$ begin raise notice $$x;$$; end $body$; select $1, a$b from t;";
        let t = texts(sql, Driver::Postgres);
        assert_eq!(t.len(), 2);
        assert_eq!(t[1], "select $1, a$b from t");
    }

    #[test]
    fn pg_escape_strings() {
        let t = texts(r"select E'a\';b'; select 2", Driver::Postgres);
        assert_eq!(t, vec![r"select E'a\';b'", "select 2"]);
        // plain string: backslash is literal, so the quote closes
        let t = texts(r"select 'a\'; select 2", Driver::Postgres);
        assert_eq!(t, vec![r"select 'a\'", "select 2"]);
    }

    #[test]
    fn pg_begin_atomic() {
        let sql = "create function f() returns int begin atomic select case when true then 1 end; end; select 1";
        let t = texts(sql, Driver::Postgres);
        assert_eq!(t.len(), 2);
        assert!(t[0].ends_with("end"));
        // plain BEGIN is a transaction statement
        assert_eq!(texts("begin; select 1; commit;", Driver::Postgres).len(), 3);
    }

    #[test]
    fn mysql_quotes_and_backslash() {
        let t = texts(r"select 'a\'b;c', `x;y`; select 2 # c; d", Driver::MySql);
        assert_eq!(t, vec![r"select 'a\'b;c', `x;y`", "select 2 # c; d"]);
        // "--" without trailing space is not a comment in MySQL
        let t = texts("select 1--1; select 2", Driver::MySql);
        assert_eq!(t, vec!["select 1--1", "select 2"]);
    }

    #[test]
    fn mysql_delimiter() {
        let sql = "DELIMITER //\ncreate procedure p() begin select 1; select 2; end//\nDELIMITER ;\nselect 3;";
        let t = texts(sql, Driver::MySql);
        assert_eq!(t.len(), 2);
        assert!(t[0].starts_with("create procedure p()"));
        assert!(t[0].ends_with("end"));
        assert_eq!(t[1], "select 3");
    }

    #[test]
    fn mysql_compound_without_delimiter() {
        let sql = "create procedure p() begin if x then select 1; end if; case when 1 then select 2; end case; select 3; end; select 4";
        let t = texts(sql, Driver::MySql);
        assert_eq!(t.len(), 2, "{t:?}");
        assert_eq!(t[1], "select 4");
    }

    #[test]
    fn mysql_executable_comment_at_start() {
        let t = texts("/*!40101 SET NAMES utf8 */;\nselect 1;", Driver::MySql);
        assert_eq!(t, vec!["/*!40101 SET NAMES utf8 */", "select 1"]);
    }

    #[test]
    fn sqlite_trigger_body() {
        let sql = "create trigger tr after insert on t begin update x set a = case when 1 then 2 end; insert into log values (1); end; select 1;";
        let t = texts(sql, Driver::Sqlite);
        assert_eq!(t.len(), 2, "{t:?}");
        assert!(t[0].ends_with("end"));
        assert_eq!(t[1], "select 1");
        let t = texts("begin; select 1; commit", Driver::Sqlite);
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn oracle_semicolon_and_slash() {
        let o = Driver::Oracle;
        assert_eq!(
            texts("select 1 from dual; select 2 from dual", o),
            vec!["select 1 from dual", "select 2 from dual"]
        );
        // a `/` inside a line is a division; alone on a line it ends the statement
        assert_eq!(texts("select 4 / 2 from dual; select 1", o).len(), 2);
        assert_eq!(
            texts("select 1 from dual\n/\nselect 2 from dual\n/\n", o),
            vec!["select 1 from dual", "select 2 from dual"]
        );
        // a `/` line after a `;` statement runs nothing
        assert_eq!(
            texts("select 1 from dual;\n/\nselect 2 from dual", o).len(),
            2
        );
    }

    #[test]
    fn oracle_quotes_and_comments() {
        let o = Driver::Oracle;
        assert_eq!(
            texts(
                "select q'[it's; fine]', q'!a;b!', nq'{x;}' from dual; select 2 from dual",
                o
            ),
            vec![
                "select q'[it's; fine]', q'!a;b!', nq'{x;}' from dual",
                "select 2 from dual"
            ]
        );
        assert_eq!(
            texts(
                "select 'a;b', \"c;d\", 'it''s;' from dual; -- x; y\nselect 2 /* ; */ from dual",
                o
            )
            .len(),
            2
        );
        // backslash and backtick mean nothing, a block comment does not nest
        assert_eq!(texts("select 'a\\' from dual; select 2", o).len(), 2);
        assert_eq!(texts("select /* a /* b */ 1; select 2", o).len(), 2);
        // a variable called q is not a quote
        assert_eq!(texts("select q from t; select 2", o).len(), 2);
    }

    #[test]
    fn oracle_plsql_blocks_keep_their_semicolons() {
        let o = Driver::Oracle;
        let t = texts(
            "begin\n  null;\n  dbms_output.put_line('x');\nend;\n/\nselect 1 from dual",
            o,
        );
        assert_eq!(t.len(), 2, "{t:?}");
        assert_eq!(t[0], "begin\n  null;\n  dbms_output.put_line('x');\nend;");
        // without the `/`: the block ends after its END;
        let t = texts("begin null; end; select 1 from dual; select 2 from dual", o);
        assert_eq!(
            t,
            vec![
                "begin null; end;",
                "select 1 from dual",
                "select 2 from dual"
            ]
        );
        // IF / LOOP / CASE inside
        let sql = "declare v number; begin if v is null then v := case when 1 = 1 then 1 else 2 end; end if; \
                   for i in 1..3 loop v := v + i; end loop; case v when 1 then null; else null; end case; end; select 3 from dual";
        let t = texts(sql, o);
        assert_eq!(t.len(), 2, "{t:?}");
        assert!(t[0].ends_with("end case; end;"), "{t:?}");
        // nested block, labels, exception section
        let t = texts(
            "begin begin null; exception when others then null; end; end;\nselect 1 from dual",
            o,
        );
        assert_eq!(t.len(), 2, "{t:?}");
    }

    #[test]
    fn oracle_create_units() {
        let o = Driver::Oracle;
        let proc_ = "create or replace procedure p(a in number) is\n  v number;\nbegin\n  v := a;\n  insert into t values (v);\nend p;";
        let t = texts(&format!("{proc_}\n/\nselect 1 from dual"), o);
        assert_eq!(t, vec![proc_, "select 1 from dual"]);
        // no `/`: still ends at the END of the unit
        let t = texts(&format!("{proc_}\nselect 1 from dual;"), o);
        assert_eq!(t, vec![proc_, "select 1 from dual"]);
        // a local subprogram's END does not end the unit
        let local = "create function f return number is\n  function g return number is begin return 1; end g;\nbegin\n  return g;\nend f;";
        assert_eq!(texts(&format!("{local}\n/"), o), vec![local]);
        assert_eq!(texts(&format!("{local}\nselect 1 from dual"), o).len(), 2);
        // triggers
        let trg = "create or replace trigger trg before update on t for each row\nbegin\n  :new.x := 1;\nend;";
        assert_eq!(texts(&format!("{trg}\n/\nselect 1 from dual"), o).len(), 2);
        assert_eq!(
            texts(&format!("create or replace editionable {}", &trg[18..]), o).len(),
            1
        );
        // a package spec ends at its END; a body needs the `/`
        let spec =
            "create or replace package pk is\n  function f return number;\n  procedure p;\nend pk;";
        assert_eq!(
            texts(&format!("{spec}\nselect 1 from dual"), o),
            vec![spec, "select 1 from dual"]
        );
        let body = "create or replace package body pk is\n  function f return number is begin return 1; end f;\n  v number;\n  procedure p is begin null; end p;\nbegin\n  v := 1;\nend pk;";
        let t = texts(
            &format!("{body}\n/\nselect 1 from dual;\nselect 2 from dual"),
            o,
        );
        assert_eq!(t, vec![body, "select 1 from dual", "select 2 from dual"]);
        // everything else CREATE is plain SQL, even with words like BEGIN as column names
        let t = texts("create table t (begin number, \"end\" number); create type ty as table of number; create index i on t (begin)", o);
        assert_eq!(t.len(), 3, "{t:?}");
        let t = texts(
            "create or replace type ty as object (a number);\n/\nselect 1 from dual",
            o,
        );
        assert_eq!(t.len(), 2, "{t:?}");
        assert!(t[0].ends_with("(a number);"), "{t:?}");
        // the caret picks the unit it is in
        let sql = format!("select 1 from dual;\n{proc_}\n/\nselect 3 from dual");
        let at = sql.find("insert").unwrap();
        assert_eq!(statement_at(&sql, at, o).unwrap().text, proc_);
        assert!(has_statement_separator("a = 1; drop table t", o));
        assert!(!has_statement_separator("a = 'x;y' and b = q'[;]'", o));
    }

    #[test]
    fn sqlite_brackets_and_backticks() {
        let t = texts("select [a;b], `c;d` from t; select 2", Driver::Sqlite);
        assert_eq!(t, vec!["select [a;b], `c;d` from t", "select 2"]);
    }

    #[test]
    fn unterminated_constructs_do_not_panic() {
        for sql in [
            "select 'abc",
            "select \"abc",
            "select /* abc",
            "select $$ abc",
            "select $a$ x",
            "select `a",
        ] {
            for d in [
                Driver::Postgres,
                Driver::MySql,
                Driver::Sqlite,
                Driver::Oracle,
            ] {
                let s = split_statements(sql, d);
                assert_eq!(s.len(), 1, "{sql} {d:?}");
            }
        }
    }

    #[test]
    fn offsets_bytes_chars_utf16() {
        // "é" = 2 bytes / 1 char / 1 utf16; "😀" = 4 bytes / 1 char / 2 utf16
        let sql = "select 'é😀';  select 2";
        let s = split_statements(sql, Driver::Postgres);
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].start, s[0].end), (0, 15));
        assert_eq!((s[0].start_char, s[0].end_char), (0, 11));
        assert_eq!((s[0].start_utf16, s[0].end_utf16), (0, 12));
        assert_eq!(&sql[s[1].start..s[1].end], "select 2");
        assert_eq!(s[1].start_char, 14);
        assert_eq!(s[1].start_utf16, 15);
        assert_eq!(s[1].end_utf16, 23);
    }

    #[test]
    fn statement_at_cases() {
        let sql = "select 1;\n\nselect 2;\nselect 3";
        let d = Driver::Postgres;
        let at = |c| statement_at(sql, c, d).map(|s| s.text);
        assert_eq!(at(0).as_deref(), Some("select 1"));
        assert_eq!(at(8).as_deref(), Some("select 1"));
        assert_eq!(at(9).as_deref(), Some("select 1")); // right after ';'
        assert_eq!(at(10).as_deref(), Some("select 1")); // blank gap -> previous
        assert_eq!(at(11).as_deref(), Some("select 2"));
        assert_eq!(at(19).as_deref(), Some("select 2"));
        assert_eq!(at(20).as_deref(), Some("select 2")); // right after its ';'
        assert_eq!(at(21).as_deref(), Some("select 3"));
        assert_eq!(at(sql.len()).as_deref(), Some("select 3"));
        assert_eq!(statement_at("  -- nothing\n", 3, d), None);
        // leading blank -> first statement
        assert_eq!(statement_at("\n\nselect 1", 0, d).unwrap().text, "select 1");
    }

    #[test]
    fn statement_at_utf16_unit() {
        let sql = "select '😀'; select 2";
        // utf16 offset 16 is inside "select 2"
        let s = statement_at_utf16(sql, 16, Driver::Postgres).unwrap();
        assert_eq!(s.text, "select 2");
        let s = statement_at_utf16(sql, 3, Driver::Postgres).unwrap();
        assert_eq!(s.text, "select '😀'");
    }

    #[test]
    fn pg_semicolons_inside_parentheses_do_not_split() {
        let sql = "create rule r as on insert to t do also (insert into a values (1); insert into b values (2)); select 1";
        let t = texts(sql, Driver::Postgres);
        assert_eq!(t.len(), 2, "{t:?}");
        assert!(t[0].ends_with("values (2))"), "{t:?}");
        assert_eq!(t[1], "select 1");
        // unbalanced ')' must not make the depth negative
        assert_eq!(texts("select 1); select 2", Driver::Postgres).len(), 2);
        // parentheses inside strings / comments / dollar quotes do not count
        assert_eq!(
            texts("select '(' ; select 2 -- (\n; select 3", Driver::Postgres).len(),
            3
        );
        assert_eq!(texts("select $$(;$$; select 2", Driver::Postgres).len(), 2);
    }

    #[test]
    fn mysql_column_named_begin_or_event_is_not_a_compound_body() {
        let t = texts(
            "create table t (event int, begin int); select 1; select 2",
            Driver::MySql,
        );
        assert_eq!(
            t,
            vec![
                "create table t (event int, begin int)",
                "select 1",
                "select 2"
            ]
        );
        let t = texts(
            "create table `trigger` (function int, begin int, procedure int); select 1",
            Driver::MySql,
        );
        assert_eq!(t.len(), 2, "{t:?}");
        let t = texts(
            "alter table t add column begin int; select 1; select 2",
            Driver::MySql,
        );
        assert_eq!(t.len(), 3, "{t:?}");
        // sqlite / pg: same rule
        let t = texts(
            "create table t (trigger int, begin int); select 1",
            Driver::Sqlite,
        );
        assert_eq!(t.len(), 2, "{t:?}");
        let t = texts(
            "create table t (function int, begin int); select 1",
            Driver::Postgres,
        );
        assert_eq!(t.len(), 2, "{t:?}");
        // a plain BEGIN / START TRANSACTION is a transaction statement
        assert_eq!(texts("begin; select 1; commit", Driver::MySql).len(), 3);
    }

    #[test]
    fn mysql_create_with_definer_is_still_compound() {
        for head in [
            "create definer = `root`@`localhost` procedure p()",
            "create definer=root@localhost procedure p()",
            "create definer = current_user() function f() returns int",
            "create definer = event@localhost trigger tr before insert on t for each row",
            "create definer = 'a'@'b' event ev on schedule every 1 day do",
            "create or replace procedure p()",
        ] {
            let sql = format!("{head} begin select 1; select 2; end; select 3");
            let t = texts(&sql, Driver::MySql);
            assert_eq!(t.len(), 2, "{sql} -> {t:?}");
            assert_eq!(t[1], "select 3");
        }
    }

    /// Random token soup must never panic (a panic aborts the whole app in release builds).
    #[test]
    fn random_input_never_panics() {
        const TOKENS: &[&str] = &[
            "select",
            " ",
            "\n",
            ";",
            "'",
            "\"",
            "`",
            "$$",
            "$a$",
            "$1",
            "--",
            "-- ",
            "/*",
            "*/",
            "#",
            "(",
            ")",
            "[",
            "]",
            "begin",
            "end",
            "atomic",
            "case",
            "if",
            "loop",
            "create",
            "or",
            "replace",
            "definer",
            "=",
            "@",
            "root",
            "procedure",
            "function",
            "trigger",
            "event",
            "table",
            "delimiter //\n",
            "//",
            "delimiter ;\n",
            "E'",
            "\\",
            "é",
            "😀",
            "x",
            "1",
            ",",
            "/*!40101",
            ".",
        ];
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..4000 {
            let len = (next() % 24) as usize;
            let sql: String = (0..len)
                .map(|_| TOKENS[(next() % TOKENS.len() as u64) as usize])
                .collect();
            for d in [
                Driver::Postgres,
                Driver::MySql,
                Driver::Sqlite,
                Driver::Oracle,
            ] {
                let stmts = split_statements(&sql, d);
                for s in &stmts {
                    assert_eq!(&sql[s.start..s.end], s.text);
                }
                for caret in 0..=sql.len() + 1 {
                    let _ = statement_at(&sql, caret, d);
                }
                for caret in 0..=sql.encode_utf16().count() + 1 {
                    let _ = statement_at_utf16(&sql, caret, d);
                }
                let _ = has_statement_separator(&sql, d);
            }
        }
    }
}
