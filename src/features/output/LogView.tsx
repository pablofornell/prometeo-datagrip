/** The Output tab: timestamped log of the console (statement echo, row counts, errors in red). */
import { For, Show, createEffect, on, onMount, type JSX } from "solid-js";
import { ActionButton } from "../../components/ui";
import { escapeHtml, highlightSql } from "./highlight";
import { logTimestamp } from "./format";
import type { ConsoleOutput, LogLine } from "./model";

/** The continuation lines of an echoed statement are indented under the timestamp (measured in DataGrip). */
const INDENT = " ".repeat(28);

function lineHtml(l: LogLine, dialect: ConsoleOutput["dialect"]): string {
  const ts = escapeHtml(logTimestamp(l.ts));
  if (l.kind === "sql") {
    const sql = highlightSql(l.text, dialect).replace(/\n/g, "\n" + INDENT);
    return `${ts} ${escapeHtml(l.prompt ?? "")}&gt; ${sql}`;
  }
  return `${ts} ${escapeHtml(l.text)}`;
}

const Svg = (props: { d: string }): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" innerHTML={props.d} />
);

/** The log as plain text (what Print puts on paper). */
export function logText(lines: readonly LogLine[]): string {
  return lines.map((l) => `${logTimestamp(l.ts)} ${l.kind === "sql" ? `${l.prompt ?? ""}> ` : ""}${l.text}`).join("\n");
}

/** The browser's print of the log text: a hidden frame holding it is printed, so the app around it is not. */
function printLog(text: string): void {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) return frame.remove();
  doc.open();
  doc.write(`<!doctype html><title>Database Output</title><pre style="font:12px monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`);
  doc.close();
  win.onafterprint = () => frame.remove();
  win.focus();
  win.print();
  setTimeout(() => frame.remove(), 60_000);
}

export function LogView(props: { out: ConsoleOutput }): JSX.Element {
  let sc!: HTMLDivElement;
  const out = () => props.out;

  // new lines (a run) and a tab shown again scroll to the end; the second pass catches the layout that follows the paint
  const toEnd = () => {
    sc.scrollTop = sc.scrollHeight;
    requestAnimationFrame(() => (sc.scrollTop = sc.scrollHeight));
  };
  createEffect(() => {
    const n = out().lines.length;
    if (n && out().scrollToEnd()) queueMicrotask(toEnd);
  });
  onMount(() => out().scrollToEnd() && queueMicrotask(toEnd));
  // the pane is hidden (display: none, no height) while a result is selected: lines added then are only reached when it is shown again
  createEffect(on([() => out().selected(), () => out().logAside()], () => out().scrollToEnd() && requestAnimationFrame(toEnd), { defer: true }));

  return (
    <div class="dgo-logwrap">
      <div ref={sc} class="dgo-log" classList={{ wrap: out().wrap() }} tabindex={0} data-focus-target>
        <Show when={out().lines.length} fallback={<div class="dgo-empty">Console output</div>}>
          <For each={out().lines}>{(l) => <div class="dgo-line" classList={{ err: l.kind === "error", warn: l.kind === "warning" }} innerHTML={lineHtml(l, out().dialect)} />}</For>
        </Show>
      </div>
      <div class="dgo-vtb">
        <ActionButton title="Soft-Wrap" selected={out().wrap()} onClick={() => out().setWrap(!out().wrap())}>
          <Svg d='<path d="M2 4h12M2 8h9a2.5 2.5 0 010 5H8M2 12h3"/><path d="M9.5 11.5L8 13l1.5 1.5"/>' />
        </ActionButton>
        <ActionButton title="Scroll to the End" selected={out().scrollToEnd()} onClick={() => (out().setScrollToEnd(!out().scrollToEnd()), sc.scrollTo({ top: sc.scrollHeight }))}>
          <Svg d='<path d="M2 3h12M2 6.5h12M2 10h6"/><path d="M12 9v5M9.5 12l2.5 2.5L14.5 12"/>' />
        </ActionButton>
        <ActionButton title="Print" disabled={!out().lines.length} onClick={() => printLog(logText(out().lines))}>
          <Svg d='<path d="M4.5 6V2.5h7V6"/><rect x="2.5" y="6" width="11" height="5.5" rx="1"/><path d="M4.5 9.5h7v4h-7z"/>' />
        </ActionButton>
        <ActionButton title="Clear All" icon="delete" onClick={() => out().clearLog()} />
      </div>
    </div>
  );
}
