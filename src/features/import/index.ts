/**
 * Import Data from a delimited file (CSV / TSV / custom delimiter) into an existing or a new table.
 * Registers `import.file`; the explorer's Import/Export menu runs it with `{ dsId, schema?, table? }`.
 */
import { registerActions } from "../../state/actions";
import { type ImportTarget, openImport } from "./run";

registerActions([
  {
    id: "import.file",
    title: "Import Data from File…",
    icon: "import",
    // the explorer passes the target in the context, which `enabled()` cannot see
    run: (ctx) => {
      const t = ctx as Partial<ImportTarget> | undefined;
      if (t?.dsId) return openImport(t as ImportTarget);
    },
  },
]);

export { openImport, runImport } from "./run";
