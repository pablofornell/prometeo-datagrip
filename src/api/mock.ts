// Browser mock of the Tauri command layer (used by `invoke` when not running inside Tauri).
//
// It fakes a PostgreSQL data source "shop@localhost" modelled on crates/dbcore/tests/fixtures/pg_seed.sql
// (schemas, tables, views, routines, columns, keys, indexes, a 100k-row big_table) and implements every
// command of src-tauri/src/commands.rs well enough to build the UI against it:
//   * introspect returns the same tree shape / paths / extra attributes as dbcore;
//   * execute streams the same events (statement/resultset/update/error/message/done) with
//     realistic delays, 500-row pages + fetch_more, a PG-style error with position, cancel;
//   * table_data / apply_changes work on generated rows kept in memory (ORDER BY and simple WHERE work);
//   * UI state, consoles and data sources persist in localStorage.
// `select pg_sleep(3)` runs for 3 s (cancellable). `select * from nope` fails with a PG error.
// An Oracle data source (driver "oracle", e.g. the one added by `?oracle` in the URL) is answered from a second
// model (ORACLE_SCHEMAS: DEMO / HR, packages, synonyms, sequences ...) with Oracle names and ORA- errors.

import type { MockHandler } from "./tauri";
import { splitStatements as splitOracle } from "../components/editor/split";
import type {
  ApplyResult,
  Cell,
  ColumnMeta,
  DataSource,
  DataSourceConfig,
  Driver,
  DumpProgress,
  DumpResult,
  ExecEvent,
  ExecOptions,
  ExplainPlan,
  ExportOptions,
  HistoryEntry,
  ImportFormat,
  ImportPreview,
  ImportProgress,
  ImportRequest,
  ImportResult,
  ImportRowError,
  NodeKind,
  ObjectRef,
  PlanNode,
  ResultSet,
  RowChange,
  SchemaModel,
  ScriptProgress,
  ScriptSummary,
  SnapshotObject,
  Statement,
  TableDataRequest,
  TreeNode,
  Usage,
} from "./types";

// ---------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Tauri rejects with the plain server message; do the same. */
const fail = (msg: string): never => {
  throw msg;
};
const uuid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

const ls = (() => {
  const mem = new Map<string, string>();
  const ok = (() => {
    try {
      localStorage.setItem("__prometeo_probe", "1");
      localStorage.removeItem("__prometeo_probe");
      return true;
    } catch {
      return false;
    }
  })();
  return {
    get: (k: string) => (ok ? localStorage.getItem(k) : mem.get(k) ?? null),
    set: (k: string, v: string) => (ok ? localStorage.setItem(k, v) : void mem.set(k, v)),
    remove: (k: string) => (ok ? localStorage.removeItem(k) : void mem.delete(k)),
    keys: () => (ok ? Object.keys(localStorage) : [...mem.keys()]),
  };
})();
const P = "prometeo-mock:";
const loadJson = <T>(k: string, dflt: T): T => {
  try {
    const v = ls.get(P + k);
    return v == null ? dflt : (JSON.parse(v) as T);
  } catch {
    return dflt;
  }
};
const saveJson = (k: string, v: unknown) => ls.set(P + k, JSON.stringify(v));

const utf8Len = (s: string) => new TextEncoder().encode(s).length;
const charLen = (s: string) => [...s].length;

// ---------------------------------------------------------------- SQL splitter (approximation of dbcore/split.rs)

function splitRaw(sql: string): { start: number; end: number; full: number }[] {
  const out: { start: number; end: number; full: number }[] = [];
  let i = 0;
  let start = -1;
  let last = -1; // end of the last significant char
  const n = sql.length;
  const flush = (full: number) => {
    if (start >= 0) out.push({ start, end: last, full });
    start = -1;
  };
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === ";") {
      flush(i + 1);
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (start < 0) start = i;
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
      } else i++;
    } else i++;
    last = i;
  }
  flush(n);
  return out;
}

function toStatements(sql: string, driver?: string): Statement[] {
  // Oracle: PL/SQL blocks end with a `/` line, `q'[...]'` quoting (the editor's splitter is the same logic as dbcore/split.rs)
  const raws =
    driver === "oracle"
      ? splitOracle(sql, "oracle").map((s) => ({ start: s.start, end: s.end, full: s.fullEnd }))
      : splitRaw(sql);
  return raws.map((r, index) => {
    const pre = sql.slice(0, r.start);
    const body = sql.slice(r.start, r.end);
    return {
      index,
      text: body,
      start: utf8Len(pre),
      end: utf8Len(pre) + utf8Len(body),
      startChar: charLen(pre),
      endChar: charLen(pre) + charLen(body),
      startUtf16: r.start,
      endUtf16: r.end,
    };
  });
}

function statementAt(sql: string, caret: number, driver?: string): Statement | null {
  const raws =
    driver === "oracle"
      ? splitOracle(sql, "oracle").map((s) => ({ start: s.start, end: s.end, full: s.fullEnd }))
      : splitRaw(sql);
  if (!raws.length) return null;
  let pick = raws.findIndex((r) => caret >= r.start && caret <= r.full);
  if (pick < 0) {
    const before = raws.filter((r) => r.full <= caret);
    pick = before.length ? raws.indexOf(before[before.length - 1]) : 0;
  }
  return toStatements(sql, driver)[pick] ?? null;
}

// ---------------------------------------------------------------- schema model

interface Col {
  name: string;
  /** PG `format_type` text, e.g. "character varying(100)". */
  type: string;
  /** Short wire type name as in result sets, e.g. "varchar". */
  wire: string;
  nullable?: boolean;
  pk?: boolean;
  def?: string;
  identity?: "d" | "a";
  comment?: string;
}
interface Fk {
  name: string;
  cols: string[];
  refTable: string;
  refCols: string[];
}
interface Idx {
  name: string;
  cols: string;
  unique?: boolean;
  primary?: boolean;
  where?: string;
}
interface TableDef {
  name: string;
  kind: "table" | "view" | "materializedView";
  comment?: string;
  rows: number;
  cols: Col[];
  uniques?: { name: string; cols: string[] }[];
  fks?: Fk[];
  indexes?: Idx[];
  checks?: { name: string; def: string }[];
  triggers?: { name: string; hint: string; def: string }[];
}
interface RoutineDef {
  name: string;
  signature: string;
  returns: string;
  procedure?: boolean;
}

const c = (name: string, type: string, wire: string, o: Partial<Col> = {}): Col => ({ name, type, wire, ...o });
const serial = (name = "id", o: Partial<Col> = {}) =>
  c(name, "integer", "int4", { pk: true, def: "nextval('seq'::regclass)", ...o });

const SHOP_TABLES: TableDef[] = [
  {
    name: "big_table",
    kind: "table",
    rows: 100000,
    cols: [
      c("id", "integer", "int4", { pk: true }),
      c("grp", "integer", "int4"),
      c("name", "text", "text"),
      c("amount", "numeric(12,2)", "numeric"),
      c("created", "timestamp with time zone", "timestamptz"),
      c("payload", "text", "text", { nullable: true }),
    ],
    indexes: [
      { name: "big_table_pkey", cols: "id", unique: true, primary: true },
      { name: "idx_big_grp", cols: "grp" },
    ],
  },
  {
    name: "categories",
    kind: "table",
    comment: "Product categories",
    rows: 5,
    cols: [
      serial(),
      c("name", "character varying(100)", "varchar"),
      c("parent_id", "integer", "int4", { nullable: true }),
    ],
    uniques: [{ name: "categories_name_key", cols: ["name"] }],
    fks: [{ name: "categories_parent_id_fkey", cols: ["parent_id"], refTable: "categories", refCols: ["id"] }],
    indexes: [
      { name: "categories_pkey", cols: "id", unique: true, primary: true },
      { name: "categories_name_key", cols: "name", unique: true },
    ],
  },
  {
    name: "customers",
    kind: "table",
    rows: 10,
    cols: [
      serial(),
      c("email", "character varying(255)", "varchar"),
      c("name", "character varying(255)", "varchar"),
      c("vip", "boolean", "bool", { def: "false" }),
      c("created_at", "timestamp without time zone", "timestamp", { def: "now()" }),
    ],
    uniques: [{ name: "customers_email_key", cols: ["email"] }],
    indexes: [
      { name: "customers_pkey", cols: "id", unique: true, primary: true },
      { name: "customers_email_key", cols: "email", unique: true },
    ],
  },
  {
    name: "order_items",
    kind: "table",
    rows: 90,
    cols: [
      c("order_id", "integer", "int4", { pk: true }),
      c("line_no", "integer", "int4", { pk: true }),
      c("product_id", "integer", "int4"),
      c("qty", "integer", "int4"),
      c("unit_price", "numeric(10,2)", "numeric"),
    ],
    fks: [
      { name: "order_items_order_id_fkey", cols: ["order_id"], refTable: "orders", refCols: ["id"] },
      { name: "order_items_product_id_fkey", cols: ["product_id"], refTable: "products", refCols: ["id"] },
    ],
    indexes: [{ name: "order_items_pkey", cols: "order_id, line_no", unique: true, primary: true }],
    checks: [{ name: "order_items_qty_check", def: "CHECK ((qty > 0))" }],
  },
  {
    name: "orders",
    kind: "table",
    rows: 30,
    cols: [
      serial(),
      c("customer_id", "integer", "int4"),
      c("status", "shop.order_status", "order_status", { def: "'new'::shop.order_status" }),
      c("placed_at", "timestamp with time zone", "timestamptz", { def: "now()" }),
      c("note", "text", "text", { nullable: true }),
    ],
    fks: [{ name: "orders_customer_id_fkey", cols: ["customer_id"], refTable: "customers", refCols: ["id"] }],
    indexes: [
      { name: "orders_pkey", cols: "id", unique: true, primary: true },
      { name: "idx_orders_customer", cols: "customer_id" },
    ],
  },
  {
    name: "products",
    kind: "table",
    rows: 20,
    cols: [
      c("id", "integer", "int4", { pk: true, identity: "d" }),
      c("sku", "character varying(32)", "varchar"),
      c("name", "character varying(255)", "varchar"),
      c("category_id", "integer", "int4"),
      c("price", "numeric(10,2)", "numeric"),
      c("stock", "integer", "int4", { def: "0" }),
      c("tags", "text[]", "_text", { def: "'{}'::text[]" }),
      c("created_at", "timestamp with time zone", "timestamptz", { def: "now()" }),
      c("updated_at", "timestamp with time zone", "timestamptz", { nullable: true }),
    ],
    uniques: [{ name: "products_sku_key", cols: ["sku"] }],
    fks: [{ name: "products_category_id_fkey", cols: ["category_id"], refTable: "categories", refCols: ["id"] }],
    indexes: [
      { name: "products_pkey", cols: "id", unique: true, primary: true },
      { name: "products_sku_key", cols: "sku", unique: true },
      { name: "idx_products_category", cols: "category_id" },
      { name: "idx_products_name_lower", cols: "lower(name::text)" },
      { name: "idx_products_low_stock", cols: "stock", where: "stock < 5" },
    ],
    checks: [{ name: "products_price_positive", def: "CHECK ((price > (0)::numeric))" }],
    triggers: [
      {
        name: "trg_products_touch",
        hint: "BEFORE UPDATE",
        def: "CREATE TRIGGER trg_products_touch BEFORE UPDATE ON shop.products FOR EACH ROW EXECUTE FUNCTION shop.touch_updated_at()",
      },
    ],
  },
  {
    name: "mv_sales_by_category",
    kind: "materializedView",
    rows: 5,
    cols: [c("category", "character varying(100)", "varchar"), c("revenue", "numeric", "numeric", { nullable: true })],
    indexes: [{ name: "mv_sales_by_category_pk", cols: "category", unique: true }],
  },
  {
    name: "v_order_totals",
    kind: "view",
    rows: 30,
    cols: [
      c("order_id", "integer", "int4"),
      c("customer", "character varying(255)", "varchar"),
      c("status", "shop.order_status", "order_status"),
      c("total", "numeric", "numeric", { nullable: true }),
    ],
  },
];

const SHOP_ROUTINES: RoutineDef[] = [
  { name: "order_total", signature: "p_order_id integer", returns: "numeric" },
  { name: "restock", signature: "p_id integer, p_qty integer", returns: "", procedure: true },
  { name: "touch_updated_at", signature: "", returns: "trigger" },
];

const PUBLIC_TABLES: TableDef[] = [];

const SCHEMAS: Record<string, { comment?: string; tables: TableDef[]; routines: RoutineDef[]; sequences: string[]; system?: boolean }> = {
  public: { tables: PUBLIC_TABLES, routines: [], sequences: [] },
  shop: { comment: "Demo shop", tables: SHOP_TABLES, routines: SHOP_ROUTINES, sequences: ["invoice_seq"] },
  information_schema: {
    system: true,
    tables: [
      {
        name: "tables",
        kind: "view",
        rows: 120,
        cols: [c("table_schema", "name", "name"), c("table_name", "name", "name"), c("table_type", "character varying", "varchar")],
      },
    ],
    routines: [],
    sequences: [],
  },
  pg_catalog: {
    system: true,
    tables: [{ name: "pg_class", kind: "table", rows: 400, cols: [c("oid", "oid", "oid", { pk: true }), c("relname", "name", "name")] }],
    routines: [],
    sequences: [],
  },
};

const DB_NAME = "shop";

type SchemaMap = Record<string, { comment?: string; tables: TableDef[]; routines: RoutineDef[]; sequences: string[]; system?: boolean; packages?: { name: string; status: string }[]; synonyms?: { name: string; target: string }[] }>;

// ---- Oracle model: names are upper case, no database level (schemas hang off the data source)

const o = (name: string, type: string, wire: string, x: Partial<Col> = {}): Col => c(name, type, wire, x);
const num = (name: string, type = "NUMBER", x: Partial<Col> = {}): Col => o(name, type, "NUMBER", x);
const vc = (name: string, n: number, x: Partial<Col> = {}): Col => o(name, `VARCHAR2(${n} CHAR)`, "VARCHAR2", x);

