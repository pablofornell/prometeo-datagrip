/**
 * Quick Documentation (Ctrl+Q): a popup with the summary of the selected object like DataGrip's documentation
 * popup: kind and qualified name, comment, and for tables / views the columns with type, NOT NULL, key, default
 * and comment; for routines the signature and return type; for keys / indexes the definition.
 */
import { For, type JSX, Show, createResource, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import type { TreeNode } from "../../api/db";
import { dsOf, rawIntrospect } from "./core";
import { type ENode, TABLE_CHILD, referenceOf } from "./model";

const KIND_TITLE: Record<string, string> = {
  dataSource: "Data source",
  database: "Database",
  schema: "Schema",
  folder: "Folder",
  table: "Table",
  view: "View",
  materializedView: "Materialized view",
  column: "Column",
  primaryKey: "Primary key",
  uniqueKey: "Unique key",
  foreignKey: "Foreign key",
  index: "Index",
  check: "Check constraint",
  trigger: "Trigger",
  sequence: "Sequence",
  function: "Function",
  procedure: "Procedure",
  routine: "Routine",
};

interface Doc {
  title: string;
  kind: string;
  where: string;
  comment?: string;
  /** Label / value lines under the title. */
  facts: [string, string][];
  columns?: TreeNode[];
}

const str = (v: unknown): string | undefined => (v === null || v === undefined || v === "" ? undefined : String(v));

export async function docOf(n: ENode): Promise<Doc> {
  const d = n.data;
  const ex = d.extra;
  const facts: [string, string][] = [];
  const doc: Doc = { title: d.name, kind: KIND_TITLE[d.kind] ?? d.kind, where: referenceOf(d), facts };
  const add = (k: string, v: unknown) => {
    const s = str(v);
    if (s) facts.push([k, s]);
  };
  switch (d.kind) {
    case "dataSource": {
      const ds = dsOf(d.dsId);
      doc.where = "";
      if (ds) {
        add("DBMS", ds.options.dbms === "mariadb" ? "MariaDB" : { postgres: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite" }[ds.driver]);
        add("Host", ds.driver === "sqlite" ? undefined : `${ds.host}:${ds.port}`);
        add("Database", ds.database);
        add("File", ds.file);
        add("User", ds.user);
      }
      break;
    }
    case "table":
    case "view":
    case "materializedView": {
      doc.comment = str(ex.comment);
      add("Engine", ex.engine);
      add("Estimated rows", ex.rowEstimate);
      doc.columns = await rawIntrospect(d.dsId, [...d.path, "columns"], false).catch(() => []);
      break;
    }
    case "column": {
      doc.comment = str(ex.comment);
      add("Type", ex.dataType);
      add("Nullable", ex.nullable === false ? "NOT NULL" : "NULL");
      add("Primary key", ex.isPk ? "yes" : undefined);
      add("Default", ex.default);
      add("Identity", ex.identity);
      add("Generated", ex.generated);
      add("Table", ex.table);
      break;
    }
    case "function":
    case "procedure":
    case "routine":
      add("Arguments", n.hint?.replace(/\)\s*:.*$/, ")"));
      add("Returns", ex.returns ?? /:\s*(.*)$/.exec(n.hint ?? "")?.[1]);
      add("Language", ex.language);
      break;
    case "sequence":
      add("Type", n.hint);
      break;
    default:
      add("Definition", ex.definition ?? n.hint);
      add("Columns", Array.isArray(ex.columns) ? ex.columns.join(", ") : ex.columns);
      add("Table", ex.table);
  }
  if (!doc.comment && (d.kind === "schema" || d.kind === "database")) doc.comment = str(n.hint);
  if (TABLE_CHILD.includes(d.kind) && d.kind !== "column") add("Table", ex.table);
  return doc;
}

function DocView(props: { node: ENode; anchor: DOMRect; close: () => void }): JSX.Element {
  let root!: HTMLDivElement;
  const [doc] = createResource(() => docOf(props.node));
  const onDown = (e: MouseEvent) => {
    if (!root.contains(e.target as Node)) props.close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.close();
    }
  };
  onMount(() => {
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", props.close);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", props.close);
  });
  const left = Math.max(4, Math.min(props.anchor.left + 48, window.innerWidth - 544));
  const top = Math.max(4, Math.min(props.anchor.bottom + 2, window.innerHeight - 364));
  return (
    <div ref={root} class="dg-quickdoc" style={{ left: left + "px", top: top + "px" }} role="dialog" aria-label="Quick Documentation">
      <Show when={doc()} fallback={<div class="dg-quickdoc-loading">Loading…</div>}>
        {(x) => (
          <>
            <div class="dg-quickdoc-head">
              <span class="dg-quickdoc-title">{x().title}</span>
              <span class="dg-quickdoc-kind">{x().kind}</span>
            </div>
            <Show when={x().where && x().where !== x().title}>
              <div class="dg-quickdoc-where">{x().where}</div>
            </Show>
            <Show when={x().comment}>
              <div class="dg-quickdoc-comment">{x().comment}</div>
            </Show>
            <Show when={x().facts.length}>
              <table class="dg-quickdoc-facts">
                <tbody>
                  <For each={x().facts}>
                    {([k, v]) => (
                      <tr>
                        <td class="dg-quickdoc-k">{k}</td>
                        <td>{v}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
            <Show when={x().columns?.length}>
              <div class="dg-quickdoc-sect">Columns</div>
              <table class="dg-quickdoc-cols">
                <tbody>
                  <For each={x().columns}>
                    {(c) => (
                      <tr>
                        <td class="dg-quickdoc-colname">
                          {c.name}
                          <Show when={c.extra.isPk}>
                            <span class="dg-quickdoc-tag">PK</span>
                          </Show>
                        </td>
                        <td class="dg-quickdoc-type">{str(c.extra.dataType) ?? c.hint}</td>
                        <td class="dg-quickdoc-null">{c.extra.nullable === false ? "NOT NULL" : ""}</td>
                        <td class="dg-quickdoc-def">{str(c.extra.default) ? `= ${c.extra.default}` : ""}</td>
                        <td class="dg-quickdoc-colcomment">{str(c.extra.comment) ?? ""}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

let closeOpen: (() => void) | undefined;

/** Shows the popup for a node below its tree row. */
export function showQuickDoc(n: ENode | undefined): void {
  closeOpen?.();
  if (!n || n.data.kind === "loading" || n.data.kind === "error") return;
  const row = document.querySelector<HTMLElement>(`.dg-explorer-tree [data-row-id="${CSS.escape(n.id)}"]`);
  const anchor = row?.getBoundingClientRect() ?? document.querySelector(".dg-explorer-tree")?.getBoundingClientRect() ?? new DOMRect(40, 120, 200, 24);
  const host = document.createElement("div");
  document.body.appendChild(host);
  let dispose: (() => void) | undefined;
  const close = () => {
    if (!closeOpen) return;
    closeOpen = undefined;
    queueMicrotask(() => {
      dispose?.();
      host.remove();
    });
    document.querySelector<HTMLElement>(".dg-explorer-tree")?.focus();
  };
  closeOpen = close;
  dispose = render(() => <DocView node={n} anchor={anchor} close={close} />, host);
}
