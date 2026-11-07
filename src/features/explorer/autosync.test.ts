// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("./core", () => ({ dsOf: () => undefined, refreshNode: () => {} }));

import { changesSchema } from "./autosync";

describe("changesSchema", () => {
  it("sees DDL anywhere in a script", () => {
    expect(changesSchema("create table t (id int)")).toBe(true);
    expect(changesSchema("select 1;\n  DROP TABLE t;")).toBe(true);
    expect(changesSchema("alter table t add c int")).toBe(true);
    expect(changesSchema("comment on table t is 'x'")).toBe(true);
  });
  it("ignores queries, DML and DDL words inside text or comments", () => {
    expect(changesSchema("select * from t where a = 'create table x'")).toBe(false);
    expect(changesSchema("-- drop table t\nselect 1")).toBe(false);
    expect(changesSchema("/* create */ insert into t values (1)")).toBe(false);
    expect(changesSchema("select \"drop\" from t")).toBe(false);
    expect(changesSchema("update t set created = 1")).toBe(false);
  });
});
