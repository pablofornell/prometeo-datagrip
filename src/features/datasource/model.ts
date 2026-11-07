/**
 * Editable model of one data source in the dialog (a "draft") and its conversion from / to the backend
 * `DataSource` / `DataSourceConfig`.
 *
 * Option keys written into `DataSourceConfig.options` (all values are strings):
 *   comment            free text
 *   dbms               "mariadb" when the Driver combo says MariaDB (driver stays "mysql")
 *   auth               "none" for "No auth" (user / password are cleared)
 *   passwordSave       reserved, always "forever" (only "Forever" is supported by the backend)
 *   sslrootcert / sslcert / sslkey   paths of the CA, client certificate and client key files (both drivers; read by dbcore)
 *   sslmode            sqlx ssl mode (PG: disable|allow|prefer|require|verify-ca|verify-full,
 *                      MySQL: disabled|preferred|required|verify_ca|verify_identity); absent = driver default
 *   create             "true": SQLite creates the file when it does not exist (read by dbcore)
 *   connectTimeout     seconds (read by dbcore); application_name (PG, read by dbcore)
 *   txMode             "auto" (default, absent) | "manual": default transaction control of new consoles
 *   sessionControl     "dedicated" (default, absent) | "single": one shared session per data source
 *   keepAliveSec       absent = off, otherwise the keep-alive query interval in seconds
 *   autoDisconnectSec  absent = off, otherwise seconds of inactivity before the connection is closed
 *   startupScript      SQL run when a session opens
 *   showSystemSchemas  "true": the explorer also lists system schemas
 *   switchSchema       "disabled": the console's schema switcher does not run `SET search_path` / `USE` (absent = automatic)
 *   autoSync           "false": no re-introspection after DDL that ran in a console (absent = on)
 *   visibleSchemas     NOT a backend option any more: the form carries it (JSON array of introspection paths of the
 *                      schemas to show, e.g. [["postgres","public"]]; absent = all non-system) but Apply stores it in the
 *                      UI state (state/schema-filter), because options are part of the connection fingerprint and a
 *                      view filter must not reconnect. Old configs that still have it are read as the fallback.
 * Any other key is a free driver property edited in the Advanced tab.
 */
import type { DataSource, DataSourceConfig } from "../../api/db";
import { defaultOptions } from "./driverDefaults";
import { visibleSchemasRaw } from "./schemas";
import { DBMS, type Dbms, buildUrl, dbmsOf, fromSqlxUrl, isMemoryUrl, parseUrl, sqliteFileOfUrl, toSqlxUrl } from "./drivers";

export type ConnType = "default" | "memory" | "url";
export type Auth = "password" | "none";

export interface Form {
  name: string;
  dbms: Dbms;
  connType: ConnType;
  host: string;
  port: string;
  auth: Auth;
  user: string;
  database: string;
  file: string;
  /** Displayed JDBC URL. In "default" mode it is derived from the fields (and edits flow back). */
  url: string;
  color: string | null;
  readOnly: boolean;
  options: Record<string, string>;
}

export interface Password {
  value: string;
  /** The user typed in the field: `value` replaces the stored one (also when empty). */
  touched: boolean;
}

export interface TestInfo {
  ok: boolean;
  /** Backend `serverVersion`, e.g. "PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2)". */
  version: string | null;
  message: string;
  elapsedMs: number;
  /** SSL mode that was configured at the time of the test. */
  sslmode: string | null;
  /** Negotiated SSL state when the backend reports it (`TestResult.ssl`), else null (derived from `sslmode`). */
  ssl?: boolean | null;
  dbms: Dbms;
}

export interface Draft {
  /** Local key, stable while the dialog is open. */
  key: string;
  /** Backend id; `null` for a data source that was not applied yet. */
  id: string | null;
  saved: DataSource | null;
  form: Form;
  password: Password;
  /** The name follows the host/database/file until the user edits it. */
  nameAuto: boolean;
  /** JSON of the form at load / last apply (modified marker). */
  base: string;
  test: { state: "idle" | "running" | "done"; info?: TestInfo; lastOk?: TestInfo };
}

export const RESERVED_OPTIONS = new Set([
  "comment", "dbms", "auth", "passwordSave", "sslmode", "create", "txMode", "sessionControl", "keepAliveSec",
  "autoDisconnectSec", "startupScript", "showSystemSchemas", "visibleSchemas", "switchSchema", "autoSync",
  "sslrootcert", "sslcert", "sslkey",
]);

export function defaultForm(dbms: Dbms): Form {
  const info = DBMS[dbms];
  const f: Form = {
    name: "",
    dbms,
    connType: "default",
    host: dbms === "sqlite" ? "" : "localhost",
    port: dbms === "sqlite" ? "" : String(info.defaultPort),
    auth: "password",
    user: "",
    database: dbms === "postgres" ? "postgres" : "",
    file: "",
    url: "",
    color: null,
    readOnly: false,
    // what the driver's Options page says new data sources start with
    options: defaultOptions(dbms),
  };
  f.url = buildUrl(dbms, f);
  return f;
}

