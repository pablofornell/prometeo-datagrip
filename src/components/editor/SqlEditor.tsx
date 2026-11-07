import { closeBrackets, closeBracketsKeymap, closeCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, deleteLine, history, historyKeymap, redo, selectLine, toggleLineComment } from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, Prec, type TransactionSpec } from "@codemirror/state";
import {
  type Command,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  scrollPastEnd,
  tooltips,
} from "@codemirror/view";
import { type Component, createEffect, on, onCleanup, onMount } from "solid-js";
import { getAction, isActionEnabled, runAction } from "../../state/actions";
import { editorMetrics, settings } from "../../state/settings";
import "./editor.css";
import { clipRecorder, completeStatement, duplicate, extendSelection, goToLine, moveLine, moveStatement, parameterInfo, parameterInfoExtension, pasteFromHistory, shiftTab, shrinkSelection, tabIndent, toggleBlock } from "./commands";
import { sqlCompletion } from "./complete";
import { completionExtras, withExtras } from "./extras";
import { errorExtension } from "./errors";
import { openEditorMenu, placeCaretAt, writeText } from "./contextMenu";
import { closeChooser, isChooserOpen, scriptRequest, selectionOrStatement, showChooser } from "./execute";
import { formatScript } from "./format";
import { applyKeywordCase } from "./keywordCase";
import { previewField, previewFill, statementFrame } from "./frame";
import { statusGutterExtension } from "./gutter";
import { docAnalysis, indentGuides, sqlHighlighting } from "./highlight";
import { inspectExtension, jumpProblem } from "./inspect";
import { intentionHostFacet, runQueryFacet } from "./intentions";
import { applyFirstIntention, intentionsCommand } from "./intentionsPopup";
import { editorLayers } from "./layers";
import { goToDeclaration, navigationExtension, quickDocAtCaret, referenceAtCaret, selectInExplorerAtCaret } from "./navigate";
import { schemaIndexFor } from "./schemaIndex";
import { sqlSearch } from "./search";
import { configField, errorsField, execMarksField, problemsField, setConfig, setErrors, setExecMarks } from "./state";
import { stripeExtension } from "./stripe";
import type { ExecuteRequest, Range, SqlEditorHandle, SqlEditorProps } from "./types";

/** Minimal replace of `a` by `b`: keeps unchanged prefix and suffix so the caret and undo stay sane. */
function diffChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let s = 0;
  const max = Math.min(a.length, b.length);
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) {
    ea--;
    eb--;
  }
  return { from: s, to: ea, insert: b.slice(s, eb) };
}

/** Single-line mode: newlines in typed or pasted text become spaces. */
const stripNewlines = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  let multi = false;
  tr.changes.iterChanges((_a, _b, _c, _d, ins) => {
    if (ins.lines > 1) multi = true;
  });
  if (!multi) return tr;
  const specs: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((a, b, _c, _d, ins) => {
    specs.push({ from: a, to: b, insert: ins.toString().replace(/\r?\n/g, " ") });
  });
  const spec: TransactionSpec = { changes: specs, selection: tr.selection, scrollIntoView: tr.scrollIntoView };
  return spec;
});

const isDark = (): boolean => document.documentElement.dataset.theme !== "light";

