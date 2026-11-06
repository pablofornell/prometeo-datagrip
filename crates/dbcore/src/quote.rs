//! Identifier / literal quoting and hex helpers.

use crate::model::Driver;

pub fn quote_ident(d: Driver, s: &str) -> String {
    match d {
        Driver::MySql => format!("`{}`", s.replace('`', "``")),
        _ => format!("\"{}\"", s.replace('"', "\"\"")),
    }
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
        Driver::Sqlite => format!("'{}'", s.replace('\'', "''")),
    }
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
    let s = s.strip_prefix("\\x").or_else(|| s.strip_prefix("0x")).unwrap_or(s);
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let v = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    s.as_bytes().chunks(2).map(|p| Some(v(p[0])? << 4 | v(p[1])?)).collect()
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
        assert_eq!(qualified(Driver::Sqlite, Some("main"), "t"), "\"main\".\"t\"");
        assert_eq!(quote_literal(Driver::Postgres, "it's"), "'it''s'");
        assert_eq!(quote_literal(Driver::Postgres, "a\\b"), "E'a\\\\b'");
        assert_eq!(quote_literal(Driver::MySql, "a\\'"), "'a\\\\'''");
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
