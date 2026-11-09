/** Size of the value editor dialog: the large one for binary, JSON and long values, the compact one for short plain text. */

/** Text longer than this many characters opens the large dialog. */
export const LARGE_VALUE_CHARS = 2000;
/** Text with more lines than this opens the large dialog. */
export const LARGE_VALUE_LINES = 20;

/**
 * True when the value editor opens large: a binary value, a JSON value, or text longer than 2000 characters or with more
 * than 20 lines. Short plain text keeps the compact dialog (it needs only the Text tab).
 */
export function isLargeValue(text: string, kind: { binary: boolean; json: boolean }): boolean {
  if (kind.binary || kind.json) return true;
  return text.length > LARGE_VALUE_CHARS || text.split("\n").length > LARGE_VALUE_LINES;
}