const DEMO_TABLES: TableDef[] = [
  {
    name: "DEPT",
    kind: "table",
    rows: 4,
    comment: "Departments",
    cols: [num("DEPTNO", "NUMBER(2,0)", { pk: true }), vc("DNAME", 14, { nullable: true }), vc("LOC", 13, { nullable: true })],
    indexes: [{ name: "DEPT_PK", cols: "DEPTNO", unique: true, primary: true }],
  },
  {
    name: "EMP",
    kind: "table",
    rows: 14,
    comment: "Employees",
    cols: [
      num("EMPNO", "NUMBER(4,0)", { pk: true }),
      vc("ENAME", 10, { nullable: true }),
      vc("JOB", 9, { nullable: true }),
      num("MGR", "NUMBER(4,0)", { nullable: true }),
      o("HIREDATE", "DATE", "DATE", { nullable: true }),
      num("SAL", "NUMBER(7,2)", { nullable: true, comment: "Monthly salary" }),
      num("COMM", "NUMBER(7,2)", { nullable: true }),
      num("DEPTNO", "NUMBER(2,0)", { nullable: true }),
    ],
    fks: [{ name: "EMP_DEPT_FK", cols: ["DEPTNO"], refTable: "DEPT", refCols: ["DEPTNO"] }],
    indexes: [{ name: "EMP_PK", cols: "EMPNO", unique: true, primary: true }, { name: "EMP_DEPTNO_IX", cols: "DEPTNO" }],
    checks: [{ name: "EMP_SAL_CK", def: "sal > 0" }],
    triggers: [{ name: "TRG_EMP_BI", hint: "BEFORE INSERT", def: 'CREATE OR REPLACE EDITIONABLE TRIGGER "DEMO"."TRG_EMP_BI" BEFORE INSERT ON "DEMO"."EMP" FOR EACH ROW BEGIN :new.hiredate := nvl(:new.hiredate, sysdate); END;' }],
  },
  {
    name: "PRODUCTS",
    kind: "table",
    rows: 40,
    cols: [
      num("ID", "NUMBER(10,0)", { pk: true, identity: "d" }),
      vc("SKU", 20),
      vc("NAME", 100),
      num("PRICE", "NUMBER(10,2)", { def: "0" }),
      o("CREATED", "TIMESTAMP(6)", "TIMESTAMP", { nullable: true, def: "SYSTIMESTAMP" }),
      o("DESCRIPTION", "CLOB", "CLOB", { nullable: true }),
      o("PHOTO", "BLOB", "BLOB", { nullable: true }),
    ],
    uniques: [{ name: "PRODUCTS_SKU_UK", cols: ["SKU"] }],
    indexes: [{ name: "PRODUCTS_PK", cols: "ID", unique: true, primary: true }, { name: "PRODUCTS_SKU_UK", cols: "SKU", unique: true }],
  },
  {
    name: "BIG_TABLE",
    kind: "table",
    rows: 20000,
    cols: [num("ID", "NUMBER(10,0)", { pk: true }), num("GRP", "NUMBER(5,0)"), vc("NAME", 60), o("PAYLOAD", "VARCHAR2(4000 CHAR)", "VARCHAR2", { nullable: true })],
    indexes: [{ name: "BIG_TABLE_PK", cols: "ID", unique: true, primary: true }],
  },
  {
    name: "V_EMP_SUMMARY",
    kind: "view",
    rows: 14,
    cols: [vc("ENAME", 10, { nullable: true }), vc("DNAME", 14, { nullable: true }), num("SAL", "NUMBER(7,2)", { nullable: true })],
  },
  {
    name: "MV_SAL_BY_DEPT",
    kind: "materializedView",
    rows: 4,
    cols: [num("DEPTNO", "NUMBER(2,0)", { nullable: true }), num("TOTAL_SAL", "NUMBER", { nullable: true })],
  },
];

const HR_TABLES: TableDef[] = [
  {
    name: "DEPARTMENTS",
    kind: "table",
    rows: 27,
    cols: [num("DEPARTMENT_ID", "NUMBER(4,0)", { pk: true }), vc("DEPARTMENT_NAME", 30), num("MANAGER_ID", "NUMBER(6,0)", { nullable: true }), num("LOCATION_ID", "NUMBER(4,0)", { nullable: true })],
    indexes: [{ name: "DEPT_ID_PK", cols: "DEPARTMENT_ID", unique: true, primary: true }],
  },
  {
    name: "EMPLOYEES",
    kind: "table",
    rows: 107,
    cols: [
      num("EMPLOYEE_ID", "NUMBER(6,0)", { pk: true }),
      vc("FIRST_NAME", 20, { nullable: true }),
      vc("LAST_NAME", 25),
      vc("EMAIL", 25),
      o("HIRE_DATE", "DATE", "DATE"),
      num("SALARY", "NUMBER(8,2)", { nullable: true }),
      num("DEPARTMENT_ID", "NUMBER(4,0)", { nullable: true }),
    ],
    fks: [{ name: "EMP_DEPT_FK", cols: ["DEPARTMENT_ID"], refTable: "DEPARTMENTS", refCols: ["DEPARTMENT_ID"] }],
    uniques: [{ name: "EMP_EMAIL_UK", cols: ["EMAIL"] }],
    indexes: [{ name: "EMP_EMP_ID_PK", cols: "EMPLOYEE_ID", unique: true, primary: true }, { name: "EMP_EMAIL_UK", cols: "EMAIL", unique: true }],
  },
];

const ORACLE_SCHEMAS: SchemaMap = {
  DEMO: {
    comment: "Demo schema",
    tables: DEMO_TABLES,
    routines: [
      { name: "FN_BONUS", signature: "P_EMPNO IN NUMBER", returns: "NUMBER" },
      { name: "PRC_RAISE", signature: "P_EMPNO IN NUMBER, P_PCT IN NUMBER", returns: "", procedure: true },
    ],
    sequences: ["EMP_SEQ", "INVOICE_SEQ"],
    packages: [
      { name: "PKG_UTIL", status: "VALID" },
      { name: "PKG_REPORTS", status: "INVALID" },
    ],
    synonyms: [{ name: "EMPLOYEE", target: "DEMO.EMP" }],
  },
  HR: { comment: "Human resources", tables: HR_TABLES, routines: [], sequences: ["EMPLOYEES_SEQ"], packages: [], synonyms: [] },
  SYS: { system: true, tables: [{ name: "DUAL", kind: "table", rows: 1, cols: [vc("DUMMY", 1)] }], routines: [], sequences: [] },
  SYSTEM: { system: true, tables: [], routines: [], sequences: [] },
};

interface MockModel {
  oracle: boolean;
  schemas: SchemaMap;
  defaultSchema: string;
  version: string;
}
const PG_MODEL: MockModel = { oracle: false, schemas: SCHEMAS, defaultSchema: "shop", version: "PostgreSQL 16.4 (mock)" };
const ORACLE_VERSION = "Oracle Database 23ai Free Release 23.0.0.0.0 - Develop, Learn, and Run for Free (mock)";
let M: MockModel = PG_MODEL;
/** Selects the model that answers the following commands (by the driver of the data source). */
function useDs(id: unknown): void {
  const d = state.sources.find((x) => x.id === id);
  M = d?.driver === "oracle" ? { oracle: true, schemas: ORACLE_SCHEMAS, defaultSchema: d.user.toUpperCase() || "DEMO", version: ORACLE_VERSION } : PG_MODEL;
}
const findTable = (schema: string | null | undefined, name: string): TableDef | undefined => {
  const tables = M.schemas[schema ?? M.defaultSchema]?.tables;
  return tables?.find((t) => t.name === name) ?? (M.oracle ? tables?.find((t) => t.name.toLowerCase() === name.toLowerCase()) : undefined);
};
/** Index of a column; Oracle folds unquoted names up, so `ename` finds `ENAME`. */
const colIdx = (t: TableDef, name: string): number => {
  const i = t.cols.findIndex((x) => x.name === name);
  return i >= 0 || !M.oracle ? i : t.cols.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
};

// ---------------------------------------------------------------- tree

const encodeSeg = (s: string) => s.replace(/%/g, "%25").replace(/\//g, "%2F");
function node(
  ds: string,
  kind: NodeKind,
  name: string,
  hint: string | null,
  path: string[],
  hasChildren: boolean,
  extra: Record<string, unknown>,
): TreeNode {
  return { id: [ds, ...path.map(encodeSeg)].join("/"), kind, name, hint, path, hasChildren, extra };
}

function shortType(t: string): string {
  if (t.startsWith("character varying")) return "varchar" + t.slice("character varying".length);
  if (t.startsWith("character")) return "char" + t.slice("character".length);
  return t;
}

function folder(ds: string, base: string[], key: string, count: number, schema: string, table?: string): TreeNode {
  return node(ds, "folder", key.replace(/_/g, " "), String(count), [...base, key], count > 0, {
    folder: key,
    count,
    schema,
    table: table ?? null,
  });
}

/** Oracle tree: data source > schemas > folders > objects > folders > items (no database level). */
function introspectOracle(ds: string, path: string[], showSystem: boolean): TreeNode[] {
  const user = (state.sources.find((x) => x.id === ds)?.user ?? "").toUpperCase();
  const sch = (sc: string) => M.schemas[sc] ?? fail(`ORA-01435: user does not exist (${sc})`);
  if (path.length === 0)
    return Object.entries(M.schemas)
      .filter(([, x]) => showSystem || !x.system)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, x]) => node(ds, "schema", name, x.comment ?? null, [name], true, { schema: name, system: !!x.system, default: name === user }));
  const [sc, key, tn, sub] = path;
  const s = sch(sc);
  if (path.length === 1) {
    const counts: [string, number][] = [
      ["tables", s.tables.filter((t) => t.kind === "table").length],
      ["views", s.tables.filter((t) => t.kind === "view").length],
      ["materialized_views", s.tables.filter((t) => t.kind === "materializedView").length],
      ["packages", s.packages?.length ?? 0],
      ["routines", s.routines.length],
      ["sequences", s.sequences.length],
      ["synonyms", s.synonyms?.length ?? 0],
    ];
    return counts.filter(([, n]) => n > 0).map(([k, n]) => folder(ds, path, k, n, sc));
  }
  if (path.length === 2) {
    switch (key) {
      case "routines":
        return s.routines.map((r) =>
          node(ds, r.procedure ? "procedure" : "function", r.name, r.procedure ? `(${r.signature})` : `(${r.signature}): ${r.returns}`, [...path, r.name], false, { schema: sc, signature: r.signature, returns: r.returns, routineType: r.procedure ? "PROCEDURE" : "FUNCTION" }),
        );
      case "sequences":
        return s.sequences.map((q) => node(ds, "sequence", q, "NUMBER", [...path, q], false, { schema: sc }));
      case "packages":
        return (s.packages ?? []).map((k) => node(ds, "package", k.name, k.status, [...path, k.name], false, { schema: sc, status: k.status }));
      case "synonyms":
        return (s.synonyms ?? []).map((y) => node(ds, "synonym", y.name, y.target, [...path, y.name], false, { schema: sc, target: y.target }));
      default: {
        const want = { tables: "table", views: "view", materialized_views: "materializedView" }[key] as TableDef["kind"] | undefined;
        if (!want) return fail(`Unknown tree path: /${path.join("/")}`);
        return s.tables
          .filter((t) => t.kind === want)
          .map((t) => node(ds, want, t.name, t.comment ?? null, [...path, t.name], true, { schema: sc, rowEstimate: t.rows, comment: t.comment ?? "" }));
      }
    }
  }
  const t = findTable(sc, tn) ?? fail(`Unknown tree path: /${path.join("/")}`);
  if (path.length === 3) {
    const items: [string, number][] =
      key === "tables"
        ? [["columns", t.cols.length], ["keys", (t.cols.some((x) => x.pk) ? 1 : 0) + (t.uniques?.length ?? 0)], ["foreign_keys", t.fks?.length ?? 0], ["indexes", t.indexes?.length ?? 0], ["checks", t.checks?.length ?? 0], ["triggers", t.triggers?.length ?? 0]]
        : key === "views"
          ? [["columns", t.cols.length]]
          : [["columns", t.cols.length], ["indexes", t.indexes?.length ?? 0]];
    return items.filter(([k, n]) => k === "columns" || n > 0).map(([k, n]) => folder(ds, path, k, n, sc, tn));
  }
  const ex = (x: Record<string, unknown>) => ({ ...x, schema: sc, table: tn });
  const pkCols = t.cols.filter((x) => x.pk).map((x) => x.name);
  switch (sub) {
    case "columns":
      return t.cols.map((col, i) =>
        node(ds, "column", col.name, col.type, [...path, col.name], false, ex({ dataType: col.type, nullable: !!col.nullable && !col.pk, default: col.def ?? null, comment: col.comment ?? "", isPk: !!col.pk, position: i + 1 })),
      );
    case "keys":
      return [
        ...(pkCols.length ? [node(ds, "primaryKey", `${t.name}_PK`, `(${pkCols.join(", ")})`, [...path, `${t.name}_PK`], false, ex({ columns: pkCols, definition: `PRIMARY KEY (${pkCols.join(", ")})` }))] : []),
        ...(t.uniques ?? []).map((u) => node(ds, "uniqueKey", u.name, `(${u.cols.join(", ")})`, [...path, u.name], false, ex({ columns: u.cols, definition: `UNIQUE (${u.cols.join(", ")})` }))),
      ];
    case "foreign_keys":
      return (t.fks ?? []).map((f) =>
        node(ds, "foreignKey", f.name, `(${f.cols.join(", ")}) -> ${f.refTable}(${f.refCols.join(", ")})`, [...path, f.name], false, ex({ columns: f.cols, refSchema: sc, refTable: f.refTable, refColumns: f.refCols, onDelete: "NO ACTION", onUpdate: "" })),
      );
    case "indexes":
      return (t.indexes ?? []).map((i) => node(ds, "index", i.name, `(${i.cols})`, [...path, i.name], false, ex({ unique: !!i.unique, primary: !!i.primary, columns: i.cols, definition: `CREATE ${i.unique ? "UNIQUE " : ""}INDEX "${sc}"."${i.name}" ON "${sc}"."${t.name}" (${i.cols.split(", ").map((x) => `"${x}"`).join(", ")})` })));
    case "checks":
      return (t.checks ?? []).map((k) => node(ds, "check", k.name, k.def, [...path, k.name], false, ex({ definition: k.def })));
    case "triggers":
      return (t.triggers ?? []).map((g) => node(ds, "trigger", g.name, g.hint, [...path, g.name], false, ex({ definition: g.def, enabled: true })));
  }
  return fail(`Unknown tree path: /${path.join("/")}`);
}