export function formFromDataSource(ds: DataSource): Form {
  const dbms = dbmsOf(ds.driver, ds.options);
  const info = DBMS[dbms];
  const connType: ConnType = ds.urlOverride ? (isMemoryUrl(ds.urlOverride) ? "memory" : "url") : "default";
  const f: Form = {
    name: ds.name,
    dbms,
    connType,
    host: ds.host || (dbms === "sqlite" ? "" : "localhost"),
    port: dbms === "sqlite" ? "" : String(ds.port || info.defaultPort),
    auth: ds.options.auth === "none" ? "none" : "password",
    user: ds.user,
    database: ds.database,
    file: ds.file,
    url: "",
    color: ds.color,
    readOnly: ds.readOnly,
    options: { ...ds.options },
  };
  const filter = visibleSchemasRaw(ds);
  if (filter) f.options.visibleSchemas = filter;
  else delete f.options.visibleSchemas;
  if (connType === "url") {
    f.url = fromSqlxUrl(dbms, ds.urlOverride!);
    const p = parseUrl(dbms, f.url);
    if (p) {
      f.host = p.host;
      f.port = p.port;
      f.database = p.database;
    }
    if (dbms === "sqlite") f.file = sqliteFileOfUrl(f.url) ?? ds.file;
  } else if (connType === "memory") {
    f.url = "jdbc:sqlite::memory:";
  } else {
    f.url = buildUrl(dbms, f);
  }
  return f;
}

export const normalizedForm = (f: Form): Form => ({
  ...f,
  options: Object.fromEntries(Object.entries(f.options).sort(([a], [b]) => (a < b ? -1 : 1))),
});

/**
 * The part of a form snapshot that is saved to the backend: everything but the schema filter (a view setting that goes
 * to the UI state). A change here needs a `save_data_source`.
 */
export function savedPart(snapshot: string): string {
  const f = JSON.parse(snapshot) as Form;
  delete f.options?.visibleSchemas;
  return JSON.stringify(f);
}

/**
 * Option keys that are view settings: the backend leaves them out of its connection fingerprint (they never reconnect).
 * `visibleSchemas` is the legacy copy of the schema filter, which lives in the UI state now.
 */
/** Option keys the form does not own: sent back as stored (a legacy `visibleSchemas`). */
export const VIEW_ONLY_OPTION_KEYS: readonly string[] = ["visibleSchemas"];

/**
 * Option keys the backend connection fingerprint ignores: changing them does not reconnect.
 * Same list as VIEW_ONLY_OPTIONS in src-tauri/src/state.rs (fingerprint.test.ts checks it).
 */
export const FINGERPRINT_IGNORED_OPTION_KEYS: readonly string[] = [
  "comment", "visibleSchemas", "showSystemSchemas", "txMode", "sessionControl", "keepAliveSec", "autoDisconnectSec",
  "startupScript", "switchSchema", "autoSync", "passwordSave",
];

/**
 * THE rule for "does this save reconnect": the connection fingerprint of the backend (`connection_fingerprint` in
 * src-tauri/src/state.rs). The whole config except the name, the color and the password (and the view-only option keys,
 * `FINGERPRINT_IGNORED_OPTION_KEYS`). Keep it in step with that function: it is the only copy on this side.
 */
function connectionFingerprint(c: Partial<DataSourceConfig>): string {
  const { name: _n, color: _c, password: _p, hasPassword: _h, passwordStorage: _s, options, ...rest } = c as Record<string, unknown> & { options?: Record<string, string> };
  const opts = Object.fromEntries(Object.entries(options ?? {}).filter(([k]) => !FINGERPRINT_IGNORED_OPTION_KEYS.includes(k)).sort(([x], [y]) => (x < y ? -1 : 1)));
  return JSON.stringify(Object.entries({ ...rest, options: opts }).sort(([x], [y]) => (x < y ? -1 : 1)));
}

/** Whether saving `after` over the stored `before` makes the backend reconnect the data source (see `connectionFingerprint`). */
export function reconnectsOnSave(before: Partial<DataSourceConfig>, after: Partial<DataSourceConfig>): boolean {
  return connectionFingerprint(before) !== connectionFingerprint(after);
}

/**
 * Whether applying `form` over the stored data source `saved` reconnects it: compares exactly what `configFromForm`
 * will send with what is stored. A new data source (no `saved`) has nothing to reconnect.
 */
export function reconnectsOnApply(form: Form, id: string | null, saved: DataSource | null): boolean {
  return !!id && !!saved && reconnectsOnSave(saved, configFromForm(form, id, saved));
}

/**
 * Form -> backend config (without `password`, which the caller adds). `saved` is the stored data source: the option
 * keys the form does not own (`VIEW_ONLY_OPTION_KEYS`, e.g. a legacy `visibleSchemas`) are sent back as stored, so
 * that a rename sends the same connection settings. Empty values the stored config has itself are kept as well.
 */
