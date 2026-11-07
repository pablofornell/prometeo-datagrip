/**
 * Services tool window (bottom slot, shares it with Database Output): the connected data sources with their
 * console sessions. Selecting a data source shows its Information, selecting a session shows its output log.
 * The window itself is declared in `TOOL_WINDOWS` (src/state/layout.ts); this module plugs the body into it.
 */
import { registerSlot } from "../../state/slots";
import { ServicesBody } from "./ServicesBody";
import "./services.css";

registerSlot("services.body", ServicesBody);
