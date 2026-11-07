// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/db", () => ({ getUiState: async () => undefined, setUiState: async () => undefined }));

import { defaultOptions, driverDefaults, resetDriverDefaults, setDriverDefaults } from "./driverDefaults";

beforeEach(() => resetDriverDefaults());

describe("driver defaults", () => {
  it("start empty and give new data sources no options", () => {
    expect(driverDefaults("postgres")).toEqual({});
    expect(defaultOptions("postgres")).toEqual({});
  });
  it("become the options of new data sources of that driver only", () => {
    setDriverDefaults("postgres", { txMode: "manual", keepAliveSec: "60" });
    expect(defaultOptions("postgres")).toEqual({ txMode: "manual", keepAliveSec: "60" });
    expect(defaultOptions("mysql")).toEqual({});
  });
});
