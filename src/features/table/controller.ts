/** Registry of the mounted table editors, so actions and the close guard can reach the one that is focused. */
import { activeTab } from "../../state/tabs";

export interface TableController {
  tabId: string;
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
  /** Resolves true when the tab may close (nothing pending, or the user chose Submit / Discard). */
  confirmClose: () => Promise<boolean>;
}

const controllers = new Map<string, TableController>();

export function registerController(c: TableController): () => void {
  controllers.set(c.tabId, c);
  return () => {
    if (controllers.get(c.tabId) === c) controllers.delete(c.tabId);
  };
}

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
