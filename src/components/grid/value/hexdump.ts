/**
 * Rows of the Hex tab (`offset | hex | ASCII`). Pure functions.
 */

/** Bytes per row of the Hex tab. */
export const HEX_ROW_BYTES = 16;

export interface HexRow {
  /** 8 hex digits: the offset of the first byte of the row. */
  offset: string;
  /** The bytes as two-digit hex, a space after each, a double space after the eighth; blanks past the end. */
  hex: string;
  /** Printable ASCII as is, `.` for the rest. */
  ascii: string;
}

/** Number of rows of a value of `length` bytes. */
export function hexRowCount(length: number, perRow = HEX_ROW_BYTES): number {
  return Math.ceil(length / perRow);
}

/** Row `row` (0-based) of `bytes`. */
export function hexRow(bytes: Uint8Array, row: number, perRow = HEX_ROW_BYTES): HexRow {
  const start = row * perRow;
  const cells: string[] = [];
  let ascii = "";
  for (let i = start; i < start + perRow; i++) {
    if (i < bytes.length) {
      const b = bytes[i];
      cells.push(b.toString(16).padStart(2, "0"));
      ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    } else {
      cells.push("  ");
    }
  }
  const half = perRow / 2;
  return {
    offset: start.toString(16).padStart(8, "0"),
    hex: `${cells.slice(0, half).join(" ")}  ${cells.slice(half).join(" ")}`,
    ascii,
  };
}
