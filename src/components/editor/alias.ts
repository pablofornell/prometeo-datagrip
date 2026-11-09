import { keywordsFor } from "./keywords";
import type { Dialect } from "./split";

/**
 * Initials of a table name: `order_items` -> `oi`, `FooTable` -> `ft`, `public.user_roles` -> `ur`;
 * lower-case, never a dialect keyword, and made unique against `taken` with a numeric suffix (`p2`).
 * The schema qualifier is dropped, and camelCase humps contribute like separators do.
 */
export function aliasFor(table: string, taken: Set<string>, dialect: Dialect = "postgres"): string {
  const name = table.split(".").pop() ?? table;
  // split on any non-identifier separator, then on camelCase humps inside each segment
  const parts = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .flatMap((p) => p.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []);
  let a = (parts.length > 1 ? parts.map((p) => p[0]).join("") : (parts[0] ?? "t").slice(0, 1)).toLowerCase();
  if (!/^[a-z_]/.test(a)) a = "t";
  const kws = keywordsFor(dialect);
  let alias = a;
  for (let i = 2; taken.has(alias) || kws.has(alias); i++) alias = a + i;
  return alias;
}
