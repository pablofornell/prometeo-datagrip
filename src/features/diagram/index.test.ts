// @vitest-environment node
/** The diagram target of the explorer selection: one node as before, several tables of one schema as the tables they name. */
import { describe, expect, it, vi } from "vitest";

const { state, openTab } = vi.hoisted(() => ({
  state: { lead: undefined as unknown, selected: [] as unknown[] },
  openTab: vi.fn(),
}));

vi.mock("../explorer", () => ({
  explorerDataSources: () => [{ id: "ds1", name: "demo" }],
  getSelectedNode: () => state.lead,
  selectedNodes: () => state.selected,
}));
vi.mock("../explorer/actions", () => ({ explorerFocused: () => false }));
vi.mock("./DiagramView", () => ({ DiagramView: () => null }));
vi.mock("../../state/slots", () => ({ registerSlot: () => () => {} }));
vi.mock("../../state/tabs", () => ({ openTab }));

import { diagramTarget, showDiagram } from "./index";

type Info = { id: string; dsId: string; kind: string; name: string; label: string; path: string[]; extra: Record<string, unknown>; objectRef: { schema: string | null; name: string; kind: string } | null };
const info = (name: string, kind = "table", schema: string | null = "public", dsId = "ds1"): Info => ({
  id: `${dsId}/${schema}/${name}`,
  dsId,
  kind,
  name,
  label: name,
  path: [],
  extra: {},
  objectRef: { schema, name, kind },
});

describe("diagram target", () => {
  it("one table draws its schema, as before", () => {
    const t1 = info("t1");
    state.lead = t1;
    state.selected = [t1];
    expect(diagramTarget()).toEqual({ dsId: "ds1", schema: "public" });
  });

  it("several tables of one schema draw just those tables", () => {
    state.selected = [info("t1"), info("t2"), info("v1", "view")];
    expect(diagramTarget()).toEqual({ dsId: "ds1", schema: "public", tables: ["t1", "t2", "v1"] });
  });

  it("tables of two schemas, or a table and another kind of node, have no diagram", () => {
    state.selected = [info("t1"), info("t3", "table", "other")];
    expect(diagramTarget()).toBeNull();
    state.selected = [info("t1"), info("id", "column")];
    expect(diagramTarget()).toBeNull();
  });

  it("tables of two data sources have no diagram", () => {
    state.selected = [info("t1"), info("t2", "table", "public", "ds2")];
    expect(diagramTarget()).toBeNull();
  });

  it("showDiagram opens a tab with the selected tables", () => {
    openTab.mockClear();
    state.selected = [info("t1"), info("t2")];
    showDiagram();
    expect(openTab).toHaveBeenCalledWith({
      id: "diagram:ds1:public:t1,t2",
      kind: "diagram",
      title: "2 tables — Diagram [demo]",
      icon: "dg/schema",
      data: { dsId: "ds1", schema: "public", tables: ["t1", "t2"] },
    });
  });

  it("showDiagram of one table keeps the schema tab", () => {
    openTab.mockClear();
    const t1 = info("t1");
    state.lead = t1;
    state.selected = [t1];
    showDiagram();
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ id: "diagram:ds1:public", title: "public — Diagram [demo]", data: { dsId: "ds1", schema: "public" } }));
  });
});
