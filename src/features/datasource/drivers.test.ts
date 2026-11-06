// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildUrl, fromSqlxUrl, isMemoryUrl, parseUrl, toSqlxUrl } from "./drivers";

describe("jdbc-like urls", () => {
  it("builds the urls DataGrip shows", () => {
    expect(buildUrl("postgres", { host: "localhost", port: "5432", database: "postgres", file: "" })).toBe("jdbc:postgresql://localhost:5432/postgres");
    expect(buildUrl("mysql", { host: "localhost", port: "3306", database: "", file: "" })).toBe("jdbc:mysql://localhost:3306");
    expect(buildUrl("sqlite", { host: "", port: "", database: "", file: "/tmp/x.db" })).toBe("jdbc:sqlite:/tmp/x.db");
  });

  it("parses them back", () => {
    expect(parseUrl("postgres", "jdbc:postgresql://db.example.com:6543/shop")).toEqual({ host: "db.example.com", port: "6543", database: "shop", query: "" });
    expect(parseUrl("mysql", "jdbc:mysql://[::1]:3306/demo?useSSL=false")).toEqual({ host: "::1", port: "3306", database: "demo", query: "useSSL=false" });
    expect(parseUrl("mariadb", "jdbc:mysql://h/d")?.host).toBe("h");
    expect(parseUrl("postgres", "jdbc:mysql://h/d")).toBeNull();
    expect(parseUrl("postgres", "nonsense")).toBeNull();
  });

  it("converts to and from sqlx urls", () => {
    expect(toSqlxUrl("postgres", "jdbc:postgresql://h:5432/db")).toBe("postgresql://h:5432/db");
    expect(toSqlxUrl("postgres", "jdbc:postgresql://h/db?user=me&password=p%40ss&sslmode=require")).toBe("postgresql://me:p%40ss@h/db?sslmode=require");
    expect(toSqlxUrl("mysql", "jdbc:mariadb://h:3306/db")).toBe("mysql://h:3306/db");
    expect(toSqlxUrl("sqlite", "jdbc:sqlite:/tmp/a.db")).toBe("sqlite:/tmp/a.db");
    expect(fromSqlxUrl("postgres", "postgres://h/db")).toBe("jdbc:postgresql://h/db");
    expect(fromSqlxUrl("mysql", "mysql://h/db")).toBe("jdbc:mysql://h/db");
    expect(fromSqlxUrl("sqlite", "sqlite:/tmp/a.db")).toBe("jdbc:sqlite:/tmp/a.db");
  });

  it("recognises in-memory sqlite", () => {
    expect(isMemoryUrl("sqlite::memory:")).toBe(true);
    expect(isMemoryUrl("sqlite:/tmp/a.db")).toBe(false);
  });
});
