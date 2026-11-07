/**
 * What Search Everywhere searches: database objects of the connected data sources (from the schema snapshots,
 * plus routines / sequences / schemas through `introspect`), the data sources themselves, the query consoles and
 * the registered actions. Entries are built once per snapshot and cached; searching never calls the backend.
 */
import { createEffect, createMemo, createRoot, createSignal, untrack } from "solid-js";
import { type DataSource, type NodeKind, type SnapshotObject, type TreeNode, introspect, listConsoles, readConsole } from "../../api/db";
import { MAIN_MENU, GEAR_MENU } from "../../components/shell/menus";
import type { MenuItem } from "../../components/ui";
import * as registry from "../../state/actions";
import { ACTION_IDS } from "../../state/core-actions";
import { isSchemaNameVisible } from "../datasource/schemas";
import { connectedDataSourceIds, explorerDataSources, loadSchemaSnapshot, schemaSnapshotFor } from "../explorer";
import { PAGES, type PageNode } from "../settings/model";
import { type PreparedQuery, type Range, matchName, prepareQuery } from "./match";

export type EntryKind =
  | "dataSource" | "schema" | "table" | "view" | "materializedView" | "routine" | "function" | "procedure" | "sequence" | "column"
  | "index" | "primaryKey" | "uniqueKey" | "foreignKey" | "check" | "trigger"
  | "console" | "action" | "setting" | "text";
export type Group = "db" | "console" | "action" | "text";

/** Kinds that live inside a table (shown as `db.schema.table`), loaded lazily after the snapshot. */
export const TABLE_CHILD_KINDS: readonly EntryKind[] = ["column", "index", "primaryKey", "uniqueKey", "foreignKey", "check", "trigger"];

export interface Entry {
  group: Group;
  kind: EntryKind;
  name: string;
  lower: string;
  dsId?: string;
  schema?: string;
  /** Column / index / key / trigger: its table. */
  table?: string;
  /** Column / index / key / trigger: kind of its table. */
  tableKind?: NodeKind;
  /** Indexes: unique ones get the unique-index icon. */
  unique?: boolean;
  /** Routines: identity arguments as the backend reports them. */
  signature?: string;
  actionId?: string;
  /** Settings options: the Settings page that holds it. */
  pageId?: string;
  /** Slash commands (`/db`): the tab they switch to. */
  goTab?: string;
  /** Text matches: console name and 1-based line. */
  file?: string;
  line?: number;
  /** Actions: gray text at the right (shortcut or menu group). */
  right?: string;
}

const RANK: Record<EntryKind, number> = {
  table: 0,
  view: 1,
  materializedView: 2,
  routine: 3,
  function: 3,
  procedure: 3,
  sequence: 4,
  index: 4,
  primaryKey: 4,
  uniqueKey: 4,
  foreignKey: 4,
  check: 4,
  trigger: 4,
  schema: 5,
  dataSource: 6,
  column: 8,
  console: 0,
  action: 0,
  setting: 1,
  text: 0,
};

const mk = (group: Group, kind: EntryKind, name: string, rest: Partial<Entry> = {}): Entry => ({ group, kind, name, lower: name.toLowerCase(), ...rest });

// ---------------------------------------------------------------- database objects

const snapshotEntries = new WeakMap<SnapshotObject[], Entry[]>();
const columnEntries = new WeakMap<SnapshotObject[], Entry[]>();

function entriesOfSnapshot(dsId: string, snap: SnapshotObject[]): Entry[] {
  let e = snapshotEntries.get(snap);
  if (!e) {
    e = snap.map((o) => mk("db", o.kind as EntryKind, o.name, { dsId, schema: o.schema }));
    snapshotEntries.set(snap, e);
  }
  return e;
}

/** Column entries are built on first use (they are by far the most numerous). */
function entriesOfColumns(dsId: string, snap: SnapshotObject[]): Entry[] {
  let e = columnEntries.get(snap);
  if (!e) {
    e = [];
    for (const o of snap) for (const c of o.columns) e.push(mk("db", "column", c.name, { dsId, schema: o.schema, table: o.name, tableKind: o.kind }));
    columnEntries.set(snap, e);
  }
  return e;
}

interface Extras {
  snap: SnapshotObject[];
  entries: Entry[];
}
const [extras, setExtras] = createSignal<ReadonlyMap<string, Extras>>(new Map());
const inFlight = new Map<string, SnapshotObject[]>();

