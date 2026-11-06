/* Standalone demo of the data grid. Open http://localhost:1433/demo/grid.html (vite dev, see docs).
 * Query params: rows=100000  cols=30  theme=dark|light  editable=1|0  paged=0|1  ref=53|57  view=table|text
 *   bench=<port>  run the scroll benchmark and POST the result to http://localhost:<port>/ (for engines without devtools) */
import { Show, createSignal, onMount } from "solid-js";
import { render } from "solid-js/web";
import "../src/theme/fonts.css";
import "../src/theme/metrics.css";
import "../src/theme/dark.css";
import "../src/theme/light.css";
import {
  DataGrid,
  GridFilterBar,
  GridPagingPill,
  GridToolbar,
  type Cell,
  type DataGridApi,
  type GridChange,
  type GridColumn,
  type SelectionInfo,
  type SortSpec,
  type ViewMode,
} from "../src/components/grid";

const q = new URLSearchParams(location.search);
const theme = q.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
const ref = q.get("ref");
const ROWS = Number(q.get("rows") ?? 100000);
const EDITABLE = q.get("editable") !== "0";
const PAGED = q.get("paged") === "1";

// ---------------------------------------------------------------------------------------------
// data

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Pablo", "Chen", "Marta", "Sofia", "Omar", "John", "Luis", "Eva", "Ana", "Yuki", "Ingrid", "Tariq"];
const LAST = ["Rossi", "Garcia", "Wang", "Kim", "Lopez", "Muller", "Silva", "Smith", "Nakamura", "Haddad"];
const CITY = ["Berlin", "Lisbon", "Madrid", "Paris", "Tokyo", "Oslo", "Cairo", "Lima"];
const CC = ["DE", "PT", "ES", "FR", "JP", "NO", "EG", "PE"];
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

const BIG_COLUMNS: GridColumn[] = [
  { name: "id", typeName: "int4", isPk: true, nullable: false },
  { name: "uuid", typeName: "uuid" },
  { name: "first_name", typeName: "varchar(255)" },
  { name: "last_name", typeName: "varchar(255)" },
  { name: "email", typeName: "varchar(255)" },
  { name: "age", typeName: "int2" },
  { name: "balance", typeName: "numeric(12,2)" },
  { name: "score", typeName: "float8" },
  { name: "active", typeName: "bool" },
  { name: "created_at", typeName: "timestamp" },
  { name: "birthday", typeName: "date" },
  { name: "alarm", typeName: "time" },
  { name: "notes", typeName: "text" },
  { name: "tags", typeName: "jsonb" },
  { name: "payload", typeName: "json" },
  { name: "avatar", typeName: "bytea" },
  { name: "country", typeName: "char(2)" },
  { name: "city", typeName: "varchar(100)" },
  { name: "status", typeName: "varchar(20)" },
  { name: "price", typeName: "numeric(10,4)" },
  { name: "qty", typeName: "int4" },
  { name: "ratio", typeName: "float4" },
  { name: "big_counter", typeName: "int8" },
  { name: "url", typeName: "text" },
  { name: "ip", typeName: "inet" },
  { name: "phone", typeName: "varchar(32)" },
  { name: "company", typeName: "varchar(255)", isFk: true },
  { name: "title", typeName: "varchar(255)" },
  { name: "description", typeName: "text" },
  { name: "deleted_at", typeName: "timestamp" },
];

