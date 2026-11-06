/** Explorer-local icon registry (column variants, blue folder, DBMS brand icons); see icons/README.md. */
import type { Driver } from "../../api/db";

const files = import.meta.glob("./icons/**/*.svg", { eager: true, query: "?no-inline", import: "default" }) as Record<string, string>;

const light = new Map<string, string>();
const dark = new Map<string, string>();
for (const [path, url] of Object.entries(files)) {
  const rel = path.replace(/^\.\/icons\//, "").replace(/\.svg$/, "");
  if (rel.endsWith("_dark")) dark.set(rel.slice(0, -5), url);
  else light.set(rel, url);
}

export function localIconUrl(name: string, theme: "dark" | "light"): string | undefined {
  return theme === "dark" ? (dark.get(name) ?? light.get(name)) : (light.get(name) ?? dark.get(name));
}

/** Icon keys starting with `x:` are explorer-local, everything else is a name of the shared kit. */
export const LOCAL = "x:";

export const providerIcon = (driver: Driver | "mariadb"): string => LOCAL + "providers/" + (driver === "postgres" ? "postgresql" : driver);
