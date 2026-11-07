// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type TableDef, cloneTable, emptyTable, newCheck, newColumn, newFk, newIndex, newKey, renameColumnRefs } from "./model";
import { alterTablePlan, createTablePlan, ident, planText, validateTable } from "./sqlgen";

function categories(schema = "shop"): TableDef {
  const t = emptyTable(schema, "categories");
  t.comment = "Product categories";
  t.columns = [
    newColumn({ name: "id", type: "integer", notNull: true, default: "nextval('shop.categories_id_seq'::regclass)" }),
    newColumn({ name: "name", type: "varchar(100)", notNull: true }),
    newColumn({ name: "parent_id", type: "integer" }),
  ];
  t.keys = [newKey({ name: "categories_pkey", primary: true, columns: ["id"] }), newKey({ name: "categories_name_key", columns: ["name"] })];
  t.fks = [newFk({ name: "categories_parent_id_fkey", columns: ["parent_id"], refSchema: "shop", refTable: "categories", refColumns: ["id"], onDelete: "SET NULL" })];
  t.indexes = [newIndex({ name: "idx_parent", columns: ["parent_id"] })];
  t.checks = [newCheck({ name: "name_not_empty", expr: "name <> ''" })];
  return t;
}

const alter = (d: "postgres" | "mysql" | "sqlite" | "oracle", edit: (t: TableDef) => void, base = categories()) => {
  const cur = cloneTable(base);
  edit(cur);
  return alterTablePlan(d, base, cur);
};

describe("identifiers", () => {
  it("quotes only when needed", () => {
    expect(ident("postgres", "table_name")).toBe("table_name");
    expect(ident("postgres", "Table")).toBe('"Table"');
    expect(ident("postgres", "order")).toBe('"order"');
    expect(ident("mysql", "Order Items")).toBe("`Order Items`");
    expect(ident("sqlite", 'a"b')).toBe('"a""b"');
  });

  it("quotes the reserved words of each dialect", () => {
    for (const w of ["rank", "system", "lock", "groups", "window", "row", "rows", "lateral", "key", "index", "select", "function", "cube"])
      expect(ident("mysql", w), w).toBe(`\`${w}\``);
    for (const w of ["window", "lateral", "user", "table", "order", "analyse", "variadic", "end", "offset"]) expect(ident("postgres", w), w).toBe(`"${w}"`);
    for (const w of ["order", "group", "window", "without", "values", "index", "transaction"]) expect(ident("sqlite", w), w).toBe(`"${w}"`);
    for (const w of ["RANK", "System"]) expect(ident("mysql", w)).toBe(`\`${w}\``);
  });

  it("leaves ordinary names alone", () => {
    for (const w of ["name", "id", "created_at", "price", "status", "title", "comment"]) {
      expect(ident("mysql", w)).toBe(w);
      expect(ident("postgres", w)).toBe(w);
      expect(ident("sqlite", w)).toBe(w);
    }
  });
});

