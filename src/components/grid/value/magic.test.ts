import { describe, expect, it } from "vitest";
import { detectImage } from "./magic";

const bytes = (...b: number[]) => Uint8Array.from(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("detectImage", () => {
  it("recognises PNG, JPEG, GIF, WEBP by their signatures", () => {
    expect(detectImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe("png");
    expect(detectImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe("jpeg");
    expect(detectImage(text("GIF89a\x01\x00"))).toBe("gif");
    expect(detectImage(text("GIF87a\x01\x00"))).toBe("gif");
    expect(detectImage(text("RIFF\x24\x00\x00\x00WEBPVP8 "))).toBe("webp");
  });

  it("needs the whole signature", () => {
    expect(detectImage(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull(); // PNG cut short
    expect(detectImage(text("GIF86a"))).toBeNull();
    expect(detectImage(text("RIFF\x24\x00\x00\x00WAVEfmt "))).toBeNull(); // a WAV file
    expect(detectImage(new Uint8Array())).toBeNull();
  });

  it('recognises BMP only with a plausible header ("BM" alone is common in text)', () => {
    const header = new Uint8Array(54);
    header.set([0x42, 0x4d], 0);
    header[14] = 40; // BITMAPINFOHEADER
    expect(detectImage(header)).toBe("bmp");
    expect(detectImage(text("BMW 320i, 2019 model, diesel, automatic transmission"))).toBeNull();
    header[14] = 41;
    expect(detectImage(header)).toBeNull();
  });

  it("recognises SVG documents, with or without a prolog", () => {
    expect(detectImage(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("svg");
    expect(detectImage(text('  <?xml version="1.0"?>\n<!-- logo -->\n<svg width="1">'))).toBe("svg");
    expect(detectImage(text('﻿<?xml version="1.0"?><svg/>'))).toBe("svg");
    expect(detectImage(text("<html><svg></svg></html>"))).toBeNull();
    expect(detectImage(text("<svgx/>"))).toBeNull();
  });

  it("is null for other binary and text", () => {
    expect(detectImage(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull();
    expect(detectImage(text('{"a": 1}'))).toBeNull();
  });
});
