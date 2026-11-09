/** Where passwords are kept and the warning the Data Sources dialog shows when that is the plain-text file. */
import type { PasswordStorage } from "../../api/types";

/**
 * The warning for the dialog footer, or `null` when every password is in the OS keyring. Shown when new
 * passwords would go to the file (`current`: the keyring is not reachable) or a saved data source already
 * keeps its password there (`savedInFile`). `current` is `null` while the keyring has not been needed yet. `configDir` is where data-sources.json lives (unknown in the browser).
 */
export function passwordStorageWarning(current: PasswordStorage | null | undefined, savedInFile: boolean, configDir?: string | null): string | null {
  if (current !== "file" && !savedInFile) return null;
  const where = configDir ? `${configDir.replace(/[\\/]+$/, "")}${/[\\]/.test(configDir) ? "\\" : "/"}data-sources.json` : "data-sources.json";
  return current === "file"
    ? `The OS keyring is not available: passwords are saved unencrypted in ${where}, readable by your account only.`
    : `Some passwords are saved unencrypted in ${where}; they move to the OS keyring when it is available.`;
}