describe("create table", () => {
  it("starts as DataGrip's empty preview", () => {
    expect(planText(createTablePlan("postgres", emptyTable("shop")))).toBe("create table shop.table_name\n(\n);");
  });

  it("postgres: columns, constraints, index and comments", () => {
    const text = planText(createTablePlan("postgres", categories()));
    expect(text).toContain("create table shop.categories\n(\n    id        integer default nextval('shop.categories_id_seq'::regclass) not null,");
    expect(text).toContain("    constraint categories_pkey primary key (id),");
    expect(text).toContain("    constraint categories_parent_id_fkey foreign key (parent_id) references shop.categories (id) on delete set null,");
    expect(text).toContain("    constraint name_not_empty check (name <> '')\n);");
    expect(text).toContain("create index idx_parent on shop.categories (parent_id);");
    expect(text).toContain("comment on table shop.categories is 'Product categories';");
  });

  it("mysql: backticks, inline comment, table comment, auto_increment", () => {
    const t = emptyTable("demo", "order items");
    t.comment = "it's";
    t.columns = [newColumn({ name: "id", type: "int", notNull: true, autoIncrement: true, comment: "pk" }), newColumn({ name: "created", type: "timestamp", default: "CURRENT_TIMESTAMP" }), newColumn({ name: "u", type: "varchar(36)", default: "uuid()" })];
    t.keys = [newKey({ primary: true, columns: ["id"] })];
    const text = planText(createTablePlan("mysql", t));
    expect(text).toContain("create table demo.`order items`");
    expect(text).toContain("id      int not null auto_increment comment 'pk'");
    expect(text).toContain("created timestamp null default CURRENT_TIMESTAMP");
    expect(text).toContain("default (uuid())");
    expect(text).toContain("    primary key (id)");
    expect(text).toContain(") comment = 'it''s';");
  });

  it("sqlite: inline integer primary key with autoincrement, no schema for main", () => {
    const t = emptyTable("main", "t");
    t.columns = [newColumn({ name: "id", type: "integer", autoIncrement: true }), newColumn({ name: "v", type: "text", notNull: true, default: "'x'" })];
    t.keys = [newKey({ primary: true, columns: ["id"] })];
    expect(planText(createTablePlan("sqlite", t))).toBe("create table t\n(\n    id integer primary key autoincrement,\n    v  text not null default 'x'\n);");
  });

  it("sqlite: composite primary key stays a table constraint", () => {
    const t = emptyTable("main", "oi");
    t.columns = [newColumn({ name: "a", type: "integer", notNull: true }), newColumn({ name: "b", type: "integer", notNull: true })];
    t.keys = [newKey({ primary: true, columns: ["a", "b"] })];
    expect(planText(createTablePlan("sqlite", t))).toContain("    primary key (a, b)");
  });

  it("validates", () => {
    const t = emptyTable("shop", "");
    t.columns = [newColumn({ name: "", type: "int" }), newColumn({ name: "a", type: "" })];
    expect(validateTable("postgres", t)).toEqual(["The table name is empty", "A column has no name", "Column 'a' has no data type"]);
    expect(validateTable("sqlite", { ...t, name: "x", columns: [newColumn({ name: "a" })] })).toEqual([]);
  });
});

describe("alter table (postgres)", () => {
  it("no change, no statements", () => {
    expect(alter("postgres", () => {}).statements).toEqual([]);
  });

  it("renames a table and a column, changes type, default and nullability", () => {
    const plan = alter("postgres", (t) => {
      t.name = "cats";
      t.columns[1].name = "title";
      t.keys[1].columns = ["title"];
      t.columns[1].type = "varchar(200)";
      t.columns[1].notNull = false;
      t.columns[2].default = "0";
    });
    expect(plan.statements).toEqual([
      "alter table shop.categories rename to cats;",
      "alter table shop.cats rename column name to title;",
      "alter table shop.cats alter column title type varchar(200);",
      "alter table shop.cats alter column title drop not null;",
      "alter table shop.cats alter column parent_id set default 0;",
    ]);
    expect(plan.transactional).toBe(true);
  });

  it("a renamed column keeps the keys that use it", () => {
    const plan = alter("postgres", (t) => {
      t.columns[0].name = "category_id";
      t.keys[0].columns = ["category_id"];
    });
    expect(plan.statements).toEqual(["alter table shop.categories rename column id to category_id;"]);
  });

  it("drops, adds, redefines and renames constraints and indexes", () => {
    const plan = alter("postgres", (t) => {
      t.keys = t.keys.filter((k) => k.primary);
      t.fks[0].onDelete = "CASCADE";
      t.checks[0].name = "chk";
      t.indexes[0].columns = ["parent_id", "name"];
      t.indexes.push(newIndex({ name: "idx_name", unique: true, columns: ["name"], method: "hash" }));
      t.columns.push(newColumn({ name: "note", type: "text", comment: "x" }));
    });
    expect(plan.statements).toEqual([
      "alter table shop.categories drop constraint categories_parent_id_fkey;",
      "alter table shop.categories drop constraint categories_name_key;",
      "drop index shop.idx_parent;",
      "alter table shop.categories add column note text;",
      "alter table shop.categories add constraint categories_parent_id_fkey foreign key (parent_id) references shop.categories (id) on delete cascade;",
      "create index idx_parent on shop.categories (parent_id, name);",
      "create unique index idx_name on shop.categories using hash (name);",
      "alter table shop.categories rename constraint name_not_empty to chk;",
      "comment on column shop.categories.note is 'x';",
    ]);
  });

  it("comments, identity and column drop", () => {
    const plan = alter("postgres", (t) => {
      t.comment = "";
      t.columns[0].identity = "ALWAYS";
      t.columns[2].comment = "up";
      t.columns = t.columns.filter((c) => c.name !== "name");
      t.keys = t.keys.filter((k) => k.primary);
    });
    expect(plan.statements).toEqual([
      "alter table shop.categories drop constraint categories_name_key;",
      "alter table shop.categories drop column name;",
      "alter table shop.categories alter column id add generated always as identity;",
      "comment on table shop.categories is null;",
      "comment on column shop.categories.parent_id is 'up';",
    ]);
  });
});

