//! Connection plumbing: per-driver pools / dedicated connections / connect options.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;

use sqlx::mysql::{
    MySqlConnectOptions, MySqlConnection, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode,
};
use sqlx::postgres::{PgConnectOptions, PgConnection, PgPool, PgPoolOptions, PgRow, PgSslMode};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqlitePool, SqlitePoolOptions,
    SqliteRow, SqliteSynchronous,
};
use sqlx::{ConnectOptions, Connection, Row};

use crate::error::{connect_error, DbError, Result};
use crate::model::{DataSourceConfig, Driver};
use crate::value::PgTypeRow;

/// Pool of connections for one data source.
#[derive(Clone)]
pub enum Pool {
    Pg(PgPool),
    My(MySqlPool),
    Lite(SqlitePool),
}

/// A dedicated, non-pooled connection (console sessions).
pub enum Conn {
    Pg(PgConnection),
    My(MySqlConnection),
    Lite(SqliteConnection),
}

#[derive(Clone)]
pub(crate) enum ConnOpts {
    Pg(PgConnectOptions),
    My(MySqlConnectOptions),
    Lite(SqliteConnectOptions),
}

/// A connected data source.
pub(crate) struct Live {
    pub cfg: DataSourceConfig,
    pub pool: Pool,
    pub opts: ConnOpts,
    pub server_version: String,
    /// Cache of PG type OIDs resolved from the catalog.
    pub pg_types: Mutex<HashMap<u32, PgTypeRow>>,
    /// Cache of PG table OIDs (`RowDescription.relation_id`) -> `schema.table`, for `ColumnMeta::table_ref`.
    pub pg_rels: Mutex<HashMap<u32, String>>,
    /// SQLite `:memory:` data sources: one connection kept open for the lifetime of the data
    /// source, because a shared in-memory database vanishes when its last connection closes.
    pub keepalive: Mutex<Option<Conn>>,
}

impl Live {
    pub fn driver(&self) -> Driver {
        self.cfg.driver
    }

    /// Open a new dedicated connection with the same options (and read-only setting).
    pub async fn new_conn(&self) -> Result<Conn> {
        connect_one(&self.opts, &self.cfg).await
    }
}

/// One non-pooled connection; fails fast (the pool would keep retrying until its timeout).
pub(crate) async fn connect_one(opts: &ConnOpts, cfg: &DataSourceConfig) -> Result<Conn> {
    let timeout = connect_timeout(cfg);
    let fut = async {
        Ok::<Conn, DbError>(match opts {
            ConnOpts::Pg(o) => Conn::Pg(o.connect().await.map_err(connect_error)?),
            ConnOpts::My(o) => {
                let mut c = o.connect().await.map_err(connect_error)?;
                if cfg.read_only {
                    sqlx::query("SET SESSION TRANSACTION READ ONLY")
                        .execute(&mut c)
                        .await
                        .map_err(connect_error)?;
                }
                Conn::My(c)
            }
            ConnOpts::Lite(o) => Conn::Lite(o.connect().await.map_err(connect_error)?),
        })
    };
    match tokio::time::timeout(timeout, fut).await {
        Ok(r) => r,
        Err(_) => Err(DbError::Connection(format!(
            "Connection timed out after {}s",
            timeout.as_secs()
        ))),
    }
}

fn opt<'a>(cfg: &'a DataSourceConfig, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| {
            cfg.options
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(k))
                .map(|(_, v)| v.as_str())
        })
        .filter(|v| !v.is_empty())
}

fn bad(msg: impl std::fmt::Display) -> DbError {
    DbError::Connection(msg.to_string())
}

/// A file option (`sslrootcert`, `sslcert`, `sslkey`): the path as typed, checked so the error names the file instead
/// of surfacing as a bare TLS failure.
fn file_opt<'a>(cfg: &'a DataSourceConfig, key: &str, what: &str) -> Result<Option<&'a str>> {
    match opt(cfg, &[key]) {
        Some(p) if !std::path::Path::new(p).is_file() => {
            Err(bad(format!("{what} file not found: {p}")))
        }
        v => Ok(v),
    }
}

/// `-c key=value` pairs of a PostgreSQL `options` property (`-c search_path=a -c statement_timeout=5000`,
/// also `-ckey=value` and `--key=value`). Words that do not set a parameter are ignored.
pub(crate) fn pg_option_pairs(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut words = text.split_whitespace();
    while let Some(w) = words.next() {
        let assignment = if w == "-c" {
            words.next().map(str::to_string)
        } else if let Some(rest) = w.strip_prefix("-c") {
            Some(rest.to_string())
        } else {
            w.strip_prefix("--").map(str::to_string)
        };
        if let Some((k, v)) = assignment.as_deref().and_then(|a| a.split_once('=')) {
            if !k.is_empty() {
                out.push((k.replace('-', "_"), v.to_string()));
            }
        }
    }
    out
}

