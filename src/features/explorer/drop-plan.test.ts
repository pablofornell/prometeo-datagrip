// @vitest-environment node
/** The "Drop…" of several nodes: the statements in drop order per DBMS, and the snapshot that orders the tables. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Driver, SnapshotObject } from "../../api/db";

const { state, nodes, spies, dropSqlOf } = vi.hoisted(() => {
  // the DROP statement of the objects of these tests (the real generator is per driver; quoting is the same idea)
  const dropSqlOf = (d: { driver: string; kind: string; name: string; extra: { schema?: string } }) => {
    const q = (s: string) => (d.driver === "mysql" ? "`" + s + "`" : '"' + s + '"');
    const qn = `${d.extra.schema ? `${q(d.extra.schema)}.` : ""}${q(d.name)}`;
    if (d.kind === "table") return `DROP TABLE ${qn}`;
    if (d.kind === "view") return `DROP VIEW ${qn}`;
    if (d.kind === "sequence") return `DROP SEQUENCE ${qn}`;
    return null;
  };
  return {
    state: { selected: [] as unknown[], objects: [] as SnapshotObject[], error: undefined as string | undefined },
    nodes: new Map<string, unknown>(),
    spies: {
      setDialog: vi.fn(),
      notify: vi.fn(),
      loadSnapshot: vi.fn(),
    },
    dropSqlOf,
  };
});

vi.mock("../../components/ui", () => ({ openMenu: () => {}, notify: spies.notify }));
vi.mock("../datasource/widgets", () => ({ COLORS: [], swatch: () => "" }));
vi.mock("./QuickDoc", () => ({ showQuickDoc: () => {} }));
vi.mock("../import/target", () => ({ importTargetOf: () => null }));
vi.mock("../schema-editor", () => ({ canModify: () => false, modifyObject: () => {}, newObjectOf: () => {}, newObjectTypes: () => [], newTable: () => {} }));
vi.mock("../../state/tabs", () => ({ activeTab: () => undefined }));
vi.mock("../../state/theme", () => ({ theme: () => "dark" }));
vi.mock("../../state/ds-folders", () => ({ dsFolders: () => [], dsGroupOf: () => undefined }));
vi.mock("./icons", () => ({ LOCAL: "x:", localIconUrl: () => "", providerIcon: () => "" }));
vi.mock("./schema", () => ({
  loadSchemaSnapshot: (...args: unknown[]) => {
    spies.loadSnapshot(...args);
    return Promise.resolve(state.objects);
  },
  schemaSnapshotErrorFor: () => state.error,
}));

vi.mock("./commands", () => ({
  canDrop: () => true,
  canRename: () => false,
  copyDdl: () => {},
  dataSourceDialogAvailable: () => false,
  ddlToConsole: () => {},
  deactivate: () => {},
  dataSourceProperties: () => {},
  dropSqlOf,
  duplicateDs: () => {},
  isTableLike: () => false,
  isTableRelated: () => false,
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
  writeClipboard: () => {},
}));

vi.mock("./core", () => ({
  connected: () => new Set(["ds1"]),
  controller: () => undefined,
  dataSources: () => [],
  expandAllLoaded: () => {},
  isDsFolder: () => false,
  nodes,
  refreshNodes: () => {},
  revealObject: () => {},
  selectedNode: () => state.selected[0],
  selectedTreeNodes: () => state.selected,
  colorOfNode: () => undefined,
  setNodeColor: () => {},
}));

import { getAction, registerAction } from "../../state/actions";
import { dropPlanOf, registerExplorerActions } from "./actions";
import type { ENode } from "./model";

/** A tree node; `parentId` links it to its container (a schema) or a folder under it. */
const node = (driver: Driver, id: string, kind: string, name: string, parentId: string | undefined, extra: Record<string, unknown> = {}): ENode => {
  const n = { id, label: name, data: { dsId: "ds1", kind, name, path: [], extra, driver, parentId } } as unknown as ENode;
  nodes.set(id, n);
  return n;
};

/** A snapshot table of schema `schema` that references the tables `refs` (same schema). */
const snap = (schema: string, name: string, refs: string[] = []): SnapshotObject => ({
  schema,
  name,
  kind: "table",
  columns: [],
  foreignKeys: refs.map((r) => ({ name: `fk_${name}_${r}`, columns: ["x"], refSchema: schema, refTable: r, refColumns: ["id"] })),
});

/** The tree of one data source of `driver`: schema `S` with tables parent, child, other; view v; sequence seq. */
function tree(driver: Driver) {
  node(driver, "ds1", "dataSource", "demo", undefined);
  node(driver, "S", "schema", "S", "ds1");
  node(driver, "S/tables", "folder", "tables", "S", { folder: "tables" });
  node(driver, "S/views", "folder", "views", "S", { folder: "views" });
  node(driver, "S/seq", "folder", "sequences", "S", { folder: "sequences" });
  const t = (id: string, name: string) => node(driver, id, "table", name, "S/tables", { schema: "S" });
  return {
    parent: t("S/tables/parent", "PARENT"),
    child: t("S/tables/child", "CHILD"),
    other: t("S/tables/other", "OTHER"),
    a: t("S/tables/a", "A"),
    b: t("S/tables/b", "B"),
    view: node(driver, "S/views/v", "view", "V", "S/views", { schema: "S" }),
    seq: node(driver, "S/seq/seq", "sequence", "SEQ", "S/seq", { schema: "S" }),
  };
}

