//! Identifier / literal quoting and hex helpers.

use crate::model::Driver;

pub fn quote_ident(d: Driver, s: &str) -> String {
    match d {
        Driver::MySql => format!("`{}`", s.replace('`', "``")),
        // unquoted names are upper case for Oracle: write them bare unless they need quotes
        Driver::Oracle if oracle_plain_ident(s) => s.to_string(),
        _ => format!("\"{}\"", s.replace('"', "\"\"")),
    }
}

/// Oracle's reserved words (`V$RESERVED_WORDS` with `RESERVED = 'Y'`, plus `ROWID` / `ROWNUM`).
const ORACLE_RESERVED: [&str; 111] = [
    "ACCESS",
    "ADD",
    "ALL",
    "ALTER",
    "AND",
    "ANY",
    "AS",
    "ASC",
    "AUDIT",
    "BETWEEN",
    "BY",
    "CHAR",
    "CHECK",
    "CLUSTER",
    "COLUMN",
    "COLUMN_VALUE",
    "COMMENT",
    "COMPRESS",
    "CONNECT",
    "CREATE",
    "CURRENT",
    "DATE",
    "DECIMAL",
    "DEFAULT",
    "DELETE",
    "DESC",
    "DISTINCT",
    "DROP",
    "ELSE",
    "EXCEPT",
    "EXCLUSIVE",
    "EXISTS",
    "FILE",
    "FLOAT",
    "FOR",
    "FROM",
    "GRANT",
    "GROUP",
    "HAVING",
    "IDENTIFIED",
    "IMMEDIATE",
    "IN",
    "INCREMENT",
    "INDEX",
    "INITIAL",
    "INSERT",
    "INTEGER",
    "INTERSECT",
    "INTO",
    "IS",
    "LEVEL",
    "LIKE",
    "LOCK",
    "LONG",
    "MAXEXTENTS",
    "MINUS",
    "MLSLABEL",
    "MODE",
    "MODIFY",
    "NESTED_TABLE_ID",
    "NOAUDIT",
    "NOCOMPRESS",
    "NOT",
    "NOWAIT",
    "NULL",
    "NUMBER",
    "OF",
    "OFFLINE",
    "ON",
    "ONLINE",
    "OPTION",
    "OR",
    "ORDER",
    "PCTFREE",
    "PRIOR",
    "PUBLIC",
    "RAW",
    "RENAME",
    "RESOURCE",
    "REVOKE",
    "ROW",
    "ROWID",
    "ROWNUM",
    "ROWS",
    "SELECT",
    "SESSION",
    "SET",
    "SHARE",
    "SIZE",
    "SMALLINT",
    "START",
    "SUCCESSFUL",
    "SYNONYM",
    "SYSDATE",
    "TABLE",
    "THEN",
    "TO",
    "TRIGGER",
    "UID",
    "UNION",
    "UNIQUE",
    "UPDATE",
    "USER",
    "VALIDATE",
    "VALUES",
    "VARCHAR",
    "VARCHAR2",
    "VIEW",
    "WHENEVER",
    "WHERE",
    "WITH",
];

/// Can `s` be written without quotes in Oracle and still name the same object: upper case letters, digits and
/// `_ $ #` starting with a letter, not a reserved word.
fn oracle_plain_ident(s: &str) -> bool {
    let mut it = s.chars();
    it.next().is_some_and(|c| c.is_ascii_uppercase())
        && s.len() <= 128
        && s.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, '_' | '$' | '#'))
        && !ORACLE_RESERVED.contains(&s)
}

pub fn qualified(d: Driver, schema: Option<&str>, name: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(d, s), quote_ident(d, name)),
        _ => quote_ident(d, name),
    }
}

/// A string literal safe to embed in SQL text.
pub fn quote_literal(d: Driver, s: &str) -> String {
    match d {
        Driver::Postgres => {
            if s.contains('\\') {
                format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
            } else {
                format!("'{}'", s.replace('\'', "''"))
            }
        }
        Driver::MySql => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        Driver::Sqlite | Driver::Oracle => format!("'{}'", s.replace('\'', "''")),
    }
}

/// A date / time text split into the parts Oracle's `TO_DATE` / `TO_TIMESTAMP(_TZ)` formats below take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleTs {
    /// `YYYY-MM-DD`
    pub date: String,
    /// `HH24:MI:SS`
    pub time: String,
    /// Fractional digits (no dot), up to nine.
    pub frac: String,
    /// `+HH:MM` offset or a region name (`UTC`, `Europe/Madrid`).
    pub tz: Option<String>,
}

