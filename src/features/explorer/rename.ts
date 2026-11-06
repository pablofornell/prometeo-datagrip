/** Rename (Shift+F6): which nodes can be renamed and the `ALTER ... RENAME` statement per DBMS, with identifier quoting. */
import type { Driver } from "../../api/db";
import type { NodeData } from "./model";

/** Quotes an identifier for the DBMS: backticks for MySQL / MariaDB, double quotes otherwise (embedded quotes doubled). */
export function quoteIdent(driver: Driver, s: string): string {
  return driver === "mysql" ? "`" + s.replace(/`/g, "``") + "`" : '"' + s.replace(/"/g, '""') + '"';
}

/**
 * `ALTER ... RENAME` for the node, or null when the DBMS cannot rename that kind of object
 * (MySQL has no schema rename, SQLite only renames tables and columns, ...).
 */
export function renameSqlOf(d: NodeData, newName: string): string | null {
  const q = (s: string) => quoteIdent(d.driver, s);
  const ex = d.extra;
  const qn = (name: string) => (ex.schema ? `${q(ex.schema)}.${q(name)}` : q(name));
  const qt = ex.table ? qn(ex.table) : "";
  const pg = d.driver === "postgres";
  const my = d.driver === "mysql";
  const to = q(newName);
  switch (d.kind) {
    case "table":
      return my ? `RENAME TABLE ${qn(d.name)} TO ${qn(newName)}` : `ALTER TABLE ${qn(d.name)} RENAME TO ${to}`;
    case "view":
      return pg ? `ALTER VIEW ${qn(d.name)} RENAME TO ${to}` : my ? `RENAME TABLE ${qn(d.name)} TO ${qn(newName)}` : null;
    case "materializedView":
      return pg ? `ALTER MATERIALIZED VIEW ${qn(d.name)} RENAME TO ${to}` : null;
    case "sequence":
      return pg ? `ALTER SEQUENCE ${qn(d.name)} RENAME TO ${to}` : null;
    case "schema":
      return pg ? `ALTER SCHEMA ${q(d.name)} RENAME TO ${to}` : null;
    case "column":
      return `ALTER TABLE ${qt} RENAME COLUMN ${q(d.name)} TO ${to}`;
    case "index":
      return pg ? `ALTER INDEX ${qn(d.name)} RENAME TO ${to}` : my ? `ALTER TABLE ${qt} RENAME INDEX ${q(d.name)} TO ${to}` : null;
    case "uniqueKey":
      return pg ? `ALTER TABLE ${qt} RENAME CONSTRAINT ${q(d.name)} TO ${to}` : my ? `ALTER TABLE ${qt} RENAME INDEX ${q(d.name)} TO ${to}` : null;
    case "primaryKey":
    case "foreignKey":
    case "check":
      return pg ? `ALTER TABLE ${qt} RENAME CONSTRAINT ${q(d.name)} TO ${to}` : null;
    case "trigger":
      return pg ? `ALTER TRIGGER ${q(d.name)} ON ${qt} RENAME TO ${to}` : null;
    case "function":
    case "procedure":
    case "routine": {
      const w = d.kind === "procedure" || ex.routineType === "PROCEDURE" ? "PROCEDURE" : "FUNCTION";
      return pg ? `ALTER ${w} ${qn(d.name)}(${ex.signature ?? ""}) RENAME TO ${to}` : null;
    }
    default:
      return null;
  }
}

/** Can the node be renamed: a data source always (it is just a name), the others when there is an `ALTER` for them. */
export const canRenameNode = (d: NodeData): boolean => d.kind === "dataSource" || (!d.synthetic && renameSqlOf(d, "x") !== null);
