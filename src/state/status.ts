/**
 * Status bar model. Other modules update it (e.g. the editor sets `caret`, the explorer sets
 * `path`); the status bar only renders operative items.
 */
import { createStore } from "solid-js/store";

export interface Crumb {
  label: string;
  /** Icon name or URL shown before the label. */
  icon?: string;
  onClick?: () => void;
}

export interface StatusState {
  /** Navigation path, left side: Database Consoles › postgres@localhost › console [postgres@localhost]. */
  path: Crumb[];
  /** Editor caret (1-based). null hides the widget. */
  caret: { line: number; col: number } | null;
  lineSeparator: "LF" | "CRLF" | "CR" | null;
  encoding: string | null;
  /** Indentation widget ("4 spaces"). undefined: derived (shown next to the caret, like DataGrip). */
  indent?: string | null;
  /** Shows the lock icon. null hides it. */
  readOnly: boolean | null;
  /** Transaction mode text, e.g. "Tx: Manual". The status bar only shows it in Manual mode (DataGrip has no Auto widget). */
  txMode: string | null;
  /** Background task: progress 0..1 (undefined = indeterminate). */
  task: { title: string; progress?: number; onCancel?: () => void } | null;
  /** Right-side free text (e.g. "No aggregator selected"). */
  aggregator: string | null;
}

export const [status, setStatus] = createStore<StatusState>({
  path: [],
  caret: null,
  lineSeparator: null,
  encoding: null,
  readOnly: null,
  txMode: null,
  task: null,
  aggregator: null,
});
