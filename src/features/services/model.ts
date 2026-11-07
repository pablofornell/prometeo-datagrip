/** Pure logic of the Services tool window: the tree (Database › data source › session › console) and the Information text. */
import type { DataSource, Driver } from "../../api/db";
import type { TreeItem } from "../../components/ui/Tree";
import { formatDuration } from "../output/format";

export type SvcKind = "root" | "ds" | "session" | "console";

export interface SvcData {
  kind: SvcKind;
  dsId?: string;
  /** Editor tab id of the console that owns the session. */
  tabId?: string;
  driver?: Driver;
  connected?: boolean;
}

export interface SvcItem extends TreeItem {
  data: SvcData;
  children?: SvcItem[];
}

/** An open DB session of a console. */
export interface SvcSession {
  tabId: string;
  dsId: string;
  /** Console name (`console`, `console_1`). */
  name: string;
  /** Duration of the last execution, null until something ran. */
  ms: number | null;
}

export const ROOT_ID = "svc:root";
export const dsNodeId = (dsId: string): string => "svc:ds:" + dsId;
export const sessionNodeId = (tabId: string): string => "svc:session:" + tabId;
export const consoleNodeId = (tabId: string): string => "svc:console:" + tabId;

const durationHint = (ms: number | null): string | undefined => (ms == null ? undefined : formatDuration(ms));

/** The tree: only data sources that are connected carry sessions; `showInactive` lists the others as well. */
export function buildTree(
  sources: readonly Pick<DataSource, "id" | "name" | "driver">[],
  connected: ReadonlySet<string>,
  sessions: readonly SvcSession[],
  showInactive: boolean,
): SvcItem[] {
  const dsItems: SvcItem[] = [];
  for (const ds of sources) {
    const on = connected.has(ds.id);
    if (!on && !showInactive) continue;
    const own = on ? sessions.filter((s) => s.dsId === ds.id) : [];
    dsItems.push({
      id: dsNodeId(ds.id),
      label: ds.name,
      hasChildren: own.length > 0,
      data: { kind: "ds", dsId: ds.id, driver: ds.driver, connected: on },
      children: own.map<SvcItem>((s) => ({
        id: sessionNodeId(s.tabId),
        label: s.name,
        hint: durationHint(s.ms),
        hasChildren: true,
        data: { kind: "session", dsId: s.dsId, tabId: s.tabId, driver: ds.driver, connected: true },
        children: [
          {
            id: consoleNodeId(s.tabId),
            label: s.name,
            hint: durationHint(s.ms),
            data: { kind: "console", dsId: s.dsId, tabId: s.tabId, driver: ds.driver, connected: true },
          },
        ],
      })),
    });
  }
  return [{ id: ROOT_ID, label: "Database", hasChildren: dsItems.length > 0, data: { kind: "root" }, children: dsItems }];
}

/** Ids of the nodes that have children (to expand them when they appear). */
export function expandableIds(items: readonly SvcItem[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly SvcItem[]) => {
    for (const it of list) {
      if (it.hasChildren) out.push(it.id);
      if (it.children) walk(it.children);
    }
  };
  walk(items);
  return out;
}

const DIALECT: Record<Driver, { label: string; case: string; driver: string }> = {
  postgres: { label: "PostgreSQL", case: "plain=lower, delimited=exact", driver: "PostgreSQL driver (sqlx)" },
  mysql: { label: "MySQL", case: "plain=exact, delimited=exact", driver: "MySQL driver (sqlx)" },
  sqlite: { label: "SQLite", case: "plain=mixed, delimited=mixed", driver: "SQLite driver (sqlx)" },
  oracle: { label: "Oracle", case: "plain=upper, delimited=exact", driver: "Oracle thin driver (oracledb)" },
};

/** `PostgreSQL 16.15 (Debian ...)` -> `PostgreSQL (ver. 16.15 (Debian ...))`. */
export function dbmsLine(label: string, serverVersion: string | null | undefined): string {
  if (!serverVersion) return "not connected";
  if (serverVersion === "…") return serverVersion;
  const rest = serverVersion.startsWith(label) ? serverVersion.slice(label.length).trim() : serverVersion.trim();
  return rest ? `${label} (ver. ${rest})` : label;
}

export interface InfoRow {
  label: string;
  value: string;
}

/** The "Information" tab of a data source: Dialect, then DBMS / Case sensitivity / Driver. */
export function dataSourceInfo(ds: Pick<DataSource, "driver" | "options">, serverVersion: string | null | undefined): InfoRow[][] {
  const base = DIALECT[ds.driver];
  const label = ds.driver === "mysql" && ds.options?.dbms === "mariadb" ? "MariaDB" : base.label;
  return [
    [{ label: "Dialect", value: label }],
    [
      { label: "DBMS", value: dbmsLine(label, serverVersion) },
      { label: "Case sensitivity", value: base.case },
      { label: "Driver", value: base.driver },
    ],
  ];
}
