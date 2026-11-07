/**
 * Built-in drivers (sqlx) and the JDBC-like URL text DataGrip shows for them.
 *
 * The UI displays `jdbc:postgresql://localhost:5432/postgres` exactly like DataGrip, but the backend takes a
 * plain sqlx URL (`postgresql://...`, `mysql://...`, `sqlite:...`) in `DataSourceConfig.urlOverride`; the
 * conversion helpers below translate between both.
 */
import type { Driver } from "../../api/db";
import { theme } from "../../state/theme";
import mariadbLight from "./icons/mariadb.svg?url";
import mariadbDark from "./icons/mariadb_dark.svg?url";
import mysqlLight from "./icons/mysql.svg?url";
import mysqlDark from "./icons/mysql_dark.svg?url";
import oracleLight from "./icons/oracle.svg?url";
import oracleDark from "./icons/oracle_dark.svg?url";
import postgresLight from "./icons/postgresql.svg?url";
import postgresDark from "./icons/postgresql_dark.svg?url";
import sqliteLight from "./icons/sqlite.svg?url";
import sqliteDark from "./icons/sqlite_dark.svg?url";
import driverLight from "./icons/userDriver.svg?url";
import driverDark from "./icons/userDriver_dark.svg?url";

/** What the Driver combo offers. MariaDB is the MySQL driver with another label (`options.dbms = "mariadb"`). */
export type Dbms = "postgres" | "mysql" | "mariadb" | "sqlite" | "oracle";

export interface DbmsInfo {
  id: Dbms;
  driver: Driver;
  label: string;
  defaultPort: number;
  /** `jdbc:<scheme>:` */
  scheme: string;
  /** Library line of the Drivers page. */
  library: string;
  sslModes: { value: string; label: string }[];
  defaultSslMode: string;
}

export const DBMS: Record<Dbms, DbmsInfo> = {
  postgres: {
    id: "postgres",
    driver: "postgres",
    label: "PostgreSQL",
    defaultPort: 5432,
    scheme: "postgresql",
    library: "sqlx-postgres 0.8 (built in)",
    sslModes: [
      { value: "disable", label: "Disable" },
      { value: "allow", label: "Allow" },
      { value: "prefer", label: "Prefer" },
      { value: "require", label: "Require" },
      { value: "verify-ca", label: "Verify CA" },
      { value: "verify-full", label: "Verify full" },
    ],
    defaultSslMode: "require",
  },
  mysql: {
    id: "mysql",
    driver: "mysql",
    label: "MySQL",
    defaultPort: 3306,
    scheme: "mysql",
    library: "sqlx-mysql 0.8 (built in)",
    sslModes: [
      { value: "disabled", label: "Disabled" },
      { value: "preferred", label: "Preferred" },
      { value: "required", label: "Required" },
      { value: "verify_ca", label: "Verify CA" },
      { value: "verify_identity", label: "Verify identity" },
    ],
    defaultSslMode: "required",
  },
  mariadb: {
    id: "mariadb",
    driver: "mysql",
    label: "MariaDB",
    defaultPort: 3306,
    scheme: "mariadb",
    library: "sqlx-mysql 0.8 (built in)",
    sslModes: [
      { value: "disabled", label: "Disabled" },
      { value: "preferred", label: "Preferred" },
      { value: "required", label: "Required" },
      { value: "verify_ca", label: "Verify CA" },
      { value: "verify_identity", label: "Verify identity" },
    ],
    defaultSslMode: "required",
  },
  oracle: {
    id: "oracle",
    driver: "oracle",
    label: "Oracle",
    defaultPort: 1521,
    scheme: "oracle:thin",
    library: "oracledb thin driver (built in)",
    sslModes: [],
    defaultSslMode: "",
  },
  sqlite: {
    id: "sqlite",
    driver: "sqlite",
    label: "SQLite",
    defaultPort: 0,
    scheme: "sqlite",
    library: "sqlx-sqlite 0.8 (built in)",
    sslModes: [],
    defaultSslMode: "",
  },
};

/** Order of the "+" popup and of the Driver combo. */
export const DBMS_ORDER: Dbms[] = ["postgres", "mysql", "mariadb", "oracle", "sqlite"];

