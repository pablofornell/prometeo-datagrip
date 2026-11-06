/** Registry of the mounted table editors, so actions and the close guard can reach the one that is focused. */
import { createSignal } from "solid-js";
import type { TxStatus } from "../../api/types";
import { activeTab } from "../../state/tabs";

export interface TableController {
  tabId: string;
  dsId: string;
  title: () => string;
  root: () => HTMLElement | undefined;
  editable: () => boolean;
  pendingCount: () => number;
  submit: () => void;
  revertSelected: () => void;
  addRow: () => void;
  deleteRows: () => void;
  reload: () => void;
  nextPage: () => void;
  prevPage: () => void;
  openDdl: () => void;
  txMode: () => "auto" | "manual";
  /** A transaction is open (`active` or `failed`, as the server reports it). */
  inTx: () => boolean;
  txStatus: () => TxStatus;
  /** Commit / Roll Back; resolves true when the transaction ended (or there was none), false when it did not. */
  endTx: (kind: "commit" | "rollback") => Promise<boolean>;
  commit: () => void;
  rollback: () => void;
  /** Opens the Export Data dialog of the table. */
  exportData: () => void;
  /** Resolves true when the tab may close (nothing pending, or the user chose Submit / Discard). */
  confirmClose: () => Promise<boolean>;
}

const controllers = new Map<string, TableController>();
/** Bumped when an editor registers / unregisters, so `allControllers()` can be read reactively. */
const [registryVersion, setRegistryVersion] = createSignal(0);

export function registerController(c: TableController): () => void {
  controllers.set(c.tabId, c);
  setRegistryVersion((v) => v + 1);
  return () => {
    if (controllers.get(c.tabId) === c) {
      controllers.delete(c.tabId);
      setRegistryVersion((v) => v + 1);
    }
  };
}

export const allControllers = (): TableController[] => (registryVersion(), [...controllers.values()]);
export const controllerOf = (tabId: string) => controllers.get(tabId);

/** The controller of the active tab when it is a table editor and keyboard focus is inside it. */
export function focusedController(): TableController | undefined {
  const t = activeTab();
  if (!t || t.kind !== "table") return undefined;
  const c = controllers.get(t.id);
  const root = c?.root();
  return c && root && root.contains(document.activeElement) ? c : undefined;
}

/** The controller of the active tab when it is a table editor (focus anywhere). */
export function activeController(): TableController | undefined {
  const t = activeTab();
  return t && t.kind === "table" ? controllers.get(t.id) : undefined;
}