export function configFromForm(f: Form, id: string | null, saved?: DataSource | null): Partial<DataSourceConfig> & { name: string } {
  const info = DBMS[f.dbms];
  const options = { ...f.options };
  for (const k of VIEW_ONLY_OPTION_KEYS) {
    delete options[k]; // the form carries the schema filter (UI state), not the connection's copy of it
    if (saved?.options[k] !== undefined) options[k] = saved.options[k];
  }
  if (f.dbms === "mariadb") options.dbms = "mariadb";
  else delete options.dbms;
  if (f.auth === "none") options.auth = "none";
  else delete options.auth;
  for (const k of Object.keys(options)) if (options[k] === "" && saved?.options[k] !== "") delete options[k];

  const cfg: Partial<DataSourceConfig> & { name: string } = {
    name: f.name.trim(),
    driver: info.driver,
    host: "",
    port: 0,
    database: "",
    user: "",
    file: "",
    urlOverride: null,
    options,
    color: f.color,
    readOnly: f.readOnly,
  };
  if (id) cfg.id = id;
  const noAuth = f.auth === "none";
  if (f.dbms === "sqlite") {
    if (f.connType === "memory") {
      cfg.urlOverride = "sqlite::memory:";
    } else if (f.connType === "url") {
      cfg.urlOverride = toSqlxUrl("sqlite", f.url);
      cfg.file = sqliteFileOfUrl(f.url) ?? "";
    } else {
      cfg.file = f.file.trim();
    }
    return cfg;
  }
  if (f.connType === "url") {
    cfg.urlOverride = toSqlxUrl(f.dbms, f.url);
    const p = parseUrl(f.dbms, f.url);
    if (p) {
      cfg.host = p.host;
      cfg.port = Number(p.port) || 0;
      cfg.database = p.database;
    }
    return cfg;
  }
  cfg.host = f.host.trim();
  cfg.port = Number(f.port) || info.defaultPort;
  cfg.database = f.database.trim();
  cfg.user = noAuth ? "" : f.user.trim();
  return cfg;
}

// ---------------------------------------------------------------- names

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

/** DataGrip's default name: `user@host` (database when the user is empty), file name for SQLite. */
export function autoName(f: Form): string {
  if (f.dbms === "sqlite") {
    if (f.connType === "memory") return "SQLite";
    return f.file.trim() ? baseName(f.file.trim()) : "SQLite";
  }
  return `${f.user.trim() || f.database.trim()}@${f.host.trim() || "localhost"}`;
}

export function uniqueName(want: string, taken: string[]): string {
  if (!taken.includes(want)) return want;
  for (let i = 1; ; i++) if (!taken.includes(`${want} ${i}`)) return `${want} ${i}`;
}

// ---------------------------------------------------------------- validation

export interface Problem {
  /** Tab to show when the problem is clicked. */
  tab: "general" | "options" | "ssh" | "schemas" | "advanced";
  message: string;
}

export function validate(f: Form, names: string[]): Problem[] {
  const out: Problem[] = [];
  const err = (message: string) => out.push({ tab: "general", message });
  if (!f.name.trim()) err("Name is empty");
  else if (names.includes(f.name.trim())) err(`Data source name "${f.name.trim()}" is already used`);
  if (f.dbms === "sqlite") {
    if (f.connType === "default" && !f.file.trim()) err("File is not specified");
    if (f.connType === "url" && !parseUrl("sqlite", f.url)) err("Invalid URL: expected jdbc:sqlite:<path>");
  } else if (f.connType === "url") {
    if (!parseUrl(f.dbms, f.url)) err(`Invalid URL: expected jdbc:${DBMS[f.dbms].scheme}://host:port/database`);
  } else {
    if (!f.host.trim()) err("Host is not specified");
    if (f.port.trim() && !(/^\d+$/.test(f.port.trim()) && Number(f.port) >= 1 && Number(f.port) <= 65535))
      err("Port must be a number between 1 and 65535");
  }
  const kn = (k: string) => f.options[k] !== undefined && f.options[k] !== "" && !/^\d+$/.test(f.options[k]);
  if (kn("keepAliveSec")) out.push({ tab: "options", message: "Keep-alive interval must be a number of seconds" });
  if (kn("autoDisconnectSec")) out.push({ tab: "options", message: "Auto-disconnect interval must be a number of seconds" });
  if (kn("connectTimeout")) out.push({ tab: "advanced", message: "connectTimeout must be a number of seconds" });
  return out;
}

/** Info line of the Test Connection footer: "PostgreSQL 16.15". */
export function shortVersion(version: string | null, dbms: Dbms): string {
  const label = DBMS[dbms].label;
  if (!version) return label;
  const v = /(\d+(?:\.\d+){0,2})/.exec(version.replace(/^[A-Za-z]+\s+/, ""))?.[1];
  const name = /^MariaDB/i.test(version) ? "MariaDB" : /^MySQL/i.test(version) ? "MySQL" : label;
  return v ? `${name} ${v}` : name;
}
