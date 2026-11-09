//! Full value of one table cell (`ConnectionManager::fetch_cell`), round trip and truncation, per driver. Run with:
//!   PROMETEO_PG_URL=... PROMETEO_MYSQL_URL=... PROMETEO_ORACLE_URL=... cargo test -p dbcore --test cell_db -- --nocapture
//! Each driver skips when its variable is not set. Objects are named `cv_*` / `CV_*`.

mod common;

use std::collections::BTreeMap;

use common::*;
use dbcore::cell::{base64_decode, CellContent, CellKind};
use dbcore::*;
use serde_json::{json, Value};

/// 100 000 bytes that are not a repeating pattern of a power of two.
fn blob_100k() -> Vec<u8> {
    (0..100_000u32)
        .map(|i| (i.wrapping_mul(31) % 251) as u8)
        .collect()
}

/// 50 000 ASCII characters: more than a 32 KB LOB, and more than one piece of the driver's LONG fetch.
fn text_50k() -> String {
    "abcdefghij".repeat(5000)
}

/// Characters of 1, 2, 3 and 4 bytes: a cut at most byte offsets lands inside one.
const MULTI: &str = "añ€😀";

fn map(v: Value) -> BTreeMap<String, Value> {
    v.as_object()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect()
}

fn key(name: &str, id: i64) -> BTreeMap<String, Value> {
    [(name.to_string(), json!(id))].into()
}

fn bytes_of(c: &CellContent) -> Vec<u8> {
    assert_eq!(c.kind, CellKind::Binary, "{c:?}");
    assert!(c.text.is_none(), "a binary value has no text");
    base64_decode(c.base64.as_deref().expect("base64")).expect("valid base64")
}

fn text_of(c: &CellContent) -> &str {
    assert_eq!(c.kind, CellKind::Text, "{c:?}");
    assert!(c.base64.is_none(), "a text value has no base64");
    c.text.as_deref().expect("text")
}

async fn insert(mgr: &ConnectionManager, ds: &str, table: &ObjectRef, values: Value) {
    let ch = RowChange {
        kind: ChangeKind::Insert,
        key: BTreeMap::new(),
        values: map(values),
        row_locator: None,
    };
    let r = mgr.apply_changes(ds, table, &[ch]).await.expect("insert");
    assert!(r.committed, "insert failed: {:?}", r.results);
}

fn hex(b: &[u8]) -> String {
    dbcore::quote::hex_encode(b)
}

/// PostgreSQL: bytea, jsonb, text; the value is read by the primary key `id`.
mod pg {
    use super::*;

    macro_rules! setup {
        () => {{
            let Some(cfg) = pg_cfg() else {
                eprintln!("PROMETEO_PG_URL not set: skipping");
                return;
            };
            let mgr = connected(&cfg).await;
            (cfg, mgr)
        }};
    }

    async fn run_sql(mgr: &ConnectionManager, sql: &str) {
        let s = mgr.open_session("pg").await.unwrap();
        assert_ok(&run(mgr, &s, sql).await);
        mgr.close_session(&s).await;
    }

    async fn scalar_text(mgr: &ConnectionManager, sql: &str) -> String {
        let s = mgr.open_session("pg").await.unwrap();
        let v = scalar(&run(mgr, &s, sql).await);
        mgr.close_session(&s).await;
        v.as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn round_trip_and_truncation() {
        let (cfg, mgr) = setup!();
        let t = ObjectRef::table(Some("public"), "cv_t");
        run_sql(&mgr, "drop table if exists public.cv_t").await;
        run_sql(
            &mgr,
            "create table public.cv_t (id int primary key, b bytea, j jsonb, t text, n int)",
        )
        .await;
        let blob = blob_100k();
        let multi = MULTI.repeat(2000);
        insert(
            &mgr,
            &cfg.id,
            &t,
            json!({"id": 1, "b": {"$bin": hex(&blob), "len": blob.len()}, "j": "{\"a\": [1, 2]}", "t": multi, "n": 42}),
        )
        .await;

        // bytea: the whole value, then cut
        let full = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "b", 0)
            .await
            .unwrap();
        assert_eq!(bytes_of(&full), blob);
        assert_eq!((full.len, full.truncated), (100_000, false));
        let cut = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "b", 1000)
            .await
            .unwrap();
        assert_eq!(bytes_of(&cut), blob[..1000]);
        assert_eq!((cut.len, cut.truncated), (100_000, true));

