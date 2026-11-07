/** What Enter / Shift+Enter do with a result. Uses the explorer module API and the tabs store only. */
import type { Driver, NodeKind } from "../../api/db";
import { notify } from "../../components/ui";
import { runAction } from "../../state/actions";
import { isToolWindowVisible } from "../../state/layout";
import { openTab } from "../../state/tabs";
import { ensureConnected, explorerDataSources, openDdlTab, openTableTab, revealObject } from "../explorer";
import type { NodeData } from "../explorer/model";
import { TABLE_CHILD_KINDS, type Entry } from "./sources";

const TABLE_KINDS = ["table", "view", "materializedView"];
/** Columns, indexes, keys, checks and triggers belong to a table: they open its data / DDL. */
const isChild = (e: Entry) => TABLE_CHILD_KINDS.includes(e.kind);

function nodeData(e: Entry, driver: Driver): NodeData {
  // A column (index, key, ...) opens the data of its table.
  const kind = (isChild(e) ? (e.tableKind ?? "table") : e.kind) as NodeKind;
  const name = isChild(e) ? (e.table ?? e.name) : e.name;
  return {
    dsId: e.dsId!,
    kind,
    name,
    path: [],
    extra: { schema: e.schema, signature: e.signature },
    driver,
  };
}

/** Does Shift+Enter (DDL) apply to this entry? */
export function hasDdl(e: Entry | undefined): boolean {
  return !!e && e.group === "db" && (isChild(e) || ["table", "view", "materializedView", "routine", "function", "procedure", "sequence"].includes(e.kind));
}

export async function openEntry(e: Entry, mode: "default" | "ddl" = "default"): Promise<void> {
  if (e.kind === "setting") {
    await runAction("app.settings", e.pageId);
    return;
  }
  if (e.group === "action") {
    if (e.actionId) await runAction(e.actionId);
    return;
  }
  const ds = explorerDataSources().find((d) => d.id === e.dsId);
  if (!ds) return;
  if (e.group === "console" || e.group === "text") {
    try {
      await ensureConnected(ds.id);
    } catch (err) {
      notify({ kind: "error", title: `Connection to ${ds.name} failed`, body: String((err as Error)?.message ?? err) });
      return;
    }
    const name = e.group === "text" ? (e.file ?? e.name) : e.name;
    openTab({ id: `console:${ds.id}:${name}`, kind: "console", title: `${name} [${ds.name}]`, icon: "dg/console", data: { dsId: ds.id, consoleName: name } });
    return;
  }
  const explorerShown = isToolWindowVisible("explorer");
  if (e.kind === "dataSource" || e.kind === "schema") {
    if (!explorerShown) return void notify({ kind: "info", title: e.name, body: "Show the Database Explorer (Alt+1) to see it." });
    await revealObject(ds.id, e.kind === "schema" ? { schema: e.name, name: e.name, kind: "schema" } : null);
    return;
  }
  const isTable = TABLE_KINDS.includes(e.kind) || isChild(e);
  // Select it in the explorer first (that focuses the tree), then open the tab so the editor ends up focused.
  if (explorerShown) {
    await revealObject(ds.id, {
      schema: e.schema ?? null,
      name: e.name,
      kind: e.kind as NodeKind,
      table: e.table ?? null,
      signature: e.signature ?? null,
    }).catch(() => false);
  }
  const d = nodeData(e, ds.driver);
  if (isTable && mode === "default") await openTableTab(d);
  else await openDdlTab(d);
}

// ---------------------------------------------------------------- recent

const KEY = "prometeo.nav.recent";
type Stored = Pick<Entry, "group" | "kind" | "name" | "dsId" | "schema" | "table" | "tableKind" | "signature" | "actionId" | "unique">;

export function loadRecent(): Entry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Stored[];
    return raw.filter((r) => r.group !== "action" && r.group !== "text").map((r) => ({ ...r, lower: r.name.toLowerCase() }));
  } catch {
    return [];
  }
}

export function pushRecent(e: Entry): void {
  if (e.group === "action" || e.group === "text") return;
  const same = (a: Stored, b: Stored) => a.kind === b.kind && a.name === b.name && a.dsId === b.dsId && a.schema === b.schema && a.table === b.table && a.signature === b.signature;
  const mine: Stored = { group: e.group, kind: e.kind, name: e.name, dsId: e.dsId, schema: e.schema, table: e.table, tableKind: e.tableKind, signature: e.signature, unique: e.unique };
  try {
    const list = (JSON.parse(localStorage.getItem(KEY) ?? "[]") as Stored[]).filter((r) => !same(r, mine));
    localStorage.setItem(KEY, JSON.stringify([mine, ...list].slice(0, 30)));
  } catch {
    /* storage unavailable */
  }
}
