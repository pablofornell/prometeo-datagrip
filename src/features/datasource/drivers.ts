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
import postgresLight from "./icons/postgresql.svg?url";
import postgresDark from "./icons/postgresql_dark.svg?url";
import sqliteLight from "./icons/sqlite.svg?url";
import sqliteDark from "./icons/sqlite_dark.svg?url";
import driverLight from "./icons/userDriver.svg?url";
import driverDark from "./icons/userDriver_dark.svg?url";

/** What the Driver combo offers. MariaDB is the MySQL driver with another label (`options.dbms = "mariadb"`). */
export type Dbms = "postgres" | "mysql" | "mariadb" | "sqlite";

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
export const DBMS_ORDER: Dbms[] = ["postgres", "mysql", "mariadb", "sqlite"];

const ICONS: Record<Dbms, [string, string]> = {
  postgres: [postgresLight, postgresDark],
  mysql: [mysqlLight, mysqlDark],
  mariadb: [mariadbLight, mariadbDark],
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
}

const hostPart = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);

/** `jdbc:postgresql://host:port/db` built from the form fields (what DataGrip displays). */
export function buildUrl(dbms: Dbms, f: { host: string; port: string; database: string; file: string }): string {
  const info = DBMS[dbms];
  if (dbms === "sqlite") return `jdbc:sqlite:${f.file}`;
  const host = f.host.trim();
  const port = f.port.trim();
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
  return "jdbc:" + u.replace(/^(postgresql|postgres|mysql|mariadb):/i, `${DBMS[dbms].scheme}:`);
}

export const isMemoryUrl = (u: string | null | undefined): boolean => !!u && /^sqlite:(\/\/)?:memory:?/i.test(u.trim());