function introspect(ds: string, path: string[], showSystem: boolean): TreeNode[] {
  if (M.oracle) return introspectOracle(ds, path, showSystem);
  switch (path.length) {
    case 0:
      return [
        node(ds, "database", DB_NAME, null, [DB_NAME], true, { current: true, encoding: "UTF8" }),
        node(ds, "database", "postgres", null, ["postgres"], false, { current: false, encoding: "UTF8", comment: "default administrative connection database" }),
        node(ds, "folder", "Server Objects", null, ["$server"], true, { folder: "$server", group: true }),
      ];
    case 1: {
      if (path[0] === "$server")
        return [folder(ds, path, "roles", 2, "", undefined), folder(ds, path, "tablespaces", 2, "", undefined)].map((f) => ({ ...f, extra: { ...f.extra, schema: null } }));
      if (path[0] !== DB_NAME)
        fail(`Database '${path[0]}' is not the one this data source is connected to ('${DB_NAME}'). Create a data source for it.`);
      return [
        ...Object.entries(M.schemas)
          .filter(([, s]) => showSystem || !s.system)
          .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
          .map(([name, s]) => node(ds, "schema", name, s.comment ?? null, [...path, name], true, { schema: name, owner: "postgres", system: !!s.system, default: name === "public" })),
        node(ds, "folder", "Database Objects", null, [...path, "$objects"], true, { folder: "$objects", group: true }),
      ];
    }
    case 2: {
      if (path[0] === "$server" && path[1] === "roles")
        return [
          node(ds, "role", "postgres", "superuser", [...path, "postgres"], false, { superuser: true, login: true, comment: "" }),
          node(ds, "role", "shop_app", "login", [...path, "shop_app"], false, { superuser: false, login: true, comment: "" }),
        ];
      if (path[0] === "$server" && path[1] === "tablespaces")
        return [
          node(ds, "tablespace", "pg_default", null, [...path, "pg_default"], false, { owner: "postgres", location: "" }),
          node(ds, "tablespace", "pg_global", null, [...path, "pg_global"], false, { owner: "postgres", location: "" }),
        ];
      if (path[1] === "$objects") return [{ ...folder(ds, path, "extensions", 2, ""), extra: { folder: "extensions", count: 2 } }];
      const sc = path[1];
      const s = M.schemas[sc] ?? fail(`Schema ${sc} not found`);
      const counts: [string, number][] = [
        ["tables", s.tables.filter((t) => t.kind === "table").length],
        ["views", s.tables.filter((t) => t.kind === "view").length],
        ["materialized_views", s.tables.filter((t) => t.kind === "materializedView").length],
        ["routines", s.routines.length],
        ["sequences", s.sequences.length],
      ];
      return counts.filter(([, n]) => n > 0).map(([k, n]) => folder(ds, path, k, n, sc));
    }
    case 3: {
      const [, sc, key] = path;
      if (sc === "$objects" && key === "extensions")
        return [
          node(ds, "extension", "pg_trgm", "1.6", [...path, "pg_trgm"], false, { version: "1.6", owner: "postgres", schema: "public", comment: "text similarity measurement and index searching based on trigrams" }),
          node(ds, "extension", "plpgsql", "1.0", [...path, "plpgsql"], false, { version: "1.0", owner: "postgres", schema: "pg_catalog", comment: "PL/pgSQL procedural language" }),
        ];
      const s = M.schemas[sc] ?? fail(`Schema ${sc} not found`);
      if (key === "routines")
        return s.routines.map((r) =>
          node(
            ds,
            r.procedure ? "procedure" : "function",
            r.name,
            r.procedure ? `(${r.signature})` : `(${r.signature}): ${r.returns}`,
            [...path, `${r.name}(${r.signature})`],
            false,
            { schema: sc, signature: r.signature, returns: r.returns, oid: "16400" },
          ),
        );
      if (key === "sequences")
        return s.sequences.map((q) => node(ds, "sequence", q, "bigint", [...path, q], false, { schema: sc, relkind: "S", rowEstimate: 1 }));
      const want = { tables: "table", views: "view", materialized_views: "materializedView" }[key] as TableDef["kind"] | undefined;
      if (!want) fail(`Unknown tree path: /${path.join("/")}`);
      return s.tables
        .filter((t) => t.kind === want)
        .map((t) =>
          node(ds, want!, t.name, t.comment ?? null, [...path, t.name], true, {
            schema: sc,
            relkind: want === "table" ? "r" : want === "view" ? "v" : "m",
            rowEstimate: t.rows,
            oid: "16384",
            comment: t.comment ?? "",
          }),
        );
    }
    case 4: {
      const [, sc, key, tn] = path;
      const t = findTable(sc, tn) ?? fail(`Unknown tree path: /${path.join("/")}`);
      const items: [string, number][] =
        key === "tables"
          ? [
              ["columns", t.cols.length],
              ["keys", (t.cols.some((x) => x.pk) ? 1 : 0) + (t.uniques?.length ?? 0)],
              ["foreign_keys", t.fks?.length ?? 0],
              ["indexes", t.indexes?.length ?? 0],
              ["checks", t.checks?.length ?? 0],
              ["triggers", t.triggers?.length ?? 0],
            ]
          : key === "views"
            ? [["columns", t.cols.length], ["triggers", 0]]
            : [["columns", t.cols.length], ["indexes", t.indexes?.length ?? 0]];
      return items.filter(([k, n]) => k === "columns" || n > 0).map(([k, n]) => folder(ds, path, k, n, sc, tn));
    }
    case 5: {
      const [, sc, , tn, sub] = path;
      const t = findTable(sc, tn) ?? fail(`Unknown tree path: /${path.join("/")}`);
      const ex = (o: Record<string, unknown>) => ({ ...o, schema: sc, table: tn });
      const pkCols = t.cols.filter((x) => x.pk).map((x) => x.name);
      switch (sub) {
        case "columns":
          return t.cols.map((col, i) =>
            node(ds, "column", col.name, shortType(col.type), [...path, col.name], false, ex({
              dataType: col.type,
              nullable: !!col.nullable && !col.pk,
              default: col.def ?? null,
              identity: col.identity ?? null,
              generated: null,
              comment: col.comment ?? "",
              isPk: !!col.pk,
              position: i + 1,
            })),
          );
        case "keys":
          return [
            ...(pkCols.length
              ? [node(ds, "primaryKey", `${t.name}_pkey`, `(${pkCols.join(", ")})`, [...path, `${t.name}_pkey`], false, ex({ columns: pkCols, definition: `PRIMARY KEY (${pkCols.join(", ")})` }))]
              : []),
            ...(t.uniques ?? []).map((u) =>
              node(ds, "uniqueKey", u.name, `(${u.cols.join(", ")})`, [...path, u.name], false, ex({ columns: u.cols, definition: `UNIQUE (${u.cols.join(", ")})` })),
            ),
          ];
        case "foreign_keys":
          return (t.fks ?? []).map((f) =>
            node(ds, "foreignKey", f.name, `(${f.cols.join(", ")}) -> ${f.refTable}(${f.refCols.join(", ")})`, [...path, f.name], false, ex({
              columns: f.cols,
              refSchema: sc,
              refTable: f.refTable,
              refColumns: f.refCols,
              definition: `FOREIGN KEY (${f.cols.join(", ")}) REFERENCES ${sc}.${f.refTable}(${f.refCols.join(", ")})`,
            })),
          );
        case "indexes":
          return (t.indexes ?? []).map((i) =>
            node(ds, "index", i.name, `(${i.cols})`, [...path, i.name], false, ex({
              unique: !!i.unique,
              primary: !!i.primary,
              definition: indexDdl(sc, t, i),
              method: "btree",
              columns: i.cols,
            })),
          );
        case "checks":
          return (t.checks ?? []).map((k) => node(ds, "check", k.name, k.def, [...path, k.name], false, ex({ definition: k.def })));
        case "triggers":
          return (t.triggers ?? []).map((g) => node(ds, "trigger", g.name, g.hint, [...path, g.name], false, ex({ definition: g.def, enabled: true })));
      }
      return fail(`Unknown tree path: /${path.join("/")}`);
    }
    default:
      return fail(`Unknown tree path: /${path.join("/")}`);
  }
}

/** Same style as the backend's DDL (DataGrip's lower-case layout, see crates/dbcore/src/ddl.rs). */
function indexDdl(sc: string, t: TableDef, i: Idx): string {
  return `create ${i.unique ? "unique " : ""}index ${i.name}\n    on ${sc}.${t.name} (${i.cols})${i.where ? ` where (${i.where})` : ""}`;
}

function tableDdl(sc: string, t: TableDef): string {
  const header = "-- auto-generated definition\n";
  if (t.kind !== "table") {
    return `${header}${t.kind === "view" ? "create or replace view" : "create materialized view"} ${sc}.${t.name} as\nSELECT ${t.cols.map((x) => x.name).join(", ")}\nFROM ${sc}.orders;`;
  }
  const w = Math.max(...t.cols.map((x) => x.name.length));
  const lines = t.cols.map(
    (x) => `    ${x.name.padEnd(w)} ${x.type}${x.identity ? " generated by default as identity" : x.def ? ` default ${x.def}` : ""}${x.nullable || x.pk ? "" : " not null"}`,
  );
  const pk = t.cols.filter((x) => x.pk).map((x) => x.name);
  if (pk.length) lines.push(`    primary key (${pk.join(", ")})`);
  for (const u of t.uniques ?? []) lines.push(`    constraint ${u.name}\n        unique (${u.cols.join(", ")})`);
  for (const f of t.fks ?? [])
    lines.push(`    constraint ${f.name}\n        foreign key (${f.cols.join(", ")}) references ${sc}.${f.refTable} (${f.refCols.join(", ")})`);
  for (const k of t.checks ?? []) lines.push(`    constraint ${k.name}\n        ${k.def.toLowerCase()}`);
  let out = `${header}create table ${sc}.${t.name}\n(\n${lines.join(",\n")}\n);\n\nalter table ${sc}.${t.name}\n    owner to postgres;`;
  for (const i of t.indexes ?? []) if (!i.primary && !(t.uniques ?? []).some((u) => u.name === i.name)) out += `\n\n${indexDdl(sc, t, i)};`;
  for (const g of t.triggers ?? []) out += `\n\ncreate trigger ${g.name}\n    ${g.hint.toLowerCase()}\n    on ${sc}.${t.name}\n    for each row\nexecute function ${sc}.touch_updated_at();`;
  return out;
}

/** DBMS_METADATA.GET_DDL style (SQLTERMINATOR on, PRETTY on, no storage clauses). */
function oracleDdl(sc: string, o: ObjectRef, unqualified: boolean): string {
  const T = (n: string) => `${unqualified ? "" : `"${sc}".`}"${n}"`;
  const schema = M.schemas[sc] ?? fail(`ORA-31603: object "${o.name}" of type ${o.kind} not found in schema "${sc}"`);
  switch (o.kind) {
    case "table":
    case "view":
    case "materializedView": {
      const t = findTable(sc, o.name) ?? fail(`ORA-31603: object "${o.name}" of type TABLE not found in schema "${sc}"`);
      if (t.kind === "view") return `  CREATE OR REPLACE FORCE EDITIONABLE VIEW ${T(t.name)} ("${t.cols.map((x) => x.name).join('", "')}") AS \n  SELECT ${t.cols.map((x) => `"${x.name}"`).join(", ")}\n  FROM ${T("EMP")};`;
      if (t.kind === "materializedView") return `  CREATE MATERIALIZED VIEW ${T(t.name)}\n  REFRESH FORCE ON DEMAND\n  AS SELECT "DEPTNO", SUM("SAL") "TOTAL_SAL" FROM ${T("EMP")} GROUP BY "DEPTNO";`;
      const lines = t.cols.map((x) => `"${x.name}" ${x.type.replace(/\((\d+)\)/, "($1,0)")}${x.identity ? " GENERATED BY DEFAULT AS IDENTITY" : x.def ? ` DEFAULT ${x.def}` : ""}${x.nullable || x.pk ? "" : " NOT NULL ENABLE"}`);
      const pk = t.cols.filter((x) => x.pk).map((x) => `"${x.name}"`);
      if (pk.length) lines.push(`CONSTRAINT "${t.name}_PK" PRIMARY KEY (${pk.join(", ")})\n  USING INDEX  ENABLE`);
      for (const u of t.uniques ?? []) lines.push(`CONSTRAINT "${u.name}" UNIQUE (${u.cols.map((x) => `"${x}"`).join(", ")})\n  USING INDEX  ENABLE`);
      for (const k of t.checks ?? []) lines.push(`CONSTRAINT "${k.name}" CHECK (${k.def}) ENABLE`);
      for (const f of t.fks ?? []) lines.push(`CONSTRAINT "${f.name}" FOREIGN KEY (${f.cols.map((x) => `"${x}"`).join(", ")})\n  REFERENCES ${T(f.refTable)} (${f.refCols.map((x) => `"${x}"`).join(", ")}) ENABLE`);
      let out = `  CREATE TABLE ${T(t.name)}\n   (\t${lines.join(",\n\t ")}\n   ) ;`;
      for (const i of t.indexes ?? []) if (!i.primary && !(t.uniques ?? []).some((u) => u.name === i.name)) out += `\n\n  CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${T(i.name)} ON ${T(t.name)} (${i.cols.split(", ").map((x) => `"${x}"`).join(", ")});`;
      if (t.comment) out += `\n\n   COMMENT ON TABLE ${T(t.name)} IS '${t.comment}';`;
      return out;
    }
    case "sequence":
      return `   CREATE SEQUENCE  ${T(o.name)}  MINVALUE 1 MAXVALUE 9999999999999999999999999999 INCREMENT BY 1 START WITH 1000 CACHE 20 NOORDER  NOCYCLE  NOKEEP  NOSCALE  GLOBAL ;`;
    case "package":
      return `  CREATE OR REPLACE EDITIONABLE PACKAGE ${T(o.name)} AS\n  FUNCTION version RETURN VARCHAR2;\n  PROCEDURE log_msg(p_text IN VARCHAR2);\nEND ${o.name.toLowerCase()};\n/\n\n  CREATE OR REPLACE EDITIONABLE PACKAGE BODY ${T(o.name)} AS\n  FUNCTION version RETURN VARCHAR2 IS BEGIN RETURN '1.0'; END;\n  PROCEDURE log_msg(p_text IN VARCHAR2) IS BEGIN DBMS_OUTPUT.PUT_LINE(p_text); END;\nEND ${o.name.toLowerCase()};\n/`;
    case "synonym": {
      const y = schema.synonyms?.find((x) => x.name === o.name);
      return `  CREATE OR REPLACE EDITIONABLE SYNONYM ${T(o.name)} FOR ${y?.target ?? "DEMO.EMP"};`;
    }
    case "function":
    case "procedure":
      return o.kind === "function"
        ? `  CREATE OR REPLACE EDITIONABLE FUNCTION ${T(o.name)} (p_empno IN NUMBER) RETURN NUMBER IS\nBEGIN\n  RETURN p_empno * 0.1;\nEND;\n/`
        : `  CREATE OR REPLACE EDITIONABLE PROCEDURE ${T(o.name)} (p_empno IN NUMBER, p_pct IN NUMBER) IS\nBEGIN\n  UPDATE emp SET sal = sal * (1 + p_pct / 100) WHERE empno = p_empno;\nEND;\n/`;
    case "index": {
      const t = findTable(sc, o.table ?? "");
      const i = t?.indexes?.find((x) => x.name === o.name);
      return t && i ? `  CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${T(i.name)} ON ${T(t.name)} (${i.cols.split(", ").map((x) => `"${x}"`).join(", ")});` : fail(`ORA-31603: object "${o.name}" of type INDEX not found in schema "${sc}"`);
    }
    default:
      return `-- DDL of ${o.kind} ${o.name}`;
  }
}

