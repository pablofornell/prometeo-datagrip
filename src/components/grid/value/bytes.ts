/**
 * Byte helpers of the value viewer. Pure functions, no DOM.
 */

/** Largest value the viewer loads or saves whole: the backend cap (`dbcore::cell::MAX_CELL_BYTES`). */
export const MAX_VALUE_BYTES = 32 * 1024 * 1024;

/** Standard base64 (with padding) of `bytes`. Chunked, so a 32 MB value does not overflow the argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Bytes of standard base64 text. */
export function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Lower-case hex of `bytes` (the `$bin` text of a binary cell). */
export function bytesToHex(bytes: Uint8Array): string {
  const digits = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += digits[bytes[i] >> 4] + digits[bytes[i] & 15];
  return out;
}

/** Bytes of hex text (either case); `null` when the text is not hex of an even length. */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Size for the viewer's status line: `812 B`, `12.3 KB`, `4.5 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** UTF-8 bytes of `text`. */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** `bytes` as UTF-8 text; `null` when they are not valid UTF-8. */
export function utf8Decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