const ICONS: Record<Dbms, [string, string]> = {
  postgres: [postgresLight, postgresDark],
  mysql: [mysqlLight, mysqlDark],
  mariadb: [mariadbLight, mariadbDark],
  oracle: [oracleLight, oracleDark],
  sqlite: [sqliteLight, sqliteDark],
};

/** Brand icon URL for the current theme (use with `<Icon src=...>` or as a menu icon). */
export const dbmsIcon = (d: Dbms): string => ICONS[d][theme() === "dark" ? 1 : 0];
export const driversRailIcon = (): string => (theme() === "dark" ? driverDark : driverLight);

export const dbmsOf = (driver: Driver, options?: Record<string, string>): Dbms =>
  driver === "mysql" ? (options?.dbms === "mariadb" ? "mariadb" : "mysql") : driver;

// ---------------------------------------------------------------- URL helpers

export interface ParsedUrl {
  host: string;
  port: string;
  database: string;
  /** Query string without the `?`. */
  query: string;
  /** Oracle: the URL names a SID (`@host:port:SID`) instead of a service name (`@//host:port/service`). */
  sid?: boolean;
  /** Oracle: `user/password` of `jdbc:oracle:thin:user/password@...`. */
  user?: string;
  password?: string;
}

/**
 * Oracle thin URLs: `jdbc:oracle:thin:[user/password]@//host[:port]/service` or `...@host[:port]:SID`
 * (also `@host:port/service`). Group 1/2 = user/password, 3 = `//`, 4 = host, 5 = port, 6 = `/service` or `:SID`.
 */
const ORACLE_JDBC = /^jdbc:oracle:thin:(?:([^/@]*)(?:\/([^@]*))?)?@(\/\/)?(\[[^\]]*\]|[\w.-]*)(?::(\d*))?(?:([/:])([^?]*))?(?:\?(.*))?$/i;

function parseOracleUrl(url: string): ParsedUrl | null {
  const m = ORACLE_JDBC.exec(url.trim());
  if (!m) return null;
  const sid = !m[3] && m[6] === ":";
  if (m[6] === ":" && m[3]) return null; // `//host:port:x` is not a thing
  const out: ParsedUrl = {
    host: m[4].replace(/^\[|\]$/g, ""),
    port: m[5] ?? "",
    database: decodeURIComponent(m[7] ?? ""),
    query: m[8] ?? "",
    sid,
  };
  if (m[1]) out.user = m[1];
  if (m[2]) out.password = m[2];
  return out;
}

const hostPart = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);

/** `jdbc:postgresql://host:port/db` built from the form fields (what DataGrip displays). */
export function buildUrl(
  dbms: Dbms,
  f: { host: string; port: string; database: string; file: string; options?: Record<string, string> },
): string {
  const info = DBMS[dbms];
  if (dbms === "sqlite") return `jdbc:sqlite:${f.file}`;
  const host = f.host.trim();
  const port = f.port.trim();
  if (dbms === "oracle") {
    // service name: `@//host:port/service`; SID: `@host:port:SID`
    const hp = (host ? hostPart(host) : "") + (port ? `:${port}` : "");
    return f.options?.oracleConnType === "sid" ? `jdbc:oracle:thin:@${hp}:${f.database}` : `jdbc:oracle:thin:@//${hp}${f.database ? `/${f.database}` : ""}`;
  }
  let u = `jdbc:${info.scheme}://${host ? hostPart(host) : ""}`;
  if (port) u += `:${port}`;
  if (f.database) u += `/${f.database}`;
  return u;
}

/** Parse a JDBC URL for the given DBMS. `null` when it does not have the expected shape. */
export function parseUrl(dbms: Dbms, url: string): ParsedUrl | null {
  const info = DBMS[dbms];
  if (dbms === "sqlite") {
    const m = /^jdbc:sqlite:(.*)$/i.exec(url.trim());
    return m ? { host: "", port: "", database: "", query: "" } : null;
  }
  if (dbms === "oracle") return parseOracleUrl(url);
  const alt = dbms === "mysql" || dbms === "mariadb" ? "(?:mysql|mariadb)" : info.scheme;
  const m = new RegExp(`^jdbc:${alt}://(\\[[^\\]]*\\]|[^/:?]*)(?::(\\d*))?(?:/([^?]*))?(?:\\?(.*))?$`, "i").exec(url.trim());
  if (!m) return null;
  const host = m[1].replace(/^\[|\]$/g, "");
  return { host, port: m[2] ?? "", database: decodeURIComponent(m[3] ?? ""), query: m[4] ?? "" };
}