// ---------------------------------------------------------------- row generation

const FIRST = ["Ada", "Linus", "Grace", "Alan", "Edsger", "Barbara", "Dennis", "Margaret", "Ken", "Radia", "Donald", "Frances"];
const LAST = ["Lovelace", "Torvalds", "Hopper", "Turing", "Dijkstra", "Liskov", "Ritchie", "Hamilton", "Thompson", "Perlman", "Knuth", "Allen"];
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
const STATUSES = ["new", "paid", "shipped", "cancelled"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const BASE_TS = Date.UTC(2024, 0, 1, 10, 0, 0);
const tsText = (ms: number, tz: boolean) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${tz ? "+00" : ""}`;
};

function genCell(t: TableDef, col: Col, i: number): Cell {
  const n = i + 1;
  const nm = col.name.toLowerCase();
  if (col.nullable && !col.pk && n % 6 === 0) return null;
  switch (col.wire) {
    case "NUMBER":
      if (col.pk && t.cols.filter((x) => x.pk).length === 1) return nm === "empno" ? 7369 + i * 5 : n;
      if (/(sal|salary|price|total)/.test(nm)) return (800 + n * 137.5).toFixed(2);
      if (nm === "comm") return n % 3 === 0 ? 300 : 0;
      if (/(deptno|department_id)$/.test(nm)) return [10, 20, 30, 40][i % 4];
      if (nm === "mgr") return 7369 + ((i * 3) % 14) * 5;
      if (nm === "grp") return n % 100;
      return (n * 37) % 1000;
    case "DATE":
      return tsText(BASE_TS - 9000 * 86400000 + n * 31 * 86400000, false);
    case "TIMESTAMP":
      return tsText(BASE_TS + n * 3600000, false);
    case "CLOB":
      return `Long description of item ${n}`;
    case "BLOB":
      return null;
    case "int4":
    case "int8":
      if (col.pk && t.cols.filter((x) => x.pk).length === 1) return n;
      if (nm === "line_no") return (i % 3) + 1;
      if (nm === "order_id") return Math.floor(i / 3) + 1;
      if (nm.endsWith("_id")) return 1 + ((i * 7) % 20);
      if (nm === "grp") return n % 100;
      if (nm === "qty") return 1 + (i % 4);
      if (nm === "stock") return (n * 7) % 40;
      return (n * 37) % 1000;
    case "numeric":
      return (5 + n * 3.37).toFixed(2);
    case "bool":
      return n % 4 === 0;
    case "timestamptz":
      return tsText(BASE_TS + n * 86400000, true);
    case "timestamp":
      return tsText(BASE_TS + n * 3600000, false);
    case "_text":
      return n % 3 === 0 ? ["sale", "new"] : ["std"];
    case "order_status":
      return STATUSES[n % 4];
    default:
      break;
  }
  if (nm === "email") return `customer${n}@example.com`;
  if (nm === "sku") return `SKU-${pad(n, 4)}`;
  if (nm === "payload") return n.toString(16).padStart(8, "0").repeat(4);
  if (nm === "note") return "gift wrap";
  if (nm === "ename") return ["SMITH", "ALLEN", "WARD", "JONES", "MARTIN", "BLAKE", "CLARK", "SCOTT", "KING", "TURNER", "ADAMS", "JAMES", "FORD", "MILLER"][i % 14];
  if (nm === "job") return ["CLERK", "SALESMAN", "MANAGER", "ANALYST", "PRESIDENT"][i % 5];
  if (nm === "dname") return ["ACCOUNTING", "RESEARCH", "SALES", "OPERATIONS"][i % 4];
  if (nm === "loc") return ["NEW YORK", "DALLAS", "CHICAGO", "BOSTON"][i % 4];
  if (nm === "department_name") return ["Administration", "Marketing", "Purchasing", "Human Resources", "Shipping", "IT", "Sales"][i % 7] + (i >= 7 ? ` ${Math.floor(i / 7)}` : "");
  if (nm === "first_name") return FIRST[i % FIRST.length];
  if (nm === "last_name") return LAST[(i * 5) % LAST.length];
  if (nm === "dummy") return "X";
  if (nm === "description") return `Description ${n}`;
  if (t.name === "customers" && nm === "name") return `${FIRST[i % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`;
  if (t.name === "categories" && nm === "name") return ["Electronics", "Books", "Garden", "Laptops", "Phones"][i % 5] + (i >= 5 ? ` ${Math.floor(i / 5)}` : "");
  if (t.name === "products" && nm === "name") return `Product ${n}`;
  if (nm === "name") return `name-${n}`;
  if (nm === "customer") return `${FIRST[i % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`;
  if (nm === "category") return ["Electronics", "Books", "Garden", "Laptops", "Phones"][i % 5];
  if (nm === "table_schema") return "shop";
  if (nm === "sku") return `SKU-${pad(n, 4)}`;
  if (nm === "table_name") return `table_${n}`;
  if (nm === "table_type") return "BASE TABLE";
  return `${WORDS[i % WORDS.length]}-${n}`;
}

const rowCache = new Map<TableDef, Cell[][]>();
function allRows(t: TableDef): Cell[][] {
  let r = rowCache.get(t);
  if (!r) {
    r = Array.from({ length: t.rows }, (_, i) => t.cols.map((col) => genCell(t, col, i)));
    rowCache.set(t, r);
  }
  return r;
}

function colMeta(t: TableDef, tableRef: string | null, cols: Col[] = t.cols): ColumnMeta[] {
  return cols.map((x) => ({ name: x.name, typeName: x.wire, nullable: !!x.nullable && !x.pk, isPk: !!x.pk, tableRef }));
}

// ---------------------------------------------------------------- tiny WHERE / ORDER BY support

function cmp(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== "boolean" && typeof b !== "boolean" && !Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na - nb;
  return String(a) < String(b) ? -1 : 1;
}

function applyWhere(t: TableDef, rows: Cell[][], where: string | null | undefined): Cell[][] {
  const w = where?.trim();
  if (!w) return rows;
  const preds = w.split(/\s+and\s+/i).map((p) => {
    const m = /^\(?\s*"?(\w+)"?\s*(=|<>|!=|<=|>=|<|>|not\s+ilike|not\s+like|ilike|like|is\s+not\s+null|is\s+null)\s*(.*?)\)?$/i.exec(p.trim());
    if (!m) return fail(`syntax error at or near "${p.trim().slice(0, 20)}" (mock supports: col <op> literal [and ...])`);
    const idx = colIdx(t, m[1]);
    if (idx < 0) return fail(`${M.oracle ? "ORA-00904: " : ""}column "${m[1]}" does not exist`);
    const op = m[2].toLowerCase().replace(/\s+/g, " ");
    let lit = m[3].trim();
    if (lit.startsWith("'") && lit.endsWith("'")) lit = lit.slice(1, -1).replace(/''/g, "'");
    return (row: Cell[]) => {
      const v = row[idx];
      switch (op) {
        case "is null": return v === null;
        case "is not null": return v !== null;
        case "=": return v !== null && cmp(v, lit) === 0;
        case "<>":
        case "!=": return v !== null && cmp(v, lit) !== 0;
        case "<": return v !== null && cmp(v, lit) < 0;
        case ">": return v !== null && cmp(v, lit) > 0;
        case "<=": return v !== null && cmp(v, lit) <= 0;
        case ">=": return v !== null && cmp(v, lit) >= 0;
        default: {
          const re = new RegExp("^" + lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$", op.includes("ilike") ? "is" : "s");
          const hit = v !== null && re.test(String(v));
          return op.startsWith("not") ? !hit : hit;
        }
      }
    };
  });
  return rows.filter((r) => preds.every((p) => p(r)));
}

function applyOrder(t: TableDef, rows: Cell[][], orderBy: string | null | undefined): Cell[][] {
  const o = orderBy?.trim();
  if (!o) return rows;
  const keys = o.split(",").map((p) => {
    const m = /^"?(\w+)"?\s*(asc|desc)?(\s+nulls\s+(first|last))?$/i.exec(p.trim());
    if (!m) return fail(`syntax error at or near "${p.trim().slice(0, 20)}"`);
    const idx = colIdx(t, m[1]);
    if (idx < 0) return fail(`${M.oracle ? "ORA-00904: " : ""}column "${m[1]}" does not exist`);
    return { idx, dir: m[2]?.toLowerCase() === "desc" ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const r = cmp(a[k.idx], b[k.idx]);
      if (r) return r * k.dir;
    }
    return 0;
  });
}

// ---------------------------------------------------------------- state

interface MockState {
  sources: DataSource[];
  connected: Set<string>;
  sessions: Map<string, { ds: string; tx: boolean; running: string | null; schema?: string }>;
  execs: Map<string, { cancelled: boolean; table?: { rows: Cell[][]; offset: number; resultIndex: number }; sessionId: string }>;
  history: HistoryEntry[];
}

const SHOP_DS: DataSource = {
  id: "ds-shop",
  name: "shop@localhost",
  driver: "postgres",
  host: "localhost",
  port: 5432,
  database: DB_NAME,
  user: "postgres",
  hasPassword: true,
  passwordStorage: "keyring",
  file: "",
  urlOverride: null,
  options: {},
  color: null,
  readOnly: false,
};

const state: MockState = {
  sources: loadJson<DataSource[]>("data-sources", [SHOP_DS]),
  connected: new Set(),
  sessions: new Map(),
  execs: new Map(),
  history: loadJson<HistoryEntry[]>("history", []),
};
const persistSources = () => saveJson("data-sources", state.sources);

/** `?oracle` in the page URL adds an Oracle data source (the DEMO / HR schemas of ORACLE_SCHEMAS) to the mock. */
const ORACLE_DS: DataSource = {
  id: "ds-oracle",
  name: "demo@localhost",
  driver: "oracle",
  host: "localhost",
  port: 1521,
  database: "FREEPDB1",
  user: "demo",
  hasPassword: true,
  passwordStorage: "keyring",
  file: "",
  urlOverride: null,
  options: { oracleConnType: "service" },
  color: null,
  readOnly: false,
};
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("oracle") && !state.sources.some((x) => x.id === ORACLE_DS.id)) {
  state.sources.push(ORACLE_DS);
  persistSources();
}

const ds = (id: unknown): DataSource => state.sources.find((s) => s.id === id) ?? fail(`Unknown data source '${String(id)}'`);
const needConn = (id: unknown) => {
  ds(id);
  if (!state.connected.has(id as string)) fail(`Data source '${String(id)}' is not connected`);
};

// ---------------------------------------------------------------- execute

/** `select current_schema()` (PG) / `select database()` (MySQL), the statements the console sends to label its schema switcher. */
function schemaFunction(sql: string): "current_schema" | "database" | null {
  const bare = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").replace(/;\s*$/, "").trim();
  if (/^select\s+sys_context\s*\(\s*'userenv'\s*,\s*'current_schema'\s*\)\s+from\s+dual$/i.test(bare)) return "current_schema";
  const m = /^select\s+(current_schema|database)\s*\(\s*\)$/i.exec(bare);
  return m ? (m[1].toLowerCase() as "current_schema" | "database") : null;
}

/** The session's schema: what `SET search_path` / `USE` chose, else PG `public`, MySQL the data source's database. */
function currentSchema(sess: { ds: string; schema?: string }): string {
  const d = ds(sess.ds);
  return sess.schema ?? (d.driver === "postgres" ? "public" : d.driver === "oracle" ? d.user.toUpperCase() : d.database);
}

/** `SET search_path TO "x"` / `USE x` of a statement, or null. */
function schemaSwitch(sql: string): string | null {
  const bare = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/;\s*$/, "").trim();
  const m = /^(?:set\s+(?:session\s+|local\s+)?search_path\s*(?:=|to)\s*|use\s+|alter\s+session\s+set\s+current_schema\s*=\s*)(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|([\w$]+))(?:\s*,.*)?$/is.exec(bare);
  if (!m) return null;
  const name = (m[1] ?? m[2] ?? m[3]).replace(/""|``/g, (q) => q[0]);
  return m[3] && /^alter\s/i.test(bare) ? name.toUpperCase() : name;
}

interface Sink {
  onmessage?: (e: ExecEvent) => void;
}

const SERVER_VERSION = "PostgreSQL 16.4 (mock)";

function parseSelect(sql: string): {
  table?: { sc: string; def: TableDef; ref: string };
  unknown?: { name: string; offset: number };
  cols: string[] | "*";
  where: string | null;
  order: string | null;
  limit: number | null;
  offset: number;
  count: boolean;
} {
  const flat = sql.replace(/\s+/g, " ").trim();
  const lim = /\blimit\s+(\d+)/i.exec(flat) ?? /\bfetch\s+(?:first|next)\s+(\d+)\s+rows?\s+only\b/i.exec(flat);
  const off = /\boffset\s+(\d+)(?:\s+rows?)?\b/i.exec(flat);
  const ord = /\border by (.+?)(?= limit\b| offset\b| fetch\b|$)/i.exec(flat);
  const whr = /\bwhere (.+?)(?= order by\b| limit\b| offset\b| fetch\b| group by\b|$)/i.exec(flat);
  const from = /\bfrom\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i.exec(sql);
  const sel = /^\s*select\s+(.+?)\s+from\b/is.exec(sql)?.[1]?.trim();
  const out = {
    cols: "*" as string[] | "*",
    where: whr?.[1] ?? null,
    order: ord?.[1] ?? null,
    limit: lim ? Number(lim[1]) : null,
    offset: off ? Number(off[1]) : 0,
    count: !!sel && /^count\(\s*\*\s*\)(\s+as\s+\w+)?$/i.test(sel),
  } as ReturnType<typeof parseSelect>;
  if (sel && sel !== "*" && !out.count) {
    const parts = sel.split(",").map((p) => p.trim().replace(/^"?(\w+\.)?"?(\w+)"?(\s+as\s+\w+)?$/i, "$2"));
    if (parts.every((p) => /^\w+$/.test(p))) out.cols = parts;
  }
  if (from && !from[1] && from[2].toLowerCase() === "dual") return out; // Oracle's one-row pseudo table
  if (from) {
    const sc = from[1] ?? M.defaultSchema;
    const def = findTable(M.oracle ? (from[1] ?? M.defaultSchema).toUpperCase() : sc, from[2]);
    if (def) out.table = { sc, def, ref: `${sc}.${def.name}` };
    else out.unknown = { name: from[1] ? `${from[1]}.${from[2]}` : from[2], offset: sql.indexOf(from[0]) + from[0].lastIndexOf(from[2]) + 1 };
  }
  return out;
}

/** The ALL_* catalog queries of the Modify Table dialog (identity / virtual columns, comments, tablespace). */
function oracleCatalog(sql: string): { columns: ColumnMeta[]; rows: Cell[][] } | null {
  const m = /\bfrom\s+(all_tab_identity_cols|all_tab_cols|all_col_comments|all_tables)\b/i.exec(sql);
  if (!m) return null;
  const tn = /table_name\s*=\s*'([^']*)'/i.exec(sql)?.[1] ?? "";
  const sc = /owner\s*=\s*'([^']*)'/i.exec(sql)?.[1] ?? "";
  const t = findTable(sc, tn);
  const col = (name: string): ColumnMeta => ({ name, typeName: "VARCHAR2", nullable: true, isPk: false, tableRef: null });
  switch (m[1].toLowerCase()) {
    case "all_tab_identity_cols":
      return { columns: [col("COLUMN_NAME"), col("GENERATION_TYPE")], rows: (t?.cols ?? []).filter((x) => x.identity).map((x) => [x.name, "BY DEFAULT"]) };
    case "all_tab_cols":
      return { columns: [col("COLUMN_NAME")], rows: [] };
    case "all_col_comments":
      return { columns: [col("COLUMN_NAME"), col("COMMENTS")], rows: (t?.cols ?? []).map((x) => [x.name, x.comment ?? null]) };
    default:
      return { columns: [col("TABLESPACE_NAME"), col("COMMENTS")], rows: t ? [["USERS", t.comment ?? null]] : [] };
  }
}

async function runExecution(
  execId: string,
  sessionId: string,
  sql: string,
  opts: ExecOptions,
  send: (e: ExecEvent) => void,
): Promise<void> {
  const ex = state.execs.get(execId)!;
  const sess = state.sessions.get(sessionId)!;
  useDs(sess.ds);
  const t0 = performance.now();
  let execMs = 0;
  let fetchMs = 0;
  let rowsTotal = 0;
  let firstError: string | null = null;
  const stmts = toStatements(sql, M.oracle ? "oracle" : undefined);
  const range = (s: Statement) => ({
    start: s.start, end: s.end, startChar: s.startChar, endChar: s.endChar, startUtf16: s.startUtf16, endUtf16: s.endUtf16,
  });
  const waitCancellable = async (ms: number) => {
    const step = 25;
    for (let left = ms; left > 0 && !ex.cancelled; left -= step) await sleep(Math.min(step, left));
  };

  for (let i = 0; i < stmts.length && !ex.cancelled; i++) {
    const st = stmts[i];
    const isLast = i === stmts.length - 1;
    send({ kind: "statement", index: i, sql: st.text, range: range(st) });
    const kw = /^\s*(\w+)/.exec(st.text)?.[1]?.toLowerCase() ?? "";
    const t1 = performance.now();
    if (kw === "select" || kw === "with" || kw === "show" || kw === "table" || kw === "values" || kw === "explain") {
      const sleepM = /pg_sleep\(\s*([\d.]+)\s*\)/i.exec(st.text);
      await waitCancellable(sleepM ? Number(sleepM[1]) * 1000 : 30 + Math.random() * 60);
      if (ex.cancelled) break;
      const q = parseSelect(st.text);
      if (q.unknown) {
        firstError = M.oracle ? "ORA-00942: table or view does not exist" : `ERROR: relation "${q.unknown.name}" does not exist`;
        send({ kind: "error", index: i, message: M.oracle ? firstError : `[42P01] ${firstError}`, position: q.unknown.offset, positionUtf16: q.unknown.offset, connectionLost: false });
        if (opts.stopOnError) break;
        continue;
      }
      let columns: ColumnMeta[];
      let rows: Cell[][];
      if (q.table) {
        try {
          const t = q.table.def;
          let r = applyOrder(t, applyWhere(t, allRows(t), q.where), q.order);
          if (q.offset) r = r.slice(q.offset);
          if (q.limit != null) r = r.slice(0, q.limit);
          const idxs = q.cols === "*" ? t.cols.map((_, k) => k) : q.cols.map((n) => colIdx(t, n));
          if (idxs.some((k) => k < 0)) {
            const bad = (q.cols as string[])[idxs.findIndex((k) => k < 0)];
            throw M.oracle ? `ORA-00904: "${bad.toUpperCase()}": invalid identifier` : `[42703] ERROR: column "${bad}" does not exist`;
          }
          if (q.count) {
            columns = [{ name: "count", typeName: "int8", nullable: false, isPk: false, tableRef: null }];
            r = [[r.length]];
          } else {
            columns = colMeta(t, q.table.ref, idxs.map((k) => t.cols[k]));
            if (q.cols !== "*") r = r.map((row) => idxs.map((k) => row[k]));
          }
          rows = r;
        } catch (e) {
          firstError = typeof e === "string" ? e : String(e);
          send({ kind: "error", index: i, message: firstError, position: null, positionUtf16: null, connectionLost: false });
          if (opts.stopOnError) break;
          continue;
        }
      } else if (M.oracle && oracleCatalog(st.text)) {
        const r = oracleCatalog(st.text)!;
        columns = r.columns;
        rows = r.rows;
      } else if (schemaFunction(st.text)) {
        const fn = schemaFunction(st.text)!;
        columns = [{ name: M.oracle ? "SYS_CONTEXT('USERENV','CURRENT_SCHEMA')" : fn, typeName: fn === "database" ? "varchar" : "name", nullable: true, isPk: false, tableRef: null }];
        rows = [[currentSchema(sess)]];
      } else if (sleepM) {
        columns = [{ name: "pg_sleep", typeName: "void", nullable: true, isPk: false, tableRef: null }];
        rows = [[""]];
      } else {
        columns = [{ name: "?column?", typeName: "int4", nullable: true, isPk: false, tableRef: null }];
        rows = [[1]];
      }
      const page = rows.slice(0, Math.max(1, opts.maxRows));
      const hasMore = rows.length > page.length && isLast;
      if (hasMore) ex.table = { rows, offset: page.length, resultIndex: i };
      rowsTotal = page.length;
      execMs += performance.now() - t1;
      await sleep(Math.min(120, page.length / 8));
      fetchMs += Math.min(120, page.length / 8);
      send({ kind: "resultset", index: i, columns, rows: page, hasMore });
      if (rows.length > page.length && !isLast)
        send({ kind: "message", index: i, text: `Result ${i + 1} was truncated to ${opts.maxRows} rows (only the last statement of a script can be paged)` });
    } else {
      await waitCancellable(25 + Math.random() * 50);
      if (ex.cancelled) break;
      if (kw === "begin" || kw === "start") sess.tx = true;
      if (kw === "commit" || kw === "rollback" || kw === "end") sess.tx = false;
      if (kw === "set" || kw === "use") sess.schema = schemaSwitch(st.text) ?? sess.schema;
      const n = ["insert", "update", "delete"].includes(kw) ? 1 + Math.floor(Math.random() * 3) : 0;
      send({ kind: "update", index: i, rowsAffected: n });
      rowsTotal = n;
      execMs += performance.now() - t1;
    }
  }
  if (ex.cancelled) {
    firstError = "Statement cancelled by user";
    send({ kind: "error", index: 0, message: "[57014] ERROR: canceling statement due to user request", position: null, positionUtf16: null, connectionLost: false });
  }
  const elapsed = Math.round(performance.now() - t0);
  send({ kind: "done", elapsedMs: elapsed, executionMs: Math.round(execMs), fetchingMs: Math.round(fetchMs) });
  if (sql.trim()) {
    state.history.push({
      id: uuid(),
      tsMs: Date.now(),
      dataSourceId: sess.ds,
      sql,
      durationMs: elapsed,
      ok: !firstError,
      error: firstError,
      rows: rowsTotal,
    });
    if (state.history.length > 1000) state.history.splice(0, state.history.length - 1000);
    saveJson("history", state.history);
  }
}

// ---------------------------------------------------------------- export

function exportText(src: Pick<ResultSet, "columns" | "rows">, o: ExportOptions): string {
  let res = src;
  if (o.transpose) {
    const col = (name: string) => ({ name, typeName: "text", nullable: true, isPk: false, tableRef: null });
    res = {
      columns: [col("column"), ...src.rows.map((_, i) => col(String(i + 1)))],
      rows: src.columns.map((c, i) => [c.name, ...src.rows.map((r) => r[i] ?? null)]),
    };
  }
  if (o.rowHeader && ["csv", "tsv", "markdown", "csvPipe", "csvSemicolon"].includes(o.format)) {
    res = { columns: [{ name: "", typeName: "int4", nullable: false, isPk: false, tableRef: null }, ...res.columns], rows: res.rows.map((r, i) => [i + 1, ...r]) };
  }
  const txt = (v: Cell): string =>
    v === null ? o.nullText : typeof v === "object" ? ("$bin" in (v as object) ? "0x" + (v as { $bin: string }).$bin : JSON.stringify(v)) : String(v);
  const names = res.columns.map((x) => x.name);
  const q = (s: string, d: string) => (s.includes(d) || s.includes(o.quote) || /[\r\n]/.test(s) ? o.quote + s.split(o.quote).join(o.quote + o.quote) + o.quote : s);
  const key = (): number[] => {
    const pk = res.columns.flatMap((c, i) => (c.isPk ? [i] : []));
    return pk.length ? pk : res.columns.map((_, i) => i);
  };
  const lit = (v: Cell) => (v === null ? "NULL" : typeof v === "number" || typeof v === "boolean" ? String(v) : `'${txt(v).replace(/'/g, "''")}'`);
  const qi = (n: string) => `"${n}"`;
  const tbl = (o.tableName ?? "table_name").split(".").map(qi).join(".");
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  switch (o.format) {
    case "xlsx":
      // a binary workbook: only the desktop app writes it
      throw new Error("Excel (xlsx) export needs the desktop app");
    case "csv":
    case "csvPipe":
    case "csvSemicolon":
    case "tsv": {
      const d = o.format === "tsv" ? "\t" : o.format === "csvPipe" ? "|" : o.format === "csvSemicolon" ? ";" : o.delimiter ?? ",";
      const lines = res.rows.map((r) => r.map((v) => (o.format === "tsv" ? txt(v).replace(/[\t\r\n]/g, " ") : q(txt(v), d))).join(d));
      return [...(o.header ? [names.join(d)] : []), ...lines].join("\n") + "\n";
    }
    case "json":
      return JSON.stringify(res.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]]))), null, 2) + "\n";
    case "jsonLines":
      return res.rows.map((r) => JSON.stringify(Object.fromEntries(names.map((n, i) => [n, r[i]])))).join("\n") + "\n";
    case "sqlUpdate": {
      const k = key();
      const set = res.columns.map((_, i) => i).filter((i) => !k.includes(i) || k.length === names.length);
      const eq = (r: Cell[], i: number) => (r[i] === null ? `${qi(names[i])} is null` : `${qi(names[i])} = ${lit(r[i])}`);
      return res.rows.map((r) => `update ${tbl} set ${set.map((i) => `${qi(names[i])} = ${lit(r[i])}`).join(", ")} where ${k.map((i) => eq(r, i)).join(" and ")};`).join("\n") + "\n";
    }
    case "whereClause": {
      const k = key();
      if (!res.rows.length) return "";
      if (k.length === 1) return `where ${qi(names[k[0]])} in (${res.rows.map((r) => lit(r[k[0]])).join(", ")})\n`;
      return "where " + res.rows.map((r) => `(${k.map((i) => (r[i] === null ? `${qi(names[i])} is null` : `${qi(names[i])} = ${lit(r[i])}`)).join(" and ")})`).join("\n   or ") + "\n";
    }
    case "html":
      return `<table>\n  <thead>\n    <tr>\n${names.map((n) => `      <th>${xml(n)}</th>\n`).join("")}    </tr>\n  </thead>\n  <tbody>\n${res.rows.map((r) => `    <tr>\n${r.map((v) => `      <td>${xml(txt(v))}</td>\n`).join("")}    </tr>\n`).join("")}  </tbody>\n</table>\n`;
    case "xml":
      return `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n${res.rows.map((r) => `  <row>\n${r.map((v, i) => (v === null ? `    <${names[i]} null="true"/>\n` : `    <${names[i]}>${xml(txt(v))}</${names[i]}>\n`)).join("")}  </row>\n`).join("")}</result>\n`;
    case "pretty": {
      const all = [names, ...res.rows.map((r) => r.map(txt))];
      const w = names.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
      const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join(" | ").trimEnd();
      return [line(all[0]), w.map((n) => "-".repeat(n)).join("-+-"), ...all.slice(1).map(line)].join("\n") + "\n";
    }
    case "markdown": {
      const row = (a: string[]) => `| ${a.map((s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
      return [row(names), row(names.map(() => "---")), ...res.rows.map((r) => row(r.map(txt)))].join("\n") + "\n";
    }
    case "sqlInsert": {
      const cols = names.map((n) => `"${n}"`).join(", ");
      const per = Math.max(1, o.rowsPerInsert);
      const out: string[] = [];
      for (let i = 0; i < res.rows.length; i += per)
        out.push(`INSERT INTO ${tbl} (${cols}) VALUES ${res.rows.slice(i, i + per).map((r) => `(${r.map(lit).join(", ")})`).join(", ")};`);
      return out.join("\n") + "\n";
    }
  }
}

function queryRows(sql: string): ResultSet {
  const q = parseSelect(sql);
  if (!q.table) {
    if (q.unknown) fail(M.oracle ? "ORA-00942: table or view does not exist" : `[42P01] ERROR: relation "${q.unknown.name}" does not exist`);
    return { columns: [{ name: "?column?", typeName: "int4", nullable: true, isPk: false, tableRef: null }], rows: [[1]], hasMore: false, totalHint: null };
  }
  const t = q.table.def;
  let rows = applyOrder(t, applyWhere(t, allRows(t), q.where), q.order);
  if (q.offset) rows = rows.slice(q.offset);
  if (q.limit != null) rows = rows.slice(0, q.limit);
  return { columns: colMeta(t, q.table.ref), rows, hasMore: false, totalHint: null };
}

// ---------------------------------------------------------------- consoles / ui state

const consoleKey = (id: string) => `consoles:${id}`;
const loadConsoles = (id: string) => loadJson<Record<string, string>>(consoleKey(id), {});
const natural = (a: string, b: string) => {
  const na = a === "console" ? 0 : Number(/_(\d+)$/.exec(a)?.[1] ?? Infinity);
  const nb = b === "console" ? 0 : Number(/_(\d+)$/.exec(b)?.[1] ?? Infinity);
  return na === nb ? a.localeCompare(b) : na - nb;
};

// ---------------------------------------------------------------- files (virtual file system in localStorage)

interface MockFile {
  text: string;
  mtimeMs: number;
}
interface MockFs {
  files: Record<string, MockFile>;
  /** Paths approved by the "dialogs" and attached folders, like the backend's file-access.json. */
  opened: string[];
  folders: string[];
}
const MOCK_SCRATCHES = "/mock/scratches";
const MOCK_OPEN_FILE = "/mock/queries/report.sql";
const MOCK_FOLDER = "/mock/projects/shop";
const loadFs = (): MockFs => loadJson<MockFs>("fs", { files: {}, opened: [], folders: [] });
const saveFs = (f: MockFs) => saveJson("fs", f);
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const fileInfo = (path: string, f?: MockFile) => ({ path, name: baseName(path), isDir: !f, size: f ? utf8Len(f.text) : 0, mtimeMs: f?.mtimeMs ?? 0 });
const fsAllowed = (f: MockFs, p: string) => p.startsWith(MOCK_SCRATCHES + "/") || f.opened.includes(p) || f.folders.some((d) => p.startsWith(d + "/") || p === d);
const fsFile = (f: MockFs, p: string): MockFile => {
  if (!fsAllowed(f, p)) fail(`Refusing to access ${p}: files must be opened with the Open dialog, attached as a folder, or live in the scratches folder`);
  return f.files[p] ?? fail(`Cannot open ${p}: No such file or directory (os error 2)`);
};
const scratchOrder = (n: string) => {
  const stem = n.replace(/\.[^.]*$/, "");
  return stem === "scratch" ? 0 : Number(/^scratch_(\d+)$/.exec(stem)?.[1] ?? Infinity);
};

// ---------------------------------------------------------------- handlers

const toView = (cfg: Partial<DataSourceConfig>, prev?: DataSource): DataSource => {
  const { password, ...rest } = cfg;
  const driver: Driver = (rest.driver ?? prev?.driver ?? "postgres") as Driver;
  return {
    id: rest.id ?? prev?.id ?? uuid(),
    name: rest.name ?? prev?.name ?? "Unnamed",
    driver,
    host: rest.host ?? prev?.host ?? "localhost",
    port: rest.port ?? prev?.port ?? (driver === "mysql" ? 3306 : driver === "oracle" ? 1521 : 5432),
    database: rest.database ?? prev?.database ?? "",
    user: rest.user ?? prev?.user ?? "",
    file: rest.file ?? prev?.file ?? "",
    urlOverride: rest.urlOverride ?? prev?.urlOverride ?? null,
    options: rest.options ?? prev?.options ?? {},
    color: rest.color ?? prev?.color ?? null,
    readOnly: rest.readOnly ?? prev?.readOnly ?? false,
    hasPassword: password == null ? (prev?.hasPassword ?? false) : password !== "",
    passwordStorage: prev?.passwordStorage ?? "keyring",
  };
};

type A = Record<string, any>;
// ---------------------------------------------------------------- import sample

const MOCK_IMPORT_PATH = "/mock/import-sample.csv";
/** A 1 x 1 PNG, for the value viewer's file load in the browser. */
const MOCK_VALUE_PATH = "/mock/value.png";
const MOCK_VALUE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MOCK_IMPORT_CSV = "id,name,price,in_stock\n1,Widget,9.99,true\n2,Gadget,24.50,false\n3,Doohickey,3.25,true\n";
const mockImports = new Map<string, { cancelled: boolean }>();
const mockDumps = new Map<string, { cancelled: boolean }>();
const mockScripts = new Map<string, { cancelled: boolean }>();

/** Minimal delimited-text parser for the mock (quotes, doubled quotes, line breaks inside quotes). */
function mockParseImport(f: ImportFormat): { rows: (string | null)[][] } {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let cur = "";
  let quoted = false;
  let inQ = false;
  const text = MOCK_IMPORT_CSV;
  const endField = () => {
    const v = f.trim ? cur.trim() : cur;
    row.push(!quoted && v === f.nullText ? null : v);
    cur = "";
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === f.quote && text[i + 1] === f.quote) (cur += ch), i++;
      else if (ch === f.quote) inQ = false;
      else cur += ch;
    } else if (f.quote && ch === f.quote && cur === "") (inQ = true), (quoted = true);
    else if (ch === f.delimiter) endField();
    else if (ch === "\n") {
      endField();
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  return { rows };
}

function mockImportPreview(f: ImportFormat, limit: number): ImportPreview {
  let { rows } = mockParseImport(f);
  if (f.firstColumnHeader) rows = rows.map((r) => r.slice(1));
  const names = f.header ? rows[0].map((n, i) => (n || `column${i + 1}`).trim()) : (rows[0] ?? []).map((_, i) => `column${i + 1}`);
  const body = rows.slice(f.header ? 1 : 0);
  const infer = (col: number): ImportPreview["columns"][number]["inferredType"] => {
    const vs = body.map((r) => r[col]).filter((v): v is string => !!v?.trim());
    if (!vs.length) return "text";
    if (vs.every((v) => /^(true|false)$/i.test(v))) return "boolean";
    if (vs.every((v) => /^-?(0|[1-9]\d*)$/.test(v))) return vs.some((v) => Math.abs(Number(v)) > 2147483647) ? "bigint" : "integer";
    if (vs.every((v) => /^-?(0|[1-9]\d*)?\.?\d+([eE][-+]?\d+)?$/.test(v))) return "double";
    if (vs.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return "date";
    if (vs.every((v) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v))) return "timestamp";
    return "text";
  };
  return {
    columns: names.map((name, i) => ({ name, inferredType: infer(i) })),
    rows: body.slice(0, limit).map((r) => names.map((_, i) => r[i] ?? null)),
    sampled: body.length,
    truncated: false,
    fileSize: MOCK_IMPORT_CSV.length,
  };
}

const h = (f: (a: A) => unknown | Promise<unknown>): MockHandler => (args) => f((args ?? {}) as A);

export const mockHandlers: Record<string, MockHandler> = {
  app_info: h(() => ({
    name: "Prometeo DataGrip (browser mock)",
    version: "0.0.0",
    configDir: null,
    dataDir: null,
    passwordStorage: "keyring",
  })),

  // ---- data sources
  list_data_sources: h(() => structuredClone(state.sources)),
  save_data_source: h((a) => {
    const cfg = a.ds as Partial<DataSourceConfig> & { name: string };
    const prev = cfg.id ? state.sources.find((s) => s.id === cfg.id) : undefined;
    const view = toView(cfg, prev);
    if (prev) state.sources[state.sources.indexOf(prev)] = view;
    else state.sources.push(view);
    if (prev && state.connected.has(view.id)) mockHandlers.disconnect({ id: view.id });
    persistSources();
    return structuredClone(view);
  }),
  delete_data_source: h(async (a) => {
    await mockHandlers.disconnect({ id: a.id });
    state.sources = state.sources.filter((s) => s.id !== a.id);
    ls.remove(P + consoleKey(a.id));
    persistSources();
  }),
  copy_data_source_password: h((a) => {
    const to = ds(a.to);
    const from = ds(a.from);
    to.hasPassword = from.hasPassword;
    persistSources();
    return to;
  }),
  duplicate_data_source: h((a) => {
    const src = ds(a.id);
    let name = `${src.name} 1`;
    for (let i = 2; state.sources.some((s) => s.name === name); i++) name = `${src.name} ${i}`;
    const copy = { ...structuredClone(src), id: uuid(), name };
    state.sources.push(copy);
    persistSources();
    return copy;
  }),
  test_connection: h(async (a) => {
    const cfg = a.ds as Partial<DataSourceConfig>;
    await sleep(350);
    if ((cfg.host ?? "localhost") !== "localhost" && cfg.host !== "127.0.0.1" && cfg.driver !== "sqlite")
      return { ok: false, serverVersion: null, message: `failed to lookup address information: Name or service not known (${cfg.host})`, elapsedMs: 350 };
    if (cfg.password === "wrong" && cfg.driver === "oracle")
      return { ok: false, serverVersion: null, message: "ORA-01017: invalid credential or not authorized; logon denied", elapsedMs: 351 };
    if (cfg.password === "wrong")
      return { ok: false, serverVersion: null, message: `[28P01] FATAL: password authentication failed for user "${cfg.user ?? "postgres"}"`, elapsedMs: 351 };
    const version = cfg.driver === "oracle" ? ORACLE_VERSION : SERVER_VERSION;
    return { ok: true, serverVersion: version, message: `Succeeded. ${version}`, elapsedMs: 38, ssl: cfg.driver === "sqlite" ? null : false };
  }),
  connect: h(async (a) => {
    ds(a.id);
    await sleep(250);
    state.connected.add(a.id);
    return { serverVersion: ds(a.id).driver === "oracle" ? ORACLE_VERSION : SERVER_VERSION };
  }),
  disconnect: h((a) => {
    state.connected.delete(a.id);
    for (const [sid, s] of state.sessions) if (s.ds === a.id) state.sessions.delete(sid);
  }),
  connected_data_sources: h(() => [...state.connected]),

  // ---- sessions
  open_session: h((a) => {
    needConn(a.dsId);
    const id = uuid();
    state.sessions.set(id, { ds: a.dsId, tx: false, running: null });
    return id;
  }),
  close_session: h((a) => {
    state.sessions.delete(a.sessionId);
  }),
  session_in_transaction: h((a) => (state.sessions.get(a.sessionId) ?? fail(`Session '${a.sessionId}' does not exist`)).tx),
  session_tx_status: h((a) => ((state.sessions.get(a.sessionId) ?? fail(`Session '${a.sessionId}' does not exist`)).tx ? "active" : "idle")),
  session_state: h((a) => {
    const tx = (state.sessions.get(a.sessionId) ?? fail(`Session '${a.sessionId}' does not exist`)).tx;
    return { txStatus: tx ? "active" : "idle", inTransaction: tx, connectionLost: false, transactionLost: false };
  }),

  // ---- introspection
  introspect: h(async (a) => {
    needConn(a.dsId);
    useDs(a.dsId);
    await sleep(40 + Math.random() * 80);
    return introspect(a.dsId, a.path, !!a.showSystem);
  }),
  get_ddl: h(async (a) => {
    needConn(a.dsId);
    useDs(a.dsId);
    await sleep(60);
    const o = a.object as ObjectRef;
    const sc = o.schema ?? M.defaultSchema;
    if (M.oracle) return oracleDdl(sc, o, !!a.unqualified);
    switch (o.kind) {
      case "table":
      case "view":
      case "materializedView":
      {
        const ddl = tableDdl(sc, findTable(sc, o.name) ?? fail(`Table ${sc}.${o.name} not found`));
        // the DDL view writes the object's own schema unqualified (the backend's `unqualified` flag)
        return a.unqualified ? ddl.split(`${sc}.`).join("") : ddl;
      }
      case "sequence":
        return `-- auto-generated definition\ncreate sequence ${sc}.${o.name}\n    as bigint\n    start with 1000\n    increment by 5\n    minvalue 1\n    maxvalue 9223372036854775807\n    cache 1;\n\nalter sequence ${sc}.${o.name} owner to postgres;`;
      case "function":
      case "procedure":
        return `CREATE OR REPLACE ${o.kind === "procedure" ? "PROCEDURE" : "FUNCTION"} ${sc}.${o.name}(${o.signature ?? ""})\n LANGUAGE sql\nAS $function$\n    select 1;\n$function$;`;
      case "index": {
        const t = findTable(sc, o.table ?? "");
        const i = t?.indexes?.find((x) => x.name === o.name);
        return t && i ? indexDdl(sc, t, i) + ";" : fail(`Index ${o.name} not found`);
      }
      case "column": {
        const col = findTable(sc, o.table ?? "")?.cols.find((x) => x.name === o.name) ?? fail(`Column ${o.name} not found`);
        return `alter table ${sc}.${o.table}\n    add ${col.name} ${col.type}${col.def ? ` default ${col.def}` : ""}${col.nullable ? "" : " not null"};`;
      }
      default:
        return `-- DDL of ${o.kind} ${o.name}`;
    }
  }),
  find_usages: h(async (a) => {
    needConn(a.dsId);
    useDs(a.dsId);
    await sleep(120);
    const o = a.objectRef as ObjectRef;
    const sc = o.schema ?? M.defaultSchema;
    // foreign keys only: the mock has no view or routine text to search
    const out: Usage[] = [];
    for (const [s, sch] of Object.entries(M.schemas))
      for (const t of sch.tables)
        for (const f of t.fks ?? []) {
          const onObject = o.kind === "column" ? (t.name === o.table && f.cols.includes(o.name)) || (f.refTable === o.table && f.refCols.includes(o.name)) : o.kind === "table" && f.refTable === o.name;
          if (s !== sc || !onObject) continue;
          out.push({ schema: s, name: t.name, kind: "foreignKey", detail: `${f.name} (${f.cols.join(", ")}) references ${f.refTable} (${f.refCols.join(", ")})`, line: null, table: t.name });
        }
    return out;
  }),
  schema_snapshot: h(async (a) => {
    needConn(a.dsId);
    useDs(a.dsId);
    await sleep(80);
    const out: SnapshotObject[] = [];
    for (const [sc, s] of Object.entries(M.schemas)) {
      if (s.system || (a.schema && a.schema !== sc)) continue;
      for (const t of s.tables)
        out.push({
          schema: sc,
          name: t.name,
          kind: t.kind,
          columns: t.cols.map((x) => ({ name: x.name, typeName: x.wire, isPk: !!x.pk })),
          foreignKeys: (t.fks ?? []).map((f) => ({ name: f.name, columns: f.cols, refSchema: sc, refTable: f.refTable, refColumns: f.refCols })),
        });
    }
    return out;
  }),

  // ---- schema compare: the model of the mock schema (columns, keys, checks, foreign keys, indexes, views)
  schema_model: h(async (a) => {
    needConn(a.dsId);
    useDs(a.dsId);
    await sleep(120);
    const sc = String(a.schema);
    const s = M.schemas[sc] ?? fail(`schema ${sc} does not exist`);
    const tables = s.tables
      .filter((t) => t.kind === "table")
      .map((t) => {
        const pk = t.cols.filter((c) => c.pk).map((c) => c.name);
        return {
          name: t.name,
          columns: t.cols.map((c, i) => ({
            name: c.name,
            position: i + 1,
            dataType: c.type,
            nullable: c.nullable ?? !c.pk,
            default: c.def ?? null,
            extra: c.identity ? "identity by default" : null,
          })),
          primaryKey: pk.length ? { name: `${t.name}_pkey`, columns: pk } : null,
          unique: (t.uniques ?? []).map((u) => ({ name: u.name, columns: u.cols })),
          checks: (t.checks ?? []).map((c) => ({ name: c.name, expression: c.def })),
          foreignKeys: (t.fks ?? []).map((f) => ({ name: f.name, columns: f.cols, refSchema: null, refTable: f.refTable, refColumns: f.refCols, onDelete: "NO ACTION" })),
          indexes: (t.indexes ?? [])
            .filter((i) => !i.primary)
            .map((i) => ({ name: i.name, columns: i.cols.split(",").map((c) => c.trim()), unique: !!i.unique, method: "btree", predicate: i.where ?? null })),
        };
      });
    const views = s.tables
      .filter((t) => t.kind !== "table")
      .map((v) => ({ name: v.name, definition: `select * from ${v.name}`, materialized: v.kind === "materializedView" }));
    return {
      driver: M.oracle ? "oracle" : "postgres",
      schema: sc,
      namePrefix: null,
      tables,
      views,
      sequences: [],
      routines: [],
    } satisfies SchemaModel;
  }),

  // ---- execution
  execute: h(async (a) => {
    const sess = state.sessions.get(a.sessionId) ?? fail(`Session '${a.sessionId}' does not exist`);
    if (sess.running) fail("The session is busy executing another statement");
    if (sess.ds && !state.connected.has(sess.ds)) fail(`Data source '${sess.ds}' is not connected`);
    // a previous result held open for paging is released
    for (const [id, e] of state.execs) if (e.sessionId === a.sessionId) state.execs.delete(id);
    const execId = uuid();
    state.execs.set(execId, { cancelled: false, sessionId: a.sessionId });
    sess.running = execId;
    const sink = a.onEvent as Sink;
    const opts: ExecOptions = { maxRows: 500, stopOnError: true, keepOpenSecs: 120, ...(a.options ?? {}) };
    // events arrive after the invoke promise resolved, like with a real Channel
    setTimeout(() => {
      runExecution(execId, a.sessionId, a.sql, opts, (e) => sink?.onmessage?.(e)).finally(() => {
        sess.running = null;
      });
    }, 0);
    return execId;
  }),
  fetch_more: h(async (a) => {
    const ex = state.execs.get(a.executionId) ?? fail(`Execution '${a.executionId}' does not exist or has finished`);
    const t = ex.table ?? fail(`Execution '${a.executionId}' has no open result set`);
    if (t.resultIndex !== a.resultIndex) fail(`result ${a.resultIndex} is closed (only result ${t.resultIndex} can be paged)`);
    await sleep(40 + Math.min(150, a.count / 10));
    const rows = t.rows.slice(t.offset, t.offset + Math.max(1, a.count));
    t.offset += rows.length;
    const hasMore = t.offset < t.rows.length;
    if (!hasMore) ex.table = undefined;
    return { rows, hasMore };
  }),
  cancel: h((a) => {
    const ex = state.execs.get(a.executionId);
    if (ex) {
      ex.cancelled = true;
      ex.table = undefined;
    }
  }),
  close_execution: h((a) => {
    const ex = state.execs.get(a.executionId);
    if (ex) ex.table = undefined;
  }),
  explain_plan: h(async (a): Promise<ExplainPlan> => {
    const sess = state.sessions.get(a.sessionId) ?? fail(`Session '${a.sessionId}' does not exist`);
    const driver = ds(sess.ds).driver;
    useDs(sess.ds);
    if (a.analyze && (driver === "sqlite" || driver === "oracle")) fail("SQLite has no EXPLAIN ANALYZE");
    const sql = String(a.sql).trim().replace(/;+$/, "");
    if (!sql) fail("There is no statement to explain");
    await sleep(60);
    const q = parseSelect(sql);
    if (q.unknown) fail(M.oracle ? "ORA-00942: table or view does not exist" : `[42P01] ERROR: relation "${q.unknown.name}" does not exist`);
    const table = q.table?.def.name ?? "orders";
    const node = (operation: string, params: string, rows: number | null, total: number | null, startup: number | null, children: PlanNode[] = []): PlanNode => ({
      operation,
      params,
      rows,
      totalCost: total,
      startupCost: startup,
      raw: "Parallel Aware = false;Async Capable = false",
      props: [
        { name: "Operation", value: operation },
        { name: "Parallel Aware", value: "false" },
        { name: "Async Capable", value: "false" },
      ],
      children,
    });
    if (driver === "oracle") {
      const full = node("TABLE ACCESS FULL", `object: ${M.defaultSchema}.${table};`, 14, 3, null);
      full.props = [{ name: "Operation", value: "TABLE ACCESS" }, { name: "Options", value: "FULL" }, { name: "Cost", value: "3" }];
      const stmt = node("SELECT STATEMENT", "", 14, 3, null, [full]);
      stmt.props = [{ name: "Operation", value: "SELECT STATEMENT" }, { name: "Optimizer", value: "ALL_ROWS" }];
      return { driver, analyze: false, sql, root: stmt, elapsedMs: 3 };
    }
    const scan = node(driver === "sqlite" ? "Full Scan (SCAN)" : "Full Scan (Seq Scan)", `table: ${table};`, driver === "sqlite" ? null : 1020, driver === "sqlite" ? null : 20.2, driver === "sqlite" ? null : 0);
    const root = node("Select", "", null, null, null, [scan]);
    root.props = [{ name: "Operation", value: "select" }, ...(a.analyze ? [{ name: "Execution Time", value: "0.412 ms" }] : [])];
    return { driver, analyze: !!a.analyze, sql, root, elapsedMs: 3 };
  }),
  cancel_session: h(() => undefined),

  // ---- table data / editing
  table_data: h(async (a): Promise<ResultSet> => {
    needConn(a.dsId);
    useDs(a.dsId);
    const o = a.table as ObjectRef;
    const sc = o.schema ?? M.defaultSchema;
    const t = findTable(sc, o.name) ?? fail(M.oracle ? "ORA-00942: table or view does not exist" : `[42P01] ERROR: relation "${sc}.${o.name}" does not exist`);
    const req = (a.request ?? {}) as TableDataRequest;
    await sleep(60 + Math.random() * 60);
    const limit = req.limit || 500;
    const offset = req.offset ?? 0;
    const filtered = applyOrder(t, applyWhere(t, allRows(t), req.whereClause), req.orderBy);
    const page = filtered.slice(offset, offset + limit);
    return {
      columns: colMeta(t, `${sc}.${t.name}`),
      rows: page,
      hasMore: offset + limit < filtered.length,
      totalHint: req.countTotal ? applyWhere(t, allRows(t), req.whereClause).length : null,
    };
  }),
  apply_changes: h(async (a): Promise<ApplyResult> => {
    needConn(a.dsId);
    useDs(a.dsId);
    const o = a.table as ObjectRef;
    const t = findTable(o.schema ?? M.defaultSchema, o.name) ?? fail(`Table ${o.name} not found`);
    if (t.kind !== "table") fail(`Cannot edit ${t.kind} "${t.name}"`);
    await sleep(80);
    const rows = allRows(t);
    const work = rows.map((r) => [...r]);
    const results: ApplyResult["results"] = [];
    const changes = a.changes as RowChange[];
    const findIdx = (key: Record<string, Cell>) => {
      const ks = Object.entries(key);
      return work.findIndex((r) => ks.every(([k, v]) => cmp(r[colIdx(t, k)], v) === 0));
    };
    for (let i = 0; i < changes.length; i++) {
      const ch = changes[i];
      const fail1 = (msg: string): ApplyResult => {
        results.push({ index: i, rowsAffected: 0, error: msg });
        return { applied: 0, committed: false, results };
      };
      for (const col of Object.keys({ ...ch.key, ...ch.values }))
        if (!t.cols.some((x) => x.name === col)) return fail1(`[42703] ERROR: column "${col}" of relation "${t.name}" does not exist`);
      if (ch.kind === "insert") {
        work.push(t.cols.map((col) => {
          const v = ch.values?.[col.name];
          return v === undefined || (v && typeof v === "object" && "$default" in v) ? (col.pk ? work.length + 1 : null) : v;
        }));
        results.push({ index: i, rowsAffected: 1, error: null });
        continue;
      }
      const at = findIdx(ch.key ?? {});
      if (at < 0) return fail1("The row was changed or deleted by someone else (0 rows matched)");
      if (ch.kind === "delete") work.splice(at, 1);
      else for (const [k, v] of Object.entries(ch.values ?? {})) work[at][colIdx(t, k)] = v;
      results.push({ index: i, rowsAffected: 1, error: null });
    }
    rowCache.set(t, work);
    t.rows = work.length;
    return { applied: changes.length, committed: true, results };
  }),

  // ---- export (no file system in a browser: files are only counted)
  choose_export_path: h((a) => `/mock/${(a.suggestedName as string | null) ?? "export.csv"}`),
  default_export_path: h((a) => `/home/mock/${a.fileName as string}`),
  approve_export_path: h((a) =>
    !/\/\./.test(a.path as string) && (a.path as string).startsWith("/home/mock/")
      ? null
      : "Only folders below your home folder (/home/mock) are accepted here.",
  ),
  export_query: h(async (a) => {
    needConn(a.dsId);
    await sleep(100);
    console.info(`[mock] export_query to ${a.path} (not written in a browser)`);
    return { rows: queryRows(a.sql).rows.length, unmappable: 0 };
  }),
  export_query_to_string: h((a) => {
    needConn(a.dsId);
    return exportText(queryRows(a.sql), a.options);
  }),
  export_result: h((a) => {
    console.info(`[mock] export_result to ${a.path} (not written in a browser)`);
    return { rows: (a.result as ResultSet).rows.length, unmappable: 0 };
  }),
  cancel_export: h(() => undefined),
  export_to_string: h((a) => exportText(a.result, a.options)),

  // ---- import (a browser has no file system: one built-in sample file)
  // ---- cell values (a browser has no database files: one fixed value, one fixed file)
  fetch_cell: h(async (a) => {
    await sleep(40);
    // the viewer loads whole values of binary cells only: the mock answers with bytes
    const text = `full value of ${String(a.column)} (browser mock)`;
    return { kind: "binary", base64: btoa(text), len: text.length, truncated: false };
  }),
  choose_value_save_path: h(() => "/mock/value.bin"),
  write_value_file: h(() => undefined),
  choose_value_file: h(() => ({ path: MOCK_VALUE_PATH, name: "value.png", size: atob(MOCK_VALUE_PNG_BASE64).length })),
  read_value_file: h((a) => {
    if (a.path !== MOCK_VALUE_PATH) fail(`Refusing to read ${a.path}: value files must be chosen in the open dialog (choose_value_file)`);
    return MOCK_VALUE_PNG_BASE64;
  }),
  choose_import_file: h(() => ({ path: MOCK_IMPORT_PATH, name: "import-sample.csv", size: MOCK_IMPORT_CSV.length, defaultErrorFile: "/mock/import-sample_errors.txt" })),
  import_preview: h(async (a) => {
    await sleep(60);
    if (a.path !== MOCK_IMPORT_PATH) fail(`Refusing to read ${a.path}: import files must be chosen in the open dialog (choose_import_file)`);
    return mockImportPreview(a.format as ImportFormat, (a.limit as number | undefined) ?? 10);
  }),
  import_file: h(async (a) => {
    needConn(a.dsId);
    useDs(a.dsId);
    const req = a.request as ImportRequest;
    const sink = a.onProgress as { onmessage?: (p: ImportProgress) => void } | undefined;
    const token = { cancelled: false };
    mockImports.set(a.importId as string, token);
    const { rows } = mockParseImport(req.format);
    const body = rows.slice(req.format.header ? 1 : 0);
    const failed: ImportRowError[] = [];
    let imported = 0;
    const out: Cell[][] = [];
    for (const [i, r] of body.entries()) {
      await sleep(250 / Math.max(1, body.length));
      if (token.cancelled) break;
      const row: Cell[] = [];
      let bad = "";
      for (const c of req.columns) {
        const v = c.source === null ? null : r[c.source + (req.format.firstColumnHeader ? 1 : 0)] ?? null;
        if (v !== null && /int|numeric|double|real/i.test(c.type) && !(v.trim() === "" || !Number.isNaN(Number(v)))) {
          bad = `Column ${c.name}: '${v}' is not a valid number`;
          if (!req.options.insertInconvertibleAsNull) break;
          row.push(null);
          bad = "";
          continue;
        }
        row.push(v === null || (v === "" && !/char|text/i.test(c.type)) ? null : /int|numeric|double|real/i.test(c.type) ? Number(v) : v);
      }
      if (bad) failed.push({ row: i + 2, message: bad });
      else {
        out.push(row);
        imported++;
      }
      sink?.onmessage?.({ rows: imported + failed.length, failed: failed.length, fraction: (i + 1) / body.length });
    }
    mockImports.delete(a.importId as string);
    const rolledBack = token.cancelled || (req.options.abortOnError && failed.length > 0);
    if (!rolledBack && req.createTable) {
      const sc = M.schemas[req.schema ?? M.defaultSchema];
      const t: TableDef = {
        name: req.table,
        kind: "table",
        rows: out.length,
        cols: req.columns.map((x) => c(x.name, x.type, x.type.replace(/\(.*/, ""), { nullable: true })),
      };
      if (sc && !sc.tables.some((x) => x.name === req.table)) {
        sc.tables.push(t);
        rowCache.set(t, out);
      }
    }
    return {
      imported: rolledBack ? 0 : imported,
      failed: failed.length,
      errors: failed.slice(0, 50),
      errorFile: failed.length && req.options.errorFile ? req.options.errorFile : null,
      errorFileError: null,
      cancelled: token.cancelled,
      rolledBack,
      createdTable: !rolledBack && req.createTable,
      elapsedMs: 250,
    } satisfies ImportResult;
  }),
  cancel_import: h((a) => {
    const t = mockImports.get(a.importId as string);
    if (t) t.cancelled = true;
  }),

  // ---- SQL dump (a browser has no file system: the tables are walked and counted, nothing is written)
  dump_schema: h(async (a) => {
    needConn(a.dsId);
    useDs(a.dsId);
    if (!String(a.path).startsWith("/mock/")) fail(`Refusing to write ${a.path}: export targets must be chosen in the save dialog (choose_export_path)`);
    const sc = M.schemas[a.schema as string] ?? fail(`Schema ${a.schema} not found`);
    const sink = a.progress as { onmessage?: (p: DumpProgress) => void } | undefined;
    const token = { cancelled: false };
    mockDumps.set(a.dumpId as string, token);
    const started = Date.now();
    const tables = sc.tables.filter((t) => t.kind === "table");
    let rows = 0;
    let done = 0;
    for (const t of tables) {
      await sleep(120);
      if (token.cancelled) break;
      done++;
      rows += t.rows;
      sink?.onmessage?.({ phase: "tables", tablesDone: done, tablesTotal: tables.length, rows });
    }
    mockDumps.delete(a.dumpId as string);
    return { tables: done, rows, cancelled: token.cancelled, elapsedMs: Date.now() - started } satisfies DumpResult;
  }),
  cancel_dump: h((a) => {
    const t = mockDumps.get(a.dumpId as string);
    if (t) t.cancelled = true;
  }),
  open_dump_folder: h((a) => {
    if (!String(a.path).startsWith("/mock/")) fail(`Refusing to open the folder of ${a.path}: no SQL dump of this session wrote that file`);
  }),

  // ---- SQL script file (a browser runs nothing: the statements of the file are counted and reported as run)
  run_sql_file: h(async (a) => {
    needConn(a.dsId);
    useDs(a.dsId);
    const file = fsFile(loadFs(), a.path as string);
    const sink = a.onProgress as { onmessage?: (p: ScriptProgress) => void } | undefined;
    const token = { cancelled: false };
    mockScripts.set(a.scriptId as string, token);
    const started = Date.now();
    const stmts = toStatements(file.text, ds(a.dsId).driver);
    let done = 0;
    for (const s of stmts) {
      await sleep(40);
      if (token.cancelled) break;
      done++;
      sink?.onmessage?.({ statementsDone: done, bytesDone: Math.min(file.text.length, s.end), bytesTotal: file.text.length });
    }
    mockScripts.delete(a.scriptId as string);
    return {
      ok: done,
      failed: 0,
      firstError: null,
      cancelled: token.cancelled,
      rolledBack: false,
      ddlCommitted: false,
      elapsedMs: Date.now() - started,
    } satisfies ScriptSummary;
  }),
  cancel_script: h((a) => {
    const t = mockScripts.get(a.scriptId as string);
    if (t) t.cancelled = true;
  }),

  // ---- splitter
  split_statements: h((a) => toStatements(a.sql, a.driver)),
  statement_at: h((a) => statementAt(a.sql, a.caretUtf16, a.driver)),

  // ---- history
  history_list: h((a) =>
    [...state.history].reverse().filter((e) => !a.dsId || e.dataSourceId === a.dsId).slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 200)),
  ),
  history_search: h((a) =>
    [...state.history]
      .reverse()
      .filter((e) => (!a.dsId || e.dataSourceId === a.dsId) && e.sql.toLowerCase().includes(String(a.text).toLowerCase()))
      .slice(0, a.limit ?? 200),
  ),
  history_clear: h(() => {
    state.history = [];
    saveJson("history", state.history);
  }),

  // ---- ui state
  get_ui_state: h((a) => loadJson<Record<string, unknown>>("ui-state", {})[a.key] ?? null),
  set_ui_state: h((a) => {
    const all = loadJson<Record<string, unknown>>("ui-state", {});
    all[a.key] = a.value;
    saveJson("ui-state", all);
  }),
  flush_ui_state: h(() => {}),

  // ---- consoles
  list_consoles: h((a) => Object.keys(loadConsoles(a.dsId)).sort(natural)),
  read_console: h((a) => loadConsoles(a.dsId)[a.name] ?? fail(`Console '${a.name}' does not exist`)),
  write_console: h((a) => {
    const all = loadConsoles(a.dsId);
    all[a.name] = a.text;
    saveJson(consoleKey(a.dsId), all);
  }),
  create_console: h((a) => {
    const all = loadConsoles(a.dsId);
    let name = "console";
    for (let i = 1; name in all; i++) name = `console_${i}`;
    all[name] = "";
    saveJson(consoleKey(a.dsId), all);
    return name;
  }),
  delete_console: h((a) => {
    const all = loadConsoles(a.dsId);
    delete all[a.name];
    saveJson(consoleKey(a.dsId), all);
  }),
  rename_console: h((a) => {
    const all = loadConsoles(a.dsId);
    if (!(a.from in all)) fail(`Console '${a.from}' does not exist`);
    if (a.to in all) fail(`Console '${a.to}' already exists`);
    all[a.to] = all[a.from];
    delete all[a.from];
    saveJson(consoleKey(a.dsId), all);
  }),

  // ---- files
  choose_open_files: h(() => {
    const f = loadFs();
    f.files[MOCK_OPEN_FILE] ??= { text: "-- monthly revenue report\nselect date_trunc('month', created_at) as month, sum(total) as revenue\nfrom shop.orders\ngroup by 1\norder by 1;\n", mtimeMs: Date.now() };
    if (!f.opened.includes(MOCK_OPEN_FILE)) f.opened.push(MOCK_OPEN_FILE);
    saveFs(f);
    return [fileInfo(MOCK_OPEN_FILE, f.files[MOCK_OPEN_FILE])];
  }),
  choose_attach_folder: h(() => {
    const f = loadFs();
    const now = Date.now();
    f.files[`${MOCK_FOLDER}/schema.sql`] ??= { text: "create table demo (id int primary key);\n", mtimeMs: now };
    f.files[`${MOCK_FOLDER}/queries/top-customers.sql`] ??= { text: "select * from shop.customers limit 10;\n", mtimeMs: now };
    if (!f.folders.includes(MOCK_FOLDER)) f.folders.push(MOCK_FOLDER);
    saveFs(f);
    return fileInfo(MOCK_FOLDER);
  }),
  detach_file_root: h((a) => {
    const f = loadFs();
    f.opened = f.opened.filter((p) => p !== a.path);
    f.folders = f.folders.filter((p) => p !== a.path);
    saveFs(f);
  }),
  file_roots: h(() => {
    const f = loadFs();
    return { files: f.opened.filter((p) => f.files[p]).map((p) => fileInfo(p, f.files[p])), folders: f.folders.map((p) => fileInfo(p)) };
  }),
  read_file: h((a) => {
    const file = fsFile(loadFs(), a.path as string);
    return { text: file.text, mtimeMs: file.mtimeMs };
  }),
  write_file: h((a) => {
    const f = loadFs();
    const file = fsFile(f, a.path as string);
    if (a.expectedMtimeMs != null && a.expectedMtimeMs !== file.mtimeMs) fail(`${a.path} was changed on disk`);
    file.text = a.text as string;
    file.mtimeMs = Date.now();
    saveFs(f);
    return file.mtimeMs;
  }),
  list_dir: h((a) => {
    const f = loadFs();
    const dir = (a.path as string).replace(/\/$/, "");
    if (!fsAllowed(f, dir)) fail(`Refusing to access ${dir}: files must be opened with the Open dialog, attached as a folder, or live in the scratches folder`);
    const dirs = new Set<string>();
    const out: ReturnType<typeof fileInfo>[] = [];
    for (const [p, file] of Object.entries(f.files)) {
      if (!p.startsWith(dir + "/")) continue;
      const rest = p.slice(dir.length + 1);
      const slash = rest.indexOf("/");
      if (slash < 0) out.push(fileInfo(p, file));
      else dirs.add(rest.slice(0, slash));
    }
    out.sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
    return [...[...dirs].sort().map((d) => fileInfo(`${dir}/${d}`)), ...out];
  }),
  list_scratches: h(() => {
    const f = loadFs();
    return Object.entries(f.files)
      .filter(([p]) => p.startsWith(MOCK_SCRATCHES + "/"))
      .map(([p, file]) => fileInfo(p, file))
      .sort((x, y) => scratchOrder(x.name) - scratchOrder(y.name) || x.name.localeCompare(y.name));
  }),
  create_scratch: h(() => {
    const f = loadFs();
    let path = `${MOCK_SCRATCHES}/scratch.sql`;
    for (let i = 1; path in f.files; i++) path = `${MOCK_SCRATCHES}/scratch_${i}.sql`;
    f.files[path] = { text: "", mtimeMs: Date.now() };
    saveFs(f);
    return fileInfo(path, f.files[path]);
  }),
  delete_scratch: h((a) => {
    const f = loadFs();
    if (!(a.path as string).startsWith(MOCK_SCRATCHES + "/")) fail(`${a.path} is not a scratch file`);
    delete f.files[a.path as string];
    saveFs(f);
  }),
  rename_scratch: h((a) => {
    const f = loadFs();
    const from = a.path as string;
    const to = `${MOCK_SCRATCHES}/${a.to}`;
    if (!from.startsWith(MOCK_SCRATCHES + "/") || !f.files[from]) fail(`${from} is not a scratch file`);
    if (!/^[\w .()@-]+$/.test(a.to as string) || (a.to as string).startsWith(".")) fail(`Invalid file name '${a.to}'`);
    if (to in f.files) fail(`'${a.to}' already exists`);
    f.files[to] = f.files[from];
    delete f.files[from];
    saveFs(f);
    return fileInfo(to, f.files[to]);
  }),
};
