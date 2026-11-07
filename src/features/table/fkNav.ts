/**
 * Foreign key navigation of grid cells (`Go To > Referenced Row` / `Related Rows`, F4). The keys come from the
 * explorer's introspection (`foreign_keys` folders); the incoming ones are found by reading the folders of the
 * other tables of the schema. Targets open the other table's data editor filtered to the matching rows.
 */
import { createEffect, createSignal, on } from "solid-js";
import { introspect } from "../../api/db";
import type { Driver, ObjectRef } from "../../api/types";
import type { GridNavTarget, GridNavigation } from "../../components/grid/types";
import { openTableTab } from "./commands";
import { dsInfo } from "./ds";
import { literal, quoteIdent } from "./sql";

export interface FkDef {
  name: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
}

export interface IncomingFk extends FkDef {
  /** The table that holds the key. */
  table: string;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function fkOf(n: { name: string; extra: Record<string, unknown> }): FkDef {
  return {
    name: n.name,
    columns: strs(n.extra.columns),
    refSchema: n.extra.refSchema ? String(n.extra.refSchema) : null,
    refTable: String(n.extra.refTable ?? ""),
    refColumns: strs(n.extra.refColumns),
  };
}

/** Explorer path of the schema of a table (`[db, schema]` PostgreSQL, `[schema]` otherwise). */
function schemaPath(driver: Driver, database: string | null | undefined, schema: string): string[] {
  return driver === "postgres" ? [database ?? "", schema] : [schema];
}

/** Outgoing keys of one table. */
export async function loadForeignKeys(dsId: string, driver: Driver, database: string | null | undefined, ref: ObjectRef): Promise<FkDef[]> {
  const nodes = await introspect(dsId, [...schemaPath(driver, database, ref.schema ?? "main"), "tables", ref.name, "foreign_keys"]).catch(() => []);
  return nodes.map(fkOf);
}

/** Keys of the other tables of the schema that point at `ref`. */
export async function loadIncomingKeys(dsId: string, driver: Driver, database: string | null | undefined, ref: ObjectRef): Promise<IncomingFk[]> {
  const schema = ref.schema ?? "main";
  const base = schemaPath(driver, database, schema);
  const tables = await introspect(dsId, [...base, "tables"]).catch(() => []);
  const out: IncomingFk[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tables.length) {
      const t = tables[next++];
      const fks = await introspect(dsId, [...base, "tables", t.name, "foreign_keys"]).catch(() => []);
      for (const f of fks.map(fkOf)) {
        if (f.refTable === ref.name && (f.refSchema ?? schema) === schema) out.push({ ...f, table: t.name });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, tables.length) }, worker));
  return out.sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name));
}

/** `a = 1 and b = 'x'` for the pairs (column of the target, value). */
export function whereOf(driver: Driver, pairs: [string, unknown][]): string {
  return pairs.map(([c, v]) => `${quoteIdent(driver, c)} = ${literal(v as never, "", driver)}`).join(" and ");
}

const cache = new Map<string, { at: number; value: Promise<IncomingFk[]> }>();
const TTL = 60_000;

/**
 * Navigation for the grid of `table()` (null: the result maps to no single table). The keys load in the background
 * when the table changes; `fkColumns` lists the columns that hold a foreign key (for their icon).
 */
export function createFkNavigation(dsIdOf: () => string, table: () => ObjectRef | null) {
  const [outgoing, setOutgoing] = createSignal<FkDef[]>([]);
  const [incoming, setIncoming] = createSignal<IncomingFk[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [fkColumns, setFkColumns] = createSignal<ReadonlySet<string>>(new Set());
  const dsId = () => dsIdOf();
  const ds = () => dsInfo(dsId());

  createEffect(
    on(
      () => [table()?.schema, table()?.name, ds()?.driver] as const,
      async () => {
        const t = table();
        const d = ds();
        setOutgoing([]);
        setIncoming([]);
        setFkColumns(new Set<string>());
        if (!t || !d || t.kind !== "table") return;
        const mine = t;
        const out = await loadForeignKeys(dsId(), d.driver, d.database, mine);
        if (table()?.name !== mine.name) return;
        setOutgoing(out);
        setFkColumns(new Set(out.flatMap((f) => f.columns)));
        const key = `${dsId()}|${mine.schema}|${mine.name}`;
        let hit = cache.get(key);
        if (!hit || Date.now() - hit.at > TTL) {
          hit = { at: Date.now(), value: loadIncomingKeys(dsId(), d.driver, d.database, mine) };
          cache.set(key, hit);
        }
        setLoading(true);
        const rel = await hit.value;
        setLoading(false);
        if (table()?.name === mine.name) setIncoming(rel);
      },
    ),
  );

  const open = (target: ObjectRef, where: string) => void openTableTab(dsId(), target, { where });
  const navigation: GridNavigation = {
    referenced(column) {
      const t = table();
      const driver = ds()?.driver;
      if (!t || !driver) return [];
      return outgoing()
        .filter((f) => f.columns.includes(column))
        .map<GridNavTarget>((f) => ({
          label: `${f.refTable} (${f.refColumns.join(", ")})`,
          enabled: (rec) => f.columns.every((c) => rec[c] !== null && rec[c] !== undefined),
          open: (rec) => open({ schema: f.refSchema ?? t.schema, name: f.refTable, kind: "table" }, whereOf(driver, f.refColumns.map((rc, i) => [rc, rec[f.columns[i]]]))),
        }));
    },
    related(column) {
      const t = table();
      const driver = ds()?.driver;
      if (!t || !driver) return [];
      return incoming()
        .filter((f) => f.refColumns.includes(column))
        .map<GridNavTarget>((f) => ({
          label: `${f.table} (${f.columns.join(", ")})`,
          enabled: (rec) => f.refColumns.every((c) => rec[c] !== null && rec[c] !== undefined),
          open: (rec) => open({ schema: t.schema, name: f.table, kind: "table" }, whereOf(driver, f.columns.map((c, i) => [c, rec[f.refColumns[i]]]))),
        }));
    },
    loading,
  };
  return { navigation, fkColumns };
}