describe("alter table (mysql)", () => {
  const base = (): TableDef => {
    const t = emptyTable("demo", "t");
    t.tableCollation = "utf8mb4_0900_ai_ci";
    t.columns = [newColumn({ name: "a", type: "int", notNull: true }), newColumn({ name: "b", type: "varchar(10)" }), newColumn({ name: "c", type: "text" })];
    t.keys = [newKey({ name: "PRIMARY", primary: true, columns: ["a"] })];
    t.indexes = [newIndex({ name: "ix_b", columns: ["b"] })];
    return t;
  };
  it("modify, change, add with position, drop", () => {
    const plan = alter(
      "mysql",
      (t) => {
        t.columns[1].type = "varchar(50)";
        t.columns[2].name = "d";
        t.columns.splice(1, 0, newColumn({ name: "n", type: "int", default: "5" }));
        t.indexes = [];
        t.comment = "hi";
      },
      base(),
    );
    // one ALTER, so MySQL validates the end result and the change is atomic
    expect(plan.statements).toEqual([
      [
        "alter table demo.t",
        "    drop index ix_b,",
        "    add column n int default 5 after a,",
        "    modify column b varchar(50),",
        "    change column c d text,",
        "    comment = 'hi';",
      ].join("\n"),
    ]);
    expect(plan.transactional).toBe(false);
  });

  it("reorders columns with the minimum of moves", () => {
    const plan = alter(
      "mysql",
      (t) => {
        const [a, b, c] = t.columns;
        t.columns = [b, a, c];
      },
      base(),
    );
    expect(plan.statements).toEqual(["alter table demo.t modify column b varchar(10) first;"]);
  });

  it("primary key and foreign key changes", () => {
    const b = base();
    b.fks = [newFk({ name: "fk1", columns: ["b"], refSchema: "demo", refTable: "o", refColumns: ["id"] })];
    const plan = alter(
      "mysql",
      (t) => {
        t.keys[0].columns = ["a", "b"];
        t.fks[0].name = "fk2";
      },
      b,
    );
    expect(plan.statements).toEqual([
      [
        "alter table demo.t",
        "    drop foreign key fk1,",
        "    drop primary key,",
        "    add primary key (a, b),",
        "    add constraint fk2 foreign key (b) references demo.o (id);",
      ].join("\n"),
    ]);
  });

  it("drops and adds the primary key of an auto_increment column in one statement (error 1075 otherwise)", () => {
    const b = base();
    b.columns[0].autoIncrement = true;
    const plan = alter("mysql", (t) => (t.keys[0].columns = ["a", "b"]), b);
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]).toBe("alter table demo.t\n    drop primary key,\n    add primary key (a, b);");
  });

  it("a foreign key redefined under its name is dropped first (error 1826 in one statement)", () => {
    const b = base();
    b.fks = [newFk({ name: "fk1", columns: ["b"], refSchema: "demo", refTable: "o", refColumns: ["id"] })];
    const plan = alter("mysql", (t) => (t.fks[0].onDelete = "CASCADE"), b);
    expect(plan.statements).toEqual([
      "alter table demo.t drop foreign key fk1;",
      "alter table demo.t add constraint fk1 foreign key (b) references demo.o (id) on delete cascade;",
    ]);
  });

  it("renames the table inside the same ALTER and creates changed indexes afterwards under the new name", () => {
    const plan = alter("mysql", (t) => {
      t.name = "t2";
      t.indexes[0].columns = ["b", "c"];
    }, base());
    expect(plan.statements).toEqual([
      "alter table demo.t\n    drop index ix_b,\n    rename to demo.t2;",
      "create index ix_b on demo.t2 (b, c);",
    ]);
  });
});

