/** Small cache of the data sources (name, driver, read-only flag) for the table / DDL views. */
import { createSignal } from "solid-js";
import { type DataSource, connect, listDataSources } from "../../api/db";

const [list, setList] = createSignal<DataSource[]>([]);
let loading: Promise<void> | undefined;

/** Loads the list once; call again with `force` after a data source changed. */
export function loadDataSources(force = false): Promise<void> {
  if (!loading || force) {
    const p: Promise<void> = listDataSources().then(
      (l) => {
        setList(l);
      },
      () => {
        loading = undefined;
      },
    );
    loading = p;
  }
  return loading;
}

/** Reactive lookup (loads the list on first use). */
export function dsInfo(dsId: string): DataSource | undefined {
  void loadDataSources();
  return list().find((d) => d.id === dsId);
}

export const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

/** `connect` is idempotent in the backend; restored tabs call it before their first request. */
export async function ensureConnected(dsId: string): Promise<void> {
  await connect(dsId);
}

/** Clipboard write: Tauri plugin when available, else the browser API / a textarea fallback. */
export async function writeClipboard(text: string): Promise<void> {
  try {
    if ("__TAURI_INTERNALS__" in window) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    }
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}
