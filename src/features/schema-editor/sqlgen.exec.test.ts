// @vitest-environment node
/**
 * Runs the plans of the SQLite rebuild against a real SQLite (python3's `sqlite3` module, in memory), the way
 * `runPlan` does: pragmas, `begin`, the statements, `commit` / `rollback`, the pragmas back. Skipped without python3.
 */
import { describe, expect, it } from "vitest";
import { type TableDef, cloneTable, emptyTable, newColumn, newFk, newIndex, newKey } from "./model";
import { type Plan, alterTablePlan, createTablePlan } from "./sqlgen";

// @types/node is not part of the project: the module is loaded by name, typed by hand
const NODE_CHILD_PROCESS = "node:child_process";
const { execFileSync } = (await import(/* @vite-ignore */ NODE_CHILD_PROCESS)) as {
  execFileSync: (cmd: string, args: string[], opts: { input?: string; encoding: "utf8" }) => string;
};

const RUNNER = `
import json, sqlite3, sys
req = json.load(sys.stdin)
db = sqlite3.connect(":memory:", isolation_level=None)
db.executescript(req["setup"])
plan = req.get("plan")
error = None
if plan:
    for s in plan["pre"]:
        db.execute(s)
    try:
        if plan["transactional"]:
            db.execute("begin")
        try:
            for s in plan["statements"]:
                db.execute(s)
            if plan["transactional"]:
                db.execute("commit")
        except Exception as e:
            if plan["transactional"]:
                db.execute("rollback")
            raise
    except Exception as e:
        error = str(e)
    for s in plan["post"]:
        db.execute(s)
out = []
for q in req.get("queries", []):
    try:
        out.append(db.execute(q).fetchall())
    except Exception as e:
        out.append("ERROR: " + str(e))
print(json.dumps({"error": error, "rows": out}))
`;

function available(): boolean {
  try {
    const v = execFileSync("python3", ["-I", "-c", "import sqlite3;print(sqlite3.sqlite_version)"], { encoding: "utf8" }).trim();
    const [maj, min] = v.split(".").map(Number);
    return maj > 3 || (maj === 3 && min >= 35);
  } catch {
    return false;
  }
}

interface Result {
  error: string | null;
  rows: unknown[][][];
}

/** `setup` runs first; the plan (if any) next; then every query on the same connection. */
function exec(setup: string, plan: Plan | undefined, queries: string[] = []): Result {
  const out = execFileSync("python3", ["-I", "-c", RUNNER], { input: JSON.stringify({ setup, plan, queries }), encoding: "utf8" });
  return JSON.parse(out) as Result;
}

const col = (name: string, type: string, over: Partial<TableDef["columns"][number]> = {}) => newColumn({ name, type, ...over });

