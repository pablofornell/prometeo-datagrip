// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openTab, tabs } from "../../state/tabs";
import { closeStaleTabs } from "./restore";

describe("closeStaleTabs", () => {
  it("closes table / ddl / console tabs of a missing data source and keeps the rest", () => {
    const ref = { schema: "s", name: "t", kind: "table" };
    openTab({ id: "table:ok:s.t", title: "t", kind: "table", data: { dsId: "ok", objectRef: ref } });
    openTab({ id: "table:gone:s.t", title: "t", kind: "table", data: { dsId: "gone", objectRef: ref } });
    openTab({ id: "ddl:gone:s.t", title: "t (DDL)", kind: "ddl", data: { dsId: "gone", objectRef: ref } });
    openTab({ id: "console:gone:console", title: "console", kind: "console", data: { dsId: "gone", consoleName: "console" } });
    openTab({ id: "console:ok:console", title: "console", kind: "console", data: { dsId: "ok", consoleName: "console" } });
    openTab({ id: "table:nodata", title: "broken", kind: "table" });

    const closed = closeStaleTabs(new Set(["ok"]));

    expect(closed.sort()).toEqual(["console:gone:console", "ddl:gone:s.t", "table:gone:s.t", "table:nodata"]);
    expect(tabs().map((t) => t.id).sort()).toEqual(["console:ok:console", "table:ok:s.t"]);
  });
});
