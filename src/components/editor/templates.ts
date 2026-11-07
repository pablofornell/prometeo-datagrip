/**
 * Live templates: DataGrip's default SQL set. An abbreviation + Tab expands in place and the caret walks through the
 * variables (Tab / Shift+Tab, Esc leaves template mode); Ctrl+J lists them; the abbreviations are also offered by
 * the normal completion. Built on CodeMirror snippets.
 */
import { type Completion, hasNextSnippetField, hasPrevSnippetField, snippet, snippetCompletion, startCompletion, nextSnippetField, completionStatus } from "@codemirror/autocomplete";
import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { type Command, EditorView } from "@codemirror/view";
import { docAnalysis } from "./highlight";
import { configField } from "./state";

export interface LiveTemplate {
  abbreviation: string;
  description: string;
  /** CodeMirror snippet: `${name}` is a variable with a default text, `${}` an empty one. */
  template: string;
}

/** DataGrip's default SQL live templates (`119-editor-parameter-or-live-template-dark.png`). */
export const LIVE_TEMPLATES: LiveTemplate[] = [
  { abbreviation: "col", description: "new column definition", template: "${column_name} ${type}" },
  { abbreviation: "del", description: "delete rows from a table", template: "delete from ${}\nwhere ${condition};" },
  { abbreviation: "ins", description: "insert rows into a table", template: "insert into ${} (${columns})\nvalues (${values});" },
  { abbreviation: "joinab", description: "join two tables", template: "select *\nfrom ${} a\n    join ${table_b} b on a.${column_a} = b.${column_b};" },
  { abbreviation: "lim", description: "select first N rows from a table", template: "select *\nfrom ${}\nlimit ${n};" },
  { abbreviation: "sel", description: "select all rows from a table", template: "select *\nfrom ${};" },
  { abbreviation: "selc", description: "select the number of specific rows in a table", template: "select count(*)\nfrom ${}\nwhere ${condition};" },
  { abbreviation: "selw", description: "select specific rows from a table", template: "select *\nfrom ${}\nwhere ${condition};" },
  { abbreviation: "tab", description: "new table definition", template: "create table ${table_name}\n(\n    ${column_name} ${type}\n);" },
  { abbreviation: "upd", description: "update values in a table", template: "update ${}\nset ${column} = ${value}\nwhere ${condition};" },
  { abbreviation: "view", description: "new view definition", template: "create view ${view_name} as\nselect ${columns}\nfrom ${};" },
];

const byAbbreviation = new Map(LIVE_TEMPLATES.map((t) => [t.abbreviation, t]));

/** `description` of a template completion (the right-aligned gray text). */
export const templateDescriptions = new WeakMap<Completion, string>();

/** The templates as completion options (`type: "template"`: the template icon). */
export function templateOptions(boost = 9): Completion[] {
  return LIVE_TEMPLATES.map((t, i) => {
    const c = snippetCompletion(t.template, { label: t.abbreviation, type: "template", boost: boost - i * 0.0001 });
    templateDescriptions.set(c, t.description);
    return c;
  });
}

// ---------------------------------------------------------------- Ctrl+J list

export const setTemplateList = StateEffect.define<boolean>();

/** True while the Ctrl+J list is the completion's content (the source returns only templates). */
export const templateListField = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setTemplateList)) return e.value;
    return v;
  },
});

/** Ctrl+J: the list of all templates; typing filters it. */
export const insertLiveTemplate: Command = (view) => {
  if (view.state.readOnly || view.state.field(configField).noTemplates) return false;
  view.dispatch({ effects: setTemplateList.of(true) });
  startCompletion(view);
  return true;
};

/** Leaves the list mode again once its popup closed. */
export function templateListWatcher() {
  let seen = false;
  return EditorView.updateListener.of((u) => {
    if (!u.state.field(templateListField)) {
      seen = false;
      return;
    }
    if (completionStatus(u.state) !== null) seen = true;
    else if (seen) {
      seen = false;
      queueMicrotask(() => u.view.dispatch({ effects: setTemplateList.of(false) }));
    }
  });
}

// ---------------------------------------------------------------- abbreviation + Tab

/** A variable that stands for a table: the table completion opens there. */
const TABLE_SLOT = /\b(?:from|join|update|into|table)\s+$/i;

/** After the caret entered a variable: open the table completion when it sits behind from / join / update. */
function completeSlot(view: EditorView): void {
  const head = view.state.selection.main.head;
  const sel = view.state.selection.main;
  if (!sel.empty) return;
  const before = view.state.sliceDoc(Math.max(0, head - 20), head);
  if (TABLE_SLOT.test(before)) startCompletion(view);
}

/** True while a template is being filled in (Tab goes to the next variable). */
export const templateActive = (state: EditorState): boolean => hasNextSnippetField(state) || hasPrevSnippetField(state);

/** The abbreviation right before the caret, and where it starts. */
function abbreviationBefore(state: EditorState): { template: LiveTemplate; from: number } | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  const m = /[A-Za-z_][A-Za-z0-9_]*$/.exec(line.text.slice(0, sel.head - line.from));
  if (!m) return null;
  const from = sel.head - m[0].length;
  if (from > line.from && /[.$]/.test(line.text[from - line.from - 1])) return null;
  const template = byAbbreviation.get(m[0]);
  if (!template) return null;
  // not inside a string, comment or quoted identifier
  const a = docAnalysis(state.doc, state.field(configField).dialect);
  if (a.tokens.some((t) => (t.kind === "string" || t.kind === "comment" || t.kind === "qident") && t.from < sel.head && sel.head <= t.to + (t.kind === "comment" ? 1 : 0))) return null;
  return { template, from };
}

/** Tab: expands the abbreviation before the caret. */
export const expandTemplate: Command = (view) => {
  if (view.state.readOnly || view.state.field(configField).noTemplates) return false;
  const hit = abbreviationBefore(view.state);
  if (!hit) return false;
  snippet(hit.template.template)(view, null, hit.from, view.state.selection.main.head);
  completeSlot(view);
  return true;
};

/** Tab inside a template: the next variable (the table completion opens at a table variable). */
export const nextTemplateField: Command = (view) => {
  if (!hasNextSnippetField(view.state)) return false;
  nextSnippetField(view);
  completeSlot(view);
  return true;
};
