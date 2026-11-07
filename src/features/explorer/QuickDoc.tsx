/**
 * Quick Documentation (Ctrl+Q): a popup with the summary of the selected object like DataGrip's documentation
 * popup: kind and qualified name, comment, and for tables / views the columns with type, NOT NULL, key, default
 * and comment; for routines the signature and return type; for keys / indexes the definition.
 */
import { For, type JSX, Show, createResource, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { type ObjectRef, type TreeNode, getDdl } from "../../api/db";
import { highlightSql } from "../../components/editor";
import { openTableRef } from "./commands";
import { dsName, dsOf, ensureConnected, rawIntrospect } from "./core";
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
  role: "Role",
  tablespace: "Tablespace",
  extension: "Extension",
  user: "User",
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
    case "role":
      doc.comment = str(ex.comment);
      add("Superuser", ex.superuser ? "yes" : "no");
      add("Can log in", ex.login ? "yes" : "no");
      break;
    case "tablespace":
      add("Owner", ex.owner);
      add("Location", ex.location);
      break;
    case "extension":
      doc.comment = str(ex.comment);
      add("Version", ex.version);
      add("Schema", ex.schema);
      add("Owner", ex.owner);
      break;
    case "user":
      add("User", ex.user);
      add("Host", ex.host);
      break;
    default:
      add("Definition", ex.definition ?? n.hint);
      add("Columns", Array.isArray(ex.columns) ? ex.columns.join(", ") : ex.columns);
      add("Table", ex.table);
  }
  if (!doc.comment && (d.kind === "schema" || d.kind === "database")) doc.comment = str(n.tooltip ?? n.hint);
  if (TABLE_CHILD.includes(d.kind) && d.kind !== "column") add("Table", ex.table);
  return doc;
}