/// SQLite boolean option: `true`/`on`/`1`/`yes` and `false`/`off`/`0`/`no`.
fn bool_opt(cfg: &DataSourceConfig, key: &str) -> Result<Option<bool>> {
    match opt(cfg, &[key]).map(str::to_ascii_lowercase).as_deref() {
        None => Ok(None),
        Some("true" | "on" | "1" | "yes") => Ok(Some(true)),
        Some("false" | "off" | "0" | "no") => Ok(Some(false)),
        Some(v) => Err(bad(format!("{key}: expected true or false, got '{v}'"))),
    }
}

/// Does this SQLite data source point at an in-memory database?
pub(crate) fn is_memory(cfg: &DataSourceConfig) -> bool {
    if cfg.driver != Driver::Sqlite {
        return false;
    }
    let t = cfg
        .url_override
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .unwrap_or(cfg.file.trim());
    t.contains(":memory:") || t.contains("mode=memory")
}

/// Percent-encode everything but `[A-Za-z0-9_-]` so a data source id is safe inside a URI.
fn uri_safe(id: &str) -> String {
    id.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

pub(crate) fn build_opts(cfg: &DataSourceConfig) -> Result<ConnOpts> {
    let url = cfg
        .url_override
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty());
    match cfg.driver {
        Driver::Postgres => {
            let mut o = match url {
                Some(u) => {
                    let mut o = PgConnectOptions::from_str(u).map_err(bad)?;
                    // the password field wins over the URL: the app keeps passwords out of stored URLs
                    if let Some(p) = &cfg.password {
                        o = o.password(p);
                    }
                    o
                }
                None => {
                    let mut o = PgConnectOptions::new_without_pgpass()
                        .host(if cfg.host.is_empty() {
                            "localhost"
                        } else {
                            &cfg.host
                        })
                        .port(if cfg.port == 0 { 5432 } else { cfg.port });
                    if !cfg.user.is_empty() {
                        o = o.username(&cfg.user);
                    }
                    if let Some(p) = &cfg.password {
                        o = o.password(p);
                    }
                    if !cfg.database.is_empty() {
                        o = o.database(&cfg.database);
                    }
                    o
                }
            };
            if let Some(m) = opt(cfg, &["sslmode", "ssl-mode"]) {
                o = o.ssl_mode(PgSslMode::from_str(m).map_err(bad)?);
            }
            o = o.application_name(
                opt(cfg, &["application_name", "applicationName"]).unwrap_or("Prometeo DataGrip"),
            );
            if let Some(p) = file_opt(cfg, "sslrootcert", "SSL CA")? {
                o = o.ssl_root_cert(p);
            }
            if let Some(p) = file_opt(cfg, "sslcert", "SSL client certificate")? {
                o = o.ssl_client_cert(p);
            }
            if let Some(p) = file_opt(cfg, "sslkey", "SSL client key")? {
                o = o.ssl_client_key(p);
            }
            // startup parameters: the `options` property, `statement_timeout` (ms) and the read-only flag
            let mut params: Vec<(String, String)> = Vec::new();
            if let Some(t) = opt(cfg, &["options"]) {
                params.extend(pg_option_pairs(t));
            }
            if let Some(t) = opt(cfg, &["statement_timeout"]) {
                params.push(("statement_timeout".into(), t.into()));
            }
            if cfg.read_only {
                params.push(("default_transaction_read_only".into(), "on".into()));
            }
            if !params.is_empty() {
                o = o.options(params);
            }
            Ok(ConnOpts::Pg(o.disable_statement_logging()))
        }
        Driver::MySql => {
            let mut o = match url {
                Some(u) => {
                    let mut o = MySqlConnectOptions::from_str(u).map_err(bad)?;
                    if let Some(p) = &cfg.password {
                        o = o.password(p);
                    }
                    o
                }
                None => {
                    let mut o = MySqlConnectOptions::new()
                        .host(if cfg.host.is_empty() {
                            "localhost"
                        } else {
                            &cfg.host
                        })
                        .port(if cfg.port == 0 { 3306 } else { cfg.port });
                    if !cfg.user.is_empty() {
                        o = o.username(&cfg.user);
                    }
                    if let Some(p) = &cfg.password {
                        o = o.password(p);
                    }
                    if !cfg.database.is_empty() {
                        o = o.database(&cfg.database);
                    }
                    o
                }
            };
            if let Some(m) = opt(cfg, &["sslmode", "ssl-mode"]) {
                o = o.ssl_mode(MySqlSslMode::from_str(m).map_err(bad)?);
            }
            if let Some(p) = file_opt(cfg, "sslrootcert", "SSL CA")? {
                o = o.ssl_ca(p);
            }
            if let Some(p) = file_opt(cfg, "sslcert", "SSL client certificate")? {
                o = o.ssl_client_cert(p);
            }
            if let Some(p) = file_opt(cfg, "sslkey", "SSL client key")? {
                o = o.ssl_client_key(p);
            }
            if let Some(c) = opt(cfg, &["charset"]) {
                o = o.charset(c);
            }
            if let Some(c) = opt(cfg, &["collation"]) {
                o = o.collation(c);
            }
            // by default the session time zone is not forced: values show as the server stores them
            o = o.timezone(opt(cfg, &["timezone"]).map(str::to_string));
            Ok(ConnOpts::My(o.disable_statement_logging()))
        }
        Driver::Sqlite => {
            let mut o = match url {
                Some(u) => SqliteConnectOptions::from_str(u).map_err(bad)?,
                // every connection of this data source (pool, console sessions) must see the
                // same database: a named shared-cache in-memory one, unique per `build_opts`
                None if is_memory(cfg) => SqliteConnectOptions::new()
                    .filename(format!(
                        "file:prometeo-{}-{}?mode=memory&cache=shared",
                        uri_safe(&cfg.id),
                        uuid::Uuid::new_v4().simple()
                    ))
                    .in_memory(true)
                    .shared_cache(true),
                None => {
                    if cfg.file.trim().is_empty() {
                        return Err(DbError::InvalidArgument(
                            "SQLite database file is not set".into(),
                        ));
                    }
                    SqliteConnectOptions::new().filename(&cfg.file)
                }
            };
            let create = opt(cfg, &["create", "createIfMissing"])
                .map(|v| v == "true")
                .unwrap_or(false);
            // `busy_timeout` is in milliseconds, like the PRAGMA
            let busy =
                match opt(cfg, &["busy_timeout"]) {
                    Some(v) => Duration::from_millis(v.parse::<u64>().map_err(|_| {
                        bad(format!("busy_timeout: expected milliseconds, got '{v}'"))
                    })?),
                    None => Duration::from_secs(5),
                };
            o = o
                .create_if_missing(create)
                .read_only(cfg.read_only)
                .busy_timeout(busy);
            if let Some(m) = opt(cfg, &["journal_mode"]) {
                o = o.journal_mode(SqliteJournalMode::from_str(m).map_err(bad)?);
            }
            if let Some(m) = opt(cfg, &["synchronous"]) {
                o = o.synchronous(SqliteSynchronous::from_str(m).map_err(bad)?);
            }
            if let Some(on) = bool_opt(cfg, "foreign_keys")? {
                o = o.foreign_keys(on);
            }
            if is_memory(cfg) {
                // shared-cache table locks would otherwise make readers block writers
                o = o.pragma("read_uncommitted", "1");
            }
            Ok(ConnOpts::Lite(o.disable_statement_logging()))
        }
    }
}

