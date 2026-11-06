/* @refresh reload */
// Demo page for <SqlEditor>. Query params: theme=light|dark, dialect=postgres|mysql|sqlite,
// layout=full (1090x847 island at the DataGrip console position) | free (fills the window),
// readonly=1, marks=1 (show executed marks), errors=1 (show an error).
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { SqlEditor } from "../src/components/editor/SqlEditor";
import type { Dialect, EditorError, ExecMark, ExecuteRequest, SchemaSnapshot, SqlEditorHandle } from "../src/components/editor/types";
import "../src/theme/fonts.css";
import "../src/theme/metrics.css";
import "../src/theme/dark.css";
import "../src/theme/light.css";

const q = new URLSearchParams(location.search);
const theme = q.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
const dialect = (q.get("dialect") ?? "postgres") as Dialect;

const SCRIPT = `-- Top customers by revenue
SELECT c.id, c.first_name, c.last_name, c.email, c.city,
       COUNT(o.id) AS orders_cnt, ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue
FROM customers c
         LEFT JOIN orders o ON o.customer_id = c.id
         LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE c.country IS NOT NULL AND o.status <> 'cancelled'
GROUP BY c.id
ORDER BY revenue DESC
LIMIT 50;

/* plain table */
SELECT * FROM products WHERE price > 10.5;

SELECT * FROM customers;

UPDATE products SET stock = stock WHERE id < 3;

SELECT * FROM no_such_table;
`;

const schema: SchemaSnapshot = {
  database: q.get("db") ?? undefined,
  schemas: [
    {
      name: "main",
      tables: [
        {
          name: "customers",
          kind: "table",
          columns: [
            { name: "id", type: "integer", key: "pk" },
            { name: "first_name", type: "text" },
            { name: "last_name", type: "text" },
            { name: "email", type: "text" },
            { name: "city", type: "text" },
            { name: "country", type: "text" },
            { name: "signup_date", type: "date" },
          ],
        },
        {
          name: "orders",
          kind: "table",
          columns: [
            { name: "id", type: "integer", key: "pk" },
            { name: "customer_id", type: "integer", key: "fk" },
            { name: "status", type: "text" },
            { name: "total", type: "numeric(12,2)" },
            { name: "created_at", type: "timestamp" },
          ],
        },
        {
          name: "order_items",
          kind: "table",
          columns: [
            { name: "id", type: "integer", key: "pk" },
            { name: "order_id", type: "integer", key: "fk" },
            { name: "product_id", type: "integer", key: "fk" },
            { name: "quantity", type: "integer" },
            { name: "unit_price", type: "numeric(10,2)" },
          ],
        },
        {
          name: "products",
          kind: "table",
          columns: [
            { name: "id", type: "integer", key: "pk" },
            { name: "name", type: "text" },
            { name: "price", type: "numeric(10,2)" },
            { name: "category_id", type: "integer", key: "fk" },
            { name: "stock", type: "integer" },
          ],
        },
        { name: "categories", kind: "table", columns: [{ name: "id", type: "integer", key: "pk" }, { name: "name", type: "text" }] },
        { name: "v_unpaid", kind: "view", columns: [{ name: "id", type: "integer" }, { name: "amount", type: "numeric(12,2)" }] },
      ],
    },
    {
      name: "sales",
      routines: [{ name: "client_total", args: "cid integer", returns: "numeric" }],
      tables: [
        { name: "clients", kind: "table", columns: [{ name: "id", type: "integer", key: "pk" }, { name: "name", type: "text" }] },
        {
          name: "invoices",
          kind: "table",
          columns: [
            { name: "id", type: "integer", key: "pk" },
            { name: "client_id", type: "integer", key: "fk" },
            { name: "amount", type: "numeric" },
            { name: "issued", type: "date" },
            { name: "paid", type: "boolean" },
          ],
        },
        { name: "v_unpaid", kind: "view", columns: [{ name: "id", type: "integer" }] },
        { name: "ticket_seq", kind: "sequence", columns: [] },
        { name: "clients_id_seq", kind: "sequence", columns: [] },
        { name: "invoices_id_seq", kind: "sequence", columns: [] },
      ],
    },
  ],
};

const DDL = `-- auto-generated definition
create table invoices
(
    id        serial
        primary key,
    client_id integer
        references clients,
    amount    numeric(12, 2),
    issued    date,
    paid      boolean
);

alter table invoices
    owner to postgres;

create index invoices_client_id_idx
    on invoices (client_id);
`;

const marks: ExecMark[] = [{ from: SCRIPT.indexOf("SELECT * FROM no_such_table"), to: SCRIPT.indexOf("SELECT * FROM no_such_table") + 27, status: "error", ms: 23 }];
const errors: EditorError[] = [{ statementFrom: SCRIPT.indexOf("SELECT * FROM no_such_table"), position: 15, message: 'ERROR: relation "no_such_table" does not exist' }];

declare global {
  interface Window {
    __ed?: SqlEditorHandle;
    __log: { exec: ExecuteRequest[]; caret: string };
  }
}
window.__log = { exec: [], caret: "" };

function Single() {
  const [value, setValue] = createSignal("active = fa");
  return (
    <div style="position:absolute;left:504px;top:119px;width:600px;height:28px;background:#191A1C;padding:3px 8px;box-sizing:border-box">
      <SqlEditor
        value={value()}
        onChange={setValue}
        dialect={dialect}
        schema={schema}
        scopeTable={{ schema: "sales", name: "invoices" }}
        singleLine
        placeholder="WHERE"
        autofocus
        ref={(h) => (window.__ed = h)}
        onSubmit={() => window.__log.exec.push({ sql: value(), ranges: [], source: "statement" })}
      />
    </div>
  );
}

function App() {
  const [value, setValue] = createSignal(q.get("ddl") ? DDL : q.get("empty") ? "" : SCRIPT);
  const full = q.get("layout") !== "free";
  const h = Number(q.get("h") ?? 847);
  const style = full
    ? `position:absolute;left:504px;top:119px;width:1090px;height:${h}px;`
    : "position:absolute;inset:0;";
  return (
    <>
      {full && <div style={`position:absolute;left:503px;top:118px;width:1092px;height:${Number(q.get("h") ?? 847) + 2}px;background:${theme === "dark" ? "#191A1C" : "#fff"};border-radius:0`} />}
      <div style={style}>
        <SqlEditor
          value={value()}
          onChange={setValue}
          dialect={dialect}
          schema={schema}
          defaultSchema="main"
          sourceLabel={q.get("label") ?? "ux-sample.db"}
          readOnly={!!q.get("readonly") || !!q.get("ddl")}
          statementFrame={!q.get("ddl")}
          execMarks={q.get("marks") ? marks : []}
          errors={q.get("errors") ? errors : []}
          autofocus
          onCustomizeExecution={() => undefined}
          ref={(h) => (window.__ed = h)}
          onExecute={(r) => window.__log.exec.push(r)}
          onCaretChange={(l, c) => (window.__log.caret = `${l}:${c}`)}
        />
      </div>
    </>
  );
}

render(() => (q.get("single") ? <Single /> : <App />), document.getElementById("root") as HTMLElement);
