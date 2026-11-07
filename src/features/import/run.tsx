/** Starts an import: native file dialog, the Import Data dialog, then the background import with its balloon. */
import {
  type Driver,
  type ImportRequest,
  cancelImport,
  chooseImportFile,
  importFile,
  introspect,
  schemaSnapshot,
} from "../../api/db";
import { notify } from "../../components/ui";
import { startTask } from "../../state/status";
import { ensureConnected, refreshNode } from "../explorer";
import { mountDialog } from "../table/dialogs";
import { dsInfo, errText, requireDriver } from "../table/ds";
import { ImportDialog, type TableInfo } from "./ImportDialog";
import { resultMessage } from "./model";

/** Where the import was started: a data source, a schema, or a table. */
export interface ImportTarget {
  dsId: string;
  schema?: string | null;
  /** Existing table to preselect. */
  table?: string | null;
}

interface SchemaEntry {
  name: string;
  path: string[];
}

/** The non-system schemas of the data source (for PostgreSQL those of the database it is connected to). */
async function loadSchemas(dsId: string, postgres: boolean): Promise<SchemaEntry[]> {
  let nodes = await introspect(dsId, [], false);
  if (postgres) {
    const db = nodes.find((n) => n.extra.current) ?? nodes[0];
    nodes = db ? await introspect(dsId, db.path, false) : [];
  }
  return nodes.filter((n) => n.kind === "schema" && !n.extra.system).map((n) => ({ name: n.name, path: n.path }));
}

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

/** Runs the import with a status bar task (cancellable) and reports it in a balloon. */
export async function runImport(dsId: string, req: ImportRequest, fileName: string, schemaPath: string[] | undefined): Promise<void> {
  const id = newId();
  const task = startTask(`Importing ${fileName}…`, { cancel: () => void cancelImport(id).catch(() => {}) });
  const label = req.schema ? `${req.schema}.${req.table}` : req.table;
  try {
    const res = await importFile(dsId, id, req, (p) => task.progress(p.fraction));
    const m = resultMessage(res, label);
    // one line per message line: the first failing rows are listed under the summary
    const body = (
      <>
        {m.body.split("\n").map((line) => (
          <div>{line}</div>
        ))}
      </>
    );
    notify({ kind: m.kind, title: m.title, body, timeout: m.kind === "success" ? 6000 : 0 });
    if (res.createdTable && schemaPath) refreshNode([dsId, ...schemaPath]);
  } catch (e) {
    notify({ kind: "error", title: "Import failed", body: errText(e) });
  } finally {
    task.done();
  }
}

/** `import.file`: choose a file, then the Import Data dialog. */
export async function openImport(t: ImportTarget): Promise<void> {
  let driver: Driver;
  try {
    driver = await requireDriver(t.dsId);
    await ensureConnected(t.dsId);
  } catch (e) {
    notify({ kind: "error", title: "Cannot import the data", body: errText(e) });
    return;
  }
  const ds = dsInfo(t.dsId);
  try {
    const source = await chooseImportFile();
    if (!source) return;
    const schemas = await loadSchemas(t.dsId, driver === "postgres");
    const names = schemas.map((s) => s.name);
    const usual = driver === "postgres" ? "public" : driver === "oracle" ? (ds?.user ?? "").toUpperCase() : "main";
    const schema = t.schema && names.includes(t.schema) ? t.schema : names.includes(usual) ? usual : (names[0] ?? null);
    const cache = new Map<string, Promise<TableInfo[]>>();
    const loadTables = (s: string | null): Promise<TableInfo[]> => {
      const key = s ?? "";
      if (!cache.has(key))
        cache.set(
          key,
          schemaSnapshot(t.dsId, s).then((objs) =>
            objs.filter((o) => o.kind === "table").map((o) => ({ name: o.name, columns: o.columns.map((c) => ({ name: c.name, type: c.typeName })) })),
          ),
        );
      return cache.get(key)!;
    };
    mountDialog((close) => (
      <ImportDialog
        dsId={t.dsId}
        dsName={ds?.name ?? t.dsId}
        driver={driver}
        source={source}
        schemas={names}
        schema={schema}
        table={t.table ?? undefined}
        loadTables={loadTables}
        onClose={close}
        onSubmit={(req) => {
          close();
          void runImport(t.dsId, req, source.name, schemas.find((s) => s.name === req.schema)?.path);
        }}
      />
    ));
  } catch (e) {
    notify({ kind: "error", title: "Cannot import the data", body: errText(e) });
  }
}
