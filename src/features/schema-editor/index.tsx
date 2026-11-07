/**
 * Modify Table (Ctrl+F6) and the New > Table / View / Materialized View / Sequence / Schema dialogs.
 * Entry points for the explorer: `modifyObject(node)`, `newTable(node)`, `newObjectOf(kind, node)`.
 */
import { render } from "solid-js/web";
import { type JSX } from "solid-js";
import { notify } from "../../components/ui";
import { ensureConnected, dsOf, nodes, refreshNode } from "../explorer/core";
import { type ENode, TABLE_CHILD, TABLE_LIKE } from "../explorer/model";
import { type EditorCtx, errText, loadTable } from "./load";
import { ObjectEditor } from "./ObjectEditor";
import { type ObjectKind, newObject, type ObjectDef } from "./objects";
import { TableEditor } from "./TableEditor";

let open = false;

/** Mounts a dialog in a root of its own; only one of these dialogs is open at a time. */
function mount(view: (close: () => void) => JSX.Element): void {
  if (open) return;
  open = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(() => view(close), host);
  function close(): void {
    dispose();
    host.remove();
    open = false;
    document.querySelector<HTMLElement>(".dg-explorer-tree")?.focus();
  }
}

const tableAncestor = (n: ENode): ENode | undefined => {
  let x: ENode | undefined = n;
  while (x && !TABLE_LIKE.includes(x.data.kind)) x = x.data.parentId ? nodes.get(x.data.parentId) : undefined;
  return x;
};

/** Where an explorer node lives: its data source, schema and the backend path of the schema. */
export function contextOf(n: ENode | undefined): EditorCtx | undefined {
  if (!n) return undefined;
  const d = n.data;
  const ds = dsOf(d.dsId);
  if (!ds) return undefined;
  const base = { dsId: d.dsId, dsName: ds.name, driver: ds.driver };
  const fromSchema = (schemaPath: string[], schema: string): EditorCtx => ({ ...base, schema, schemaPath });
  if (d.kind === "dataSource" || d.kind === "database") {
    if (ds.driver === "sqlite") return fromSchema(["main"], "main");
    if (ds.driver === "mysql") return fromSchema([ds.database], ds.database);
    return fromSchema([d.kind === "database" ? d.name : ds.database || "postgres", "public"], "public");
  }
  if (d.kind === "schema") return fromSchema(d.path, d.name);
  const t = tableAncestor(n);
  if (t) return fromSchema(t.data.path.slice(0, -2), String(t.data.extra.schema ?? ""));
  if (d.kind === "folder" || d.kind === "sequence" || d.kind === "routine" || d.kind === "function" || d.kind === "procedure") {
    return fromSchema(d.path.slice(0, d.kind === "folder" ? -1 : -2), String(d.extra.schema ?? ""));
  }
  return undefined;
}

const refresh = (ctx: EditorCtx) => () => refreshNode([ctx.dsId, ...ctx.schemaPath]);

async function prepare(ctx: EditorCtx): Promise<boolean> {
  try {
    await ensureConnected(ctx.dsId);
    return true;
  } catch (e) {
    notify({ kind: "error", title: `Connection to ${ctx.dsName} failed`, body: errText(e) });
    return false;
  }
}

/** Ctrl+F6 on a table (or one of its columns / keys / indexes ...) or on a PostgreSQL schema. */
export function canModify(n: ENode | undefined): boolean {
  if (!n || n.data.kind === "loading" || n.data.kind === "error") return false;
  const k = n.data.kind;
  if (k === "schema") return dsOf(n.data.dsId)?.driver === "postgres";
  const t = tableAncestor(n);
  return !!t && t.data.kind === "table" && (k === "table" || TABLE_CHILD.includes(k));
}

const SELECT = { column: "col", primaryKey: "key", uniqueKey: "key", foreignKey: "fk", index: "idx", check: "chk" } as const;

export async function modifyObject(n: ENode | undefined): Promise<void> {
  if (!n || !canModify(n)) return;
  const ctx = contextOf(n);
  if (!ctx || !(await prepare(ctx))) return;
  if (n.data.kind === "schema") {
    const orig: ObjectDef = { ...newObject("schema", "", ctx.driver), name: n.data.name, comment: n.hint ?? "" };
    mount((close) => <ObjectEditor ctx={ctx} initial={orig} orig={orig} onClose={close} onApplied={refresh(ctx)} />);
    return;
  }
  const t = tableAncestor(n)!;
  try {
    const orig = await loadTable(ctx, t.data.name, t.data.extra);
    const kind = (SELECT as Record<string, "col" | "key" | "fk" | "idx" | "chk">)[n.data.kind];
    mount((close) => <TableEditor ctx={ctx} orig={orig} select={kind ? { kind, name: n.data.name } : undefined} onClose={close} onApplied={refresh(ctx)} />);
  } catch (e) {
    notify({ kind: "error", title: "Cannot open the table", body: errText(e) });
  }
}

export async function newTable(n: ENode | undefined): Promise<void> {
  const ctx = contextOf(n);
  if (!ctx || !(await prepare(ctx))) return;
  mount((close) => <TableEditor ctx={ctx} onClose={close} onApplied={refresh(ctx)} />);
}

export async function newObjectOf(kind: ObjectKind, n: ENode | undefined): Promise<void> {
  const ctx = contextOf(n);
  if (!ctx || !(await prepare(ctx))) return;
  const initial = newObject(kind, ctx.schema, ctx.driver);
  // a new schema / database lives next to the others: reload the node above
  const done = kind === "schema" ? () => refreshNode([ctx.dsId, ...ctx.schemaPath.slice(0, -1)]) : refresh(ctx);
  mount((close) => <ObjectEditor ctx={ctx} initial={initial} onClose={close} onApplied={done} />);
}

/** Object types of the New submenu of a node, for its dialect (empty when the node has no schema to create in). */
export function newObjectTypes(n: ENode | undefined): { label: string; kind: "table" | ObjectKind; icon: string }[] {
  const ctx = contextOf(n);
  if (!ctx) return [];
  const out: { label: string; kind: "table" | ObjectKind; icon: string }[] = [{ label: "Table", kind: "table", icon: "dg/table" }];
  if (ctx.driver === "postgres") out.push({ label: "Materialized View", kind: "materializedView", icon: "dg/materialized-view" });
  out.push({ label: "View", kind: "view", icon: "data-schema" });
  if (ctx.driver === "postgres") out.push({ label: "Sequence", kind: "sequence", icon: "dg/sequence" }, { label: "Schema", kind: "schema", icon: "dg/schema" });
  if (ctx.driver === "mysql") out.push({ label: "Database", kind: "schema", icon: "dg/database" });
  return out;
}
