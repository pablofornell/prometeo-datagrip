import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, bytesToHex, formatBytes, hexToBytes, utf8Decode, utf8Encode } from "./bytes";

describe("formatBytes", () => {
  it("picks the unit", () => {
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(12_595)).toBe("12.3 KB");
    expect(formatBytes(32 * 1024 * 1024)).toBe("32.0 MB");
  });
});

describe("base64", () => {
  it("round-trips every byte value, and matches RFC 4648", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
    expect(bytesToBase64(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy");
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("handles a large value without overflowing the argument list", () => {
    const big = new Uint8Array(3_000_000).map((_, i) => (i * 7) & 0xff);
    const back = base64ToBytes(bytesToBase64(big));
    expect(back.length).toBe(big.length);
    expect(back[2_999_999]).toBe(big[2_999_999]);
  });
});

describe("hex", () => {
  it("encodes lower case and decodes either case", () => {
    expect(bytesToHex(Uint8Array.from([0, 0x0f, 0xa0, 0xff]))).toBe("000fa0ff");
    expect(hexToBytes("000FA0ff")).toEqual(Uint8Array.from([0, 0x0f, 0xa0, 0xff]));
    expect(hexToBytes("")).toEqual(new Uint8Array());
  });

  it("refuses odd length and non-hex text", () => {
    expect(hexToBytes("abc")).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
    expect(hexToBytes("\\x00")).toBeNull();
  });
});

describe("utf8", () => {
  it("encodes and decodes, and refuses invalid UTF-8", () => {
    const bytes = utf8Encode("añ€😀");
    expect(bytes.length).toBe(10);
    expect(utf8Decode(bytes)).toBe("añ€😀");
    expect(utf8Decode(Uint8Array.from([0xff, 0xfe]))).toBeNull();
    expect(utf8Decode(Uint8Array.from([0xc3]))).toBeNull(); // a character cut in half
  });
});
