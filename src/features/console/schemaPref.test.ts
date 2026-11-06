// @vitest-environment node
import { describe, expect, it } from "vitest";
import { savedSchema, saveSchema } from "./schemaPref";

describe("console schema preference", () => {
  it("is kept per data source and console, and can be forgotten", () => {
    expect(savedSchema("pg", "console")).toBeNull();
    saveSchema("pg", "console", "sales");
    saveSchema("pg", "console_1", "inventory");
    saveSchema("my", "console", "demo");
    expect(savedSchema("pg", "console")).toBe("sales");
    expect(savedSchema("pg", "console_1")).toBe("inventory");
    expect(savedSchema("my", "console")).toBe("demo");
    saveSchema("pg", "console", null);
    expect(savedSchema("pg", "console")).toBeNull();
    expect(savedSchema("pg", "console_1")).toBe("inventory");
  });
});
