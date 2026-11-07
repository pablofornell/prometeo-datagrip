// @vitest-environment node
/** The explorer's keymap (DataGrip keymap, datagrip-map §9): which shortcut belongs to which action. */
import { describe, expect, it, vi } from "vitest";

const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => undefined) }) }));
vi.mock("../../components/ui", () => ({ openMenu: () => {}, ...stub() }));
vi.mock("../datasource/widgets", () => ({ COLORS: [], swatch: () => "" }));
vi.mock("./commands", () => stub());
vi.mock("./core", () => ({ ...(stub() as object), dataSources: () => [], connected: () => new Set(), selectedNode: () => undefined, controller: () => undefined }));
vi.mock("./QuickDoc", () => ({ showQuickDoc: () => {} }));
vi.mock("../import/target", () => ({ importTargetOf: () => null }));
vi.mock("../schema-editor", () => ({ canModify: () => false, modifyObject: () => {}, newObjectOf: () => {}, newObjectTypes: () => [], newTable: () => {} }));
vi.mock("../../state/tabs", () => ({ activeTab: () => undefined }));
vi.mock("../../state/theme", () => ({ theme: () => "dark" }));
vi.mock("../../state/ds-folders", () => ({ dsFolders: () => [], dsGroupOf: () => undefined }));
vi.mock("./icons", () => ({ LOCAL: "x:", localIconUrl: () => "", providerIcon: () => "" }));

import { getAction } from "../../state/actions";
import { registerExplorerActions } from "./actions";

registerExplorerActions();
const shortcuts = (id: string): string[] => {
  const s = getAction(id)?.shortcut;
  return s === undefined ? [] : Array.isArray(s) ? s : [s];
};

describe("explorer shortcuts", () => {
  it("Generate DDL to Clipboard / Query Console", () => {
    expect(shortcuts("db.copyDdl")).toContain("Ctrl+Alt+Shift+G");
    expect(shortcuts("db.ddlToConsole")).toEqual(["Ctrl+Alt+Shift+B"]);
  });
  it("Select in Database Explorer works from anywhere", () => {
    expect(shortcuts("explorer.locate")).toEqual(["Alt+Shift+B"]);
    expect(getAction("explorer.locate")?.when).toBeUndefined();
  });
  it("the tree-only keys are guarded by the explorer focus", () => {
    for (const id of ["db.copyDdl", "db.ddlToConsole", "db.refresh", "db.rename", "db.new", "db.modifyObject"]) expect(getAction(id)?.when, id).toBeTypeOf("function");
  });
  it("the keys that were already there", () => {
    expect(shortcuts("db.new")).toEqual(["Alt+Insert"]);
    expect(shortcuts("db.modifyObject")).toEqual(["Ctrl+F6"]);
    expect(shortcuts("db.refresh")).toEqual(["Ctrl+F5"]);
    expect(shortcuts("db.gotoDdl")).toEqual(["Ctrl+B"]);
  });
});
