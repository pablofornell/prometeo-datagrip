/**
 * Golden fixtures of the migration script. For each DBMS, schema A and schema B are built here in code, and the script
 * that makes B like A (drops included) must equal `crates/dbcore/tests/fixtures/compare/<dbms>_migration.sql`.
 * The CREATE scripts of A and B next to it (`<dbms>_a.sql`, `<dbms>_b.sql`) describe the same models: the Rust test
 * `crates/dbcore/tests/compare_apply_db.rs` runs them on a live database and runs the script against B.
 *
 * `UPDATE_FIXTURES=1 npx vitest run src/features/schema-diff/fixtures.test.ts` writes the migration files again.
 */
import { describe, expect, it } from "vitest";
import type { CompareCheck, CompareColumn, CompareForeignKey, CompareIndex, CompareKey, CompareTable, CompareView, Driver, SchemaModel } from "../../api/types";
import { DEFAULT_DIFF_OPTIONS } from "./diff";
import { planMigration, renderMigration, tableDdlKey } from "./migration";

// the files are read and written with Node's file system (its types are not part of the project)
declare const process: { cwd(): string; env: Record<string, string | undefined> };
const NODE_FS = "node:fs";
interface NodeFs {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
}
const fs = (await import(/* @vite-ignore */ NODE_FS)) as NodeFs;
const FIXTURE_DIR = `${process.cwd()}/crates/dbcore/tests/fixtures/compare`;

const col = (name: string, dataType: string, p: Partial<CompareColumn> = {}): CompareColumn => ({
  name,
  position: 0,
  dataType,
  nullable: true,
  default: null,
  extra: null,
  ...p,
});

const table = (name: string, columns: CompareColumn[], p: Partial<CompareTable> = {}): CompareTable => ({
  name,
  columns: columns.map((c, i) => ({ ...c, position: i + 1 })),
  primaryKey: null,
  unique: [],
  checks: [],
  foreignKeys: [],
  indexes: [],
  ...p,
});

const key = (name: string, columns: string[]): CompareKey => ({ name, columns });
const sysKey = (name: string, columns: string[]): CompareKey => ({ name, columns, generatedName: true });
const index = (name: string, columns: string[], p: Partial<CompareIndex> = {}): CompareIndex => ({
  name,
  columns,
  unique: false,
  method: "btree",
  predicate: null,
  ...p,
});
const fk = (name: string, columns: string[], refTable: string, refColumns: string[], onDelete = "NO ACTION"): CompareForeignKey => ({
  name,
  columns,
  refSchema: null,
  refTable,
  refColumns,
  onDelete,
});
const check = (name: string, expression: string): CompareCheck => ({ name, expression });

const model = (driver: Driver, schema: string, tables: CompareTable[], views: CompareView[] = []): SchemaModel => ({
  driver,
  schema,
  namePrefix: driver === "oracle" ? "CMPX_" : null,
  tables,
  views,
  sequences: [],
  routines: [],
});

// ---------------------------------------------------------------- Oracle (owner DEMO, objects CMPX_*)

