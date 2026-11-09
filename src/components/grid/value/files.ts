/**
 * The value viewer's file access: save a value to a file the user picks, and load a file the user picks into a cell.
 * The backend writes and reads only the paths its own dialogs returned (see `choose_value_save_path`, `choose_value_file`).
 */
import { chooseValueFile, chooseValueSavePath, readValueFile, writeValueFile } from "../../../api/db";
import { base64ToBytes, bytesToBase64, MAX_VALUE_BYTES } from "./bytes";

/** Save dialog, then write `bytes` as `<name>.<ext>`. Resolves `false` when the dialog was cancelled. */
export async function saveValue(name: string, ext: string, bytes: Uint8Array): Promise<boolean> {
  const path = await chooseValueSavePath(`${name}.${ext}`, ext);
  if (!path) return false;
  await writeValueFile(path, bytesToBase64(bytes));
  return true;
}

/** Open dialog, then the bytes of the file. Resolves `null` when the dialog was cancelled; rejects above the 32 MB cap. */
export async function loadValue(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const file = await chooseValueFile();
  if (!file) return null;
  if (file.size > MAX_VALUE_BYTES) throw new Error(`${file.name} is larger than 32 MB: it cannot be stored in a cell`);
  return { name: file.name, bytes: base64ToBytes(await readValueFile(file.path)) };
}