        // jsonb: the server's text form
        let j = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "j", 0)
            .await
            .unwrap();
        assert_eq!(
            text_of(&j),
            scalar_text(&mgr, "select j::text from public.cv_t where id = 1").await
        );
        assert!(!j.truncated);

        // text: whole, then cut before a character (a 2-byte and a 3-byte character start after byte 1 and 3)
        let t_full = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "t", 0)
            .await
            .unwrap();
        assert_eq!(text_of(&t_full), multi);
        assert_eq!(t_full.len, multi.len() as u64);
        let cut = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "t", 4)
            .await
            .unwrap();
        assert_eq!(
            text_of(&cut),
            "añ",
            "3 bytes: the 3-byte character does not fit"
        );
        assert!(cut.truncated);
        assert_eq!(cut.len, multi.len() as u64);
        let cut = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "t", 12)
            .await
            .unwrap();
        assert_eq!(text_of(&cut), "añ€😀a");

        // an integer column reads as its text
        let n = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "n", 0)
            .await
            .unwrap();
        assert_eq!(text_of(&n), "42");

        // errors: NULL, missing row, no primary key, unknown column, non-key column in the key
        insert(&mgr, &cfg.id, &t, json!({"id": 2})).await;
        let e = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 2), "b", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("NULL"), "{e}");
        let e = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 99), "b", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("no longer exists"), "{e}");
        let e = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "zz", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("Unknown column"), "{e}");
        let mut bad = key("id", 1);
        bad.insert("n".into(), json!(1));
        let e = mgr.fetch_cell(&cfg.id, &t, &bad, "b", 0).await.unwrap_err();
        assert!(e.to_string().contains("not a primary key"), "{e}");
        run_sql(&mgr, "drop table if exists public.cv_t").await;
        run_sql(&mgr, "create table public.cv_nopk (a int, b bytea)").await;
        let nopk = ObjectRef::table(Some("public"), "cv_nopk");
        let e = mgr
            .fetch_cell(&cfg.id, &nopk, &key("a", 1), "b", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("no primary key"), "{e}");
        run_sql(&mgr, "drop table if exists public.cv_nopk").await;
    }
}

/// MySQL: longblob, json, longtext; the value is read by the primary key `id`.
mod mysql {
    use super::*;

    macro_rules! setup {
        () => {{
            let Some(cfg) = mysql_cfg() else {
                eprintln!("PROMETEO_MYSQL_URL not set: skipping");
                return;
            };
            let mgr = connected(&cfg).await;
            (cfg, mgr)
        }};
    }

    async fn run_sql(mgr: &ConnectionManager, sql: &str) {
        let s = mgr.open_session("my").await.unwrap();
        assert_ok(&run(mgr, &s, sql).await);
        mgr.close_session(&s).await;
    }

    async fn scalar_text(mgr: &ConnectionManager, sql: &str) -> String {
        let s = mgr.open_session("my").await.unwrap();
        let v = scalar(&run(mgr, &s, sql).await);
        mgr.close_session(&s).await;
        v.as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn round_trip_and_truncation() {
        let (cfg, mgr) = setup!();
        let t = ObjectRef::table(None, "cv_t");
        run_sql(&mgr, "drop table if exists cv_t").await;
        run_sql(
            &mgr,
            "create table cv_t (id int primary key, bl longblob, js json, tx longtext, n int)",
        )
        .await;
        let blob = blob_100k();
        let multi = MULTI.repeat(2000);
        insert(
            &mgr,
            &cfg.id,
            &t,
            json!({"id": 1, "bl": {"$bin": hex(&blob), "len": blob.len()}, "js": "{\"a\": [1, 2]}", "tx": multi, "n": 42}),
        )
        .await;

        let full = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "bl", 0)
            .await
            .unwrap();
        assert_eq!(bytes_of(&full), blob);
        assert_eq!((full.len, full.truncated), (100_000, false));
        let cut = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "bl", 1000)
            .await
            .unwrap();
        assert_eq!(bytes_of(&cut), blob[..1000]);
        assert_eq!((cut.len, cut.truncated), (100_000, true));