describe("alter table (sqlite)", () => {
  const base = (): TableDef => {
    const t = emptyTable("main", "p");
    t.columns = [newColumn({ name: "id", type: "INTEGER" }), newColumn({ name: "name", type: "TEXT", notNull: true }), newColumn({ name: "price", type: "REAL" })];
    t.keys = [newKey({ primary: true, columns: ["id"] })];
    t.indexes = [newIndex({ name: "ix_name", columns: ["name"] })];
    t.triggers = ["CREATE TRIGGER trg AFTER INSERT ON p BEGIN SELECT 1; END"];
    return t;
  };

  it("uses ALTER where SQLite can: rename, add column at the end, index changes", () => {
    const plan = alter(
      "sqlite",
      (t) => {
        t.name = "q";
        t.columns[2].name = "cost";
        t.columns.push(newColumn({ name: "note", type: "TEXT", default: "'-'" }));
        t.indexes = [];
        t.indexes.push(newIndex({ name: "ix_cost", columns: ["cost"] }));
      },
      base(),
    );
    expect(plan.statements).toEqual([
      "drop index ix_name;",
      "alter table p rename column price to cost;",
      "alter table p add column note TEXT default '-';",
      "create index ix_cost on p (cost);",
      "alter table p rename to q;",
    ]);
    expect(plan.pre).toEqual([]);
  });

  it("drops an unused column in place, but rebuilds when it is indexed", () => {
    expect(alter("sqlite", (t) => (t.columns = t.columns.slice(0, 2)), base()).statements).toEqual(["alter table p drop column price;"]);
    const plan = alter("sqlite", (t) => (t.columns = [t.columns[0], t.columns[2]]), base());
    expect(plan.pre).toEqual(["pragma foreign_keys = off;", "pragma legacy_alter_table = on;"]);
  });

  it("rebuilds the table for a type change: create, copy, drop, rename, indexes, triggers", () => {
    const plan = alter(
      "sqlite",
      (t) => {
        t.columns[2].type = "NUMERIC(10,2)";
        t.columns[1].name = "title";
        t.indexes[0].columns = ["title"];
      },
      base(),
    );
    expect(plan.transactional).toBe(true);
    expect(plan.post).toEqual(["pragma legacy_alter_table = off;", "pragma foreign_keys = on;"]);
    expect(plan.statements).toEqual([
      "create table p_dg_tmp\n(\n    id    INTEGER primary key,\n    title TEXT not null,\n    price NUMERIC(10,2)\n);",
      "insert into p_dg_tmp (id, title, price)\nselect id, name, price\nfrom p;",
      "drop table p;",
      "alter table p_dg_tmp rename to p;",
      "create index ix_name on p (title);",
      "CREATE TRIGGER trg AFTER INSERT ON p BEGIN SELECT 1; END;",
    ]);
  });

  it("rebuilds for a new foreign key and a check", () => {
    const plan = alter(
      "sqlite",
      (t) => {
        t.fks.push(newFk({ columns: ["id"], refTable: "o", refColumns: ["id"], onDelete: "CASCADE" }));
        t.checks.push(newCheck({ expr: "price > 0" }));
      },
      base(),
    );
    expect(plan.statements[0]).toContain("    foreign key (id) references o (id) on delete cascade,\n    check (price > 0)\n);");
  });

  it("does not rebuild a table with generated columns it cannot read", () => {
    const b = base();
    b.columns.push(newColumn({ name: "g", type: "INT", generated: "?" }));
    expect(alter("sqlite", (t) => (t.columns[2].type = "INT"), b).error).toMatch(/generated/);
  });
});