const ROUTINE_KINDS: NodeKind[] = ["routine", "function", "procedure"];
const TABLE_FOLDERS = ["tables", "views", "materialized_views"];
const TABLE_KINDS_N: NodeKind[] = ["table", "view", "materializedView"];
/** Object folders of a table whose children are indexed (columns come with the snapshot). */
const CHILD_FOLDERS = ["keys", "foreign_keys", "indexes", "checks", "triggers"];
const CHILD_KINDS: NodeKind[] = ["primaryKey", "uniqueKey", "foreignKey", "index", "check", "trigger"];
/** Tables whose keys / indexes / triggers are looked up per data source (a few calls each). */
const MAX_RELATED_TABLES = 300;

interface TableRef {
  node: TreeNode;
  schema: string;
}

/** Routines, sequences, schemas and the tables themselves (for `loadRelated`) of a data source, through the lazy introspection API (a few calls per schema). */
async function loadExtras(ds: DataSource): Promise<{ entries: Entry[]; tables: TableRef[] }> {
  const top = await introspect(ds.id, []);
  let schemas: TreeNode[];
  if (top.some((n) => n.kind === "database")) {
    const db = top.find((n) => n.extra.current) ?? top[0];
    schemas = db ? (await introspect(ds.id, db.path)).filter((n) => n.kind === "schema") : [];
  } else schemas = top.filter((n) => n.kind === "schema");
  const out: Entry[] = [];
  const tables: TableRef[] = [];
  for (const s of schemas) {
    out.push(mk("db", "schema", s.name, { dsId: ds.id, schema: s.name }));
    const folders = (await introspect(ds.id, s.path)).filter((f) => f.kind === "folder" && ["routines", "sequences", ...TABLE_FOLDERS].includes(f.extra.folder));
    for (const f of folders) {
      for (const n of await introspect(ds.id, f.path)) {
        if (n.kind === "sequence") out.push(mk("db", "sequence", n.name, { dsId: ds.id, schema: s.name }));
        else if (ROUTINE_KINDS.includes(n.kind)) out.push(mk("db", n.kind as EntryKind, n.name, { dsId: ds.id, schema: s.name, signature: String(n.extra.signature ?? "") }));
        else if (TABLE_KINDS_N.includes(n.kind)) tables.push({ node: n, schema: s.name });
      }
    }
  }
  return { entries: out, tables };
}

