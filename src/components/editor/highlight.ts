import { RangeSetBuilder, type Extension, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { HARD_KEYWORDS, keywordsFor } from "./keywords";
import { lex, type Token } from "./lexer";
import { analyzeStatement, identName, type Mark, type MarkCls } from "./semantic";
import { configField, errorsField, setConfig } from "./state";
import { splitStatements, type Dialect, type Statement } from "./split";

export interface DocAnalysis {
  text: string;
  tokens: Token[];
  statements: Statement[];
}

const cache = new WeakMap<Text, Map<Dialect, DocAnalysis>>();

/**
 * Above this many characters the document is treated as plain text: no semantic highlighting, statement
 * frame or completion context (lexing and splitting cost about 100 ns per character on every edit).
 * Selection execution still works.
 */
export const LARGE_DOC = 2_000_000;

/** Tokens and statements of a document, cached per document and dialect. */
export function docAnalysis(doc: Text, dialect: Dialect): DocAnalysis {
  let m = cache.get(doc);
  if (!m) cache.set(doc, (m = new Map()));
  let a = m.get(dialect);
  if (!a) {
    if (doc.length > LARGE_DOC) a = { text: "", tokens: [], statements: [] };
    else {
      const text = doc.toString();
      a = { text, tokens: lex(text, dialect), statements: splitStatements(text, dialect) };
    }
    m.set(dialect, a);
  }
  return a;
}

const classes: Record<MarkCls, Decoration> = {
  kw: Decoration.mark({ class: "cm-sql-kw" }),
  str: Decoration.mark({ class: "cm-sql-str" }),
  num: Decoration.mark({ class: "cm-sql-num" }),
  cmt: Decoration.mark({ class: "cm-sql-cmt" }),
  fn: Decoration.mark({ class: "cm-sql-fn" }),
  col: Decoration.mark({ class: "cm-sql-col" }),
  bad: Decoration.mark({ class: "cm-sql-bad" }),
  param: Decoration.mark({ class: "cm-sql-param" }),
};

/** All semantic marks for the statements intersecting `[vFrom, vTo]`. */
export function computeMarks(view: EditorView, vFrom: number, vTo: number): Mark[] {
  const cfg = view.state.field(configField);
  const a = docAnalysis(view.state.doc, cfg.dialect);
  const marks: Mark[] = [];
  const toks = a.tokens;
  let ti = 0;
  const plainGap = (until: number): void => {
    while (ti < toks.length && toks[ti].from < until) {
      const t = toks[ti++];
      if (t.kind === "comment") marks.push({ from: t.from, to: t.to, cls: "cmt" });
      else if (t.kind === "string") marks.push({ from: t.from, to: t.to, cls: "str" });
      else if (t.kind === "number") marks.push({ from: t.from, to: t.to, cls: "num" });
    }
  };
  for (const st of a.statements) {
    plainGap(st.start);
    const begin = ti;
    while (ti < toks.length && toks[ti].from < st.fullEnd) ti++;
    if (st.fullEnd < vFrom || st.start > vTo) continue;
    const an = analyzeStatement(a.text, toks.slice(begin, ti), cfg.index, cfg.dialect, cfg.implicit);
    for (const m of an.marks) marks.push(m);
  }
  plainGap(Infinity);
  return marks;
}

function build(view: EditorView): DecorationSet {
  const vr = view.visibleRanges;
  const vFrom = vr.length ? Math.max(0, vr[0].from - 20000) : 0;
  const vTo = vr.length ? vr[vr.length - 1].to + 20000 : view.state.doc.length;
  const marks = computeMarks(view, vFrom, vTo);
  marks.sort((x, y) => x.from - y.from || x.to - y.to);
  const b = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const m of marks) {
    if (m.from < last || m.to <= m.from) continue; // overlapping marks are a bug upstream; stay valid
    b.add(m.from, m.to, classes[m.cls]);
    last = m.to;
  }
  return b.finish();
}

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setConfig)))) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Other occurrences of the identifier at the caret get a boxed background (IDENTIFIER_UNDER_CARET). */
const idDeco = Decoration.mark({ class: "cm-sql-idcaret" });

