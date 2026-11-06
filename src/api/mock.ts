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

import type { MockHandler } from "./tauri";
import type {
  ApplyResult,
  Cell,
  ColumnMeta,
  DataSource,
  DataSourceConfig,
  Driver,
  ExecEvent,
  ExecOptions,
  ExportOptions,
  HistoryEntry,
  NodeKind,
  ObjectRef,
  ResultSet,
  RowChange,
  SnapshotObject,
  Statement,
  TableDataRequest,
  TreeNode,
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

function toStatements(sql: string): Statement[] {
  return splitRaw(sql).map((r, index) => {
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

function statementAt(sql: string, caret: number): Statement | null {
  const raws = splitRaw(sql);
  if (!raws.length) return null;
  let pick = raws.findIndex((r) => caret >= r.start && caret <= r.full);
  if (pick < 0) {
    const before = raws.filter((r) => r.full <= caret);
    pick = before.length ? raws.indexOf(before[before.length - 1]) : 0;
  }
  return toStatements(sql)[pick] ?? null;
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
const findTable = (schema: string | null | undefined, name: string): TableDef | undefined =>
  SCHEMAS[schema ?? "shop"]?.tables.find((t) => t.name === name);

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

function introspect(ds: string, path: string[], showSystem: boolean): TreeNode[] {
  switch (path.length) {
    case 0:
      return [
        node(ds, "database", DB_NAME, null, [DB_NAME], true, { current: true, encoding: "UTF8" }),
        node(ds, "database", "postgres", null, ["postgres"], false, { current: false, encoding: "UTF8" }),
      ];
    case 1: {
      if (path[0] !== DB_NAME)
        fail(`Database '${path[0]}' is not the one this data source is connected to ('${DB_NAME}'). Create a data source for it.`);
      return Object.entries(SCHEMAS)
        .filter(([, s]) => showSystem || !s.system)
        .map(([name, s]) => node(ds, "schema", name, s.comment ?? null, [...path, name], true, { schema: name, owner: "postgres", system: !!s.system }));
    }
    case 2: {
      const sc = path[1];
      const s = SCHEMAS[sc] ?? fail(`Schema ${sc} not found`);
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
      const s = SCHEMAS[sc] ?? fail(`Schema ${sc} not found`);
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
        return s.sequences.map((q) => node(ds, "sequence", q, null, [...path, q], false, { schema: sc, relkind: "S", rowEstimate: 1 }));
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
  const nm = col.name;
  if (col.nullable && !col.pk && n % 6 === 0) return null;
  switch (col.wire) {
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
  if (t.name === "customers" && nm === "name") return `${FIRST[i % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`;
  if (t.name === "categories" && nm === "name") return ["Electronics", "Books", "Garden", "Laptops", "Phones"][i % 5] + (i >= 5 ? ` ${Math.floor(i / 5)}` : "");
  if (t.name === "products" && nm === "name") return `Product ${n}`;
  if (nm === "name") return `name-${n}`;
  if (nm === "customer") return `${FIRST[i % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`;
  if (nm === "category") return ["Electronics", "Books", "Garden", "Laptops", "Phones"][i % 5];
  if (nm === "table_schema") return "shop";
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
    const idx = t.cols.findIndex((x) => x.name === m[1]);
    if (idx < 0) return fail(`column "${m[1]}" does not exist`);
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
    const idx = t.cols.findIndex((x) => x.name === m[1]);
    if (idx < 0) return fail(`column "${m[1]}" does not exist`);
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

const ds = (id: unknown): DataSource => state.sources.find((s) => s.id === id) ?? fail(`Unknown data source '${String(id)}'`);
const needConn = (id: unknown) => {
  ds(id);
  if (!state.connected.has(id as string)) fail(`Data source '${String(id)}' is not connected`);
};

// ---------------------------------------------------------------- execute

/** `select current_schema()` (PG) / `select database()` (MySQL), the statements the console sends to label its schema switcher. */
function schemaFunction(sql: string): "current_schema" | "database" | null {
  const bare = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").replace(/;\s*$/, "").trim();
  const m = /^select\s+(current_schema|database)\s*\(\s*\)$/i.exec(bare);
  return m ? (m[1].toLowerCase() as "current_schema" | "database") : null;
}

/** The session's schema: what `SET search_path` / `USE` chose, else PG `public`, MySQL the data source's database. */
function currentSchema(sess: { ds: string; schema?: string }): string {
  const d = ds(sess.ds);
  return sess.schema ?? (d.driver === "postgres" ? "public" : d.database);
}

/** `SET search_path TO "x"` / `USE x` of a statement, or null. */
function schemaSwitch(sql: string): string | null {
  const bare = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/;\s*$/, "").trim();
  const m = /^(?:set\s+(?:session\s+|local\s+)?search_path\s*(?:=|to)\s*|use\s+)(?:"((?:[^"]|"")+)"|`((?:[^`]|``)+)`|([\w$]+))(?:\s*,.*)?$/is.exec(bare);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3]).replace(/""|``/g, (q) => q[0]);
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
  count: boolean;
} {
  const flat = sql.replace(/\s+/g, " ").trim();
  const lim = /\blimit\s+(\d+)/i.exec(flat);
  const ord = /\border by (.+?)(?= limit\b| offset\b|$)/i.exec(flat);
  const whr = /\bwhere (.+?)(?= order by\b| limit\b| group by\b|$)/i.exec(flat);
  const from = /\bfrom\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i.exec(sql);
  const sel = /^\s*select\s+(.+?)\s+from\b/is.exec(sql)?.[1]?.trim();
  const out = {
    cols: "*" as string[] | "*",
    where: whr?.[1] ?? null,
    order: ord?.[1] ?? null,
    limit: lim ? Number(lim[1]) : null,
    count: !!sel && /^count\(\s*\*\s*\)(\s+as\s+\w+)?$/i.test(sel),
  } as ReturnType<typeof parseSelect>;
  if (sel && sel !== "*" && !out.count) {
    const parts = sel.split(",").map((p) => p.trim().replace(/^"?(\w+\.)?"?(\w+)"?(\s+as\s+\w+)?$/i, "$2"));
    if (parts.every((p) => /^\w+$/.test(p))) out.cols = parts;
  }
  if (from) {
    const sc = from[1] ?? "shop";
    const def = findTable(sc, from[2]);
    if (def) out.table = { sc, def, ref: `${sc}.${def.name}` };
    else out.unknown = { name: from[1] ? `${from[1]}.${from[2]}` : from[2], offset: sql.indexOf(from[0]) + from[0].lastIndexOf(from[2]) + 1 };
  }
  return out;
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
  const t0 = performance.now();
  let execMs = 0;
  let fetchMs = 0;
  let rowsTotal = 0;
  let firstError: string | null = null;
  const stmts = toStatements(sql);
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
        firstError = `ERROR: relation "${q.unknown.name}" does not exist`;
        send({ kind: "error", index: i, message: `[42P01] ${firstError}`, position: q.unknown.offset, positionUtf16: q.unknown.offset, connectionLost: false });
        if (opts.stopOnError) break;
        continue;
      }
      let columns: ColumnMeta[];
      let rows: Cell[][];
      if (q.table) {
        try {
          const t = q.table.def;
          let r = applyOrder(t, applyWhere(t, allRows(t), q.where), q.order);
          if (q.limit != null) r = r.slice(0, q.limit);
          const idxs = q.cols === "*" ? t.cols.map((_, k) => k) : q.cols.map((n) => t.cols.findIndex((x) => x.name === n));
          if (idxs.some((k) => k < 0)) {
            const bad = (q.cols as string[])[idxs.findIndex((k) => k < 0)];
            throw `[42703] ERROR: column "${bad}" does not exist`;
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
      } else if (schemaFunction(st.text)) {
        const fn = schemaFunction(st.text)!;
        columns = [{ name: fn, typeName: fn === "database" ? "varchar" : "name", nullable: true, isPk: false, tableRef: null }];
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

function exportText(res: Pick<ResultSet, "columns" | "rows">, o: ExportOptions): string {
  const txt = (v: Cell): string =>
    v === null ? o.nullText : typeof v === "object" ? ("$bin" in (v as object) ? "0x" + (v as { $bin: string }).$bin : JSON.stringify(v)) : String(v);
  const names = res.columns.map((x) => x.name);
  const q = (s: string, d: string) => (s.includes(d) || s.includes(o.quote) || /[\r\n]/.test(s) ? o.quote + s.split(o.quote).join(o.quote + o.quote) + o.quote : s);
  switch (o.format) {
    case "csv":
    case "tsv": {
      const d = o.format === "tsv" ? "\t" : o.delimiter ?? ",";
      const lines = res.rows.map((r) => r.map((v) => (o.format === "tsv" ? txt(v).replace(/[\t\r\n]/g, " ") : q(txt(v), d))).join(d));
      return [...(o.header ? [names.join(d)] : []), ...lines].join("\n") + "\n";
    }
    case "json":
      return JSON.stringify(res.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]]))), null, 2) + "\n";
    case "markdown": {
      const row = (a: string[]) => `| ${a.map((s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
      return [row(names), row(names.map(() => "---")), ...res.rows.map((r) => row(r.map(txt)))].join("\n") + "\n";
    }
    case "sqlInsert": {
      const lit = (v: Cell) => (v === null ? "NULL" : typeof v === "number" || typeof v === "boolean" ? String(v) : `'${txt(v).replace(/'/g, "''")}'`);
      const tbl = (o.tableName ?? "table").split(".").map((s) => `"${s}"`).join(".");
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
    if (q.unknown) fail(`[42P01] ERROR: relation "${q.unknown.name}" does not exist`);
    return { columns: [{ name: "?column?", typeName: "int4", nullable: true, isPk: false, tableRef: null }], rows: [[1]], hasMore: false, totalHint: null };
  }
  const t = q.table.def;
  let rows = applyOrder(t, applyWhere(t, allRows(t), q.where), q.order);
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

// ---------------------------------------------------------------- handlers

const toView = (cfg: Partial<DataSourceConfig>, prev?: DataSource): DataSource => {
  const { password, ...rest } = cfg;
  const driver: Driver = (rest.driver ?? prev?.driver ?? "postgres") as Driver;
  return {
    id: rest.id ?? prev?.id ?? uuid(),
    name: rest.name ?? prev?.name ?? "Unnamed",
    driver,
    host: rest.host ?? prev?.host ?? "localhost",
    port: rest.port ?? prev?.port ?? (driver === "mysql" ? 3306 : 5432),
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
    if (cfg.password === "wrong")
      return { ok: false, serverVersion: null, message: `[28P01] FATAL: password authentication failed for user "${cfg.user ?? "postgres"}"`, elapsedMs: 351 };
    return { ok: true, serverVersion: SERVER_VERSION, message: `Succeeded. ${SERVER_VERSION}`, elapsedMs: 38 };
  }),
  connect: h(async (a) => {
    ds(a.id);
    await sleep(250);
    state.connected.add(a.id);
    return { serverVersion: SERVER_VERSION };
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
    await sleep(40 + Math.random() * 80);
    return introspect(a.dsId, a.path, !!a.showSystem);
  }),
  get_ddl: h(async (a) => {
    needConn(a.dsId);
    await sleep(60);
    const o = a.object as ObjectRef;
    const sc = o.schema ?? "shop";
    switch (o.kind) {
      case "table":
      case "view":
      case "materializedView":
        return tableDdl(sc, findTable(sc, o.name) ?? fail(`Table ${sc}.${o.name} not found`));
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
  schema_snapshot: h(async (a) => {
    needConn(a.dsId);
    await sleep(80);
    const out: SnapshotObject[] = [];
    for (const [sc, s] of Object.entries(SCHEMAS)) {
      if (s.system || (a.schema && a.schema !== sc)) continue;
      for (const t of s.tables)
        out.push({ schema: sc, name: t.name, kind: t.kind, columns: t.cols.map((x) => ({ name: x.name, typeName: x.wire, isPk: !!x.pk })) });
    }
    return out;
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

  // ---- table data / editing
  table_data: h(async (a): Promise<ResultSet> => {
    needConn(a.dsId);
    const o = a.table as ObjectRef;
    const sc = o.schema ?? "shop";
    const t = findTable(sc, o.name) ?? fail(`[42P01] ERROR: relation "${sc}.${o.name}" does not exist`);
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
    const o = a.table as ObjectRef;
    const t = findTable(o.schema ?? "shop", o.name) ?? fail(`Table ${o.name} not found`);
    if (t.kind !== "table") fail(`Cannot edit ${t.kind} "${t.name}"`);
    await sleep(80);
    const rows = allRows(t);
    const work = rows.map((r) => [...r]);
    const results: ApplyResult["results"] = [];
    const changes = a.changes as RowChange[];
    const findIdx = (key: Record<string, Cell>) => {
      const ks = Object.entries(key);
      return work.findIndex((r) => ks.every(([k, v]) => cmp(r[t.cols.findIndex((x) => x.name === k)], v) === 0));
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
      else for (const [k, v] of Object.entries(ch.values ?? {})) work[at][t.cols.findIndex((x) => x.name === k)] = v;
      results.push({ index: i, rowsAffected: 1, error: null });
    }
    rowCache.set(t, work);
    t.rows = work.length;
    return { applied: changes.length, committed: true, results };
  }),

  // ---- export (no file system in a browser: files are only counted)
  choose_export_path: h((a) => `/mock/${(a.suggestedName as string | null) ?? "export.csv"}`),
  export_query: h(async (a) => {
    needConn(a.dsId);
    await sleep(100);
    console.info(`[mock] export_query to ${a.path} (not written in a browser)`);
    return queryRows(a.sql).rows.length;
  }),
  export_query_to_string: h((a) => {
    needConn(a.dsId);
    return exportText(queryRows(a.sql), a.options);
  }),
  export_result: h((a) => {
    console.info(`[mock] export_result to ${a.path} (not written in a browser)`);
    return (a.result as ResultSet).rows.length;
  }),
  export_to_string: h((a) => exportText(a.result, a.options)),

  // ---- splitter
  split_statements: h((a) => toStatements(a.sql)),
  statement_at: h((a) => statementAt(a.sql, a.caretUtf16)),

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
};
