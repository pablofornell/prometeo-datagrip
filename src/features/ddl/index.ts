/** DDL view feature: registers the `editor.view.ddl` slot. Tabs are opened by the explorer (Ctrl+B) or the table editor's DDL button. */
import { registerSlot } from "../../state/slots";
import { DdlView } from "./DdlView";

registerSlot("editor.view.ddl", DdlView);