/** Closes on a click outside, Escape or a lost window focus. The popup itself never takes the keyboard focus. */
function dismissOn(root: () => HTMLElement, close: () => void, onTyping = false): void {
  const onDown = (e: MouseEvent) => {
    if (!root().contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || (onTyping && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "q")) {
      // Ctrl+Q again toggles the popup off
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (onTyping && !["Control", "Shift", "Alt", "Meta"].includes(e.key)) close(); // the editor keeps the focus: typing moves on
  };
  onMount(() => {
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
  });
}

function DocView(props: { node: ENode; anchor: DOMRect; close: () => void }): JSX.Element {
  let root!: HTMLDivElement;
  const [doc] = createResource(() => docOf(props.node));
  dismissOn(() => root, props.close);
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

/** Mounts a popup on <body>, replacing the open one. `refocus`: give the keyboard focus back to the explorer on close. */
function present(view: (close: () => void) => JSX.Element, refocus: boolean): void {
  closeOpen?.();
  const host = document.createElement("div");
  document.body.appendChild(host);
  let dispose: (() => void) | undefined;
  const close = () => {
    if (closeOpen !== close) return;
    closeOpen = undefined;
    queueMicrotask(() => {
      dispose?.();
      host.remove();
    });
    if (refocus) document.querySelector<HTMLElement>(".dg-explorer-tree")?.focus();
  };
  closeOpen = close;
  dispose = render(() => view(close), host);
}

/** Shows the popup for a node below its tree row. */
export function showQuickDoc(n: ENode | undefined): void {
  closeOpen?.();
  if (!n || n.data.kind === "loading" || n.data.kind === "error") return;
  const row = document.querySelector<HTMLElement>(`.dg-explorer-tree [data-row-id="${CSS.escape(n.id)}"]`);
  const anchor = row?.getBoundingClientRect() ?? document.querySelector(".dg-explorer-tree")?.getBoundingClientRect() ?? new DOMRect(40, 120, 200, 24);
  present((close) => <DocView node={n} anchor={anchor} close={close} />, true);
}

// ---------------------------------------------------------------- from the SQL editor

/** A table, view or column named in the SQL editor. */
export interface QuickDocTarget {
  dsId: string;
  ref: ObjectRef;
  column?: { name: string; type?: string; key?: string };
}

const KIND_LABEL: Record<string, string> = { table: "Table", view: "View", materializedView: "Materialized view", sequence: "Sequence", foreign: "Table" };

/**
 * SQLite hands back `create table` as it was written, usually one long line: put every top-level item of the
 * parenthesised list on its own line, like the DDL of the other DBMSs. Anything else is shown as it is.
 */
export function layoutCreate(ddl: string): string {
  const nl = ddl.indexOf("\n");
  if (nl >= 0) return layoutCreate(ddl.slice(0, nl)) + ddl.slice(nl); // the statements that follow (indexes) stay as they are
  const m = /^(\s*create\s+table\s[^(]*?)\(([\s\S]*)\)(\s*;?\s*)$/i.exec(ddl);
  if (!m) return ddl;
  const items: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of m[2]) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0 && !quote) {
      items.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  items.push(cur.trim());
  return `${m[1].trimEnd()}\n(\n${items.map((i) => `    ${i}`).join(",\n")}\n)${m[3].trim()}`;
}

/** DDL with the keyword / string / comment colors of the editor. */
function Ddl(props: { text: string; dialect: string }): JSX.Element {
  const parts = (): JSX.Element[] => {
    const text = layoutCreate(props.text);
    const out: JSX.Element[] = [];
    let at = 0;
    for (const m of highlightSql(text, props.dialect as "postgres" | "mysql" | "sqlite")) {
      if (m.from < at || m.to <= m.from) continue;
      if (m.from > at) out.push(text.slice(at, m.from));
      out.push(<span class={`cm-sql-${m.cls}`}>{text.slice(m.from, m.to)}</span>);
      at = m.to;
    }
    out.push(text.slice(at));
    return out;
  };
  return <pre class="dg-quickdoc-code dg-sql-hl">{parts()}</pre>;
}

function RefDoc(props: { target: QuickDocTarget; anchor: DOMRect; close: () => void }): JSX.Element {
  let root!: HTMLDivElement;
  const t = props.target;
  const ds = dsOf(t.dsId);
  const isTable = !t.column && ["table", "view", "materializedView"].includes(t.ref.kind);
  const [ddl] = createResource(async () => {
    if (!isTable && t.ref.kind !== "sequence") return undefined;
    try {
      await ensureConnected(t.dsId);
      return await getDdl(t.dsId, t.ref);
    } catch {
      return undefined;
    }
  });
  dismissOn(() => root, props.close, true);
  const left = Math.max(4, Math.min(props.anchor.left, window.innerWidth - 520));
  const top = Math.max(4, Math.min(props.anchor.bottom + 2, window.innerHeight - 200));
  const facts: [string, string][] = [["Data Source", dsName(t.dsId)]];
  if (t.ref.schema) facts.push(["Schema", t.ref.schema]);
  facts.push([KIND_LABEL[t.ref.kind] ?? t.ref.kind, t.ref.name]);
  if (t.column) {
    facts.push(["Column", t.column.name]);
    if (t.column.type) facts.push(["Type", t.column.type]);
    if (t.column.key) facts.push(["Key", t.column.key === "pk" ? "primary key" : "foreign key"]);
  }
  const preview = t.ref.kind === "table" || t.ref.kind === "view" || t.ref.kind === "materializedView";
  return (
    <div ref={root} class="dg-quickdoc dg-quickdoc-ref" style={{ left: left + "px", top: top + "px" }} role="dialog" aria-label="Quick Documentation">
      <For each={facts}>
        {([k, v]) => (
          <div class="dg-quickdoc-line">
            <b>{k}:</b> {v}
          </div>
        )}
      </For>
      <Show when={ddl()}>{(x) => <Ddl text={x()} dialect={ds?.driver ?? "postgres"} />}</Show>
      <Show when={preview}>
        <a
          class="dg-quickdoc-link"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            props.close();
            void openTableRef(t.dsId, t.ref);
          }}
        >
          Show table preview
        </a>
      </Show>
    </div>
  );
}

/** Quick Documentation of an object named in the SQL editor, below `anchor`; the editor keeps the focus. Esc closes it. */
export function showQuickDocRef(target: QuickDocTarget, anchor: DOMRect): void {
  present((close) => <RefDoc target={target} anchor={anchor} close={close} />, false);
}
