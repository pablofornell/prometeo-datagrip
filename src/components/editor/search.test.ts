// @vitest-environment node
import { describe, expect, it } from "vitest";
import { preserveCase } from "./search";

describe("preserve case", () => {
  it("follows the case pattern of the match", () => {
    expect(preserveCase("price", "cost")).toBe("cost");
    expect(preserveCase("PRICE", "cost")).toBe("COST");
    expect(preserveCase("Price", "cost")).toBe("Cost");
    expect(preserveCase("pRiCe", "cost")).toBe("cost");
    expect(preserveCase("123", "Cost")).toBe("Cost");
  });
});