function makeRow(i: number, ncols: number): Cell[] {
  const rnd = mulberry32(i * 7919 + 13);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const nul = (v: Cell, p = 0.1): Cell => (rnd() < p ? null : v);
  const f = pick(FIRST);
  const l = pick(LAST);
  const date = (y: number) => `${y}-${String(1 + Math.floor(rnd() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;
  const ci = Math.floor(rnd() * CITY.length);
  const all: Cell[] = [
    i + 1,
    `${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}-${Math.floor(rnd() * 65535).toString(16).padStart(4, "0")}-4${Math.floor(rnd() * 4095).toString(16).padStart(3, "0")}-a9b2-${Math.floor(rnd() * 2 ** 32).toString(16).padStart(8, "0")}${Math.floor(rnd() * 65535).toString(16).padStart(4, "0")}`,
    f,
    nul(l, 0.05),
    nul(`${f.toLowerCase()}.${l.toLowerCase()}${i}@example.com`, 0.12),
    nul(18 + Math.floor(rnd() * 70), 0.08),
    (rnd() * 100000).toFixed(2),
    rnd() * 1000,
    rnd() < 0.5 ? true : rnd() < 0.1 ? null : false,
    `${date(2020 + Math.floor(rnd() * 6))} ${String(Math.floor(rnd() * 24)).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}.${String(Math.floor(rnd() * 1000)).padStart(3, "0")}`,
    nul(date(1950 + Math.floor(rnd() * 55)), 0.2),
    `${String(Math.floor(rnd() * 24)).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}:00`,
    rnd() < 0.25 ? null : rnd() < 0.3 ? LOREM + "\n" + LOREM : LOREM.slice(0, 20 + Math.floor(rnd() * 150)),
    nul({ tier: pick(["free", "pro", "team"]), flags: [1, 2, 3].slice(0, 1 + Math.floor(rnd() * 3)), nested: { ok: rnd() < 0.5 } }, 0.3),
    nul([Math.floor(rnd() * 100), Math.floor(rnd() * 100)], 0.5),
    nul({ $bin: Array.from({ length: 16 }, () => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join(""), len: 1024, truncated: true }, 0.4),
    CC[ci],
    nul(CITY[ci], 0.15),
    pick(["active", "pending", "banned", "archived"]),
    (rnd() * 999).toFixed(4),
    Math.floor(rnd() * 5000),
    Math.fround(rnd()),
    rnd() < 0.2 ? String(9007199254740993n + BigInt(i)) : Math.floor(rnd() * 1e9),
    `https://example.com/u/${i}/${f.toLowerCase()}`,
    `10.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}`,
    nul(`+${Math.floor(1e10 + rnd() * 9e10)}`, 0.3),
    pick(["Acme Corp", "Globex", "Initech", "Umbrella", "Hooli"]),
    nul(pick(["CEO", "Engineer", "Analyst", "Intern", "Designer"]), 0.2),
    LOREM.slice(0, Math.floor(rnd() * LOREM.length)),
    rnd() < 0.9 ? null : date(2024),
  ];
  return all.slice(0, ncols);
}

const REF_COLUMNS: GridColumn[] = [
  { name: "id", typeName: "int4", isPk: true },
  { name: "first_name", typeName: "text", nullable: false },
  { name: "last_name", typeName: "text", nullable: false },
  { name: "email", typeName: "text", isIndexed: true },
  { name: "city", typeName: "text" },
  { name: "country", typeName: "text" },
  { name: "signup_date", typeName: "text" },
];
const N = null;
const REF_53: Cell[][] = [
  [1, "Pablo", "Rossi", "user1@example.com", "Berlin", "DE", "2024-10-12"],
  [2, "Chen", "Garcia", "user2@example.com", N, N, "2024-07-26"],
  [3, "Marta", "Wang", "user3@example.com", "Lisbon", "PT", "2024-07-02"],
  [4, "Sofia", "Wang", "user4@example.com", N, N, "2024-09-14"],
  [5, "Sofia", "Kim", "user5@example.com", N, N, "2024-06-01"],
  [6, "Omar", "Rossi", "user6@example.com", "Lisbon", "PT", "2024-08-20"],
  [7, "John", "Lopez", N, "Madrid", "ES", "2024-09-19"],
  [8, "Luis", "Muller", "user8@example.com", "Berlin", "DE", "2024-01-27"],
  [9, "Luis", "Garcia", "user9@example.com", "Madrid", "ES", "2024-08-01"],
  [10, "John", "Muller", "user10@example.com", "Paris", "FR", "2024-02-26"],
  [11, "Marta", "Rossi", "user11@example.com", "Lisbon", "PT", "2024-05-03"],
  [12, "Marta", "Muller", "user12@example.com", "Berlin", "DE", "2024-09-06"],
  [13, "Chen", "Silva", "user13@example.com", "Paris", "FR", "2024-12-11"],
  [14, "Eva", "Smith", N, N, N, "2024-01-10"],
];
const REF_57: Cell[][] = [
  [22, "Ana", "Muller", "user22@example.com", N, N, "2024-03-07"],
  [25, "Ana", "Garcia", "user25@example.com", "Berlin", "DE", "2024-10-27"],
  [35, "Ana", "Smith", N, "Madrid", "ES", "2024-03-06"],
  [2, "Chen", "Garcia", "user2@example.com", N, N, "2024-07-26"],
  [13, "Chen", "Silva", "user13@example.com", "Paris", "FR", "2024-12-11"],
  [16, "Chen", "Wang", "user16@example.com", "Madrid", "ES", "2024-10-14"],
  [23, "Chen", "Smith", "user23@example.com", "Madrid", "ES", "2024-02-10"],
  [30, "Chen", "Silva", "user30@example.com", N, N, "2024-01-11"],
  [33, "Chen", "Smith", "user33@example.com", "Berlin", "DE", "2024-07-18"],
  [14, "Eva", "Smith", N, N, N, "2024-01-10"],
  [20, "Eva", "Wang", "user20@example.com", "Lisbon", "PT", "2024-09-21"],
  [39, "Eva", "Lopez", "user39@example.com", "Lisbon", "PT", "2024-10-18"],
  [7, "John", "Lopez", N, "Madrid", "ES", "2024-09-19"],
  [10, "John", "Muller", "user10@example.com", "Paris", "FR", "2024-02-26"],
];