describe.skipIf(!available())("SQLite rebuild executed on a real database", () => {
  it("renaming a column keeps the triggers working (new.v -> new.w)", () => {
    const setup = `
      create table log (msg text);
      create table t (id integer primary key, v text);
      create trigger t_ai after insert on t begin insert into log (msg) values (new.v); end;
      create trigger t_au after update of v on t when old.v <> new.v begin insert into log (msg) values ('was ' || old.v || ' is ' || "new"."v"); end;
      insert into t (v) values ('one');`;
    const orig = emptyTable("main", "t");
    orig.columns = [col("id", "integer"), col("v", "text")];
    orig.keys = [newKey({ primary: true, columns: ["id"] })];
    orig.triggers = [
      "CREATE TRIGGER t_ai after insert on t begin insert into log (msg) values (new.v); end",
      `CREATE TRIGGER t_au after update of v on t when old.v <> new.v begin insert into log (msg) values ('was ' || old.v || ' is ' || "new"."v"); end`,
    ];
    const cur = cloneTable(orig);
    cur.columns[1].name = "w";
    cur.columns[1].notNull = true; // forces the rebuild
    cur.keys[0].columns = ["id"];
    const plan = alterTablePlan("sqlite", orig, cur);
    expect(plan.statements[0]).toMatch(/_dg_tmp/);
    const r = exec(setup, plan, [
      "insert into t (w) values ('two')",
      "update t set w = 'three' where w = 'two'",
      "select msg from log order by rowid",
      "select name from sqlite_master where type = 'trigger' order by name",
    ]);
    expect(r.error).toBeNull();
    expect(r.rows[0]).toEqual([]);
    expect(r.rows[1]).toEqual([]);
    expect(r.rows[2]).toEqual([["one"], ["two"], ["was two is three"]]);
    expect(r.rows[3]).toEqual([["t_ai"], ["t_au"]]);
  });

  it("refuses a rename it cannot follow into a trigger (a bare name may be a column of another table)", () => {
    const orig = emptyTable("main", "t");
    orig.columns = [col("id", "integer"), col("v", "text")];
    orig.keys = [newKey({ primary: true, columns: ["id"] })];
    orig.triggers = ["create trigger t_ai after insert on t begin insert into log (v) values (new.v); end"];
    const cur = cloneTable(orig);
    cur.columns[1].name = "w";
    cur.columns[1].notNull = true;
    const plan = alterTablePlan("sqlite", orig, cur);
    expect(plan.error).toMatch(/Trigger 't_ai' mentions the column 'v'/);
    // the same change without the bare mention goes through
    orig.triggers = ["create trigger t_ai after insert on t begin insert into log (msg) values (new.v); end"];
    expect(alterTablePlan("sqlite", orig, cur).error).toBeUndefined();
    // a function called like the column is not a reference
    orig.triggers = ["create trigger t_ai after insert on t begin insert into log (msg) values (v(new.v)); end"];
    expect(alterTablePlan("sqlite", orig, cur).error).toBeUndefined();
  });

  it("refuses to drop a column that a trigger still uses", () => {
    const orig = emptyTable("main", "t");
    orig.columns = [col("id", "integer"), col("v", "text")];
    orig.keys = [newKey({ primary: true, columns: ["id"] })];
    orig.triggers = ["create trigger t_ai after insert on t begin insert into log (msg) values (new.v); end"];
    const cur = cloneTable(orig);
    cur.columns.pop();
    cur.keys[0].name = "pk"; // not needed, a pk change forces the rebuild path
    cur.keys[0].columns = ["id"];
    cur.columns[0].notNull = true;
    expect(alterTablePlan("sqlite", orig, cur).error).toMatch(/uses the column 'v' that is dropped/);
  });

  it("renaming the table and rebuilding keeps the foreign keys of other tables valid", () => {
    const setup = `
      create table p (id integer primary key, name text);
      create table c (id integer primary key, pid integer references p (id) on delete cascade);
      create view v_c as select c.id, p.name from c join p on p.id = c.pid;
      create index p_name on p (name);
      create trigger p_ai after insert on p begin select 1; end;
      insert into p (id, name) values (1, 'a');
      insert into c (pid) values (1);`;
    const orig = emptyTable("main", "p");
    orig.columns = [col("id", "integer"), col("name", "text")];
    orig.keys = [newKey({ primary: true, columns: ["id"] })];
    orig.indexes = [newIndex({ name: "p_name", columns: ["name"] })];
    orig.triggers = ["create trigger p_ai after insert on p begin select 1; end"];
    const cur = cloneTable(orig);
    cur.name = "p2";
    cur.columns[1].type = "varchar(20)"; // forces the rebuild
    const plan = alterTablePlan("sqlite", orig, cur);
    expect(plan.statements.join("\n")).not.toMatch(/p2_dg_tmp/);
    const r = exec(setup, plan, [
      "select sql from sqlite_master where name = 'c'",
      "pragma foreign_keys = on",
      "insert into c (pid) values (1)",
      "pragma foreign_key_check",
      "select name from sqlite_master where tbl_name = 'p2' order by name",
      "select * from v_c order by id",
      "pragma legacy_alter_table",
    ]);
    expect(r.error).toBeNull();
    expect(JSON.stringify(r.rows[0])).toContain('references \\"p2\\"');
    expect(r.rows[2]).toEqual([]);
    expect(r.rows[3]).toEqual([]);
    expect(r.rows[4].map((x) => x[0])).toContain("p_name");
    expect(r.rows[4].map((x) => x[0])).toContain("p_ai");
    expect(r.rows[5]).toEqual([[1, "a"], [2, "a"]]);
    expect(r.rows[6]).toEqual([[0]]);
  });

  it("a self-referencing table renamed with a rebuild keeps pointing to itself", () => {
    const setup = `
      create table n (id integer primary key, parent integer references n (id));
      insert into n (id, parent) values (1, null), (2, 1);`;
    const orig = emptyTable("main", "n");
    orig.columns = [col("id", "integer"), col("parent", "integer")];
    orig.keys = [newKey({ primary: true, columns: ["id"] })];
    orig.fks = [newFk({ columns: ["parent"], refTable: "n", refColumns: ["id"] })];
    const cur = cloneTable(orig);
    cur.name = "n2";
    cur.columns[1].type = "bigint";
    const plan = alterTablePlan("sqlite", orig, cur);
    const r = exec(setup, plan, ["select sql from sqlite_master where name = 'n2'", "pragma foreign_key_check", "select count(*) from n2"]);
    expect(r.error).toBeNull();
    expect(JSON.stringify(r.rows[0])).toContain('references \\"n2\\"');
    expect(r.rows[1]).toEqual([]);
    expect(r.rows[2]).toEqual([[2]]);
  });

  it("expression defaults get their parentheses back", () => {
    const setup = `create table e (id integer primary key, at text default (datetime('now')), n integer default (1 + 2), s text default 'x', c text default current_timestamp, k integer default -1);
      insert into e (id) values (1);`;
    const orig = emptyTable("main", "e");
    // as `pragma table_info` reports them: without the parentheses
    orig.columns = [
      col("id", "integer"),
      col("at", "text", { default: "datetime('now')" }),
      col("n", "integer", { default: "1 + 2" }),
      col("s", "text", { default: "'x'" }),
      col("c", "text", { default: "CURRENT_TIMESTAMP" }),
      col("k", "integer", { default: "-1" }),
    ];
    orig.keys = [newKey({ primary: true, columns: ["id"] })];
    const cur = cloneTable(orig);
    cur.columns[2].notNull = true; // forces the rebuild
    const plan = alterTablePlan("sqlite", orig, cur);
    const r = exec(setup, plan, ["insert into e (id) values (2)", "select at is not null, n, s, c is not null, k from e where id = 2", "select sql from sqlite_master where name = 'e'"]);
    expect(r.error).toBeNull();
    expect(r.rows[1]).toEqual([[1, 3, "x", 1, -1]]);
    expect(JSON.stringify(r.rows[2])).toContain("default (datetime('now'))");
    // the same through create table
    const created = exec("", createTablePlan("sqlite", cloneTable(orig)), ["select sql from sqlite_master where name = 'e'"]);
    expect(created.error).toBeNull();
  });

  it("an expression index survives a rebuild (and follows a renamed column)", () => {
    const setup = `
      create table x (d text, b text, c integer);
      create unique index x_u on x (d, lower(b));
      create index x_part on x (c) where c > 5;
      insert into x values ('a', 'B', 1);`;
    const orig = emptyTable("main", "x");
    orig.columns = [col("d", "text"), col("b", "text"), col("c", "integer")];
    orig.indexes = [
      newIndex({ name: "x_u", unique: true, columns: ["d", "lower(b)"], locked: true, definition: "CREATE UNIQUE INDEX x_u on x (d, lower(b))" }),
      newIndex({ name: "x_part", columns: ["c"], locked: true, definition: "CREATE INDEX x_part on x (c) where c > 5" }),
    ];
    const cur = cloneTable(orig);
    cur.columns[1].name = "bb";
    cur.columns[2].type = "bigint"; // rebuild
    const plan = alterTablePlan("sqlite", orig, cur);
    const r = exec(setup, plan, [
      "select name, sql from sqlite_master where type = 'index' order by name",
      "insert into x values ('a', 'b', 2)",
    ]);
    expect(r.rows[0]).toHaveLength(2);
    expect(r.rows[1]).toContain("ERROR");
    expect(r.error).toBeNull();
    const idx = r.rows[0] as string[][];
    expect(idx[0][1]).toBe("CREATE INDEX x_part on x (c) where c > 5");
    expect(idx[1][1]).toBe("CREATE UNIQUE INDEX x_u on x (d, lower(bb))");
  });

  it("a plain rebuild keeps unique indexes with expressions when nothing is renamed", () => {
    const setup = `
      create table x (d text, b text);
      create unique index x_u on x (d, lower(b));`;
    const orig = emptyTable("main", "x");
    orig.columns = [col("d", "text"), col("b", "text")];
    orig.indexes = [newIndex({ name: "x_u", unique: true, columns: ["d", "lower(b)"], locked: true, definition: "CREATE UNIQUE INDEX x_u on x (d, lower(b))" })];
    const cur = cloneTable(orig);
    cur.columns[0].notNull = true;
    const r = exec(setup, alterTablePlan("sqlite", orig, cur), ["select sql from sqlite_master where name = 'x_u'"]);
    expect(r.error).toBeNull();
    expect(r.rows[0]).toEqual([["CREATE UNIQUE INDEX x_u on x (d, lower(b))"]]);
  });
});
