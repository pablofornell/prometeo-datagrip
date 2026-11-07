/** Files tool window (Alt+4, docks right). Placeholder until the tree of scratches and consoles replaces it. */
import type { JSX } from "solid-js";

export function FilesToolWindow(): JSX.Element {
  const el = document.createElement("div");
  el.className = "dg-placeholder-center";
  el.textContent = "No files to show";
  return el;
}