        let js = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "js", 0)
            .await
            .unwrap();
        assert_eq!(
            text_of(&js),
            scalar_text(&mgr, "select cast(js as char) from cv_t where id = 1").await
        );

        let tx = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "tx", 0)
            .await
            .unwrap();
        assert_eq!(text_of(&tx), multi);
        assert_eq!(tx.len, multi.len() as u64);
        let cut = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "tx", 4)
            .await
            .unwrap();
        assert_eq!(text_of(&cut), "añ");
        assert!(cut.truncated);
        let cut = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "tx", 12)
            .await
            .unwrap();
        assert_eq!(text_of(&cut), "añ€😀a");

        let n = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 1), "n", 0)
            .await
            .unwrap();
        assert_eq!(text_of(&n), "42");

        insert(&mgr, &cfg.id, &t, json!({"id": 2})).await;
        let e = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 2), "bl", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("NULL"), "{e}");
        let e = mgr
            .fetch_cell(&cfg.id, &t, &key("id", 99), "bl", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("no longer exists"), "{e}");
        run_sql(&mgr, "drop table if exists cv_t").await;
    }
}

/// SQLite: a BLOB column, a text column and an integer column in a file of its own.
mod sqlite {
    use super::*;

    #[tokio::test]
    async fn round_trip_and_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = lite_cfg(&dir.path().join("cell.db"));
        let mgr = ConnectionManager::new();
        mgr.connect(&cfg).await.unwrap();
        let s = mgr.open_session("lite").await.unwrap();
        assert_ok(
            &run(
                &mgr,
                &s,
                "create table cv_t (id integer primary key, b blob, t text, n integer, z blob)",
            )
            .await,
        );
        let t = ObjectRef::table(None, "cv_t");
        let blob = blob_100k();
        let multi = MULTI.repeat(2000);
        insert(
            &mgr,
            "lite",
            &t,
            json!({"id": 1, "b": {"$bin": hex(&blob), "len": blob.len()}, "t": multi, "n": 42, "z": {"$bin": "00ff", "len": 2}}),
        )
        .await;

        let full = mgr
            .fetch_cell("lite", &t, &key("id", 1), "b", 0)
            .await
            .unwrap();
        assert_eq!(bytes_of(&full), blob);
        assert_eq!((full.len, full.truncated), (100_000, false));
        let cut = mgr
            .fetch_cell("lite", &t, &key("id", 1), "b", 1000)
            .await
            .unwrap();
        assert_eq!(bytes_of(&cut), blob[..1000]);
        assert_eq!((cut.len, cut.truncated), (100_000, true));
        let z = mgr
            .fetch_cell("lite", &t, &key("id", 1), "z", 0)
            .await
            .unwrap();
        assert_eq!(bytes_of(&z), vec![0, 255]);

        let tx = mgr
            .fetch_cell("lite", &t, &key("id", 1), "t", 0)
            .await
            .unwrap();
        assert_eq!(text_of(&tx), multi);
        assert_eq!(tx.len, multi.len() as u64);
        let cut = mgr
            .fetch_cell("lite", &t, &key("id", 1), "t", 4)
            .await
            .unwrap();
        assert_eq!(text_of(&cut), "añ");
        assert!(cut.truncated);
        let cut = mgr
            .fetch_cell("lite", &t, &key("id", 1), "t", 12)
            .await
            .unwrap();
        assert_eq!(text_of(&cut), "añ€😀a");

        let n = mgr
            .fetch_cell("lite", &t, &key("id", 1), "n", 0)
            .await
            .unwrap();
        assert_eq!(text_of(&n), "42");

        insert(&mgr, "lite", &t, json!({"id": 2})).await;
        let e = mgr
            .fetch_cell("lite", &t, &key("id", 2), "b", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("NULL"), "{e}");
        let e = mgr
            .fetch_cell("lite", &t, &key("id", 99), "b", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("no longer exists"), "{e}");
        mgr.close_session(&s).await;
    }
}

/// Oracle: BLOB, CLOB and NCLOB (whole LOB read), VARCHAR2 and NUMBER key; the table is created and dropped here.
mod oracle {
    use super::*;

    macro_rules! setup {
        () => {{
            let Some(cfg) = oracle_cfg() else {
                eprintln!("PROMETEO_ORACLE_URL not set: skipping");
                return;
            };
            let mgr = connected(&cfg).await;
            (cfg, mgr)
        }};
    }

    async fn run_sql(mgr: &ConnectionManager, sql: &str) {
        let s = mgr.open_session("ora").await.unwrap();
        assert_ok(&run(mgr, &s, sql).await);
        mgr.close_session(&s).await;
    }

