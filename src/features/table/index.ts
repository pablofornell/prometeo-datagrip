/**
 * Table data editor feature: registers the `editor.view.table` slot, the `table.*` actions and the close guard.
 * Tabs are opened by the explorer (`db.editData`, F4); see `commands.ts` for the shared tab ids.
 */
import { registerSlot } from "../../state/slots";
import { registerActions } from "../../state/actions";
import { TableView } from "./TableView";
import { installCloseGuard, tableActions } from "./actions";

registerSlot("editor.view.table", TableView);
registerActions(tableActions());
installCloseGuard();

export { openTableTab, openDdlTab } from "./commands";
