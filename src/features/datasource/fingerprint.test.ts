// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FINGERPRINT_IGNORED_OPTION_KEYS } from "./model";
import stateRs from "../../../src-tauri/src/state.rs?raw";

describe("connection fingerprint rule", () => {
  it("ignores the same option keys as the backend (VIEW_ONLY_OPTIONS in src-tauri/src/state.rs)", () => {
    const m = stateRs.match(/const VIEW_ONLY_OPTIONS[^=]*=\s*\[([\s\S]*?)\];/);
    expect(m, "backend list VIEW_ONLY_OPTIONS not found").toBeTruthy();
    const backend = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    expect([...FINGERPRINT_IGNORED_OPTION_KEYS].sort()).toEqual(backend);
  });
});
