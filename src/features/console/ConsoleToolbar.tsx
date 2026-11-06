/** The 34px toolbar of a query console (operative items of DataGrip's: run, history, Tx, commit / rollback, stop, schema). */
import { Show, type JSX } from "solid-js";
import { ActionButton, Icon, ToolbarSeparator, openMenu } from "../../components/ui";
import type { ConsoleSession } from "./session";

export function ConsoleToolbar(props: { session: ConsoleSession }): JSX.Element {
  const s = () => props.session;
  let txBtn!: HTMLButtonElement;
  let schemaBtn!: HTMLButtonElement;
  return (
    <div class="dg-toolbar dgc-toolbar">
      <span
        class="dgc-run"
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu([{ action: "sql.execute" }, { action: "sql.executeScript" }], { x: e.clientX, y: e.clientY });
        }}
      >
        <ActionButton action="sql.execute" icon="run" />
      </span>
      <ToolbarSeparator />
      <ActionButton action="sql.history" icon="history" title="Browse Query History" />
      <ToolbarSeparator />
      <button ref={txBtn} type="button" class="dgc-text-btn" tabindex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => s().openTxMenu(txBtn)}>
        <span>Tx: {s().txMode() === "manual" ? "Manual" : "Auto"}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      <Show when={s().txMode() === "manual"}>
        <ActionButton action="sql.commit" icon="dg/commit" />
        <ActionButton action="sql.rollback" icon="dg/rollback" title="Roll Back" />
      </Show>
      <ActionButton action="sql.cancel" icon="stop" class="dgc-stop" />
      <span class="dgc-spacer" />
      <button
        ref={schemaBtn}
        type="button"
        class="dgc-text-btn dgc-schema"
        title="Switch current schema"
        tabindex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void s().openSchemaMenu(schemaBtn)}
      >
        <Icon name="dg/schema" size={16} />
        <span>{s().label() ?? "<schema>"}</span>
        <Icon name="chevron-down" size={16} />
      </button>
    </div>
  );
}
