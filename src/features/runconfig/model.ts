/** Run configurations of type "Database Script": what to run (script text or files) and where (data source / schema). */
import type { Driver } from "../../api/db";

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

/** Last path component. */
export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

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
