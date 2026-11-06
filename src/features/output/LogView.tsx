/** The Output tab: timestamped log of the console (statement echo, row counts, errors in red). */
import { For, Show, createEffect, type JSX } from "solid-js";
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

export function LogView(props: { out: ConsoleOutput }): JSX.Element {
  let sc!: HTMLDivElement;
  const out = () => props.out;

  createEffect(() => {
    const n = out().lines.length;
    if (n && out().scrollToEnd()) queueMicrotask(() => (sc.scrollTop = sc.scrollHeight));
  });

  return (
    <div class="dgo-logwrap">
      <div ref={sc} class="dgo-log" classList={{ wrap: out().wrap() }} tabindex={0} data-focus-target>
        <Show when={out().lines.length} fallback={<div class="dgo-empty">Console output</div>}>
          <For each={out().lines}>{(l) => <div class="dgo-line" classList={{ err: l.kind === "error" }} innerHTML={lineHtml(l, out().dialect)} />}</For>
        </Show>
      </div>
      <div class="dgo-vtb">
        <ActionButton title="Soft-Wrap" selected={out().wrap()} onClick={() => out().setWrap(!out().wrap())}>
          <Svg d='<path d="M2 4h12M2 8h9a2.5 2.5 0 010 5H8M2 12h3"/><path d="M9.5 11.5L8 13l1.5 1.5"/>' />
        </ActionButton>
        <ActionButton title="Scroll to the End" selected={out().scrollToEnd()} onClick={() => (out().setScrollToEnd(!out().scrollToEnd()), sc.scrollTo({ top: sc.scrollHeight }))}>
          <Svg d='<path d="M2 3h12M2 6.5h12M2 10h6"/><path d="M12 9v5M9.5 12l2.5 2.5L14.5 12"/>' />
        </ActionButton>
        <ActionButton title="Clear All" icon="delete" onClick={() => out().clearLog()} />
      </div>
    </div>
  );
}
