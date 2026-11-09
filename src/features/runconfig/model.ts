/** Run configurations of type "Database Script": what to run (script text or files) and where (data source / schema). */
import type { Driver, ScriptOptions, ScriptSummary } from "../../api/db";

export interface RunTarget {
  dsId: string;
  /** Schema (PostgreSQL), database (MySQL); none for SQLite or the data source's default. */
  schema?: string;
}

export interface RunConfig {
  id: string;
  name: string;
  allowMultiple: boolean;
  targets: RunTarget[];
  /** `text`: run `text`; `files`: run every file of `files`, in order. */
  mode: "text" | "files";
  text: string;
  files: string[];
  /** `files` only: stop at the first failing statement (default). Off: the failures are counted and the run goes on. */
  stopOnError: boolean;
  /** `files` only: the whole file runs in one transaction, committed at the end (rolled back when the run stops or is cancelled). */
  singleTransaction: boolean;
  showPage: boolean;
  activateTool: boolean;
  focusTool: boolean;
  /** Created by running a file directly (drawn dim in the tree); an edit in the dialog makes it permanent. */
  temporary: boolean;
}

let seq = 0;
export const newConfigId = (): string => `rc-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function newConfig(p: Partial<RunConfig> = {}): RunConfig {
  return {
    id: newConfigId(),
    name: "Unnamed",
    allowMultiple: false,
    targets: [],
    mode: "files",
    text: "",
    files: [],
    stopOnError: true,
    singleTransaction: false,
    showPage: true,
    activateTool: true,
    focusTool: false,
    temporary: false,
    ...p,
  };
}

/** The error the dialog's footer shows while the configuration cannot run (null: valid). */
export function validate(c: RunConfig, knownDs: ReadonlySet<string>): string | null {
  if (!c.targets.some((t) => knownDs.has(t.dsId))) return "No configured target data sources";
  if (c.mode === "files" && c.files.length === 0) return "No script files specified";
  if (c.mode === "text" && !c.text.trim()) return "Script text is empty";
  if (!c.name.trim()) return "The name must not be empty";
  return null;
}

/** `base`, `base (1)`, `base (2)` ... the first not in `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const all = new Set(taken);
  if (!all.has(base)) return base;
  for (let i = 1; ; i++) if (!all.has(`${base} (${i})`)) return `${base} (${i})`;
}

export const sameConfig = (a: RunConfig, b: RunConfig): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `postgres@localhost / postgres.public`: the row of the targets list (the second part is drawn gray italic). */
export function targetParts(ds: { name: string; database?: string }, t: RunTarget): { name: string; schema: string } {
  return { name: ds.name, schema: t.schema ? (ds.database && t.schema !== ds.database ? `${ds.database}.${t.schema}` : t.schema) : "" };
}

/** Statements run on the new session before the script (the schema of the target). */
export function initSql(driver: Driver, schema: string | undefined): string[] {
  if (!schema || driver === "sqlite") return [];
  const q = (s: string, c: string) => c + s.replaceAll(c, c + c) + c;
  if (driver === "oracle") return [`ALTER SESSION SET CURRENT_SCHEMA = ${q(schema, '"')}`];
  return [driver === "postgres" ? `SET search_path TO ${q(schema, '"')}` : `USE ${q(schema, "`")}`];
}

/** Last path component (Windows paths use `\`). */
export const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

/** Only configurations whose data sources are of the first target's DBMS can be added together (DataGrip filters the chooser). */
export function compatibleDrivers(current: RunTarget[], driverOf: (dsId: string) => Driver | undefined): Driver | undefined {
  for (const t of current) {
    const d = driverOf(t.dsId);
    if (d) return d;
  }
  return undefined;
}

/** Persisted shape guard: drops entries that are not configurations. */
export function sanitize(raw: unknown): RunConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object" || typeof (r as RunConfig).id !== "string") return [];
    const c = newConfig(r as Partial<RunConfig>);
    c.id = (r as RunConfig).id;
    c.targets = Array.isArray(c.targets) ? c.targets.filter((t) => t && typeof t.dsId === "string") : [];
    c.files = Array.isArray(c.files) ? c.files.filter((f) => typeof f === "string") : [];
    return [c];
  });
}

/** The options of a file run (`ScriptOptions`) from its configuration. The file is read as UTF-8 (a byte order mark is dropped). */
export const scriptOptionsOf = (c: Pick<RunConfig, "stopOnError" | "singleTransaction">): ScriptOptions => ({
  stopOnError: c.stopOnError,
  singleTransaction: c.singleTransaction,
  encoding: "UTF-8",
});

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A file run that failed ends the whole run (the remaining files and targets are not started) when it stops on errors. */
export const stopsAfterFailure = (c: Pick<RunConfig, "mode" | "stopOnError">, failed: number): boolean => c.mode === "files" && c.stopOnError && failed > 0;

/** What a rollback leaves: MySQL and Oracle commit DDL by themselves, so the DDL of a "single transaction" stays. */
const rollbackNote = (sum: ScriptSummary): string => (sum.ddlCommitted ? "DDL statements are committed by the server and stay" : "nothing was kept");

/** Balloon of a finished file run: the kind sets its colour; the first error comes with its line in the file. */
export function scriptResult(sum: ScriptSummary, name: string, stopOnError: boolean): { kind: "success" | "warning" | "error"; title: string; body: string } {
  const first = sum.firstError ? `Line ${sum.firstError.line}: ${sum.firstError.message}` : "";
  if (sum.cancelled)
    return {
      kind: "warning",
      title: `${name} cancelled`,
      body: sum.rolledBack
        ? `${plural(sum.ok, "statement")} rolled back${sum.ddlCommitted ? " (" + rollbackNote(sum) + ")" : ", nothing was kept"}.`
        : `${plural(sum.ok, "statement")} ran before the cancel.`,
    };
  if (sum.rolledBack)
    return {
      kind: "error",
      title: `${name} failed`,
      body: `${plural(sum.failed, "statement")} failed: the transaction was rolled back${sum.ddlCommitted ? " (" + rollbackNote(sum) + ")" : ", nothing was kept"}. ${first}`,
    };
  if (sum.failed && stopOnError)
    return { kind: "error", title: `${name} failed`, body: `${plural(sum.ok, "statement")} ran, then the run stopped at the error. ${first}` };
  if (sum.failed)
    return {
      kind: "warning",
      title: `${name} finished with errors`,
      body: `${plural(sum.ok, "statement")} ran, ${plural(sum.failed, "statement")} failed. ${first}`,
    };
  return { kind: "success", title: `${name} finished`, body: `${plural(sum.ok, "statement")} ran.` };
}