fn connect_timeout(cfg: &DataSourceConfig) -> Duration {
    let secs = opt(cfg, &["connectTimeout", "connect_timeout"])
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(15);
    Duration::from_secs(secs.max(1))
}

pub(crate) async fn open_pool(cfg: &DataSourceConfig, opts: &ConnOpts) -> Result<Pool> {
    let timeout = connect_timeout(cfg);
    Ok(match opts {
        ConnOpts::Pg(o) => Pool::Pg(
            PgPoolOptions::new()
                .max_connections(8)
                .acquire_timeout(timeout)
                .idle_timeout(Duration::from_secs(300))
                .connect_with(o.clone())
                .await
                .map_err(connect_error)?,
        ),
        ConnOpts::My(o) => {
            let ro = cfg.read_only;
            Pool::My(
                MySqlPoolOptions::new()
                    .max_connections(8)
                    .acquire_timeout(timeout)
                    .idle_timeout(Duration::from_secs(300))
                    .after_connect(move |conn, _| {
                        Box::pin(async move {
                            if ro {
                                sqlx::query("SET SESSION TRANSACTION READ ONLY")
                                    .execute(&mut *conn)
                                    .await?;
                            }
                            Ok(())
                        })
                    })
                    .connect_with(o.clone())
                    .await
                    .map_err(connect_error)?,
            )
        }
        ConnOpts::Lite(o) => Pool::Lite(
            SqlitePoolOptions::new()
                .max_connections(4)
                .acquire_timeout(timeout)
                .connect_with(o.clone())
                .await
                .map_err(connect_error)?,
        ),
    })
}

