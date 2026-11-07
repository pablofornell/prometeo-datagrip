// @vitest-environment node
import { describe, expect, it } from "vitest";
import { friendlyConnectionError, isConnectionLost } from "./connection-errors";

const RAW = "error communicating with database: Connection refused (os error 111)";

describe("friendlyConnectionError", () => {
  it("PostgreSQL: DataGrip's wording for a refused connection", () => {
    expect(friendlyConnectionError(RAW, { driver: "postgres", host: "127.0.0.1", port: 55499 })).toBe(
      "Connection to 127.0.0.1:55499 refused. Check that the hostname and port are correct and that the postmaster is accepting TCP/IP connections.",
    );
  });
  it("MySQL and MariaDB get a clear message", () => {
    for (const driver of ["mysql", "mariadb"]) {
      expect(friendlyConnectionError(RAW, { driver, host: "db", port: "3306" })).toBe(
        "Connection to db:3306 refused. Check that the hostname and port are correct and that the MySQL server is accepting TCP/IP connections.",
      );
    }
  });
  it("SQLite: missing file", () => {
    expect(friendlyConnectionError("error returned from database: (code: 14) unable to open database file", { driver: "sqlite", file: "/x/y.db" })).toBe(
      "Cannot open the database file '/x/y.db'. Check that the path is correct and that the file is accessible.",
    );
  });
  it("unknown host", () => {
    expect(friendlyConnectionError("failed to lookup address information: Name or service not known", { driver: "postgres", host: "nope", port: 5432 })).toContain("unknown host 'nope'");
  });
  it("other errors lose only the sqlx prefix", () => {
    expect(
      friendlyConnectionError('error returned from database: password authentication failed for user "postgres"', { driver: "postgres", host: "h", port: 1 }),
    ).toBe('error returned from database: password authentication failed for user "postgres"');
    expect(friendlyConnectionError("error communicating with database: broken pipe", { driver: "postgres" })).toBe("broken pipe");
  });
});

describe("isConnectionLost", () => {
  it("the backend's connectionLost flag", () => {
    expect(isConnectionLost({ connectionLost: true, message: "whatever" })).toBe(true);
    expect(isConnectionLost({ connectionLost: false, message: "syntax error" })).toBe(false);
  });
  it("the SQLSTATE prefix of PG / SQLite (08006) and MySQL (08S01), with or without `Error:`", () => {
    expect(isConnectionLost(new Error("[08006] connection lost: the server closed the connection"))).toBe(true);
    expect(isConnectionLost("Error: [08S01] connection lost")).toBe(true);
    expect(isConnectionLost(new Error("[08003] no connection"))).toBe(true);
    expect(isConnectionLost(new Error("[08001] cannot connect"))).toBe(true);
  });
  it("the old `Session ... does not exist` text", () => {
    expect(isConnectionLost(new Error("Session 's3' does not exist"))).toBe(true);
    expect(isConnectionLost("Session is closed")).toBe(true);
  });
  it("is not fooled by other errors", () => {
    expect(isConnectionLost(new Error('relation "t" does not exist'))).toBe(false);
    expect(isConnectionLost(new Error("syntax error near [08006]"))).toBe(false);
    expect(isConnectionLost(undefined)).toBe(false);
    expect(isConnectionLost(null)).toBe(false);
  });
});

describe("friendlyConnectionError: Oracle", () => {
  it("refused connection names the listener", () => {
    expect(friendlyConnectionError(RAW, { driver: "oracle", host: "h", port: 1521 })).toBe(
      "Connection to h:1521 refused. Check that the hostname and port are correct and that the listener is accepting TCP/IP connections.",
    );
  });
  it("leaves ORA errors alone", () => {
    expect(friendlyConnectionError("ORA-01017: invalid username/password; logon denied", { driver: "oracle", host: "h", port: 1521 })).toBe("ORA-01017: invalid username/password; logon denied");
  });
});
