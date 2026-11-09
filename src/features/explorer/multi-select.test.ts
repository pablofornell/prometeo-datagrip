// @vitest-environment node
/** Explorer actions with one node and with several selected nodes (the enablement of menus and shortcuts, and what they run). */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../../components/ui";

const { state, nodes, spies, dropSqlOf, isTable } = vi.hoisted(() => {
  // Drop SQL of the test objects: tables and views only (the real generator is per driver)
  const dropSqlOf = (d: { kind: string; name: string }) => (d.kind === "table" ? `DROP TABLE ${d.name}` : d.kind === "view" ? `DROP VIEW ${d.name}` : null);
  const isTable = (n: { data: { kind: string } } | undefined) => !!n && n.data.kind === "table";
  return {
    state: { selected: [] as unknown[] },
    nodes: new Map<string, unknown>(),
    spies: {
      refreshNodes: vi.fn(),
      writeClipboard: vi.fn(),
      setDialog: vi.fn(),
      dumpSqlFile: vi.fn(),
    },
    dropSqlOf,
    isTable,
  };
});

vi.mock("../../components/ui", () => ({ openMenu: () => {} }));
vi.mock("../datasource/widgets", () => ({ COLORS: [], swatch: () => "" }));
vi.mock("./QuickDoc", () => ({ showQuickDoc: () => {} }));
vi.mock("../import/target", () => ({ importTargetOf: () => null }));
vi.mock("../schema-editor", () => ({ canModify: () => false, modifyObject: () => {}, newObjectOf: () => {}, newObjectTypes: () => [], newTable: () => {} }));
vi.mock("../../state/tabs", () => ({ activeTab: () => undefined }));
vi.mock("../../state/theme", () => ({ theme: () => "dark" }));
vi.mock("../../state/ds-folders", () => ({ dsFolders: () => [], dsGroupOf: () => undefined }));
vi.mock("./icons", () => ({ LOCAL: "x:", localIconUrl: () => "", providerIcon: () => "" }));

vi.mock("./commands", () => ({
  canDrop: (n: { data: { kind: string; name: string } } | undefined) => !!n && (n.data.kind === "dataSource" || dropSqlOf(n.data) !== null),
  canRename: (n: { data: { kind: string } } | undefined) => isTable(n),
  copyDdl: () => {},
  dataSourceDialogAvailable: () => false,
  ddlToConsole: () => {},
  deactivate: () => {},
  dataSourceProperties: () => {},
  dropSqlOf,
  duplicateDs: () => {},
  isTableLike: (n: { data: { kind: string } } | undefined) => isTable(n),
  isTableRelated: (n: { data: { kind: string } } | undefined) => isTable(n),
  jumpToConsole: () => {},
  moveDataSource: () => {},
  newConsole: () => {},
  newDataSource: () => {},
  newDataSourceFromUrl: () => {},
  newFolder: () => {},
  openDdl: () => {},
  openDrivers: () => {},
  openTable: () => {},
  removeFolder: () => {},
  renameFolder: () => {},
  requestDrop: () => {},
  setDialog: spies.setDialog,
  startRename: () => {},
  updateDataSource: async () => true,
  writeClipboard: spies.writeClipboard,
}));

vi.mock("./core", () => ({
  connected: () => new Set(["ds1"]),
  controller: () => undefined,
  dataSources: () => [],
  expandAllLoaded: () => {},
  isDsFolder: (n: { data: { extra: { dsFolder?: boolean } } } | undefined) => !!n?.data.extra.dsFolder,
  nodes,
  refreshNodes: spies.refreshNodes,
  revealObject: () => {},
  selectedNode: () => state.selected[0],
  selectedTreeNodes: () => state.selected,
  colorOfNode: () => undefined,
  setNodeColor: () => {},
}));

import { getAction, isActionEnabled, registerAction } from "../../state/actions";
import { contextMenuItems, dropPlanOf, registerExplorerActions } from "./actions";
import type { ENode } from "./model";

