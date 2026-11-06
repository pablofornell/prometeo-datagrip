/** Commit / Roll Back strip shown under the grid toolbar while Tx is Manual (table editor and editable results). */
import type { JSX } from "solid-js";
import { ActionButton, ToolbarSeparator } from "../../components/ui";

export interface TxBarProps {
  inTx: boolean;
  onCommit: () => void;
  onRollback: () => void;
  shortcut?: string;
}

export function TxBar(props: TxBarProps): JSX.Element {
  return (
    <div class="dg-toolbar dgt-txbar">
      <ActionButton icon="dg/commit" title="Commit" shortcut={props.shortcut} disabled={!props.inTx} onClick={props.onCommit} />
      <ActionButton icon="dg/rollback" title="Roll Back" disabled={!props.inTx} onClick={props.onRollback} />
      <ToolbarSeparator />
      <span class="dgt-txstate">{props.inTx ? "Transaction is active" : "No active transaction"}</span>
    </div>
  );
}
