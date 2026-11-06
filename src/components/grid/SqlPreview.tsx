/**
 * "Preview Pending Changes" popup: the SQL the submit would run, with `Submit` / `Cancel`
 * (docs/ux/screens/60-grid-preview-pending-changes-popup-dark.png). Presentational: the table feature builds the SQL text
 * from `api.getChanges()` and renders this over the grid.
 */
import { For, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import "./grid.css";

export interface PendingSqlPreviewProps {
  /** Statements separated by newlines (each ends with `;`). */
  sql: string;
  submitLabel?: string;
  cancelLabel?: string;
  /** Hide the Submit button (read-only preview). */
  readOnly?: boolean;
  /** Rectangle to centre the popup over (default: the window). */
  bounds?: DOMRect;
  onSubmit: () => void;
  onCancel: () => void;
}

const KEYWORDS = new Set(
  "SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE AND OR NOT NULL IS IN AS ORDER BY GROUP LIMIT OFFSET DEFAULT TRUE FALSE JOIN ON LIKE BETWEEN".split(" "),
);

/** Minimal SQL highlighter (keywords, strings, numbers, quoted identifiers) as HTML-safe segments. */
export function highlightSql(sql: string): { text: string; cls: string }[] {
  const out: { text: string; cls: string }[] = [];
  const re = /('(?:[^']|'')*'?)|("(?:[^"]|"")*"?|`[^`]*`?)|(--[^\n]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z_0-9]*)|(\s+|.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    if (m[1]) out.push({ text: m[1], cls: "str" });
    else if (m[2]) out.push({ text: m[2], cls: "id" });
    else if (m[3]) out.push({ text: m[3], cls: "cmt" });
    else if (m[4]) out.push({ text: m[4], cls: "num" });
    else if (m[5]) out.push({ text: m[5], cls: KEYWORDS.has(m[5].toUpperCase()) ? "kw" : "" });
    else out.push({ text: m[6], cls: "" });
  }
  return out;
}

export function PendingSqlPreview(props: PendingSqlPreviewProps): JSX.Element {
  let el!: HTMLDivElement;
  onMount(() => {
    const down = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) props.onCancel();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onCancel();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !props.readOnly) {
        e.preventDefault();
        e.stopPropagation();
        props.onSubmit();
      }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    });
  });
  const style = (): JSX.CSSProperties => {
    const b = props.bounds;
    if (!b) return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
    return { left: b.left + b.width / 2 + "px", top: b.top + b.height / 2 + "px", transform: "translate(-50%, -50%)" };
  };
  return (
    <Portal>
      <div ref={el} class="dgg-sqlp" style={style()}>
        <pre class="dgg-sqlp-text">
          <For each={highlightSql(props.sql)}>{(s) => (s.cls ? <span class={"sq-" + s.cls}>{s.text}</span> : s.text)}</For>
        </pre>
        <div class="dgg-sqlp-foot">
          {!props.readOnly && (
            <button class="dgg-btn primary" onClick={() => props.onSubmit()}>
              {props.submitLabel ?? "Submit"}
            </button>
          )}
          <button class="dgg-btn" onClick={() => props.onCancel()}>
            {props.cancelLabel ?? "Cancel"}
          </button>
        </div>
      </div>
    </Portal>
  );
}
