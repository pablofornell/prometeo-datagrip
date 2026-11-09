import { describe, expect, it } from "vitest";
import type { CompareColumn, CompareCheck, CompareForeignKey, CompareIndex, CompareKey, CompareTable, CompareView, Driver, SchemaModel } from "../../api/types";
import { planCounts, planMigration, renderMigration, tableDdlKey, tablesToCreate, type MigrationPlan } from "./migration";

const col = (name: string, dataType: string, p: Partial<CompareColumn> = {}): CompareColumn => ({
  name,
  position: 1,
  dataType,
  nullable: true,
  default: null,
  extra: null,
  ...p,
});

const table = (name: string, p: Partial<CompareTable> = {}): CompareTable => ({
  name,
  columns: [],
  primaryKey: null,
  unique: [],
  checks: [],
  foreignKeys: [],
  indexes: [],
  ...p,
});

const model = (driver: Driver, schema: string, p: Partial<SchemaModel> = {}): SchemaModel => ({
  driver,
  schema,
  namePrefix: null,
  tables: [],
  views: [],
  sequences: [],
  routines: [],
  ...p,
});

const key = (name: string, columns: string[]): CompareKey => ({ name, columns });
const index = (name: string, p: Partial<CompareIndex> = {}): CompareIndex => ({ name, columns: ["NAME"], unique: false, method: "", predicate: null, ...p });
const fk = (name: string, p: Partial<CompareForeignKey> = {}): CompareForeignKey => ({
  name,
  columns: ["DEPT_ID"],
  refSchema: null,
  refTable: "DEPT",
  refColumns: ["ID"],
  onDelete: "NO ACTION",
  ...p,
});
const view = (name: string, definition: string): CompareView => ({ name, definition, materialized: false });

/** The SQL of the statements of a phase, in the plan's order. */
const sqlOf = (plan: MigrationPlan, phase?: number) =>
  plan.statements.filter((s) => phase === undefined || s.phase === phase).map((s) => s.sql);