const oracleA = model(
  "oracle",
  "DEMO",
  [
    table("CMPX_DEPT", [col("ID", "NUMBER(10)", { nullable: false }), col("NAME", "VARCHAR2(40)")], {
      primaryKey: key("CMPX_DEPT_PK", ["ID"]),
      unique: [key("CMPX_DEPT_NAME_UQ", ["NAME"])],
    }),
    table(
      "CMPX_EMP",
      [
        col("ID", "NUMBER(10)", { nullable: false }),
        col("NAME", "VARCHAR2(80)", { nullable: false }),
        col("CODE", "VARCHAR2(10)"),
        col("SALARY", "NUMBER(10,2)", { default: "0", defaultKind: "expression" }),
        col("STATUS", "VARCHAR2(10)", { nullable: false, default: "'new'", defaultKind: "expression" }),
        col("DEPT_ID", "NUMBER(10)"),
      ],
      {
        primaryKey: key("CMPX_EMP_PK", ["ID"]),
        unique: [key("CMPX_EMP_CODE_UQ", ["CODE"])],
        checks: [check("CMPX_EMP_SALARY_CK", "SALARY >= 0")],
        foreignKeys: [fk("CMPX_EMP_DEPT_FK", ["DEPT_ID"], "CMPX_DEPT", ["ID"], "CASCADE")],
        indexes: [
          index("CMPX_EMP_NAME_IX", ["NAME"], { method: "normal" }),
          index("CMPX_EMP_SAL_IX", ["SALARY"], { method: "normal", descending: [true] }),
          index("CMPX_EMP_STATUS_BX", ["STATUS"], { method: "bitmap", bitmap: true }),
        ],
      },
    ),
    table("CMPX_ORDERS", [col("ID", "NUMBER(10)", { nullable: false }), col("REF", "VARCHAR2(20)")], {
      primaryKey: key("CMPX_ORDERS_PK", ["ID"]),
    }),
    table("CMPX_ORDER_LINES", [col("ID", "NUMBER(10)", { nullable: false }), col("ORDER_ID", "NUMBER(10)", { nullable: false }), col("QTY", "NUMBER(5)")], {
      primaryKey: key("CMPX_LINES_PK", ["ID"]),
      foreignKeys: [fk("CMPX_LINES_ORDER_FK", ["ORDER_ID"], "CMPX_ORDERS", ["ID"])],
    }),
    table("CMPX_NOTE", [col("ID", "NUMBER(10)", { nullable: false }), col("CODE", "VARCHAR2(10)")], {
      primaryKey: sysKey("SYS_C0011001", ["ID"]),
      unique: [sysKey("SYS_C0011002", ["CODE"])],
    }),
    table("CMPX_TAG", [col("ID", "NUMBER(10)", { nullable: false }), col("NAME", "VARCHAR2(20)")], {
      primaryKey: key("CMPX_TAG_PK", ["ID"]),
      indexes: [index("CMPX_TAG_NAME_IX", ["NAME"], { method: "normal" })],
    }),
    table("CMPX_ITEM_TAG", [col("ITEM_ID", "NUMBER(10)", { nullable: false }), col("TAG_ID", "NUMBER(10)", { nullable: false })], {
      primaryKey: key("CMPX_ITEM_TAG_PK", ["ITEM_ID", "TAG_ID"]),
      foreignKeys: [fk("CMPX_ITEM_TAG_TAG_FK", ["TAG_ID"], "CMPX_TAG", ["ID"])],
    }),
    table("CMPX_AUDIT", [col("ID", "NUMBER(10)", { nullable: false }), col("EMP_ID", "NUMBER(10)", { nullable: false })], {
      primaryKey: key("CMPX_AUDIT_PK", ["ID"]),
      foreignKeys: [fk("CMPX_AUDIT_EMP_FK", ["EMP_ID"], "CMPX_EMP", ["ID"])],
    }),
  ],
  [{ name: "CMPX_V_EMP", definition: "select ID, NAME from CMPX_EMP", materialized: false }],
);