beforeAll(() => {
  registerExplorerActions();
  registerAction({ id: "dump.sqlFile", title: "Dump to SQL File…", run: () => {} });
});

describe("drop plan of several objects, per DBMS", () => {
  it("Oracle: a child table goes before its parent, whatever the selection order", () => {
    const { parent, child } = tree("oracle");
    const objects = [snap("S", "PARENT"), snap("S", "CHILD", ["PARENT"])];
    expect(dropPlanOf([parent, child], objects)?.sql).toBe('DROP TABLE "S"."CHILD";\nDROP TABLE "S"."PARENT"');
    expect(dropPlanOf([child, parent], objects)?.sql).toBe('DROP TABLE "S"."CHILD";\nDROP TABLE "S"."PARENT"');
  });

  it("Oracle: a cycle of tables drops each table with CASCADE CONSTRAINTS, after the tables that reference the cycle", () => {
    const { a, b, child } = tree("oracle");
    const objects = [snap("S", "A", ["B"]), snap("S", "B", ["A"]), snap("S", "CHILD", ["A"])];
    expect(dropPlanOf([a, b, child], objects)?.sql).toBe(
      'DROP TABLE "S"."CHILD";\nDROP TABLE "S"."A" CASCADE CONSTRAINTS;\nDROP TABLE "S"."B" CASCADE CONSTRAINTS',
    );
  });

  it("PostgreSQL: a cycle of tables is one DROP TABLE statement without CASCADE", () => {
    const { a, b } = tree("postgres");
    expect(dropPlanOf([a, b], [snap("S", "A", ["B"]), snap("S", "B", ["A"])])?.sql).toBe('DROP TABLE "S"."A", "S"."B"');
  });

  it("MySQL: a cycle of tables is one DROP TABLE statement", () => {
    const { a, b } = tree("mysql");
    expect(dropPlanOf([a, b], [snap("S", "A", ["B"]), snap("S", "B", ["A"])])?.sql).toBe("DROP TABLE `S`.`A`, `S`.`B`");
  });

  it("SQLite: a cycle is dropped one table at a time", () => {
    const { a, b } = tree("sqlite");
    expect(dropPlanOf([a, b], [snap("S", "A", ["B"]), snap("S", "B", ["A"])])?.sql).toBe('DROP TABLE "S"."A";\nDROP TABLE "S"."B"');
  });

  it("views go first and the sequence last, after the tables", () => {
    const { seq, child, parent, view } = tree("oracle");
    const objects = [snap("S", "PARENT"), snap("S", "CHILD", ["PARENT"])];
    expect(dropPlanOf([seq, parent, child, view], objects)?.sql).toBe(
      'DROP VIEW "S"."V";\nDROP TABLE "S"."CHILD";\nDROP TABLE "S"."PARENT";\nDROP SEQUENCE "S"."SEQ"',
    );
  });

  it("without a snapshot the tables keep the tree order", () => {
    const { parent, child } = tree("postgres");
    expect(dropPlanOf([parent, child])?.sql).toBe('DROP TABLE "S"."PARENT";\nDROP TABLE "S"."CHILD"');
  });
});

describe("Drop of several tables loads the snapshot that orders them", () => {
  it("two tables: the schema snapshot is loaded and the dialog lists the child first", async () => {
    const { parent, child } = tree("oracle");
    state.selected = [parent, child];
    state.objects = [snap("S", "PARENT"), snap("S", "CHILD", ["PARENT"])];
    state.error = undefined;
    spies.setDialog.mockClear();
    spies.loadSnapshot.mockClear();
    getAction("db.drop")!.run!();
    await new Promise((r) => setTimeout(r, 0));
    expect(spies.loadSnapshot).toHaveBeenCalledWith("ds1", "S");
    expect(spies.setDialog).toHaveBeenCalledWith({ kind: "drop", node: parent, sql: 'DROP TABLE "S"."CHILD";\nDROP TABLE "S"."PARENT"', what: "2 objects" });
  });

  it("a table and a view do not need the snapshot", async () => {
    const { parent, view } = tree("oracle");
    state.selected = [parent, view];
    spies.loadSnapshot.mockClear();
    spies.setDialog.mockClear();
    getAction("db.drop")!.run!();
    expect(spies.loadSnapshot).not.toHaveBeenCalled();
    expect(spies.setDialog).toHaveBeenCalledWith(expect.objectContaining({ kind: "drop", sql: 'DROP VIEW "S"."V";\nDROP TABLE "S"."PARENT"' }));
  });

  it("when the snapshot cannot be read, nothing is dropped and the error is shown", async () => {
    const { parent, child } = tree("oracle");
    state.selected = [parent, child];
    state.objects = [];
    state.error = "ORA-00942: table or view does not exist";
    spies.setDialog.mockClear();
    spies.notify.mockClear();
    getAction("db.drop")!.run!();
    await new Promise((r) => setTimeout(r, 0));
    expect(spies.setDialog).not.toHaveBeenCalled();
    expect(spies.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", body: "ORA-00942: table or view does not exist" }));
    state.error = undefined;
  });
});