/// Parses `2024-02-29`, `2024-02-29 13:45:10`, `2024-02-29T13:45:10.5`, `... +02:00`, `... Z`, `... Europe/Madrid`.
pub fn parse_oracle_ts(text: &str) -> Option<OracleTs> {
    let t = text.trim();
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    if t.len() < 10 || !t.is_char_boundary(10) {
        return None;
    }
    let (date, rest) = t.split_at(10);
    let dp: Vec<&str> = date.split('-').collect();
    if dp.len() != 3 || !digits(dp[0], 4) || !digits(dp[1], 2) || !digits(dp[2], 2) {
        return None;
    }
    let rest = rest.trim_start_matches(['T', ' ']);
    if rest.is_empty() {
        return Some(OracleTs {
            date: date.into(),
            time: "00:00:00".into(),
            frac: String::new(),
            tz: None,
        });
    }
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == ':' || c == '.'))
        .unwrap_or(rest.len());
    let (clock, tz) = rest.split_at(end);
    let (hms, frac) = clock.split_once('.').unwrap_or((clock, ""));
    let hp: Vec<&str> = hms.split(':').collect();
    let ok = (2..=3).contains(&hp.len())
        && hp.iter().all(|p| digits(p, 2))
        && frac.bytes().all(|b| b.is_ascii_digit());
    if !ok {
        return None;
    }
    let time = format!("{}:{}:{}", hp[0], hp[1], hp.get(2).copied().unwrap_or("00"));
    let tz = tz.trim();
    let tz = if tz.is_empty() {
        None
    } else if tz.eq_ignore_ascii_case("z") {
        Some("+00:00".to_string())
    } else if let Some(sign) = tz.strip_prefix(['+', '-']).map(|r| (&tz[..1], r)) {
        let r = sign.1.replace(':', "");
        if !(r.len() == 2 || r.len() == 4) || !r.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some(format!(
            "{}{}:{}",
            sign.0,
            &r[..2],
            if r.len() == 4 { &r[2..] } else { "00" }
        ))
    } else if tz
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '+' | '-'))
    {
        Some(tz.to_string())
    } else {
        return None;
    };
    Some(OracleTs {
        date: date.into(),
        time,
        frac: frac.chars().take(9).collect(),
        tz,
    })
}

impl OracleTs {
    /// `YYYY-MM-DD HH24:MI:SS`
    pub fn date_text(&self) -> String {
        format!("{} {}", self.date, self.time)
    }

    /// `YYYY-MM-DD HH24:MI:SS.FF9`
    pub fn timestamp_text(&self) -> String {
        format!("{} {}.{:0<9}", self.date, self.time, self.frac)
    }

    /// `YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM` (or ` TZR` with a region); without a zone the session's applies.
    pub fn timestamp_tz_text(&self) -> String {
        match &self.tz {
            Some(z) => format!("{} {z}", self.timestamp_text()),
            None => self.timestamp_text(),
        }
    }

    pub fn tz_format(&self) -> &'static str {
        match &self.tz {
            None => "YYYY-MM-DD HH24:MI:SS.FF9",
            Some(z) if z.starts_with(['+', '-']) => "YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM",
            Some(_) => "YYYY-MM-DD HH24:MI:SS.FF9 TZR",
        }
    }
}

/// How an Oracle column type stores a date / time: decides the conversion function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OracleTimeKind {
    Date,
    Timestamp,
    TimestampTz,
}

/// `DATE`, `TIMESTAMP(6)`, `TIMESTAMP(3) WITH TIME ZONE`, `TIMESTAMP WITH LOCAL TIME ZONE` -> kind.
pub fn oracle_time_kind(type_name: &str) -> Option<OracleTimeKind> {
    let t = type_name.trim().to_ascii_uppercase();
    if t == "DATE" {
        Some(OracleTimeKind::Date)
    } else if t.starts_with("TIMESTAMP") {
        Some(if t.contains("TIME ZONE") {
            OracleTimeKind::TimestampTz
        } else {
            OracleTimeKind::Timestamp
        })
    } else {
        None
    }
}

/// A SQL expression building the date / time `text` for a column of `kind`; `None` when the text cannot be parsed.
pub fn oracle_time_literal(kind: OracleTimeKind, text: &str) -> Option<String> {
    let ts = parse_oracle_ts(text)?;
    Some(match kind {
        OracleTimeKind::Date => format!("TO_DATE('{}', 'YYYY-MM-DD HH24:MI:SS')", ts.date_text()),
        OracleTimeKind::Timestamp => format!(
            "TO_TIMESTAMP('{}', 'YYYY-MM-DD HH24:MI:SS.FF9')",
            ts.timestamp_text()
        ),
        OracleTimeKind::TimestampTz => format!(
            "TO_TIMESTAMP_TZ('{}', '{}')",
            ts.timestamp_tz_text(),
            ts.tz_format()
        ),
    })
}

/// Text literal for Oracle: a string literal holds at most 4000 bytes, longer text is joined from `TO_CLOB` pieces.
pub fn oracle_text_literal(s: &str) -> String {
    const LIMIT: usize = 2000;
    if s.len() <= LIMIT {
        return quote_literal(Driver::Oracle, s);
    }
    let mut parts = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if cur.len() + ch.len_utf8() > LIMIT {
            parts.push(std::mem::take(&mut cur));
        }
        cur.push(ch);
    }
    parts.push(cur);
    parts
        .iter()
        .map(|p| format!("TO_CLOB({})", quote_literal(Driver::Oracle, p)))
        .collect::<Vec<_>>()
        .join(" || ")
}

