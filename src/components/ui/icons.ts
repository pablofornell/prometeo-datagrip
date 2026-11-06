/**
 * Icon registry. Every SVG in src/assets/icons is bundled as a *separate file* (never inlined, so the JS
 * stays small) and addressed by its path without extension, e.g. "chevron-down", "dg/table",
 * "menu@20x20". `<name>.svg` is the light variant, `<name>_dark.svg` the dark one.
 */
const files = import.meta.glob("../../assets/icons/**/*.svg", {
  eager: true,
  query: "?no-inline",
  import: "default",
}) as Record<string, string>;

const light = new Map<string, string>();
const dark = new Map<string, string>();

for (const [path, url] of Object.entries(files)) {
  const rel = path.replace(/^.*\/assets\/icons\//, "").replace(/\.svg$/, "");
  if (rel.endsWith("_dark")) dark.set(rel.slice(0, -5), url);
  else light.set(rel, url);
}

/** URL of the icon for the given theme (falls back to the other variant), or undefined if unknown. */
export function iconUrl(name: string, theme: "dark" | "light"): string | undefined {
  return theme === "dark" ? (dark.get(name) ?? light.get(name)) : (light.get(name) ?? dark.get(name));
}

export function hasIcon(name: string): boolean {
  return light.has(name) || dark.has(name);
}

export function iconNames(): string[] {
  return [...new Set([...light.keys(), ...dark.keys()])].sort();
}
