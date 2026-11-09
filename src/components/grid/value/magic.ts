/**
 * Recognises the image formats the value viewer shows, by their magic bytes (and the start of an SVG document).
 * Pure functions, no DOM.
 */

export type ImageKind = "png" | "jpeg" | "gif" | "webp" | "bmp" | "svg";

export const IMAGE_MIME: Record<ImageKind, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export const IMAGE_EXTENSION: Record<ImageKind, string> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  svg: "svg",
};

const at = (bytes: Uint8Array, offset: number, sig: readonly number[]): boolean =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

/** DIB header sizes a BMP file may carry (BITMAPCOREHEADER .. BITMAPV5HEADER). */
const BMP_HEADERS = new Set([12, 40, 52, 56, 64, 108, 124]);

function isBmp(bytes: Uint8Array): boolean {
  if (!at(bytes, 0, [0x42, 0x4d]) || bytes.length < 18) return false;
  // the two reserved words are zero and the info header has a known size: "BM" alone is too common in text
  const reserved = bytes[6] | bytes[7] | bytes[8] | bytes[9];
  const headerSize = (bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24)) >>> 0;
  return reserved === 0 && BMP_HEADERS.has(headerSize);
}

/** `<svg` after an optional BOM, XML prolog, comments, doctype and whitespace (checked on the first 1 KB). */
const SVG_START = /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>/]/i;

function isSvg(bytes: Uint8Array): boolean {
  let start = at(bytes, 0, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  const head = String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + 1024)));
  return SVG_START.test(head);
}

/** The image kind of `bytes`, or `null` when they are not one of the supported formats. */
export function detectImage(bytes: Uint8Array): ImageKind | null {
  if (at(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (at(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  // GIF87a / GIF89a
  if (at(bytes, 0, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
  // RIFF <size> WEBP
  if (at(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && at(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return "webp";
  if (isBmp(bytes)) return "bmp";
  if (isSvg(bytes)) return "svg";
  return null;
}
