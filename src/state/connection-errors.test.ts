// @vitest-environment node
import { describe, expect, it } from "vitest";
import { friendlyConnectionError } from "./connection-errors";

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