const oracleB = model(
  "oracle",
  "DEMO",
  [
    table("CMPX_DEPT", [col("ID", "NUMBER(10)", { nullable: false }), col("NAME", "VARCHAR2(40)")], {
      primaryKey: key("CMPX_DEPT_PK", ["ID"]),
    }),
    table(
      "CMPX_EMP",
      [
        col("ID", "NUMBER(10)", { nullable: false }),
        col("NAME", "VARCHAR2(50)"),
        col("CODE", "VARCHAR2(10)", { nullable: false }),
        col("SALARY", "NUMBER(10,2)", { default: "1", defaultKind: "expression" }),
        col("OLD_FLAG", "NUMBER(1)"),
        col("DEPT_ID", "NUMBER(10)"),
      ],
      {
        primaryKey: key("CMPX_EMP_PK", ["ID"]),
        checks: [check("CMPX_EMP_SALARY_CK", "SALARY > 0")],
        foreignKeys: [fk("CMPX_EMP_DEPT_FK", ["DEPT_ID"], "CMPX_DEPT", ["ID"], "CASCADE")],
        indexes: [
          index("CMPX_EMP_NAME_IX", ["NAME"], { unique: true, method: "normal" }),
          index("CMPX_EMP_SAL_IX", ["SALARY"], { method: "normal" }),
          index("CMPX_EMP_OLD_IX", ["DEPT_ID"], { method: "normal" }),
        ],
      },
    ),
    table("CMPX_ORDERS", [col("ID", "NUMBER(10)", { nullable: false }), col("REF", "VARCHAR2(20)")], {
      primaryKey: key("CMPX_ORDERS_PK_OLD", ["ID"]),
    }),
    table("CMPX_ORDER_LINES", [col("ID", "NUMBER(10)", { nullable: false }), col("ORDER_ID", "NUMBER(10)", { nullable: false }), col("QTY", "NUMBER(5)")], {
      primaryKey: key("CMPX_LINES_PK", ["ID"]),
      foreignKeys: [fk("CMPX_LINES_ORDER_FK", ["ORDER_ID"], "CMPX_ORDERS", ["ID"])],
    }),
    table("CMPX_NOTE", [col("ID", "NUMBER(10)", { nullable: false }), col("CODE", "VARCHAR2(10)")], {
      primaryKey: sysKey("SYS_C0012001", ["ID"]),
      unique: [sysKey("SYS_C0012002", ["CODE"])],
    }),
    table("CMPX_OLD_LOG", [col("ID", "NUMBER(10)", { nullable: false })], {
      primaryKey: key("CMPX_OLD_LOG_PK", ["ID"]),
    }),
  ],
  [{ name: "CMPX_V_EMP", definition: "select ID from CMPX_EMP", materialized: false }],
);

/** DDL of the tables only in A, as `get_ddl` returns them (Oracle: no foreign keys; the indexes come with the table). */
const oracleDdl = new Map<string, string>([
  [
    tableDdlKey("CMPX_TAG"),
    'CREATE TABLE "CMPX_TAG"\n   (\t"ID" NUMBER(10,0) NOT NULL ENABLE,\n\t"NAME" VARCHAR2(20),\n\tCONSTRAINT "CMPX_TAG_PK" PRIMARY KEY ("ID")\n   );\n\nCREATE INDEX "CMPX_TAG_NAME_IX" ON "CMPX_TAG" ("NAME");',
  ],
  [
    tableDdlKey("CMPX_ITEM_TAG"),
    'CREATE TABLE "CMPX_ITEM_TAG"\n   (\t"ITEM_ID" NUMBER(10,0) NOT NULL ENABLE,\n\t"TAG_ID" NUMBER(10,0) NOT NULL ENABLE,\n\tCONSTRAINT "CMPX_ITEM_TAG_PK" PRIMARY KEY ("ITEM_ID", "TAG_ID")\n   );',
  ],
  [
    tableDdlKey("CMPX_AUDIT"),
    'CREATE TABLE "CMPX_AUDIT"\n   (\t"ID" NUMBER(10,0) NOT NULL ENABLE,\n\t"EMP_ID" NUMBER(10,0) NOT NULL ENABLE,\n\tCONSTRAINT "CMPX_AUDIT_PK" PRIMARY KEY ("ID")\n   );',
  ],
]);

// ---------------------------------------------------------------- PostgreSQL (schemas cmpx_a, cmpx_b)

const pgCommon = {
  note: table("note", [col("id", "integer", { nullable: false }), col("code", "varchar(10)")], {
    primaryKey: key("note_pkey", ["id"]),
    unique: [key("note_code_key", ["code"])],
  }),
  orderLines: table("order_lines", [col("id", "integer", { nullable: false }), col("order_id", "integer", { nullable: false }), col("qty", "numeric(5,0)")], {
    primaryKey: key("order_lines_pkey", ["id"]),
    foreignKeys: [fk("order_lines_order_fk", ["order_id"], "orders", ["id"])],
  }),
};

