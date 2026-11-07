import { describe, expect, it } from "vitest";
import { parseEdit, validateEdit } from "./format";

describe("validateEdit", () => {
  it("accepts numbers and an empty text (NULL) in a numeric column", () => {
    for (const t of ["", "0", "-12", "+3.5", ".5", "1e3", " 42 ", "NaN", "-Infinity"]) expect(validateEdit(t, "number")).toBeNull();
  });

  it("refuses a blank or non-numeric text in a numeric column instead of saving NULL", () => {
    expect(validateEdit(" ", "number")).toMatch(/number is expected/);
    expect(validateEdit("12abc", "number")).toBe('"12abc" is not a valid number');
    expect(validateEdit("1,5", "number")).toMatch(/not a valid number/);
  });

  it("does not check the other kinds", () => {
    for (const k of ["text", "bool", "date", "json", "other"] as const) expect(validateEdit(" x ", k)).toBeNull();
  });

  it("agrees with parseEdit: an accepted number parses to a number", () => {
    expect(parseEdit("42", "number")).toBe(42);
    expect(parseEdit("", "number")).toBeNull();
  });
});
