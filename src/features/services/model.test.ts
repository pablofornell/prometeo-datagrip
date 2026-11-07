import { describe, expect, it } from "vitest";
import { ROOT_ID, buildTree, consoleNodeId, dataSourceInfo, dbmsLine, dsNodeId, expandableIds, sessionNodeId } from "./model";

const pg = { id: "pg", name: "postgres@localhost", driver: "postgres" as const };
const lite = { id: "lite", name: "ux-sample.db", driver: "sqlite" as const };
const sess = { tabId: "console:pg:console", dsId: "pg", name: "console", ms: 30452 };

describe("buildTree", () => {
  it("nests Database > data source > session > console", () => {
    const [root] = buildTree([pg, lite], new Set(["pg"]), [sess], true);
    expect(root.id).toBe(ROOT_ID);
    expect(root.children!.map((c) => c.id)).toEqual([dsNodeId("pg"), dsNodeId("lite")]);
    const s = root.children![0].children![0];
    expect(s.id).toBe(sessionNodeId(sess.tabId));
    expect(s.hint).toBe("30 s 452 ms");
    expect(s.children![0].id).toBe(consoleNodeId(sess.tabId));
  });

  it("sessions only hang under connected data sources, and inactive ones can be hidden", () => {
    const [root] = buildTree([pg, lite], new Set(), [sess], false);
    expect(root.children).toEqual([]);
    expect(root.hasChildren).toBe(false);
    const [all] = buildTree([pg], new Set(), [sess], true);
    expect(all.children![0].children).toEqual([]);
    expect(all.children![0].data.connected).toBe(false);
  });

  it("has no duration hint before something ran", () => {
    const [root] = buildTree([pg], new Set(["pg"]), [{ ...sess, ms: null }], true);
    expect(root.children![0].children![0].hint).toBeUndefined();
  });

  it("lists the nodes to expand", () => {
    const tree = buildTree([pg, lite], new Set(["pg"]), [sess], true);
    expect(expandableIds(tree)).toEqual([ROOT_ID, dsNodeId("pg"), sessionNodeId(sess.tabId)]);
  });
});

describe("information", () => {
  it("formats the DBMS line", () => {
    expect(dbmsLine("PostgreSQL", "PostgreSQL 16.15 (Debian 16.15-1)")).toBe("PostgreSQL (ver. 16.15 (Debian 16.15-1))");
    expect(dbmsLine("SQLite", "3.45.1")).toBe("SQLite (ver. 3.45.1)");
    expect(dbmsLine("MySQL", null)).toBe("not connected");
  });

  it("reports the dialect, case sensitivity and driver of the DBMS", () => {
    const rows = dataSourceInfo({ driver: "postgres", options: {} }, "PostgreSQL 16.4");
    expect(rows[0]).toEqual([{ label: "Dialect", value: "PostgreSQL" }]);
    expect(rows[1].map((r) => r.label)).toEqual(["DBMS", "Case sensitivity", "Driver"]);
    expect(rows[1][1].value).toBe("plain=lower, delimited=exact");
    expect(dataSourceInfo({ driver: "mysql", options: { dbms: "mariadb" } }, null)[0][0].value).toBe("MariaDB");
  });
});