describe("planMigration: Oracle", () => {
  const a = model("oracle", "A", {
    tables: [
      table("EMP", {
        columns: [
          col("ID", "NUMBER(10)", { nullable: false }),
          col("NAME", "VARCHAR2(80)"),
          col("HIRED", "DATE", { default: "SYSDATE" }),
        ],
        primaryKey: key("PK_EMP", ["ID"]),
        indexes: [index("IX_EMP_NAME")],
        foreignKeys: [fk("FK_EMP_DEPT", { onDelete: "CASCADE" })],
      }),
      table("DEPT", { columns: [col("ID", "NUMBER(10)", { nullable: false })], primaryKey: key("PK_DEPT", ["ID"]) }),
    ],
    views: [view("V_EMP", "select id, name from emp")],
    sequences: [{ name: "S_ID", incrementBy: "1", minValue: "1", maxValue: "99999", cycle: false, cacheSize: "20" }],
  });
  const b = model("oracle", "B", {
    tables: [
      table("EMP", {
        columns: [
          col("ID", "NUMBER(10)", { nullable: false }),
          col("NAME", "VARCHAR2(50)", { nullable: false }),
          col("OLD_COL", "VARCHAR2(5)"),
        ],
        primaryKey: key("PK_EMP", ["ID"]),
        indexes: [index("IX_EMP_NAME", { unique: true })],
      }),
      table("LEGACY", { columns: [col("ID", "NUMBER(10)")] }),
    ],
    views: [view("V_EMP", "select id from emp")],
    sequences: [{ name: "S_ID", incrementBy: "5", minValue: "1", maxValue: "99999", cycle: false, cacheSize: "0" }],
  });
  const ddl = new Map([[tableDdlKey("DEPT"), 'CREATE TABLE "DEPT" ("ID" NUMBER(10) NOT NULL, CONSTRAINT "PK_DEPT" PRIMARY KEY ("ID"))']]);
  const plan = planMigration(a, b, undefined, ddl);

  it("sets the current schema of B first", () => {
    expect(plan.header).toEqual(['ALTER SESSION SET CURRENT_SCHEMA = "B";']);
  });

  it("creates the table that exists only in A from its DDL, first", () => {
    expect(sqlOf(plan, 0)).toEqual(['CREATE TABLE "DEPT" ("ID" NUMBER(10) NOT NULL, CONSTRAINT "PK_DEPT" PRIMARY KEY ("ID"));']);
  });

  it("drops the changed index, then creates it again", () => {
    expect(sqlOf(plan, 1)).toContain('DROP INDEX "IX_EMP_NAME";');
    expect(sqlOf(plan, 5)).toEqual(['CREATE INDEX "IX_EMP_NAME" ON "EMP" ("NAME");']);
  });

  it("modifies the changed column with the definition of A, and adds the new one", () => {
    expect(sqlOf(plan, 2)).toEqual([
      'ALTER TABLE "EMP" MODIFY ("NAME" VARCHAR2(80) DEFAULT NULL NULL);',
      'ALTER TABLE "EMP" ADD ("HIRED" DATE DEFAULT SYSDATE);',
    ]);
  });

  it("adds the foreign key of A with its delete rule, after the keys", () => {
    expect(sqlOf(plan, 4)).toEqual(['ALTER TABLE "EMP" ADD CONSTRAINT "FK_EMP_DEPT" FOREIGN KEY ("DEPT_ID") REFERENCES "DEPT" ("ID") ON DELETE CASCADE;']);
  });

  it("writes the view of A with CREATE OR REPLACE and the sequence with ALTER SEQUENCE", () => {
    expect(sqlOf(plan, 6)).toEqual(['CREATE OR REPLACE VIEW "V_EMP" AS select id, name from emp;']);
    expect(sqlOf(plan, 7)).toEqual(['ALTER SEQUENCE "S_ID" INCREMENT BY 1 MINVALUE 1 MAXVALUE 99999 NOCYCLE CACHE 20;']);
  });

  it("marks the drops of objects that exist only in B as destructive", () => {
    const drops = plan.statements.filter((s) => s.phase === 8);
    expect(drops.map((s) => [s.sql, s.destructive])).toEqual([
      ['ALTER TABLE "EMP" DROP COLUMN "OLD_COL";', true],
      ['DROP TABLE "LEGACY" CASCADE CONSTRAINTS;', true],
    ]);
  });

  it("comments the destructive statements out unless drops are included", () => {
    const text = renderMigration(plan, { includeDrops: false }, { from: "A", to: "B" });
    expect(text).toContain('-- ALTER TABLE "EMP" DROP COLUMN "OLD_COL";');
    expect(text).toContain('-- DROP TABLE "LEGACY" CASCADE CONSTRAINTS;');
    expect(text).toContain('\nALTER SESSION SET CURRENT_SCHEMA = "B";\n');
    expect(text).toContain('\nDROP INDEX "IX_EMP_NAME";\n');
    expect(text).toContain("-- Migration: make B like A (Oracle)");
    const all = renderMigration(plan, { includeDrops: true }, { from: "A", to: "B" });
    expect(all).toContain('\nALTER TABLE "EMP" DROP COLUMN "OLD_COL";\n');
    expect(all).not.toContain('-- ALTER TABLE "EMP" DROP COLUMN "OLD_COL";');
  });

  it("counts the statements that run for the options", () => {
    expect(planCounts(plan, { includeDrops: false }).commented).toBe(2);
    expect(planCounts(plan, { includeDrops: true })).toEqual({ total: plan.statements.length, active: plan.statements.length, commented: 0 });
  });

  it("lists the tables that exist only in A", () => {
    expect(tablesToCreate(a, b)).toEqual(["DEPT"]);
  });

  it("notes a table of A whose DDL was not given", () => {
    const missing = planMigration(a, b, undefined, new Map());
    expect(missing.notes).toContain("table DEPT: the DDL of A is missing; create the table by hand");
  });
});

describe("planMigration: PostgreSQL", () => {
  const a = model("postgres", "shop_a", {
    tables: [
      table("orders", {
        columns: [col("id", "integer", { nullable: false }), col("total", "numeric(10,2)", { nullable: false, default: "0" }), col("status", "varchar(10)")],
        primaryKey: key("orders_pkey", ["id"]),
        checks: [{ name: "ck_total", expression: "(total >= 0)" } as CompareCheck],
        indexes: [index("orders_status_idx", { columns: ["status"], method: "btree" })],
      }),
    ],
  });
  const b = model("postgres", "shop_b", {
    tables: [
      table("orders", {
        columns: [col("id", "integer", { nullable: false }), col("total", "numeric(10,2)")],
        primaryKey: key("orders_pkey", ["id"]),
        unique: [key("orders_code_key", ["total"])],
      }),
      table("old"),
    ],
  });
  const plan = planMigration(a, b);

  it("sets the search path to B", () => {
    expect(plan.header).toEqual(['SET search_path TO "shop_b";']);
  });

  it("alters each attribute of the column separately, and adds the new column", () => {
    expect(sqlOf(plan, 2)).toEqual([
      'ALTER TABLE "orders" ALTER COLUMN "total" SET NOT NULL;',
      'ALTER TABLE "orders" ALTER COLUMN "total" SET DEFAULT 0;',
      'ALTER TABLE "orders" ADD COLUMN "status" varchar(10);',
    ]);
  });

  it("adds the check, creates the index without USING for btree", () => {
    expect(sqlOf(plan, 3)).toEqual(['ALTER TABLE "orders" ADD CONSTRAINT "ck_total" CHECK ((total >= 0));']);
    expect(sqlOf(plan, 5)).toEqual(['CREATE INDEX "orders_status_idx" ON "orders" ("status");']);
  });

  it("drops the unique constraint that only B has (commented out) and the table only in B", () => {
    const drops = plan.statements.filter((s) => s.phase === 1 || s.phase === 8);
    expect(drops.map((s) => [s.sql, s.destructive])).toEqual([
      ['ALTER TABLE "orders" DROP CONSTRAINT "orders_code_key";', true],
      ['DROP TABLE "old";', true],
    ]);
  });
});

