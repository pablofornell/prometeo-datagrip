/**
 * "Data Source from URL": turns a pasted connection URL or file path into the fields of a new data source.
 * Understands `jdbc:postgresql://host:port/db`, `postgres://user:password@host/db?user=..&password=..`,
 * `mysql://`, `mariadb://`, `jdbc:sqlite:path`, `sqlite:path` / `file:path` and plain paths of SQLite files.
 */
import type { Dbms } from "./drivers";

export interface UrlPrefill {
  dbms: Dbms;
  host?: string;
  port?: string;
  database?: string;
  user?: string;
  password?: string;
  file?: string;
}

const SQLITE_FILE = /\.(db|db3|sqlite|sqlite3|s3db)$/i;

export function parseDataSourceUrl(text: string): UrlPrefill | null {
  let t = text.trim().replace(/^jdbc:/i, "");
  if (!t) return null;
  const lite = /^(?:sqlite|file):(?:\/\/)?(.*)$/i.exec(t);
  if (lite) {
    const file = lite[1].replace(/\?.*$/, "");
    return file && !/^:memory:?$/i.test(file) ? { dbms: "sqlite", file: /^\/\/?[A-Za-z]:/.test(file) ? file.replace(/^\/+/, "") : file } : null;
  }
  if (/^(?:\/|~|\.{1,2}\/|[A-Za-z]:[\\/])/.test(t) && SQLITE_FILE.test(t)) return { dbms: "sqlite", file: t };
  const m = /^(postgresql|postgres|pgsql|mysql|mariadb):\/\/(.*)$/i.exec(t);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const dbms: Dbms = scheme === "mysql" ? "mysql" : scheme === "mariadb" ? "mariadb" : "postgres";
  t = m[2];
  const q = t.indexOf("?");
  const params = new URLSearchParams(q >= 0 ? t.slice(q + 1) : "");
  if (q >= 0) t = t.slice(0, q);
  const slash = t.indexOf("/");
  const authority = slash >= 0 ? t.slice(0, slash) : t;
  const database = slash >= 0 ? safeDecode(t.slice(slash + 1)) : "";
  const at = authority.lastIndexOf("@");
  const cred = at >= 0 ? authority.slice(0, at) : "";
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  const [u, p] = cred.includes(":") ? [cred.slice(0, cred.indexOf(":")), cred.slice(cred.indexOf(":") + 1)] : [cred, undefined];
  const hp = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(hostPort);
  if (!hp) return null;
  const out: UrlPrefill = { dbms, host: hp[1].replace(/^\[|\]$/g, ""), port: hp[2] ?? "", database };
  const user = params.get("user") ?? (u ? safeDecode(u) : undefined);
  const password = params.get("password") ?? (p !== undefined ? safeDecode(p) : undefined);
  if (user) out.user = user;
  if (password) out.password = password;
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