const postgresA = model(
  "postgres",
  "cmpx_a",
  [
    table("dept", [col("id", "integer", { nullable: false }), col("name", "varchar(40)")], {
      primaryKey: key("dept_pkey", ["id"]),
      unique: [key("dept_name_key", ["name"])],
    }),
    table(
      "emp",
      [
        col("id", "integer", { nullable: false }),
        col("name", "varchar(80)", { nullable: false }),
        col("code", "varchar(10)"),
        col("salary", "numeric(10,2)", { default: "0", defaultKind: "expression" }),
        col("status", "varchar(10)", { nullable: false, default: "'new'::character varying", defaultKind: "expression" }),
        col("dept_id", "integer"),
      ],
      {
        primaryKey: key("emp_pkey", ["id"]),
        unique: [key("emp_code_key", ["code"])],
        checks: [check("emp_salary_ck", "(salary >= (0)::numeric)")],
        foreignKeys: [fk("emp_dept_fk", ["dept_id"], "dept", ["id"], "CASCADE")],
        indexes: [index("emp_name_ix", ["name"]), index("emp_salary_ix", ["salary"], { descending: [true] })],
      },
    ),
    table("orders", [col("id", "integer", { nullable: false }), col("ref", "varchar(20)")], {
      primaryKey: key("orders_pkey", ["id"]),
    }),
    pgCommon.orderLines,
    pgCommon.note,
    table("tag", [col("id", "integer", { nullable: false }), col("name", "varchar(20)")], {
      primaryKey: key("tag_pkey", ["id"]),
      indexes: [index("tag_name_ix", ["name"])],
    }),
    table("item_tag", [col("item_id", "integer", { nullable: false }), col("tag_id", "integer", { nullable: false })], {
      primaryKey: key("item_tag_pkey", ["item_id", "tag_id"]),
      foreignKeys: [fk("item_tag_tag_fk", ["tag_id"], "tag", ["id"])],
    }),
    table("audit", [col("id", "integer", { nullable: false }), col("emp_id", "integer", { nullable: false })], {
      primaryKey: key("audit_pkey", ["id"]),
      foreignKeys: [fk("audit_emp_fk", ["emp_id"], "emp", ["id"])],
    }),
  ],
  [{ name: "v_emp", definition: "SELECT emp.id, emp.name FROM emp", materialized: false }],
);

const postgresB = model(
  "postgres",
  "cmpx_b",
  [
    table("dept", [col("id", "integer", { nullable: false }), col("name", "varchar(40)")], {
      primaryKey: key("dept_pkey", ["id"]),
    }),
    table(
      "emp",
      [
        col("id", "integer", { nullable: false }),
        col("name", "varchar(50)"),
        col("code", "varchar(10)", { nullable: false }),
        col("salary", "numeric(10,2)", { default: "1", defaultKind: "expression" }),
        col("old_flag", "integer"),
        col("dept_id", "integer"),
      ],
      {
        primaryKey: key("emp_pkey", ["id"]),
        checks: [check("emp_salary_ck", "(salary > (0)::numeric)")],
        foreignKeys: [fk("emp_dept_fk", ["dept_id"], "dept", ["id"], "CASCADE")],
        indexes: [
          index("emp_name_ix", ["name"], { unique: true }),
          index("emp_salary_ix", ["salary"]),
          index("emp_old_ix", ["dept_id"]),
        ],
      },
    ),
    table("orders", [col("id", "integer", { nullable: false }), col("ref", "varchar(20)")], {
      primaryKey: key("orders_pkey_old", ["id"]),
    }),
    pgCommon.orderLines,
    pgCommon.note,
    table("old_log", [col("id", "integer", { nullable: false })], {
      primaryKey: key("old_log_pkey", ["id"]),
    }),
  ],
  [{ name: "v_emp", definition: "SELECT emp.id FROM emp", materialized: false }],
);