describe("planMigration: MySQL", () => {
  const a = model("mysql", "shop_a", {
    tables: [
      table("items", {
        columns: [col("id", "int", { nullable: false }), col("price", "decimal(10,2)", { nullable: false, default: "0" })],
        foreignKeys: [fk("fk_items_order", { columns: ["order_id"], refTable: "orders", refColumns: ["id"], onDelete: "CASCADE" })],
        indexes: [index("ix_price", { columns: ["price"], method: "btree" })],
      }),
    ],
  });
  const b = model("mysql", "shop_b", {
    tables: [
      table("items", {
        columns: [col("id", "int", { nullable: false }), col("price", "decimal(8,2)")],
        foreignKeys: [fk("fk_items_order", { columns: ["order_id"], refTable: "orders", refColumns: ["id"] })],
        indexes: [index("ix_price", { columns: ["price"], method: "btree", unique: true })],
      }),
    ],
  });
  const plan = planMigration(a, b);

  it("uses USE and MODIFY COLUMN with the full definition", () => {
    expect(plan.header).toEqual(["USE `shop_b`;"]);
    expect(sqlOf(plan, 2)).toEqual(["ALTER TABLE `items` MODIFY COLUMN `price` decimal(10,2) DEFAULT 0 NOT NULL;"]);
  });

  it("drops a foreign key and its index with the MySQL statements", () => {
    expect(sqlOf(plan, 1)).toEqual(["ALTER TABLE `items` DROP FOREIGN KEY `fk_items_order`;", "DROP INDEX `ix_price` ON `items`;"]);
    expect(sqlOf(plan, 4)).toEqual(["ALTER TABLE `items` ADD CONSTRAINT `fk_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE;"]);
    expect(sqlOf(plan, 5)).toEqual(["CREATE INDEX `ix_price` ON `items` (`price`);"]);
  });
});

describe("planMigration: SQLite", () => {
  const a = model("sqlite", "main", {
    tables: [
      table("t", {
        columns: [col("id", "integer", { nullable: false }), col("name", "text", { nullable: false }), col("extra", "text")],
        primaryKey: { name: "", columns: ["id"] },
      }),
    ],
    views: [view("v", "select id from t")],
  });
  const b = model("sqlite", "main", {
    tables: [table("t", { columns: [col("id", "integer", { nullable: false }), col("name", "text")], primaryKey: { name: "", columns: ["id"] } })],
    views: [view("v", "select id, name from t")],
  });
  const plan = planMigration(a, b);

  it("adds the column in place and notes the change of a column for a rebuild", () => {
    expect(plan.header).toEqual([]);
    expect(sqlOf(plan, 2)).toEqual(['ALTER TABLE "t" ADD COLUMN "extra" text;']);
    expect(plan.notes).toContain(
      "table t: change column name: not generated for SQLite (SQLite changes this only by rebuilding the table); write it by hand",
    );
  });

  it("replaces a changed view by a drop and a create", () => {
    expect(sqlOf(plan, 6)).toEqual(['DROP VIEW IF EXISTS "v";', 'CREATE VIEW "v" AS select id from t;']);
    const replaced = plan.statements.filter((s) => s.phase === 6);
    expect(replaced.every((s) => !s.destructive)).toBe(true);
  });
});

describe("planMigration: other cases", () => {
  it("writes no script between two DBMS, but says why", () => {
    const plan = planMigration(model("postgres", "s"), model("oracle", "S"));
    expect(plan.statements).toEqual([]);
    expect(plan.notes).toEqual(["s is on PostgreSQL and S on Oracle: no migration script between two DBMS."]);
  });

  it("writes nothing for identical schemas", () => {
    const m = model("postgres", "s", { tables: [table("t", { columns: [col("id", "integer")] })] });
    const plan = planMigration(m, m);
    expect(plan.statements).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(renderMigration(plan, { includeDrops: false }, { from: "s", to: "s" })).not.toContain("-- NOTE");
  });

  it("renders the statements in phase order with their comments", () => {
    const a = model("postgres", "a", { tables: [table("t", { columns: [col("n", "integer")] })] });
    const b = model("postgres", "b", { tables: [table("t", { columns: [col("n", "integer")], unique: [key("u", ["n"])] })] });
    const text = renderMigration(planMigration(a, b), { includeDrops: false }, { from: "a", to: "b" });
    expect(text).toContain('-- Statements that drop objects are commented out: uncomment them to apply them.');
    expect(text).toContain('-- table t: unique u (only in B)');
    expect(text.split("\n")).toContain('-- ALTER TABLE "t" DROP CONSTRAINT "u";');
  });
});
