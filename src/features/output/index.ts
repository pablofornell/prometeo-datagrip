/**
 * Database Output tool window: `output.header` (Output + result tabs, console / duration), `output.toolbar`
 * (log mini toolbar or the grid toolbar), `output.body` (log / result grid), `output.headerActions`.
 * The data lives in `./model` (one `ConsoleOutput` per console tab, written by src/features/console).
 */
import { registerSlot } from "../../state/slots";
import { OutputBody } from "./OutputBody";
import { OutputHeader, OutputHeaderActions } from "./OutputHeader";
import { OutputToolbar } from "./OutputToolbar";
import "./output.css";

export { currentOutput, outputOf } from "./model";
export { exportCurrentResult } from "./export";
export type { ConsoleOutput, ResultTab } from "./model";

registerSlot("output.header", OutputHeader);
registerSlot("output.headerActions", OutputHeaderActions);
registerSlot("output.toolbar", OutputToolbar);
registerSlot("output.body", OutputBody);