    #[tokio::test]
    async fn round_trip_and_truncation() {
        let (cfg, mgr) = setup!();
        let t = ObjectRef::table(None, "CV_T");
        run_sql(
            &mgr,
            "begin execute immediate 'drop table CV_T purge'; exception when others then null; end;\n/",
        )
        .await;
        run_sql(
            &mgr,
            "create table CV_T (ID number primary key, B blob, C clob, N nclob, V varchar2(100), NB blob)",
        )
        .await;
        // inserted the way the grid does it: bound parameters
        let blob = blob_100k();
        let text = text_50k();
        let multi = MULTI.repeat(2000);
        insert(
            &mgr,
            &cfg.id,
            &t,
            json!({"ID": 1, "B": {"$bin": hex(&blob), "len": blob.len()}, "C": text, "N": multi, "V": "abc"}),
        )
        .await;

        let full = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "B", 0)
            .await
            .unwrap();
        assert_eq!(bytes_of(&full), blob);
        assert_eq!((full.len, full.truncated), (100_000, false));
        let cut = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "B", 1000)
            .await
            .unwrap();
        assert_eq!(bytes_of(&cut), blob[..1000]);
        assert_eq!((cut.len, cut.truncated), (100_000, true));

        // CLOB over 32 KB: the whole value, and a cut
        let c = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "C", 0)
            .await
            .unwrap();
        assert_eq!(text_of(&c), text, "CLOB read whole");
        assert_eq!((c.len, c.truncated), (50_000, false));
        let c = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "C", 100)
            .await
            .unwrap();
        assert_eq!(text_of(&c), &text[..100]);
        assert_eq!((c.len, c.truncated), (50_000, true));

        // NCLOB with characters of 1 to 4 bytes
        let n = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "N", 0)
            .await
            .unwrap();
        assert_eq!(text_of(&n), multi);
        assert_eq!(n.len, multi.len() as u64);
        let cut = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "N", 4)
            .await
            .unwrap();
        assert_eq!(text_of(&cut), "añ");
        assert!(cut.truncated);

        let v = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "V", 0)
            .await
            .unwrap();
        assert_eq!(text_of(&v), "abc");

        insert(&mgr, &cfg.id, &t, json!({"ID": 2})).await;
        let e = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 2), "B", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("NULL"), "{e}");
        let e = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 99), "B", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("no longer exists"), "{e}");
        let e = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "NB", 0)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("NULL"), "{e}");

        run_sql(
            &mgr,
            "begin execute immediate 'drop table CV_T purge'; exception when others then null; end;\n/",
        )
        .await;
    }

    /// Characters of 1, 2 and 4 bytes (the emoji is two UTF-16 units). The emoji starts at unit 1000, so the server's
    /// first 1000-unit piece ends inside it: the read must go on piece by piece.
    fn straddling_text() -> String {
        format!("{}{}", "a".repeat(999), "😀é€".repeat(1500))
    }

    /// The first `n` bytes of `s`, cut back to a character boundary.
    fn prefix(s: &str, n: usize) -> &str {
        let mut end = n.min(s.len());
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        &s[..end]
    }

    const DROP_BIG: &str =
        "begin execute immediate 'drop table CV_BIG purge'; exception when others then null; end;\n/";
    const DROP_TXT: &str =
        "begin execute immediate 'drop table CV_TXT purge'; exception when others then null; end;\n/";

    #[tokio::test]
    async fn blob_of_3_mb_is_cut_on_the_server() {
        let (cfg, mgr) = setup!();
        let t = ObjectRef::table(None, "CV_BIG");
        run_sql(&mgr, DROP_BIG).await;
        run_sql(&mgr, "create table CV_BIG (ID number primary key, B blob)").await;
        let blob: Vec<u8> = (0..3_000_000u32)
            .map(|i| (i.wrapping_mul(31) % 251) as u8)
            .collect();
        insert(
            &mgr,
            &cfg.id,
            &t,
            json!({"ID": 1, "B": {"$bin": hex(&blob), "len": blob.len()}}),
        )
        .await;

        // the first 1 MB of 3 MB, and the length of the whole (a first read warms up the column introspection)
        mgr.fetch_cell(&cfg.id, &t, &key("ID", 1), "B", 1 << 20)
            .await
            .unwrap();
        let started = std::time::Instant::now();
        let cut = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "B", 1 << 20)
            .await
            .unwrap();
        eprintln!("oracle 3 MB BLOB, 1 MB cap: {:?}", started.elapsed());
        assert_eq!(bytes_of(&cut), blob[..1 << 20]);
        assert_eq!((cut.len, cut.truncated), (3_000_000, true));

        let started = std::time::Instant::now();
        let full = mgr
            .fetch_cell(&cfg.id, &t, &key("ID", 1), "B", 0)
            .await
            .unwrap();
        eprintln!("oracle 3 MB BLOB, whole: {:?}", started.elapsed());
        assert_eq!(bytes_of(&full), blob);
        assert_eq!((full.len, full.truncated), (3_000_000, false));

        // caps that are not piece sizes, and one byte
        for cap in [1u64, 1999, 2000, 2001, 4001] {
            let c = mgr
                .fetch_cell(&cfg.id, &t, &key("ID", 1), "B", cap)
                .await
                .unwrap();
            assert_eq!(bytes_of(&c), blob[..cap as usize], "cap {cap}");
            assert_eq!((c.len, c.truncated), (3_000_000, true), "cap {cap}");
        }
        run_sql(&mgr, DROP_BIG).await;
    }

    #[tokio::test]
    async fn text_lobs_are_read_exactly_across_piece_boundaries() {
        let (cfg, mgr) = setup!();
        let t = ObjectRef::table(None, "CV_TXT");
        run_sql(&mgr, DROP_TXT).await;
        run_sql(
            &mgr,
            "create table CV_TXT (ID number primary key, C clob, N nclob)",
        )
        .await;
        let text = straddling_text();
        let units = text.encode_utf16().count() as u64; // 6999
        let small = "😀é"; // 6 bytes, 3 units
        let accents = "é".repeat(3000); // 6000 bytes, 3000 units
        insert(&mgr, &cfg.id, &t, json!({"ID": 1, "C": text, "N": text})).await;
        insert(&mgr, &cfg.id, &t, json!({"ID": 2, "C": small, "N": small})).await;
        insert(
            &mgr,
            &cfg.id,
            &t,
            json!({"ID": 3, "C": accents, "N": accents}),
        )
        .await;
        insert(&mgr, &cfg.id, &t, json!({"ID": 4})).await;

        for col in ["C", "N"] {
            // the whole value: its UTF-8 size
            let full = mgr
                .fetch_cell(&cfg.id, &t, &key("ID", 1), col, 0)
                .await
                .unwrap();
            assert_eq!(text_of(&full), text, "{col} whole");
            assert_eq!((full.len, full.truncated), (text.len() as u64, false));

            // cuts at every kind of boundary, around the 1000-unit pieces
            for cap in [
                1usize, 2, 3, 4, 5, 998, 999, 1000, 1001, 1002, 1003, 1004, 1005, 2000, 2003, 5000,
            ] {
                let c = mgr
                    .fetch_cell(&cfg.id, &t, &key("ID", 1), col, cap as u64)
                    .await
                    .unwrap();
                assert_eq!(text_of(&c), prefix(&text, cap), "{col} cap {cap}");
                // not read whole: the length is in UTF-16 units
                assert_eq!((c.len, c.truncated), (units, true), "{col} cap {cap}");
            }
            // the pieces cover the whole value here, so its UTF-8 size is known
            let c = mgr
                .fetch_cell(&cfg.id, &t, &key("ID", 1), col, 13000)
                .await
                .unwrap();
            assert_eq!(text_of(&c), prefix(&text, 13000), "{col} cap 13000");
            assert_eq!((c.len, c.truncated), (text.len() as u64, true));

            // a character of 4 bytes does not fit in 3 bytes; the whole value is read because it is 3 units
            let c = mgr
                .fetch_cell(&cfg.id, &t, &key("ID", 2), col, 3)
                .await
                .unwrap();
            assert_eq!(text_of(&c), "", "{col}: the emoji does not fit");
            assert_eq!((c.len, c.truncated), (6, true));
            let c = mgr
                .fetch_cell(&cfg.id, &t, &key("ID", 2), col, 4)
                .await
                .unwrap();
            assert_eq!(text_of(&c), "😀");

            // no piece boundary in the middle of a 2-byte character: 2001 bytes give 1000 characters
            let c = mgr
                .fetch_cell(&cfg.id, &t, &key("ID", 3), col, 2001)
                .await
                .unwrap();
            assert_eq!(text_of(&c), "é".repeat(1000), "{col} accents");
            assert_eq!((c.len, c.truncated), (6000, true));

            let e = mgr
                .fetch_cell(&cfg.id, &t, &key("ID", 4), col, 0)
                .await
                .unwrap_err();
            assert!(e.to_string().contains("NULL"), "{e}");
            let e = mgr
                .fetch_cell(&cfg.id, &t, &key("ID", 99), col, 0)
                .await
                .unwrap_err();
            assert!(e.to_string().contains("no longer exists"), "{e}");
        }
        run_sql(&mgr, DROP_TXT).await;
    }
}