impl Pool {
    pub fn driver(&self) -> Driver {
        match self {
            Pool::Pg(_) => Driver::Postgres,
            Pool::My(_) => Driver::MySql,
            Pool::Lite(_) => Driver::Sqlite,
        }
    }

    pub async fn close(&self) {
        match self {
            Pool::Pg(p) => p.close().await,
            Pool::My(p) => p.close().await,
            Pool::Lite(p) => p.close().await,
        }
    }

    /// Run a statement without reading rows (text protocol).
    pub async fn exec(&self, sql: &str) -> Result<u64> {
        Ok(match self {
            Pool::Pg(p) => sqlx::raw_sql(sql).execute(p).await?.rows_affected(),
            Pool::My(p) => sqlx::raw_sql(sql).execute(p).await?.rows_affected(),
            Pool::Lite(p) => sqlx::raw_sql(sql).execute(p).await?.rows_affected(),
        })
    }

    /// Run a query and return every value as text (NULL = `None`). Used by introspection
    /// where the SQL text is built by us and values are parsed back by position.
    pub async fn query_strings(&self, sql: &str) -> Result<Vec<Vec<Option<String>>>> {
        Ok(match self {
            Pool::Pg(p) => sqlx::raw_sql(sql)
                .fetch_all(p)
                .await?
                .iter()
                .map(pg_strings)
                .collect(),
            Pool::My(p) => sqlx::raw_sql(sql)
                .fetch_all(p)
                .await?
                .iter()
                .map(my_strings)
                .collect(),
            Pool::Lite(p) => sqlx::raw_sql(sql)
                .fetch_all(p)
                .await?
                .iter()
                .map(lite_strings)
                .collect(),
        })
    }
}

impl Conn {
    pub fn driver(&self) -> Driver {
        match self {
            Conn::Pg(_) => Driver::Postgres,
            Conn::My(_) => Driver::MySql,
            Conn::Lite(_) => Driver::Sqlite,
        }
    }

    pub async fn close(self) {
        let _ = match self {
            Conn::Pg(c) => c.close().await,
            Conn::My(c) => c.close().await,
            Conn::Lite(c) => c.close().await,
        };
    }
}

pub(crate) fn pg_strings(r: &PgRow) -> Vec<Option<String>> {
    (0..r.len())
        .map(|i| r.try_get_unchecked::<Option<String>, _>(i).ok().flatten())
        .collect()
}

pub(crate) fn my_strings(r: &MySqlRow) -> Vec<Option<String>> {
    (0..r.len())
        .map(|i| {
            r.try_get_unchecked::<Option<Vec<u8>>, _>(i)
                .ok()
                .flatten()
                .map(|b| String::from_utf8_lossy(&b).into_owned())
        })
        .collect()
}

pub(crate) fn lite_strings(r: &SqliteRow) -> Vec<Option<String>> {
    use sqlx::{TypeInfo, ValueRef};
    (0..r.len())
        .map(|i| {
            let raw = r.try_get_raw(i).ok()?;
            if raw.is_null() {
                return None;
            }
            let ty = raw.type_info().name().to_string();
            match ty.as_str() {
                "INTEGER" | "INT" | "INT8" | "BOOLEAN" => {
                    r.try_get_unchecked::<i64, _>(i).ok().map(|v| v.to_string())
                }
                "REAL" | "NUMERIC" => r.try_get_unchecked::<f64, _>(i).ok().map(|v| v.to_string()),
                "BLOB" => r
                    .try_get_unchecked::<Vec<u8>, _>(i)
                    .ok()
                    .map(|b| crate::quote::hex_encode(&b)),
                _ => r.try_get_unchecked::<String, _>(i).ok(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::pg_option_pairs;

    #[test]
    fn pg_options_text_becomes_startup_parameters() {
        assert_eq!(
            pg_option_pairs("-c search_path=a,b -ctimezone=UTC --lock-timeout=5 -c nonsense -x"),
            vec![
                ("search_path".to_string(), "a,b".to_string()),
                ("timezone".to_string(), "UTC".to_string()),
                ("lock_timeout".to_string(), "5".to_string()),
            ]
        );
        assert!(pg_option_pairs("").is_empty());
    }
}