/** DDL of the tables only in A, as `get_ddl` returns them: the foreign keys are written under their column. */
const postgresDdl = new Map<string, string>([
  [
    tableDdlKey("tag"),
    [
      "-- auto-generated definition",
      "create table tag",
      "(",
      "    id   integer not null",
      "        primary key,",
      "    name varchar(20)",
      ");",
      "",
      "create index tag_name_ix on tag using btree (name);",
    ].join("\n"),
  ],
  [
    tableDdlKey("item_tag"),
    [
      "-- auto-generated definition",
      "create table item_tag",
      "(",
      "    item_id integer not null,",
      "    tag_id  integer not null",
      "        constraint item_tag_tag_fk",
      "        references tag (id),",
      "    constraint item_tag_pkey primary key (item_id, tag_id)",
      ");",
    ].join("\n"),
  ],
  [
    tableDdlKey("audit"),
    [
      "-- auto-generated definition",
      "create table audit",
      "(",
      "    id     integer not null",
      "        primary key,",
      "    emp_id integer not null",
      "        constraint audit_emp_fk",
      "        references emp (id)",
      ");",
    ].join("\n"),
  ],
]);

// ---------------------------------------------------------------- MySQL (databases cmpx_a, cmpx_b)

const myCommon = {
  dept: table("dept", [col("id", "int", { nullable: false }), col("name", "varchar(40)")], {
    primaryKey: key("PRIMARY", ["id"]),
  }),
  orderLines: table("order_lines", [col("id", "int", { nullable: false }), col("order_id", "int", { nullable: false }), col("qty", "int")], {
    primaryKey: key("PRIMARY", ["id"]),
    foreignKeys: [fk("order_lines_order_fk", ["order_id"], "orders", ["id"])],
    indexes: [index("order_lines_order_fk", ["order_id"])],
  }),
  note: table("note", [col("id", "int", { nullable: false }), col("code", "varchar(10)")], {
    primaryKey: key("PRIMARY", ["id"]),
    unique: [key("code", ["code"])],
  }),
};

const mysqlA = model(
  "mysql",
  "cmpx_a",
  [
    table("dept", [col("id", "int", { nullable: false }), col("name", "varchar(40)")], {
      primaryKey: key("PRIMARY", ["id"]),
      unique: [key("dept_name_key", ["name"])],
    }),
    table(
      "emp",
      [
        col("id", "int", { nullable: false }),
        col("name", "varchar(80)", { nullable: false }),
        col("code", "varchar(10)"),
        col("salary", "decimal(10,2)", { default: "0", defaultKind: "literal" }),
        col("status", "varchar(10)", { nullable: false, default: "new", defaultKind: "literal" }),
        col("dept_id", "int"),
      ],
      {
        primaryKey: key("PRIMARY", ["id"]),
        unique: [key("emp_code_key", ["code"])],
        checks: [check("emp_salary_ck", "(`salary` >= 0)")],
        foreignKeys: [fk("emp_dept_fk", ["dept_id"], "dept", ["id"], "CASCADE")],
        indexes: [index("emp_name_ix", ["name"]), index("emp_dept_ix", ["dept_id"])],
      },
    ),
    table("orders", [col("id", "int", { nullable: false }), col("ref", "varchar(20)", { nullable: false })], {
      primaryKey: key("PRIMARY", ["id", "ref"]),
      unique: [key("orders_id_uq", ["id"])],
    }),
    myCommon.orderLines,
    myCommon.note,
    table("tag", [col("id", "int", { nullable: false }), col("name", "varchar(20)")], {
      primaryKey: key("PRIMARY", ["id"]),
      indexes: [index("tag_name_ix", ["name"])],
    }),
    table("item_tag", [col("item_id", "int", { nullable: false }), col("tag_id", "int", { nullable: false })], {
      primaryKey: key("PRIMARY", ["item_id", "tag_id"]),
      foreignKeys: [fk("item_tag_tag_fk", ["tag_id"], "tag", ["id"])],
      indexes: [index("item_tag_tag_fk", ["tag_id"])],
    }),
    table("audit", [col("id", "int", { nullable: false }), col("emp_id", "int", { nullable: false })], {
      primaryKey: key("PRIMARY", ["id"]),
      foreignKeys: [fk("audit_emp_fk", ["emp_id"], "emp", ["id"])],
      indexes: [index("audit_emp_fk", ["emp_id"])],
    }),
  ],
  [{ name: "v_emp", definition: "select `emp`.`id` AS `id`,`emp`.`name` AS `name` from `emp`", materialized: false }],
);