describe("Oracle", () => {
  function emp(): TableDef {
    const t = emptyTable("DEMO", "EMP");
    t.comment = "Employees";
    t.columns = [
      newColumn({ name: "ID", type: "NUMBER(10)", notNull: true, identity: "BY DEFAULT", comment: "key" }),
      newColumn({ name: "NAME", type: "VARCHAR2(100 CHAR)", notNull: true, default: "'n/a'" }),
      newColumn({ name: "HIRED", type: "TIMESTAMP(6) WITH TIME ZONE" }),
      newColumn({ name: "MGR_ID", type: "NUMBER(10)" }),
    ];
    t.keys = [newKey({ name: "EMP_PK", primary: true, columns: ["ID"] }), newKey({ name: "EMP_NAME_UK", columns: ["NAME"] })];
    t.fks = [newFk({ name: "EMP_MGR_FK", columns: ["MGR_ID"], refSchema: "DEMO", refTable: "EMP", refColumns: ["ID"], onDelete: "SET NULL", onUpdate: "CASCADE" })];
    t.indexes = [newIndex({ name: "EMP_HIRED_IX", columns: ["HIRED"] })];
    t.checks = [newCheck({ name: "EMP_NAME_CK", expr: "length(name) > 1" })];
    return t;
  }
  const ora = (edit: (t: TableDef) => void) => alter("oracle", edit, emp());

  it("writes upper-case names bare and quotes the rest", () => {
    expect(ident("oracle", "EMP")).toBe("EMP");
    expect(ident("oracle", "emp")).toBe('"emp"');
    expect(ident("oracle", "Order Items")).toBe('"Order Items"');
    for (const w of ["USER", "LEVEL", "ROWNUM", "COMMENT", "DATE", "NUMBER", "SYSDATE"]) expect(ident("oracle", w), w).toBe(`"${w}"`);
    expect(ident("oracle", "EMP#1$")).toBe("EMP#1$");
  });

  it("create table: identity, default, constraints, comments (no ON UPDATE, no transaction)", () => {
    const p = createTablePlan("oracle", emp());
    expect(p.transactional).toBe(false);
    expect(planText(p)).toBe(
      [
        "create table DEMO.EMP",
        "(",
        "    ID     NUMBER(10) generated by default as identity not null,",
        "    NAME   VARCHAR2(100 CHAR) default 'n/a' not null,",
        "    HIRED  TIMESTAMP(6) WITH TIME ZONE,",
        "    MGR_ID NUMBER(10),",
        "    constraint EMP_PK primary key (ID),",
        "    constraint EMP_NAME_UK unique (NAME),",
        "    constraint EMP_MGR_FK foreign key (MGR_ID) references DEMO.EMP (ID) on delete set null,",
        "    constraint EMP_NAME_CK check (length(name) > 1)",
        ");",
        "create index DEMO.EMP_HIRED_IX on DEMO.EMP (HIRED);",
        "comment on table DEMO.EMP is 'Employees';",
        "comment on column DEMO.EMP.ID is 'key';",
      ].join("\n"),
    );
  });

  it("alter: add (...), modify (...) with only what changed, rename column, drop column", () => {
    const p = ora((t) => {
      t.columns.push(newColumn({ name: "SALARY", type: "NUMBER(10,2)", default: "0", notNull: true, comment: "pay" }), newColumn({ name: "NOTE", type: "CLOB" }));
      const name = t.columns.find((c) => c.name === "NAME")!;
      name.type = "VARCHAR2(200 CHAR)";
      name.notNull = false;
      t.columns.find((c) => c.name === "HIRED")!.default = "systimestamp";
      renameColumnRefs(t, t.columns.find((c) => c.name === "MGR_ID")!.uid, "BOSS_ID");
    });
    expect(p.transactional).toBe(false);
    expect(p.statements).toEqual([
      "alter table DEMO.EMP rename column MGR_ID to BOSS_ID;",
      'alter table DEMO.EMP modify (NAME VARCHAR2(200 CHAR) null, HIRED default systimestamp);',
      "alter table DEMO.EMP add (SALARY NUMBER(10,2) default 0 not null, NOTE CLOB);",
      "comment on column DEMO.EMP.SALARY is 'pay';",
    ]);
  });

  it("alter: never repeats NOT NULL / NULL on an unchanged column", () => {
    const p = ora((t) => {
      t.columns.find((c) => c.name === "NAME")!.type = "VARCHAR2(50 CHAR)";
    });
    expect(p.statements).toEqual(["alter table DEMO.EMP modify (NAME VARCHAR2(50 CHAR));"]);
  });

  it("alter: drop column, identity changes, constraints, indexes, comments, rename table", () => {
    const p = ora((t) => {
      t.columns = t.columns.filter((c) => c.name !== "HIRED");
      t.indexes = [];
      t.checks[0].expr = "length(name) > 2";
      t.columns.find((c) => c.name === "ID")!.identity = "ALWAYS";
      t.comment = "Staff";
      t.name = "STAFF";
    });
    expect(p.statements).toEqual([
      "alter table DEMO.EMP rename to STAFF;",
      "alter table DEMO.STAFF drop constraint EMP_NAME_CK;",
      "drop index DEMO.EMP_HIRED_IX;",
      "alter table DEMO.STAFF drop column HIRED;",
      "alter table DEMO.STAFF modify (ID generated always as identity);",
      "alter table DEMO.STAFF add constraint EMP_NAME_CK check (length(name) > 2);",
      "comment on table DEMO.STAFF is 'Staff';",
    ]);
  });

  it("alter: nothing changed gives no statements", () => {
    expect(ora(() => {}).statements).toEqual([]);
  });

  it("virtual columns", () => {
    const t = emptyTable("DEMO", "V");
    t.columns = [newColumn({ name: "A", type: "NUMBER" }), newColumn({ name: "B", type: "NUMBER", generated: "A * 2" })];
    expect(planText(createTablePlan("oracle", t))).toContain("B NUMBER generated always as (A * 2) virtual");
  });
});
