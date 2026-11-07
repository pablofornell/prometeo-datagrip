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

  it("handles Oracle thin urls", () => {
    expect(buildUrl("oracle", { host: "localhost", port: "1521", database: "FREEPDB1", file: "", options: {} })).toBe("jdbc:oracle:thin:@//localhost:1521/FREEPDB1");
    expect(buildUrl("oracle", { host: "localhost", port: "1521", database: "XE", file: "", options: { oracleConnType: "sid" } })).toBe("jdbc:oracle:thin:@localhost:1521:XE");
    expect(parseUrl("oracle", "jdbc:oracle:thin:@//h:1522/svc")).toEqual({ host: "h", port: "1522", database: "svc", query: "", sid: false });
    expect(parseUrl("oracle", "jdbc:oracle:thin:@h:1521:ORCL")).toEqual({ host: "h", port: "1521", database: "ORCL", query: "", sid: true });
    expect(parseUrl("oracle", "jdbc:oracle:thin:@h:1521/svc")).toMatchObject({ database: "svc", sid: false });
    expect(parseUrl("oracle", "jdbc:oracle:thin:u/p@//h/svc")).toMatchObject({ user: "u", password: "p", host: "h" });
    expect(parseUrl("oracle", "jdbc:postgresql://h/d")).toBeNull();
    expect(toSqlxUrl("oracle", "jdbc:oracle:thin:@//h:1521/svc")).toBe("oracle://h:1521/svc");
    expect(toSqlxUrl("oracle", "jdbc:oracle:thin:@h:1521:XE")).toBe("oracle://h:1521/XE?sid=1");
    expect(toSqlxUrl("oracle", "jdbc:oracle:thin:me/p%40ss@//h/svc")).toBe("oracle://me:p%2540ss@h/svc");
    expect(fromSqlxUrl("oracle", "oracle://h:1521/svc")).toBe("jdbc:oracle:thin:@//h:1521/svc");
    expect(fromSqlxUrl("oracle", "oracle://me:pw@h:1521/XE?sid=1")).toBe("jdbc:oracle:thin:me/pw@h:1521:XE");
  });

  it("recognises in-memory sqlite", () => {
    expect(isMemoryUrl("sqlite::memory:")).toBe(true);
    expect(isMemoryUrl("sqlite:/tmp/a.db")).toBe(false);
  });
});
