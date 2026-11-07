import { StateEffect, StateField } from "@codemirror/state";
import { SchemaIndex } from "./schemaIndex";
import type { TableRef } from "./semantic";
import type { EditorError, ExecMark } from "./types";
import type { Dialect } from "./split";

export interface EditorConfig {
  dialect: Dialect;
  index: SchemaIndex;
  sourceLabel?: string;
  /** Show the green statement frame. */
  statementFrame: boolean;
  /** Table every column reference resolves against (table-editor WHERE / ORDER BY fields). */
  implicit?: TableRef[];
}

export const setConfig = StateEffect.define<EditorConfig>();

export const configField = StateField.define<EditorConfig>({
  create: () => ({ dialect: "postgres", index: new SchemaIndex(undefined), statementFrame: true }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setConfig)) return e.value;
    return v;
  },
});

export const setErrors = StateEffect.define<EditorError[]>();
export const setExecMarks = StateEffect.define<ExecMark[]>();

/** Errors reported by the host, as document ranges that follow edits. */
export const errorsField = StateField.define<EditorError[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setErrors)) return e.value;
    if (tr.docChanged && v.length) {
      // an edit inside the failed statement invalidates its error
      const out: EditorError[] = [];
      for (const err of v) {
        const to = err.statementTo ?? err.statementFrom;
        if (tr.changes.touchesRange(err.statementFrom, Math.max(to, err.statementFrom + 1))) continue;
        out.push({
          ...err,
          statementFrom: tr.changes.mapPos(err.statementFrom, 1),
          statementTo: err.statementTo === undefined ? undefined : tr.changes.mapPos(err.statementTo, -1),
        });
      }
      return out;
    }
    return v;
  },
});

export const execMarksField = StateField.define<ExecMark[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setExecMarks)) return e.value;
    if (tr.docChanged && v.length) {
      const out: ExecMark[] = [];
      for (const m of v) {
        if (tr.changes.touchesRange(m.from, Math.max(m.to, m.from + 1))) continue;
        out.push({ ...m, from: tr.changes.mapPos(m.from, 1), to: tr.changes.mapPos(m.to, -1) });
      }
      return out;
    }
    return v;
  },
});

/** A live inspection result: a syntax error or a name that does not resolve. */
export interface Problem {
  from: number;
  to: number;
  message: string;
  kind: "syntax" | "unresolved";
}

export const setProblems = StateEffect.define<Problem[]>();

/** Problems of the inspections (recomputed after a pause in typing; positions follow edits meanwhile). */
export const problemsField = StateField.define<Problem[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setProblems)) return e.value;
    if (tr.docChanged && v.length) {
      const out: Problem[] = [];
      for (const p of v) {
        const from = tr.changes.mapPos(p.from, 1);
        const to = tr.changes.mapPos(p.to, -1);
        if (to > from) out.push({ ...p, from, to });
      }
      return out;
    }
    return v;
  },
});