/** A node of the test tree: data source ds1 > schema public > tables folder > tables t1, t2; view v1; schema other > t3. */
const node = (id: string, kind: string, name: string, parentId: string | undefined, extra: Record<string, unknown> = {}): ENode => {
  const n = { id, label: name, data: { dsId: "ds1", kind, name, path: [], extra, driver: "postgres", parentId } } as unknown as ENode;
  nodes.set(id, n);
  return n;
};
const ds = node("ds1", "dataSource", "demo", undefined);
node("public", "schema", "public", "ds1");
node("other", "schema", "other", "ds1");
node("public/tables", "folder", "tables", "public", { folder: "tables" });
node("public/views", "folder", "views", "public", { folder: "views" });
node("other/tables", "folder", "tables", "other", { folder: "tables" });
const t1 = node("public/tables/t1", "table", "t1", "public/tables", { schema: "public" });
const t2 = node("public/tables/t2", "table", "t2", "public/tables", { schema: "public" });
const v1 = node("public/views/v1", "view", "v1", "public/views", { schema: "public" });
const t3 = node("other/tables/t3", "table", "t3", "other/tables", { schema: "other" });

const enabled = (id: string): boolean => isActionEnabled(getAction(id));
/** How the menu decides it (Menu.tsx resolve): own `enabled`, the action's when there is one, and an item needs something to run. */
const itemEnabled = (it: MenuItem): boolean => {
  if (it.type === "separator" || it.type === "header" || it.type === "hint") return false;
  const a = it.action ? getAction(it.action) : undefined;
  const own = typeof it.enabled === "function" ? it.enabled() : (it.enabled ?? true);
  if (!it.children?.length && !it.action && !it.run) return false;
  return own && (it.action ? isActionEnabled(a) : true);
};
const labelOf = (it: MenuItem): string => ("label" in it && it.label) || (it.type === undefined && it.action ? getAction(it.action)?.title ?? "" : "");
/** The first item (searching the submenus too) with this label. */
function find(items: MenuItem[], label: string): MenuItem | undefined {
  for (const it of items) {
    if (it.type === "separator" || it.type === "header" || it.type === "hint") continue;
    if (labelOf(it) === label) return it;
    const inner = it.children ? find(it.children, label) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

beforeAll(() => {
  registerExplorerActions();
  // the dump feature registers `dump.sqlFile`; the menu hands it the target
  registerAction({ id: "dump.sqlFile", title: "Dump to SQL File…", run: spies.dumpSqlFile });
});

describe("explorer actions: one node", () => {
  it("the actions of a single table are enabled", () => {
    state.selected = [t1];
    for (const id of ["db.copyName", "db.copyReference", "db.refresh", "db.editData", "db.gotoDdl", "db.drop", "db.copyDdl", "db.rename", "db.quickDoc", "db.new"]) {
      expect(enabled(id), id).toBe(true);
    }
  });

  it("the single table menu keeps its items enabled", () => {
    state.selected = [t1];
    const items = contextMenuItems(t1, [t1]);
    expect(itemEnabled(find(items, "New")!)).toBe(true);
    expect(itemEnabled(find(items, "Drop…")!)).toBe(true);
    expect(itemEnabled(find(items, "Import/Export")!)).toBe(true);
    expect(itemEnabled(find(items, "Dump to SQL File…")!)).toBe(true);
  });

  it("a node that is not in the selection is a single-node menu, whatever the selection holds", () => {
    state.selected = [t1, t2];
    const items = contextMenuItems(t3, [t1, t2]);
    expect(itemEnabled(find(items, "New")!)).toBe(true);
    expect(itemEnabled(find(items, "Drop…")!)).toBe(true);
  });
});

describe("explorer actions: several nodes", () => {
  it("the actions that work on several nodes are enabled for two tables of one schema", () => {
    state.selected = [t1, t2];
    expect(enabled("db.copyName")).toBe(true);
    expect(enabled("db.copyReference")).toBe(true);
    expect(enabled("db.refresh")).toBe(true);
    expect(enabled("db.drop")).toBe(true);
  });

  it("the actions that work on one node only are disabled", () => {
    state.selected = [t1, t2];
    for (const id of ["db.editData", "db.gotoDdl", "db.rename", "db.copyDdl", "db.ddlToConsole", "db.quickDoc", "db.new", "db.modifyObject", "db.duplicateDataSource"]) {
      expect(enabled(id), id).toBe(false);
    }
  });

  it("the menu disables the one-node items and keeps Drop, Dump and Copy enabled", () => {
    state.selected = [t1, t2];
    const items = contextMenuItems(t1, [t1, t2]);
    expect(itemEnabled(find(items, "New")!)).toBe(false);
    expect(itemEnabled(find(items, "Edit Data")!)).toBe(false);
    expect(itemEnabled(find(items, "Import/Export")!)).toBe(false);
    expect(itemEnabled(find(items, "Copy Name")!)).toBe(true);
    expect(itemEnabled(find(items, "Drop…")!)).toBe(true);
    expect(itemEnabled(find(items, "Dump to SQL File…")!)).toBe(true);
  });

  it("Dump to SQL File… on several tables dumps just those tables", () => {
    state.selected = [t1, t2];
    spies.dumpSqlFile.mockClear();
    (find(contextMenuItems(t1, [t1, t2]), "Dump to SQL File…") as { run: () => void }).run();
    expect(spies.dumpSqlFile).toHaveBeenCalledWith(expect.objectContaining({ dsId: "ds1", schema: "public", driver: "postgres", tables: ["t1", "t2"] }));
  });

  it("tables of two schemas cannot be dumped together", () => {
    state.selected = [t1, t3];
    const items = contextMenuItems(t1, [t1, t3]);
    expect(find(items, "Dump to SQL File…")).toBeUndefined();
  });

  it("Refresh runs on each selected node", () => {
    state.selected = [t1, t2];
    spies.refreshNodes.mockClear();
    getAction("db.refresh")!.run!();
    expect(spies.refreshNodes).toHaveBeenCalledWith([t1, t2]);
  });

  it("Copy Name and Copy Reference put one name per line", () => {
    state.selected = [t1, t2];
    spies.writeClipboard.mockClear();
    getAction("db.copyName")!.run!();
    expect(spies.writeClipboard).toHaveBeenLastCalledWith("t1\nt2");
    getAction("db.copyReference")!.run!();
    expect(spies.writeClipboard).toHaveBeenLastCalledWith("public.t1\npublic.t2");
  });

  it("a folder or a data source in the selection cannot be dropped with the objects", () => {
    state.selected = [t1, ds];
    expect(enabled("db.drop")).toBe(false);
    expect(dropPlanOf([t1, ds])).toBeUndefined();
  });
});

describe("explorer drop of several nodes", () => {
  it("one DROP per object, views before tables, and one confirmation", () => {
    const plan = dropPlanOf([t2, t1, v1]);
    expect(plan).toEqual({ node: t2, sql: "DROP VIEW v1;\nDROP TABLE t2;\nDROP TABLE t1", what: "3 objects" });
  });

  it("the tables of one schema keep the tree order", () => {
    expect(dropPlanOf([t1, t2])?.sql).toBe("DROP TABLE t1;\nDROP TABLE t2");
  });

  it("nodes of two schemas, or a single node, have no plan of their own", () => {
    expect(dropPlanOf([t1, t3])).toBeUndefined();
    expect(dropPlanOf([t1])).toBeUndefined();
  });

  it("Drop opens the confirmation of all of them", () => {
    state.selected = [t1, v1];
    spies.setDialog.mockClear();
    getAction("db.drop")!.run!();
    expect(spies.setDialog).toHaveBeenCalledWith({ kind: "drop", node: t1, sql: "DROP VIEW v1;\nDROP TABLE t1", what: "2 objects" });
  });
});