/** Indexes, keys, foreign keys, checks and triggers of the tables, with a few requests running at once. */
async function loadRelated(ds: DataSource, tables: TableRef[], isCurrent: () => boolean): Promise<Entry[]> {
  const out: Entry[] = [];
  const shown = (t: TableRef) => isSchemaNameVisible(ds, t.schema);
  // schemas the explorer shows first: the cap must not be spent on hidden ones
  const queue = [...tables.filter(shown), ...tables.filter((t) => !shown(t))].slice(0, MAX_RELATED_TABLES);
  const one = async (t: TableRef) => {
    const folders = (await introspect(ds.id, t.node.path)).filter((f) => f.kind === "folder" && CHILD_FOLDERS.includes(f.extra.folder) && Number(f.extra.count ?? f.hint ?? 1) !== 0);
    for (const f of folders) {
      for (const n of await introspect(ds.id, f.path)) {
        if (!CHILD_KINDS.includes(n.kind)) continue;
        out.push(mk("db", n.kind as EntryKind, n.name, { dsId: ds.id, schema: t.schema, table: t.node.name, tableKind: t.node.kind, unique: n.kind === "index" && !!n.extra.unique && !n.extra.primary }));
      }
    }
  };
  let next = 0;
  const worker = async () => {
    while (isCurrent() && next < queue.length) {
      try {
        await one(queue[next++]);
      } catch {
        /* a table that cannot be read is skipped */
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

function refreshExtras(ds: DataSource, snap: SnapshotObject[]): void {
  if (extras().get(ds.id)?.snap === snap || inFlight.get(ds.id) === snap) return;
  inFlight.set(ds.id, snap);
  const current = () => inFlight.get(ds.id) === snap;
  void loadExtras(ds)
    .then(async ({ entries, tables }) => {
      if (!current()) return;
      setExtras((m) => new Map(m).set(ds.id, { snap, entries }));
      const related = await loadRelated(ds, tables, current).catch(() => [] as Entry[]);
      if (!current() || !related.length) return;
      setExtras((m) => new Map(m).set(ds.id, { snap, entries: [...entries, ...related] }));
    })
    .catch(() => {})
    .finally(() => {
      if (inFlight.get(ds.id) === snap) inFlight.delete(ds.id);
    });
}

let started = false;
let dbEntries: () => Entry[] = () => [];
let colEntries: () => Entry[] = () => [];

/** Starts the (lazy, once) reactive index: call when the popup opens. */
export function ensureIndex(): void {
  if (started) return;
  started = true;
  createRoot(() => {
    // Keep the extras (routines / sequences / schemas) in step with the snapshots of the connected data sources.
    createEffect(() => {
      const connected = connectedDataSourceIds();
      for (const ds of explorerDataSources()) {
        if (!connected.has(ds.id)) continue;
        const snap = schemaSnapshotFor(ds.id);
        void loadSchemaSnapshot(ds.id).then((loaded) => untrack(() => refreshExtras(ds, loaded)));
        void snap;
      }
    });
    dbEntries = createMemo(() => {
      const connected = connectedDataSourceIds();
      const ex = extras();
      const out: Entry[] = [];
      for (const ds of explorerDataSources()) {
        out.push(mk("db", "dataSource", ds.name, { dsId: ds.id }));
        if (!connected.has(ds.id)) continue;
        const snap = schemaSnapshotFor(ds.id);
        out.push(...entriesOfSnapshot(ds.id, snap));
        const e = ex.get(ds.id);
        if (e) out.push(...e.entries);
        else for (const s of new Set(snap.map((o) => o.schema))) out.push(mk("db", "schema", s, { dsId: ds.id, schema: s }));
      }
      return out;
    });
    colEntries = createMemo(() => {
      const connected = connectedDataSourceIds();
      const out: Entry[] = [];
      for (const ds of explorerDataSources()) if (connected.has(ds.id)) out.push(...entriesOfColumns(ds.id, schemaSnapshotFor(ds.id)));
      return out;
    });
  });
}

export const databaseEntries = (): Entry[] => dbEntries();
export const databaseColumnEntries = (): Entry[] => colEntries();

/** Is the entry in a schema the explorer shows (the schema selector of its data source)? Data sources and entries without a schema always are. */
export function isEntryVisible(e: Entry, ds: DataSource | undefined): boolean {
  if (e.group !== "db" || !ds || !e.schema || e.kind === "dataSource") return true;
  return isSchemaNameVisible(ds, e.schema);
}

// ---------------------------------------------------------------- consoles

const [consoles, setConsoles] = createSignal<Entry[]>([]);
export { consoles as consoleEntries };

/** Re-reads the console names of every data source (cheap, no connection needed). */
export async function reloadConsoles(): Promise<void> {
  const out: Entry[] = [];
  await Promise.all(
    explorerDataSources().map(async (ds) => {
      try {
        for (const n of await listConsoles(ds.id)) out.push(mk("console", "console", n, { dsId: ds.id }));
      } catch {
        /* no consoles */
      }
    }),
  );
  out.sort((a, b) => a.lower.localeCompare(b.lower, undefined, { numeric: true }));
  setConsoles(out);
}

// ---------------------------------------------------------------- text (contents of the consoles)

const MAX_TEXT_LINES = 20000;
const [textLines, setTextLines] = createSignal<Entry[]>([]);
export { textLines as textEntries };

/** Reads every console file (small, local): one entry per non-blank line. */
export async function reloadTextIndex(): Promise<void> {
  const per = await Promise.all(
    explorerDataSources().map(async (ds) => {
      const out: Entry[] = [];
      try {
        for (const name of await listConsoles(ds.id)) {
          let text = "";
          try {
            text = await readConsole(ds.id, name);
          } catch {
            continue;
          }
          text.split(/\r?\n/).forEach((l, i) => {
            const t = l.trim();
            if (t) out.push(mk("text", "text", t, { dsId: ds.id, file: name, line: i + 1, right: `${name}.sql:${i + 1}` }));
          });
        }
      } catch {
        /* no consoles */
      }
      return out;
    }),
  );
  setTextLines(per.flat().slice(0, MAX_TEXT_LINES));
}

/** Lines that contain the text (case-insensitive), with the matched ranges. */
export function searchText(entries: Entry[], text: string, limit: number, dsId?: string | null): Hit[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const out: Hit[] = [];
  for (const e of entries) {
    if (dsId && e.dsId !== dsId) continue;
    const ranges: Range[] = [];
    for (let at = e.lower.indexOf(q); at >= 0; at = e.lower.indexOf(q, at + q.length)) ranges.push([at, at + q.length]);
    if (!ranges.length) continue;
    out.push({ entry: e, ranges, score: 0 });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- settings options

function settingEntries(): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  const walk = (nodes: PageNode[], trail: string[]) => {
    for (const n of nodes) {
      const here = [...trail, n.title];
      const right = "Settings > " + here.join(" > ");
      for (const name of [n.title, ...(n.keywords ?? [])]) {
        const key = n.id + "\u0000" + name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(mk("action", "setting", name, { pageId: n.id, right }));
      }
      if (n.children) walk(n.children, here);
    }
  };
  walk(PAGES, []);
  return out;
}

/** Options of the Settings pages (their labels), found by Search Everywhere / Find Action. */
export const collectSettings = (): Entry[] => settingEntries();

// ---------------------------------------------------------------- actions

function groupsOfActions(): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (items: MenuItem[], group: string) => {
    for (const it of items) {
      if ("action" in it && it.action && !map.has(it.action)) map.set(it.action, group);
      if ("children" in it && it.children) walk(it.children, group);
    }
  };
  for (const m of MAIN_MENU) walk(m.items, m.label);
  walk(GEAR_MENU, "Settings");
  return map;
}

const KNOWN_ACTIONS = [
  ...Object.values(ACTION_IDS),
  "app.exit", "window.minimize", "window.maximize", "window.resetLayout", "help.about", "tab.close", "tab.closeOthers", "tab.closeAll",
  "tab.next", "tab.prev", "toolwindow.hideActive", "toolwindow.hideAll", "toolwindow.explorer", "toolwindow.output", "toolwindow.files", "toolwindow.services", "toolwindow.notifications",
  "notifications.menu", "notifications.expireAll", "notifications.clearAll",
  "theme.system", "theme.dark", "theme.light", "db.properties", "db.disconnect", "db.drop", "db.copyReference", "db.copyName",
  "db.copyDdl", "db.ddlToConsole", "db.duplicateDataSource", "explorer.locate", "explorer.expandAll", "explorer.collapseAll",
  "sql.executeScript", "table.addRow", "table.deleteRows", "table.submit", "table.revert", "table.reload", "table.nextPage",
  "table.prevPage", "table.ddl",
  "edit.undo", "edit.redo", "edit.cut", "edit.copy", "edit.paste", "edit.selectAll", "edit.find", "edit.replace",
  "code.complete", "code.reformat", "code.comment",
];

/** The actions Search Everywhere offers. Uses `listActions()` of the registry when it exists, else the known ids + menus. */
export function collectActions(): Entry[] {
  const groups = groupsOfActions();
  const lister = (registry as Record<string, unknown>)["list" + "Actions"] as (() => registry.Action[]) | undefined;
  const all: registry.Action[] = [];
  const seen = new Set<string>();
  const add = (a: registry.Action | undefined) => {
    if (a && !seen.has(a.id) && a.title) {
      seen.add(a.id);
      all.push(a);
    }
  };
  if (typeof lister === "function") for (const a of lister()) add(registry.getAction(a.id));
  for (const id of [...KNOWN_ACTIONS, ...groups.keys()]) add(registry.getAction(id));
  return all
    .filter((a) => a.id !== ACTION_IDS.searchEverywhere && a.id !== ACTION_IDS.gotoObject)
    .map((a) => {
      const sc = registry.actionShortcut(a);
      return mk("action", "action", a.title.replace(/[…]+$|\.\.\.$/, "").trim(), { actionId: a.id, right: sc ?? groups.get(a.id) });
    });
}

// ---------------------------------------------------------------- searching

export interface Hit {
  entry: Entry;
  ranges: Range[];
  score: number;
}

export interface Query {
  /** Qualifier parts of a dotted query (`sales.inv`): matched against the object's path. */
  quals: PreparedQuery[];
  name: PreparedQuery;
  /** The whole query without dots (non-database entries). */
  whole: PreparedQuery;
}

export function parseQuery(text: string): Query {
  const t = text.trim();
  const parts = t.split(".");
  const last = parts.pop() ?? "";
  return { quals: parts.filter((p) => p.trim()).map(prepareQuery), name: prepareQuery(last), whole: prepareQuery(t) };
}

/** Path segments of a database entry, outermost first (used for dotted queries and the footer). */
export function pathOf(e: Entry, ds: DataSource | undefined): string[] {
  const out: string[] = [];
  if (ds) out.push(ds.name);
  if (ds?.driver === "postgres") out.push(ds.database || "postgres");
  if (e.schema && e.kind !== "schema") out.push(e.schema);
  if (e.table) out.push(e.table);
  return out;
}

export interface SearchOptions {
  limit: number;
  /** Database kinds to leave out. */
  hideKinds?: ReadonlySet<EntryKind>;
  dsId?: string | null;
  dsById: (id: string) => DataSource | undefined;
}

/** Best matches first: tier (exact / prefix / word start / substring), fewer chunks, kind, shorter name, name. */
export function search(entries: Entry[], q: Query, opts: SearchOptions): Hit[] {
  const buckets = new Map<number, Entry[]>();
  const info = new Map<Entry, number>();
  for (const e of entries) {
    if (opts.hideKinds?.has(e.kind)) continue;
    if (opts.dsId && e.dsId !== opts.dsId) continue;
    const pq = e.group === "db" ? q.name : q.whole;
    let score: number;
    if (!pq.raw) {
      if (e.group === "db" && q.quals.length === 0) continue;
      score = 5000;
    } else {
      const r = matchName(e.name, e.lower, pq);
      if (!r) continue;
      score = r.score;
    }
    if (e.group === "db" && q.quals.length) {
      const segs = pathOf(e, e.dsId ? opts.dsById(e.dsId) : undefined);
      let at = 0;
      for (const qq of q.quals) {
        while (at < segs.length && !matchName(segs[at], segs[at].toLowerCase(), qq)) at++;
        if (at++ >= segs.length) {
          score = -1;
          break;
        }
      }
      if (score < 0) continue;
    }
    let b = buckets.get(score);
    if (!b) buckets.set(score, (b = []));
    b.push(e);
    info.set(e, score);
  }
  const out: Hit[] = [];
  for (const score of [...buckets.keys()].sort((a, b) => b - a)) {
    const b = buckets.get(score)!;
    b.sort((x, y) => RANK[x.kind] - RANK[y.kind] || x.name.length - y.name.length || x.lower.localeCompare(y.lower));
    for (const e of b) {
      const pq = e.group === "db" ? q.name : q.whole;
      out.push({ entry: e, score, ranges: pq.raw ? (matchName(e.name, e.lower, pq, true)?.ranges ?? []) : [] });
      if (out.length >= opts.limit) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------- display

/** Routine signature as DataGrip shows it in lists: argument types only, `(integer, text)`. */
export function signatureText(sig: string | undefined): string {
  if (sig == null) return "";
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of sig) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) (args.push(cur), (cur = ""));
    else cur += ch;
  }
  if (cur.trim()) args.push(cur);
  const TYPE_FIRST = new Set(["double", "character", "timestamp", "time", "bit", "national", "interval", "long", "unsigned"]);
  const types = args.map((a) => {
    let t = a.trim().replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, "");
    const sp = t.indexOf(" ");
    if (sp > 0 && !TYPE_FIRST.has(t.slice(0, sp).toLowerCase())) t = t.slice(sp + 1);
    return t;
  });
  return `(${types.join(", ")})`;
}

/** Gray location text after the name: `postgres.sales [postgres@localhost]`. */
export function locationOf(e: Entry, ds: DataSource | undefined): string {
  if (e.group === "console") return `Database Consoles/${ds?.name ?? ""}`;
  if (e.group === "action" || e.group === "text" || e.kind === "dataSource") return "";
  const segs = pathOf(e, ds).slice(1);
  const dsPart = ds ? `[${ds.name}]` : "";
  return [segs.join("."), dsPart].filter(Boolean).join(" ");
}

/** Gray path in the popup footer for a database object: `postgres@localhost/postgres/sales/invoices/invoices_pkey`. */
export function footerPath(e: Entry, ds: DataSource | undefined): string {
  if (e.group === "console") return `Database Consoles/${ds?.name ?? ""}/${e.name}`;
  if (e.group !== "db" || !ds) return "";
  return e.kind === "dataSource" ? ds.name : [...pathOf(e, ds), e.name].join("/");
}