/// `HEXTORAW('..')` of the bytes (hex text), joined from `TO_BLOB` pieces when longer than a literal may be.
pub fn oracle_raw_literal(hex: &str) -> String {
    const LIMIT: usize = 2000; // hex digits per piece: 1000 bytes
    if hex.is_empty() {
        return "NULL".into();
    }
    if hex.len() <= LIMIT {
        return format!("HEXTORAW('{hex}')");
    }
    hex.as_bytes()
        .chunks(LIMIT)
        .map(|c| format!("TO_BLOB(HEXTORAW('{}'))", String::from_utf8_lossy(c)))
        .collect::<Vec<_>>()
        .join(" || ")
}

pub fn hex_encode(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    let s = s
        .strip_prefix("\\x")
        .or_else(|| s.strip_prefix("0x"))
        .unwrap_or(s);
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let v = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    s.as_bytes()
        .chunks(2)
        .map(|p| Some(v(p[0])? << 4 | v(p[1])?))
        .collect()
}

/// First SQL keyword of a statement (upper-case), skipping leading whitespace and comments.
pub fn first_keyword(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map(|x| x.1).unwrap_or("").trim_start();
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map(|x| x.1).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    rest.trim_start_matches('(')
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(quote_ident(Driver::Postgres, "a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_ident(Driver::MySql, "a`b"), "`a``b`");
        assert_eq!(
            qualified(Driver::Sqlite, Some("main"), "t"),
            "\"main\".\"t\""
        );
        assert_eq!(quote_literal(Driver::Postgres, "it's"), "'it''s'");
        assert_eq!(quote_literal(Driver::Postgres, "a\\b"), "E'a\\\\b'");
        assert_eq!(quote_literal(Driver::MySql, "a\\'"), "'a\\\\'''");
    }

    #[test]
    fn oracle_names() {
        assert_eq!(quote_ident(Driver::Oracle, "EMP_1"), "EMP_1");
        assert_eq!(quote_ident(Driver::Oracle, "emp"), "\"emp\"");
        assert_eq!(quote_ident(Driver::Oracle, "ORDER"), "\"ORDER\"");
        assert_eq!(quote_ident(Driver::Oracle, "1A"), "\"1A\"");
        assert_eq!(quote_ident(Driver::Oracle, "A B"), "\"A B\"");
        assert_eq!(qualified(Driver::Oracle, Some("DEMO"), "t"), "DEMO.\"t\"");
        assert_eq!(quote_literal(Driver::Oracle, "it's \\"), "'it''s \\'");
    }

    #[test]
    fn oracle_date_times() {
        let t = parse_oracle_ts("2024-02-29T13:45:10.5+02:00").unwrap();
        assert_eq!(
            t.timestamp_tz_text(),
            "2024-02-29 13:45:10.500000000 +02:00"
        );
        assert_eq!(t.tz_format(), "YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM");
        assert_eq!(
            parse_oracle_ts("2024-02-29").unwrap().date_text(),
            "2024-02-29 00:00:00"
        );
        assert_eq!(
            parse_oracle_ts("2024-02-29 13:45 Z").unwrap().tz.as_deref(),
            Some("+00:00")
        );
        assert_eq!(
            parse_oracle_ts("2024-02-29 13:45:10 Europe/Madrid")
                .unwrap()
                .tz_format(),
            "YYYY-MM-DD HH24:MI:SS.FF9 TZR"
        );
        assert_eq!(
            parse_oracle_ts("2024-02-29 13:45 -0330")
                .unwrap()
                .tz
                .as_deref(),
            Some("-03:30")
        );
        assert!(parse_oracle_ts("29/02/2024").is_none());
        assert!(parse_oracle_ts("2024-02-29 13:xx").is_none());
        assert_eq!(
            oracle_time_kind("TIMESTAMP(6) WITH LOCAL TIME ZONE"),
            Some(OracleTimeKind::TimestampTz)
        );
        assert_eq!(
            oracle_time_kind("timestamp(3)"),
            Some(OracleTimeKind::Timestamp)
        );
        assert_eq!(oracle_time_kind("NUMBER"), None);
        assert_eq!(
            oracle_time_literal(OracleTimeKind::Date, "2024-02-29").unwrap(),
            "TO_DATE('2024-02-29 00:00:00', 'YYYY-MM-DD HH24:MI:SS')"
        );
        assert_eq!(oracle_raw_literal("CAFE"), "HEXTORAW('CAFE')");
        assert!(oracle_raw_literal(&"AB".repeat(2000)).contains("|| TO_BLOB("));
        assert_eq!(oracle_text_literal("a'b"), "'a''b'");
        assert!(oracle_text_literal(&"x".repeat(5000)).starts_with("TO_CLOB('"));
    }

    #[test]
    fn hex() {
        assert_eq!(hex_encode(&[0, 15, 255]), "000fff");
        assert_eq!(hex_decode("\\x000fFF"), Some(vec![0, 15, 255]));
        assert_eq!(hex_decode("abc"), None);
    }

    #[test]
    fn keyword() {
        assert_eq!(first_keyword("  -- x\n /* y */ select 1"), "SELECT");
        assert_eq!(first_keyword("(select 1)"), "SELECT");
    }
}