/** SQLite file of a `jdbc:sqlite:<path>` URL. */
export const sqliteFileOfUrl = (url: string): string | null => /^jdbc:sqlite:(.*)$/i.exec(url.trim())?.[1] ?? null;

/** JDBC-like URL -> URL for the backend (sqlx). User/password given as `?user=&password=` move into the authority. */
export function toSqlxUrl(dbms: Dbms, url: string): string {
  let u = url.trim().replace(/^jdbc:/i, "");
  if (dbms === "sqlite") return u;
  if (dbms === "oracle") {
    // the backend takes `oracle://[user[:password]@]host:port/service[?sid=1]`
    const p = parseOracleUrl(url);
    if (!p) return u;
    const enc = encodeURIComponent;
    const cred = p.user ? enc(p.user) + (p.password ? ":" + enc(p.password) : "") + "@" : "";
    const rest = p.query ? `${p.sid ? "sid=1&" : ""}${p.query}` : p.sid ? "sid=1" : "";
    return `oracle://${cred}${p.host ? hostPart(p.host) : ""}${p.port ? ":" + p.port : ""}/${enc(p.database)}${rest ? "?" + rest : ""}`;
  }
  u = u.replace(/^(postgresql|postgres|mysql|mariadb):/i, () => (dbms === "postgres" ? "postgresql:" : "mysql:"));
  const qi = u.indexOf("?");
  if (qi < 0) return u;
  const params = new URLSearchParams(u.slice(qi + 1));
  const user = params.get("user");
  const pass = params.get("password");
  if (user == null && pass == null) return u;
  params.delete("user");
  params.delete("password");
  const rest = params.toString();
  let base = u.slice(0, qi);
  const m = /^([a-z]+:\/\/)(?:[^@/]*@)?(.*)$/i.exec(base);
  if (m) {
    const cred = (user != null ? encodeURIComponent(user) : "") + (pass != null ? ":" + encodeURIComponent(pass) : "");
    base = m[1] + (cred ? cred + "@" : "") + m[2];
  }
  return rest ? `${base}?${rest}` : base;
}

/** URL of the backend (sqlx) -> JDBC-like text. */
export function fromSqlxUrl(dbms: Dbms, url: string): string {
  const u = url.trim();
  if (/^jdbc:/i.test(u)) return u;
  if (dbms === "sqlite") return "jdbc:" + u;
  if (dbms === "oracle") {
    const m = /^oracle:\/\/(?:([^@/]*)@)?(\[[^\]]*\]|[^/:?]*)(?::(\d*))?(?:\/([^?]*))?(?:\?(.*))?$/i.exec(u);
    if (!m) return "jdbc:" + u;
    const params = new URLSearchParams(m[5] ?? "");
    const sid = ["1", "true"].includes(params.get("sid") ?? "");
    params.delete("sid");
    const [user, pass] = m[1] ? (m[1].includes(":") ? [m[1].slice(0, m[1].indexOf(":")), m[1].slice(m[1].indexOf(":") + 1)] : [m[1], undefined]) : [];
    const dec = (x: string) => decodeURIComponent(x);
    const cred = user ? dec(user) + (pass !== undefined ? "/" + dec(pass) : "") : "";
    const hp = m[2] + (m[3] ? `:${m[3]}` : "");
    const db = dec(m[4] ?? "");
    const q = params.toString();
    return `jdbc:oracle:thin:${cred}@${sid ? `${hp}:${db}` : `//${hp}${db ? "/" + db : ""}`}${q ? "?" + q : ""}`;
  }
  return "jdbc:" + u.replace(/^(postgresql|postgres|mysql|mariadb):/i, `${DBMS[dbms].scheme}:`);
}

export const isMemoryUrl = (u: string | null | undefined): boolean => !!u && /^sqlite:(\/\/)?:memory:?/i.test(u.trim());