// ---------------------------------------------------------------------------------------------

const NCOLS = Number(q.get("cols") ?? 30);

function Demo() {
  const columns: GridColumn[] = ref ? REF_COLUMNS : BIG_COLUMNS.slice(0, NCOLS);
  const refRows = ref === "57" ? REF_57 : REF_53;
  const PAGE = 500;

  const [loaded, setLoaded] = createSignal(ref ? refRows.length : PAGED ? Math.min(PAGE, ROWS) : ROWS);
  const total = ref ? 40 : ROWS;
  const cache: Cell[][] = [];
  const getRow = (i: number): Cell[] | undefined => {
    if (ref) return refRows[i];
    if (i >= loaded()) return undefined;
    return (cache[i] ??= makeRow(i, NCOLS));
  };

  const [viewMode, setViewMode] = createSignal<ViewMode>((q.get("view") as ViewMode) === "text" ? "text" : "table");
  const [sort, setSort] = createSignal<SortSpec[]>(ref === "57" ? [{ col: 1, dir: "asc" }] : []);
  const [pending, setPending] = createSignal(0);
  const [sel, setSel] = createSignal<SelectionInfo>({ row: null, col: null, cells: 0, numeric: null });
  const [where, setWhere] = createSignal("");
  const [orderBy, setOrderBy] = createSignal("");
  const [log, setLog] = createSignal<string>("");
  const [pageSize, setPageSize] = createSignal<number | "all">(500);
  let api!: DataGridApi;

  onMount(() => {
    (window as unknown as Record<string, unknown>).__grid = api;
  });

  const onSubmit = (changes: GridChange[]) => {
    setLog(`submit: ${changes.length} change(s)\n` + JSON.stringify(changes.slice(0, 3)));
    console.log("submit", JSON.stringify(changes));
  };

  const grid = (
    <div class="demo-grid">
      <DataGrid
        columns={columns}
        rowCount={loaded()}
        getRow={getRow}
        hasMore={loaded() < total && !ref}
        onNeedMore={() => setTimeout(() => setLoaded((n) => Math.min(total, n + PAGE)), 120)}
        editable={EDITABLE}
        tableName="public.customers"
        onSubmit={onSubmit}
        onChangesChange={setPending}
        sort={sort()}
        onSortChange={setSort}
        sortMode={ref ? "external" : "local"}
        viewMode={viewMode()}
        onSelectionChange={setSel}
        apiRef={(a) => (api = a)}
        onColumnFilter={(c) => setLog(`filter column ${c}`)}
      >
        <GridPagingPill
          rowCount={ref ? total : loaded()}
          pageSize={pageSize()}
          onPageSizeChange={setPageSize}
          onCountRows={() => setLog("count rows")}
        />
      </DataGrid>
    </div>
  );

  const toolbar = (
    <GridToolbar
      editable={EDITABLE}
      hasChanges={pending() > 0}
      viewMode={viewMode()}
      onViewModeChange={setViewMode}
      txMode="Auto"
      onTxMenu={() => setLog("tx menu")}
      onReload={() => setLog("reload")}
      onAddRow={() => api.addRow()}
      onDeleteRows={() => api.deleteRows()}
      onRevert={() => api.revertSelected()}
      onSubmit={() => api.submit()}
      onPreview={() => setLog("preview " + JSON.stringify(api.getChanges()).slice(0, 300))}
      onDDL={() => setLog("ddl")}
      onFind={() => setLog("find")}
      onSql={() => setLog("sql")}
      onExport={() => setLog("export")}
      onExtractorMenu={() => setLog("extractor")}
      onManageColumns={() => api.showAllColumns()}
      onOptions={() => setLog("options")}
    />
  );

  return (
    <Show
      when={ref}
      fallback={
        <div class="demo-window">
          <div class="demo-island">
            {toolbar}
            <GridFilterBar where={where()} orderBy={orderBy()} onWhereChange={setWhere} onOrderByChange={setOrderBy} onApply={() => setLog(`apply WHERE ${where()} ORDER BY ${orderBy()}`)} />
            {grid}
          </div>
          <div class="demo-status">
            <span>
              rows loaded: {loaded().toLocaleString()} / {total.toLocaleString()}
            </span>
            <span>pending: {pending()}</span>
            <span>
              <Show when={sel().row} fallback="no selection">
                {sel().row}:{sel().col} ({sel().cells} cells)
              </Show>
              <Show when={sel().numeric}> SUM: {sel().numeric!.sum.toFixed(2)} (n={sel().numeric!.count})</Show>
            </span>
            <span class="demo-log">{log()}</span>
            <span class="demo-spacer" />
            <button onClick={() => (document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark")}>theme</button>
          </div>
        </div>
      }
    >
      <div class="demo-window ref">
        <div class="demo-island ref">
          <div class="demo-hdr">
            <b>Database Output</b>
          </div>
          {toolbar}
          {grid}
        </div>
      </div>
    </Show>
  );
}

const style = document.createElement("style");
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; overflow: hidden; }
  body { background: var(--dg-window-bg); font: 13px/16px var(--dg-font-ui); color: var(--dg-text); }
  .demo-window { height: 100%; padding: 8px 6px 6px 8px; display: flex; flex-direction: column; gap: 6px; }
  .demo-island { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--dg-island-bg); border-radius: 10px; overflow: hidden; }
  .demo-grid { flex: 1; min-height: 0; position: relative; }
  .demo-status { height: 24px; display: flex; gap: 18px; align-items: center; padding: 0 12px; color: var(--dg-text-muted); white-space: pre; overflow: hidden; }
  .demo-log { color: var(--dg-text-secondary); overflow: hidden; text-overflow: ellipsis; max-width: 700px; }
  .demo-spacer { flex: 1; }
  .demo-status button { font: inherit; background: none; color: inherit; border: 1px solid var(--dg-button-border); border-radius: 4px; padding: 0 8px; }
  /* reference layout: island at x=8, toolbar top at y=524, island bottom y=966 (screens 53/57/58/59) */
  .demo-window.ref { padding: 0; display: block; }
  .demo-island.ref { position: absolute; left: 8px; top: 484px; width: 1586px; height: 482px; }
  .demo-hdr { height: 40px; flex: none; display: flex; align-items: center; padding: 0 12px; border-bottom: 1px solid var(--dg-border); }
