import { describe, expect, it } from "vitest";
import { parseDataSourceUrl } from "./urlParse";

describe("parseDataSourceUrl", () => {
  it("reads a jdbc url", () => {
    expect(parseDataSourceUrl("jdbc:postgresql://db.example.com:5433/shop")).toEqual({ dbms: "postgres", host: "db.example.com", port: "5433", database: "shop" });
  });
  it("reads credentials from the authority and the query", () => {
    expect(parseDataSourceUrl("postgres://me:p%40ss@localhost/app")).toEqual({ dbms: "postgres", host: "localhost", port: "", database: "app", user: "me", password: "p@ss" });
    expect(parseDataSourceUrl("jdbc:mysql://h:3307/demo?user=root&password=x")).toEqual({ dbms: "mysql", host: "h", port: "3307", database: "demo", user: "root", password: "x" });
  });
  it("tells MariaDB from MySQL by the scheme", () => {
    expect(parseDataSourceUrl("mariadb://localhost:3306/x")?.dbms).toBe("mariadb");
  });
  it("reads ipv6 hosts", () => {
    expect(parseDataSourceUrl("postgresql://[::1]:5432/db")).toMatchObject({ host: "::1", port: "5432" });
  });
  it("reads SQLite urls and file paths", () => {
    expect(parseDataSourceUrl("jdbc:sqlite:/tmp/ux-sample.db")).toEqual({ dbms: "sqlite", file: "/tmp/ux-sample.db" });
    expect(parseDataSourceUrl("/home/me/data.sqlite3")).toEqual({ dbms: "sqlite", file: "/home/me/data.sqlite3" });
    expect(parseDataSourceUrl("sqlite::memory:")).toBeNull();
  });
  it("reads Oracle thin urls (service name and SID) and oracle:// urls", () => {
    expect(parseDataSourceUrl("jdbc:oracle:thin:@//db.example.com:1521/FREEPDB1")).toEqual({ dbms: "oracle", host: "db.example.com", port: "1521", database: "FREEPDB1", oracleConnType: "service" });
    expect(parseDataSourceUrl("jdbc:oracle:thin:@localhost:1521:XE")).toEqual({ dbms: "oracle", host: "localhost", port: "1521", database: "XE", oracleConnType: "sid" });
    expect(parseDataSourceUrl("jdbc:oracle:thin:demo/secret@//h/svc")).toEqual({ dbms: "oracle", host: "h", port: "", database: "svc", oracleConnType: "service", user: "demo", password: "secret" });
    expect(parseDataSourceUrl("oracle://demo:p%40ss@127.0.0.1:15219/FREEPDB1")).toEqual({
      dbms: "oracle", host: "127.0.0.1", port: "15219", database: "FREEPDB1", oracleConnType: "service", user: "demo", password: "p@ss",
    });
    expect(parseDataSourceUrl("oracle://h:1521/XE?sid=1")).toMatchObject({ dbms: "oracle", database: "XE", oracleConnType: "sid" });
  });
  it("rejects what it does not know", () => {
    expect(parseDataSourceUrl("")).toBeNull();
    expect(parseDataSourceUrl("mssql://x/y")).toBeNull();
    expect(parseDataSourceUrl("jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=x)))")).toBeNull();
    expect(parseDataSourceUrl("hello")).toBeNull();
  });
});