export const SqlEditor: Component<SqlEditorProps> = (props) => {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const darkC = new Compartment();
  const readOnlyC = new Compartment();
  const numbersC = new Compartment();
  const metricsC = new Compartment();
  const showNumbers = (): boolean => props.lineNumbers ?? settings.editorLineNumbers;
  const fontSize = (): number => props.fontSize ?? settings.editorFontSize;
  const lineHeight = (): number => props.lineHeight ?? settings.editorLineHeight;
  /** Only editors with an explicit override set the metrics themselves; the others inherit them from <html>. */
  const metricsStyle = () => {
    if (props.fontSize === undefined && props.lineHeight === undefined) return undefined;
    const m = editorMetrics(fontSize(), lineHeight());
    return { "--dg-editor-font-size": `${m.fontSize}px`, "--dg-editor-line-pitch": `${m.pitch}px`, "--dg-editor-cell": `${m.cell}px` };
  };

  const emit = (req: ExecuteRequest): void => props.onExecute?.(req);

  // `Customize` link of the statement chooser: the host's handler, else Settings > Database > Query Execution
  // when the settings dialog is registered (no link otherwise: it would do nothing).
  const customizeHandler = (): (() => void) | undefined => {
    if (props.onCustomizeExecution) return props.onCustomizeExecution;
    return isActionEnabled(getAction("app.settings")) ? () => void runAction("app.settings", "database.query-execution") : undefined;
  };

  const execute: Command = (v) => {
    closeCompletion(v); // Ctrl+Enter does not accept the popup: leaving it open would hang over the running statement
    if (isChooserOpen(v)) return true;
    const r = selectionOrStatement(v.state);
    if (!r) return true;
    // Settings > Database > Query Execution: "When caret inside statement execute" (the candidates are the statement, then
    // the statement with its attached comment)
    const mode = settings.execCaretInside;
    if (r.candidates.length > 1 && mode !== "ask") {
      const c = mode === "smallest" ? r.candidates[0] : r.candidates[r.candidates.length - 1];
      emit({ sql: v.state.sliceDoc(c.range.from, c.range.to), ranges: [c.range], source: "statement" });
    } else if (r.candidates.length > 1) {
      showChooser(
        v,
        r.candidates,
        (c) => emit({ sql: v.state.sliceDoc(c.range.from, c.range.to), ranges: [c.range], source: "statement" }),
        customizeHandler(),
      );
    } else emit(r.req);
    return true;
  };

  const reformat: Command = (v) => {
    if (v.state.readOnly) return false;
    const dialect = v.state.field(configField).dialect;
    const sel = v.state.selection.main;
    if (!sel.empty) {
      const text = v.state.sliceDoc(sel.from, sel.to);
      const out = applyKeywordCase(formatScript(text, dialect), dialect, settings.sqlKeywordCase);
      const ch = diffChange(text, out);
      if (ch) v.dispatch({ changes: { from: sel.from + ch.from, to: sel.from + ch.to, insert: ch.insert }, userEvent: "input.format" });
      return true;
    }
    const text = v.state.doc.toString();
    const out = applyKeywordCase(formatScript(text, dialect), dialect, settings.sqlKeywordCase);
    const ch = diffChange(text, out);
    if (ch) {
      const head = v.state.selection.main.head;
      const mapped = head <= ch.from ? head : head >= ch.to ? head - (ch.to - ch.from) + ch.insert.length : ch.from + ch.insert.length;
      v.dispatch({ changes: ch, selection: EditorSelection.cursor(Math.min(mapped, out.length)), userEvent: "input.format" });
    }
    return true;
  };

  const nav = () => props.navigate ?? {};
  const goTo = goToDeclaration(nav);
  const copyReference: Command = (v) => {
    const ref = nav().goTo ? referenceAtCaret(v) : null;
    if (!ref) return false;
    void writeText(ref);
    return true;
  };

  const handle: SqlEditorHandle = {
    focus: () => view?.focus(),
    getSelectionOrStatement: () => (view ? (selectionOrStatement(view.state)?.req ?? null) : null),
    getScript: () => (view ? scriptRequest(view.state) : null),
    getStatements: () => {
      if (!view) return [];
      const a = docAnalysis(view.state.doc, view.state.field(configField).dialect);
      return a.statements.map((s): Range => ({ from: s.start, to: s.end }));
    },
    revealRange: (r) => {
      view?.dispatch({ selection: EditorSelection.range(r.from, r.to), effects: EditorView.scrollIntoView(r.from, { y: "center" }) });
    },
    execute: () => {
      if (view) execute(view);
    },
    reformat: () => {
      if (view) reformat(view);
    },
    get view() {
      return view;
    },
  };

  // sequences / routines supplied by the host's extras provider (tracked: a late load re-configures the editor)
  // Only editors whose host already supplies a schema ask: the provider may connect and introspect.
  const extras = () => (props.schema ? completionExtras({ dialect: props.dialect, sourceLabel: props.sourceLabel }) : undefined);

  const configEffect = () => {
    const dialect = props.dialect;
    const index = schemaIndexFor(withExtras(props.schema, extras()), props.defaultSchema);
    const st = props.scopeTable;
    const table = st ? index.findTable([...(st.schema ? [st.schema.toLowerCase()] : []), st.name.toLowerCase()]) : undefined;
    return setConfig.of({
      dialect,
      index,
      sourceLabel: props.sourceLabel,
      statementFrame: props.statementFrame !== false && !props.singleLine,
      noTemplates: !!props.singleLine,
      implicit: table ? [{ parts: [table.name.toLowerCase()], table, opaque: false }] : undefined,
    });
  };

  onMount(() => {
    const single = !!props.singleLine;
    const showGutter = props.gutter !== false && !single;
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) props.onChange?.(u.state.doc.toString());
      if (u.docChanged || u.selectionSet) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        const sel = u.state.selection.main;
        props.onCaretChange?.(line.number, head - line.from + 1, sel.to - sel.from, sel.empty ? 0 : u.state.doc.lineAt(sel.to).number - u.state.doc.lineAt(sel.from).number);
      }
    });

    const keys = Prec.high(
      keymap.of([
        ...(single ? [{ key: "Enter", run: () => (props.onSubmit?.(), true) }] : [{ key: "Mod-Enter", run: execute, preventDefault: true }]),
        { key: "Mod-/", run: toggleLineComment, preventDefault: true },
        { key: "Mod-Shift-/", run: toggleBlock, preventDefault: true },
        { key: "Mod-d", run: duplicate, preventDefault: true },
        { key: "Mod-y", run: deleteLine, preventDefault: true },
        { key: "Mod-Shift-z", run: redo, preventDefault: true },
        { key: "Mod-Shift-ArrowUp", run: moveStatement(-1), preventDefault: true },
        { key: "Mod-Shift-ArrowDown", run: moveStatement(1), preventDefault: true },
        { key: "Alt-Shift-ArrowUp", run: moveLine(-1), preventDefault: true },
        { key: "Alt-Shift-ArrowDown", run: moveLine(1), preventDefault: true },
        { key: "Mod-Alt-l", run: reformat, preventDefault: true },
        { key: "Mod-Shift-v", run: pasteFromHistory, preventDefault: true },
        ...(single ? [] : [{ key: "Mod-Shift-Enter", run: completeStatement, preventDefault: true }]),
        { key: "Mod-p", run: parameterInfo, preventDefault: true },
        { key: "Mod-w", run: extendSelection, preventDefault: true },
        { key: "Mod-Shift-w", run: shrinkSelection, preventDefault: true },
        { key: "Mod-g", run: goToLine, preventDefault: true },
        { key: "Mod-b", run: goTo, preventDefault: true },
        { key: "Mod-q", run: quickDocAtCaret(nav), preventDefault: true },
        { key: "Alt-Shift-b", run: selectInExplorerAtCaret(nav), preventDefault: true },
        { key: "Mod-Alt-Shift-c", run: copyReference, preventDefault: true },
        ...(single ? [] : [{ key: "F2", run: (v: EditorView) => jumpProblem(v, 1), preventDefault: true }, { key: "Shift-F2", run: (v: EditorView) => jumpProblem(v, -1), preventDefault: true }]),
        ...(single || props.readOnly ? [] : [{ key: "Alt-Enter", run: intentionsCommand, preventDefault: true }, { key: "Alt-Shift-Enter", run: applyFirstIntention, preventDefault: true }]),
        { key: "Alt-j", run: selectNextOccurrence, preventDefault: true },
        { key: "Mod-Alt-Shift-j", run: selectSelectionMatches, preventDefault: true },
        { key: "Mod-Shift-l", run: selectLine },
        ...(single ? [] : [{ key: "Tab", run: tabIndent, shift: shiftTab }]),
        {
          key: "Escape",
          run: (v) => {
            if (closeChooser(v)) return true;
            if (v.state.selection.ranges.length > 1) {
              v.dispatch({ selection: EditorSelection.single(v.state.selection.main.head) });
              return true;
            }
            props.onEscape?.();
            return false;
          },
        },
      ]),
    );

    const state = EditorState.create({
      doc: props.value,
      extensions: [
        configField,
        errorsField,
        problemsField,
        execMarksField,
        previewField,
        parameterInfoExtension,
        clipRecorder,
        intentionHostFacet.of({
          get refreshSchema() {
            return props.intentions?.refreshSchema;
          },
          get chooseSchema() {
            return props.intentions?.chooseSchema;
          },
        }),
        ...(props.onExecute && !single ? [runQueryFacet.of(execute)] : []),
        EditorState.allowMultipleSelections.of(true),
        EditorView.clickAddsSelectionRange.of((e) => e.altKey && !e.shiftKey),
        rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey && e.button === 0 }),
        EditorState.tabSize.of(4),
        indentUnit.of("    "),
        EditorState.languageData.of(() => [{ commentTokens: { line: "--", block: { open: "/*", close: "*/" } }, closeBrackets: { brackets: ["(", "[", "'", '"', "`"] } }]),
        darkC.of(EditorView.darkTheme.of(isDark())),
        readOnlyC.of(EditorState.readOnly.of(!!props.readOnly)),
        drawSelection({ cursorBlinkRate: 1000 }),
        // Popups live on <body>: the editor host (30px single line, island overflow) would clip them, and they
        // flip above the caret when there is no room below. scrollPastEnd would pad a single line.
        tooltips({ parent: document.body }),
        ...(single ? [] : [scrollPastEnd()]),
        previewFill,
        ...(single ? [] : [editorLayers(), highlightActiveLine(), indentGuides]),
        ...(single ? [stripNewlines, placeholder(props.placeholder ?? "")] : []),
        ...(showGutter ? [numbersC.of(showNumbers() ? lineNumbers() : []), highlightActiveLineGutter(), statusGutterExtension()] : []),
        metricsC.of([]),
        history(),
        bracketMatching(),
        closeBrackets(),
        sqlHighlighting(),
        errorExtension(),
        ...(props.stripe !== false && !single ? [inspectExtension()] : []),
        navigationExtension(nav),
        EditorView.domEventHandlers({
          contextmenu(e, v) {
            e.preventDefault();
            v.focus();
            placeCaretAt(v, e);
            openEditorMenu(v, e, { single, nav: nav(), canExecute: !!props.onExecute, reformat, goToDeclaration: goTo });
            return true;
          },
        }),
        statementFrame,
        ...(props.stripe !== false && !single ? [stripeExtension()] : []),
        sqlCompletion(),
        sqlSearch(),
        keys,
        keymap.of([...closeBracketsKeymap, ...defaultKeymap.filter((k) => k.key !== "Mod-Enter"), ...historyKeymap.filter((k) => k.key !== "Mod-y" && k.mac !== "Mod-y")]),
        EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        updateListener,
      ],
    });
    view = new EditorView({ state, parent: host });
    view.dispatch({ effects: configEffect() });
    props.ref?.(handle);
    if (props.autofocus) view.focus();

    const mo = new MutationObserver(() => {
      view?.dispatch({ effects: darkC.reconfigure(EditorView.darkTheme.of(isDark())) });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    onCleanup(() => {
      mo.disconnect();
      view?.destroy();
      view = undefined;
    });
  });

  // external value changes (tab switch, file reload, host-driven edits)
  createEffect(
    on(
      () => props.value,
      (v) => {
        if (!view) return;
        const cur = view.state.doc.toString();
        const ch = diffChange(cur, v);
        if (ch) view.dispatch({ changes: ch, annotations: [] });
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => [props.dialect, props.schema, extras(), props.defaultSchema, props.sourceLabel, props.statementFrame, props.scopeTable?.name, props.scopeTable?.schema] as const,
      () => view?.dispatch({ effects: configEffect() }),
      { defer: true },
    ),
  );
  createEffect(on(() => props.readOnly, (ro) => view?.dispatch({ effects: readOnlyC.reconfigure(EditorState.readOnly.of(!!ro)) }), { defer: true }));
  // Settings > Editor: line numbers and font metrics apply to every open editor at once
  createEffect(on(showNumbers, (on) => view?.dispatch({ effects: numbersC.reconfigure(on ? lineNumbers() : []) }), { defer: true }));
  createEffect(
    on(
      () => [fontSize(), lineHeight()] as const,
      ([fs, lh]) => {
        // a changed theme facet makes CodeMirror re-measure line height and character width (the CSS variables already changed)
        view?.dispatch({ effects: metricsC.reconfigure(EditorView.theme({ ".cm-scroller": { "--ed-measured": `${fs}/${lh}` } })) });
      },
      { defer: true },
    ),
  );
  createEffect(on(() => props.errors, (e) => view?.dispatch({ effects: setErrors.of(e ?? []) })));
  createEffect(on(() => props.execMarks, (m) => view?.dispatch({ effects: setExecMarks.of(m ?? []) })));

  return <div ref={host} style={metricsStyle()} class={`sql-editor${props.readOnly ? " sql-editor-readonly" : ""}${props.singleLine ? " sql-editor-single" : ""}${props.class ? ` ${props.class}` : ""}`} />;
};

export default SqlEditor;
