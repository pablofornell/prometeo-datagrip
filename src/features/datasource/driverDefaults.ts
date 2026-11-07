/**
 * Driver-level defaults (Drivers page > Options): the connection options a NEW data source of that driver starts
 * with. Kept in the UI state; data sources that exist are not touched.
 */
import { loadLocal, saveUiState } from "../../state/persist";
import type { Dbms } from "./drivers";

export interface DriverDefaults {
  /** "manual": new consoles start in manual transaction mode. */
  txMode?: "manual";
  /** Seconds, as a string like the data source options. */
  keepAliveSec?: string;
  autoDisconnectSec?: string;
}

const KEY = "driverDefaults";
let cache: Partial<Record<Dbms, DriverDefaults>> | undefined;
const all = () => (cache ??= loadLocal<Partial<Record<Dbms, DriverDefaults>>>(KEY, {}));

export const driverDefaults = (dbms: Dbms): DriverDefaults => all()[dbms] ?? {};

export function setDriverDefaults(dbms: Dbms, value: DriverDefaults): void {
  cache = { ...all(), [dbms]: value };
  saveUiState(KEY, cache);
}

/** The `options` entries a new data source of `dbms` starts with. */
export function defaultOptions(dbms: Dbms): Record<string, string> {
  const d = driverDefaults(dbms);
  const out: Record<string, string> = {};
  if (d.txMode) out.txMode = d.txMode;
  if (d.keepAliveSec) out.keepAliveSec = d.keepAliveSec;
  if (d.autoDisconnectSec) out.autoDisconnectSec = d.autoDisconnectSec;
  return out;
}

/** Tests: forget the in-memory copy. */
export function resetDriverDefaults(): void {
  cache = undefined;
}
