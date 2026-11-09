// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LARGE_VALUE_CHARS, LARGE_VALUE_LINES, isLargeValue } from "./size";

const plain = { binary: false, json: false };

describe("isLargeValue", () => {
  it("keeps the compact dialog for short plain text", () => {
    expect(isLargeValue("hello", plain)).toBe(false);
    expect(isLargeValue("", plain)).toBe(false);
  });

  it("opens large for a binary value or a JSON value, whatever their length", () => {
    expect(isLargeValue("x", { binary: true, json: false })).toBe(true);
    expect(isLargeValue("1", { binary: false, json: true })).toBe(true);
  });

  it("opens large for text longer than 2000 characters, not for exactly 2000", () => {
    expect(LARGE_VALUE_CHARS).toBe(2000);
    expect(isLargeValue("a".repeat(2000), plain)).toBe(false);
    expect(isLargeValue("a".repeat(2001), plain)).toBe(true);
  });

  it("opens large for text of more than 20 lines, not for exactly 20", () => {
    expect(LARGE_VALUE_LINES).toBe(20);
    expect(isLargeValue(Array(20).fill("line").join("\n"), plain)).toBe(false);
    expect(isLargeValue(Array(21).fill("line").join("\n"), plain)).toBe(true);
  });

  it("counts a trailing newline as a line", () => {
    expect(isLargeValue(Array(20).fill("line").join("\n") + "\n", plain)).toBe(true);
  });
});