`;
document.head.appendChild(style);
// ?css=<rules> injects extra CSS (experiments)
if (q.get("css")) {
  const extra = document.createElement("style");
  extra.textContent = q.get("css")!;
  document.head.appendChild(extra);
}

Promise.all([document.fonts.load('13px "JetBrains Mono"'), document.fonts.load('13px Inter'), document.fonts.load('600 13px Inter')]).then(() =>
  render(() => <Demo />, document.getElementById("root") as HTMLElement),
);

// ---------------------------------------------------------------------------------------------
// optional scroll benchmark (rAF frame times while scrolling programmatically)

const benchPort = q.get("bench");
if (benchPort) {
  const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
  const run = async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const sc = document.querySelector(".dgg-scroller") as HTMLElement;
    const out: Record<string, unknown> = { userAgent: navigator.userAgent };
    const scenarios: [string, number, number, number][] = [
      ["vertical slow 200px/frame", 200, 0, 300],
      ["vertical fast 3000px/frame", 3000, 0, 300],
      ["vertical extreme 30000px/frame", 30000, 0, 80],
      ["horizontal 400px/frame", 0, 400, 120],
      ["diagonal 900x300px/frame", 900, 300, 200],
    ];
    for (const [name, dy, dx, frames] of scenarios) {
      sc.scrollTop = 0;
      sc.scrollLeft = 0;
      await raf();
      await raf();
      const times: number[] = [];
      let last = performance.now();
      let ky = 1;
      let kx = 1;
      for (let i = 0; i < frames; i++) {
        sc.scrollTop += dy * ky;
        sc.scrollLeft += dx * kx;
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) ky = -1;
        if (sc.scrollTop <= 0) ky = 1;
        if (sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 2) kx = -1;
        if (sc.scrollLeft <= 0) kx = 1;
        const t = await raf();
        times.push(t - last);
        last = t;
      }
      times.shift();
      const sorted = [...times].sort((a, b) => a - b);
      out[name] = {
        avgMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
        p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
        worstMs: +sorted[sorted.length - 1].toFixed(2),
        over20ms: times.filter((t) => t > 20).length,
        frames: times.length,
      };
    }
    out.domNodes = document.querySelector(".dgg")!.getElementsByTagName("*").length;
    await fetch(`http://localhost:${benchPort}/`, { method: "POST", mode: "no-cors", body: JSON.stringify(out) });
  };
  window.addEventListener("load", () => void run());
}