export function identifierAtCaret(view: EditorView): { name: string; tokens: Token[] } | null {
  const sel = view.state.selection.main;
  if (!sel.empty || view.state.selection.ranges.length > 1) return null;
  const cfg = view.state.field(configField);
  const a = docAnalysis(view.state.doc, cfg.dialect);
  const toks = a.tokens;
  // binary search the token containing the caret
  let lo = 0;
  let hi = toks.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = toks[mid];
    if (t.to < sel.head) lo = mid + 1;
    else if (t.from > sel.head) hi = mid - 1;
    else {
      hit = mid;
      // caret between two tokens: prefer an identifier
      if (t.kind !== "word" && t.kind !== "qident" && mid > 0 && toks[mid - 1].to === sel.head) hit = mid - 1;
      break;
    }
  }
  if (hit < 0) return null;
  const t = toks[hit];
  if (t.kind !== "word" && t.kind !== "qident") return null;
  const name = identName(a.text.slice(t.from, t.to));
  const kw = keywordsFor(cfg.dialect);
  if (t.kind === "word" && (HARD_KEYWORDS.has(name) || kw.has(name))) return null;
  return { name, tokens: toks.filter((x) => (x.kind === "word" || x.kind === "qident") && identName(a.text.slice(x.from, x.to)) === name) };
}

const idCaret = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    constructor(view: EditorView) {
      this.decorations = this.compute(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(setConfig)))) {
        this.decorations = this.compute(u.view);
      }
    }
    compute(view: EditorView): DecorationSet {
      const hit = identifierAtCaret(view);
      if (!hit || hit.tokens.length < 2) return Decoration.none;
      const b = new RangeSetBuilder<Decoration>();
      for (const t of hit.tokens) b.add(t.from, t.to, idDeco);
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

export function sqlHighlighting(): Extension {
  return [highlighter, idCaret, errorsField];
}

/**
 * Indent guides (IntelliJ style): a line gets a 1px vertical guide at the indent column of each of its
 * ancestor lines, an ancestor being the nearest earlier non-blank line with a smaller indent. Guides at
 * column 0 are not drawn.
 */
const guideCache = new Map<string, Decoration>();
function guideDeco(cols: number[]): Decoration {
  const key = cols.join(",");
  let d = guideCache.get(key);
  if (!d) {
    // 8px per column, 2px line padding, the guide sits 1px left of the column's cell
    const layers = cols.map((c) => `linear-gradient(var(--dg-editor-indent-guide),var(--dg-editor-indent-guide)) ${2 + c * 8 - 1}px 0 / 1px 100% no-repeat`);
    d = Decoration.line({ attributes: { style: `background:${layers.join(",")}` } });
    guideCache.set(key, d);
  }
  return d;
}

function lineIndent(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === " ") n++;
    else if (c === "\t") n += 4 - (n % 4);
    else return n;
  }
  return -1; // blank
}

export const indentGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    constructor(view: EditorView) {
      this.decorations = this.compute(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = this.compute(u.view);
    }
    compute(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;
      let last = -1;
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = doc.lineAt(pos);
          pos = line.to + 1;
          if (line.from <= last) continue;
          last = line.from;
          let cur = lineIndent(line.text);
          if (cur <= 0) continue;
          const cols: number[] = [];
          for (let k = line.number - 1; k >= 1 && k >= line.number - 300 && cur > 0; k--) {
            const ind = lineIndent(doc.line(k).text);
            if (ind >= 0 && ind < cur) {
              if (ind > 0) cols.push(ind);
              cur = ind;
            }
          }
          if (cols.length) b.add(line.from, line.from, guideDeco(cols.sort((x, y) => x - y)));
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

