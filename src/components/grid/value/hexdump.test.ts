import { describe, expect, it } from "vitest";
import { HEX_ROW_BYTES, hexRow, hexRowCount } from "./hexdump";

describe("hexRow", () => {
  it("prints offset, hex (grouped by eight) and ASCII", () => {
    const bytes = Uint8Array.from([0x41, 0x00, 0xff, 0x20, 0x7e, 0x7f, 0x0a, 0x42]);
    const row = hexRow(bytes, 0);
    expect(row.offset).toBe("00000000");
    expect(row.hex).toBe("41 00 ff 20 7e 7f 0a 42  " + Array(8).fill("  ").join(" "));
    // only printable ASCII (0x20..0x7e) is shown as is
    expect(row.ascii).toBe("A.. ~..B");
  });

  it("keeps every row the same width, with blanks past the end", () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => i + 0x30);
    const full = hexRow(bytes, 0);
    const last = hexRow(bytes, 1);
    expect(last.offset).toBe("00000010");
    expect(last.hex).toHaveLength(full.hex.length);
    expect(last.hex.startsWith("40 41 42 43")).toBe(true);
    expect(last.ascii).toBe("@ABC");
  });

  it("uses 8-digit offsets up to the 32 MB cap", () => {
    const bytes = new Uint8Array(0x1000);
    expect(hexRow(bytes, 0x1000 / HEX_ROW_BYTES - 1).offset).toBe("00000ff0");
  });

  it("counts the rows of a value", () => {
    expect(hexRowCount(0)).toBe(0);
    expect(hexRowCount(1)).toBe(1);
    expect(hexRowCount(16)).toBe(1);
    expect(hexRowCount(17)).toBe(2);
    expect(hexRowCount(100_000)).toBe(6250);
  });
});
