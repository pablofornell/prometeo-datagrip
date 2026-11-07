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
  it("rejects what it does not know", () => {
    expect(parseDataSourceUrl("")).toBeNull();
    expect(parseDataSourceUrl("oracle://x/y")).toBeNull();
    expect(parseDataSourceUrl("hello")).toBeNull();
  });
});