const mysqlB = model(
  "mysql",
  "cmpx_b",
  [
    myCommon.dept,
    table(
      "emp",
      [
        col("id", "int", { nullable: false }),
        col("name", "varchar(50)"),
        col("code", "varchar(10)", { nullable: false }),
        col("salary", "decimal(10,2)", { default: "1", defaultKind: "literal" }),
        col("old_flag", "tinyint"),
        col("dept_id", "int"),
      ],
      {
        primaryKey: key("PRIMARY", ["id"]),
        checks: [check("emp_salary_ck", "(`salary` > 0)")],
        foreignKeys: [fk("emp_dept_fk", ["dept_id"], "dept", ["id"], "CASCADE")],
        indexes: [index("emp_name_ix", ["name"], { unique: true }), index("emp_dept_ix", ["dept_id"]), index("emp_old_ix", ["code"])],
      },
    ),
    table("orders", [col("id", "int", { nullable: false }), col("ref", "varchar(20)", { nullable: false })], {
      primaryKey: key("PRIMARY", ["id"]),
    }),
    myCommon.orderLines,
    myCommon.note,
    table("old_log", [col("id", "int", { nullable: false })], {
      primaryKey: key("PRIMARY", ["id"]),
    }),
  ],
  [{ name: "v_emp", definition: "select `emp`.`id` AS `id` from `emp`", materialized: false }],
);

/** DDL of the tables only in A, as `SHOW CREATE TABLE` returns them: the foreign keys are table lines. */
const mysqlDdl = new Map<string, string>([
  [
    tableDdlKey("tag"),
    [
      "CREATE TABLE `tag` (",
      "  `id` int NOT NULL,",
      "  `name` varchar(20) DEFAULT NULL,",
      "  PRIMARY KEY (`id`),",
      "  KEY `tag_name_ix` (`name`)",
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
    ].join("\n"),
  ],
  [
    tableDdlKey("item_tag"),
    [
      "CREATE TABLE `item_tag` (",
      "  `item_id` int NOT NULL,",
      "  `tag_id` int NOT NULL,",
      "  PRIMARY KEY (`item_id`,`tag_id`),",
      "  KEY `item_tag_tag_fk` (`tag_id`),",
      "  CONSTRAINT `item_tag_tag_fk` FOREIGN KEY (`tag_id`) REFERENCES `tag` (`id`)",
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
    ].join("\n"),
  ],
  [
    tableDdlKey("audit"),
    [
      "CREATE TABLE `audit` (",
      "  `id` int NOT NULL,",
      "  `emp_id` int NOT NULL,",
      "  PRIMARY KEY (`id`),",
      "  KEY `audit_emp_fk` (`emp_id`),",
      "  CONSTRAINT `audit_emp_fk` FOREIGN KEY (`emp_id`) REFERENCES `emp` (`id`)",
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;",
    ].join("\n"),
  ],
]);

// ---------------------------------------------------------------- the golden files

const CASES: { dbms: string; a: SchemaModel; b: SchemaModel; ddl: Map<string, string> }[] = [
  { dbms: "oracle", a: oracleA, b: oracleB, ddl: oracleDdl },
  { dbms: "postgres", a: postgresA, b: postgresB, ddl: postgresDdl },
  { dbms: "mysql", a: mysqlA, b: mysqlB, ddl: mysqlDdl },
];

describe("golden migration scripts (make B like A, drops included)", () => {
  for (const c of CASES) {
    it(`${c.dbms}: the script matches its checked-in file`, () => {
      const plan = planMigration(c.a, c.b, DEFAULT_DIFF_OPTIONS, c.ddl);
      // every change of the fixture is written: nothing is left to the person who runs it
      expect(plan.notes).toEqual([]);
      const text = renderMigration(plan, { includeDrops: true }, { from: "A", to: "B" });
      const file = `${FIXTURE_DIR}/${c.dbms}_migration.sql`;
      if (process.env.UPDATE_FIXTURES === "1") fs.writeFileSync(file, text);
      expect(fs.readFileSync(file, "utf8")).toBe(text);
    });
  }
});
