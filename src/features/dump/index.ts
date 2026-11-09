/**
 * Dump to SQL File: the schema of a data source (PostgreSQL / Oracle schema, MySQL database, SQLite), or some of its
 * tables, to a `.sql` file, with a progress dialog and Cancel. Registers `dump.sqlFile`; the explorer's SQL Scripts menu
 * runs it with a `DumpTarget`.
 */
import { registerActions } from "../../state/actions";
import { openDump } from "./run";
import type { DumpTarget } from "./target";

registerActions([
  {
    id: "dump.sqlFile",
    title: "Dump to SQL File…",
    icon: "sql-file",
    // the explorer passes the target in the context, which `enabled()` cannot see
    run: (ctx) => {
      const t = ctx as Partial<DumpTarget> | undefined;
      if (t?.dsId && t.schema) return openDump(t as DumpTarget);
    },
  },
]);
