/**
 * DataGrip's wording for connection failures. The backend (sqlx) reports the raw OS / driver error
 * ("error communicating with database: Connection refused (os error 111)"); the Data Sources dialog
 * (Test Connection) and the explorer (connect error balloon / node) show this text instead.
 */

export interface ConnectionTarget {
  driver: string;
  host?: string | null;
  port?: string | number | null;
  /** SQLite database file. */
  file?: string | null;
}

const REFUSED = /connection refused|os error 111|econnrefused|actively refused|os error 10061/i;
const TIMED_OUT = /timed out|timeout|os error 110|os error 10060/i;
const NO_HOST = /failed to lookup address|name or service not known|no such host|nodename nor servname|os error -2\b|temporary failure in name resolution/i;
const NO_FILE = /unable to open database file|os error 2\b|no such file or directory|cannot open/i;

const hostPort = (t: ConnectionTarget): string => `${t.host || "localhost"}${t.port ? ":" + t.port : ""}`;

/**
 * Maps a raw connection error to the message DataGrip shows. PostgreSQL's wording is the pgjdbc one;
 * MySQL / MariaDB / SQLite are DataGrip-style equivalents. Unknown errors are returned without the
 * "error communicating with database:" prefix.
 */
export function friendlyConnectionError(raw: string, t: ConnectionTarget): string {
  const msg = String(raw ?? "").replace(/^Error:\s*/, "").trim();
  const driver = t.driver === "mariadb" ? "mysql" : t.driver;
  if (driver === "sqlite") {
    if (NO_FILE.test(msg)) return `Cannot open the database file${t.file ? ` '${t.file}'` : ""}. Check that the path is correct and that the file is accessible.`;
  } else {
    if (REFUSED.test(msg)) {
      return driver === "postgres"
        ? `Connection to ${hostPort(t)} refused. Check that the hostname and port are correct and that the postmaster is accepting TCP/IP connections.`
        : `Connection to ${hostPort(t)} refused. Check that the hostname and port are correct and that the MySQL server is accepting TCP/IP connections.`;
    }
    if (NO_HOST.test(msg)) return `The connection to ${hostPort(t)} failed: unknown host '${t.host ?? ""}'. Check that the hostname is correct.`;
    if (TIMED_OUT.test(msg) && /os error|connect/i.test(msg)) return `Connection to ${hostPort(t)} timed out. Check that the hostname and port are correct and that the server is reachable.`;
  }
  return msg.replace(/^error communicating with database:\s*/i, "");
}
