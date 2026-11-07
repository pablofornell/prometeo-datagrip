import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  acceptCompletion,
  autocompletion,
  completionKeymap,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import { type Extension, Prec } from "@codemirror/state";
import { type EditorView, ViewPlugin, keymap } from "@codemirror/view";
import type { MenuItem } from "../ui/Menu";
import { docAnalysis } from "./highlight";
import { KEYWORD_HINTS, ORACLE_RESERVED, functionsFor, keywordsFor } from "./keywords";
import { type Token } from "./lexer";
import type { TableIdx } from "./schemaIndex";
import { analyzeStatement, identName, type Scope } from "./semantic";
import { configField } from "./state";
import { type Dialect, statementIndexAt } from "./split";
import { expandTemplate, insertLiveTemplate, nextTemplateField, templateDescriptions, templateListField, templateListWatcher, templateOptions } from "./templates";

const hints = new WeakMap<Completion, string>();

function mkOpt(c: Completion, hint?: string): Completion {
  if (hint) hints.set(c, hint);
  return c;
}

/** The popup's `⋮` menu: `Sort by name` and `Show types`, kept across sessions. */
const PREFS_KEY = "prometeo.completion";
export const completionPrefs = (() => {
  let saved: { sortByName?: boolean; showTypes?: boolean } = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    /* no storage: defaults */
  }
  return { sortByName: !!saved.sortByName, showTypes: saved.showTypes !== false };
})();
function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(completionPrefs));
  } catch {
    /* no storage */
  }
  document.body.classList.toggle("dg-comp-no-types", !completionPrefs.showTypes);
}
if (typeof document !== "undefined") document.body.classList.toggle("dg-comp-no-types", !completionPrefs.showTypes);

/** Quote an identifier when it is not a plain lower-case name. */
export function quoteIdent(name: string, d: Dialect): string {
  // Oracle stores unquoted names in upper case
  if (d === "oracle") return /^[A-Z][A-Z0-9_$#]*$/.test(name) && !ORACLE_RESERVED.has(name.toLowerCase()) ? name : '"' + name.replace(/"/g, '""') + '"';
  if (/^[a-z_][a-z0-9_$]*$/.test(name)) return name;
  if (d === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

const keywordCache = new Map<Dialect, string[]>();
function keywordList(d: Dialect): string[] {
  let l = keywordCache.get(d);
  if (!l) keywordCache.set(d, (l = [...keywordsFor(d)].filter((k) => !/^(isnull|notnull|overlaps)$/.test(k)).sort()));
  return l;
}

function columnIcon(k?: string): string {
  return k === "pk" || k === "pkfk" ? "column-pk" : k === "fk" ? "column-fk" : "column";
}

function columnOptions(t: TableIdx, label: string | null): Completion[] {
  return t.columns.map((c) =>
    mkOpt(
      { label: c.name, type: columnIcon(c.key), detail: label ? ` (${label})` : undefined, boost: 40 },
      c.type,
    ),
  );
}

function tableOption(t: TableIdx, cfg: { sourceLabel?: string; defaultSchema?: string; dialect: Dialect; database?: string }, qualify: boolean): Completion {
  const view = t.kind === "view" || t.kind === "matview";
  const name = quoteIdent(t.name, cfg.dialect);
  return mkOpt(
    {
      label: t.name,
      type: view ? "view" : t.kind === "sequence" ? "sequence" : "table",
      detail: ` (${cfg.database ? `${cfg.database}.${t.schema}` : t.schema})`,
      apply: qualify ? `${quoteIdent(t.schema, cfg.dialect)}.${name}` : name,
      boost: t.kind === "sequence" ? 28 : 30,
    },
    cfg.sourceLabel ?? t.kind,
  );
}

function functionOption(f: { name: string; args: string; ret?: string }): Completion {
  return mkOpt(
    {
      label: f.name,
      type: "function",
      detail: `(${f.args})`,
      boost: 5,
      apply: (view, _c, fr, to) => {
        const insert = `${f.name}()`;
        view.dispatch({ changes: { from: fr, to, insert }, selection: { anchor: fr + f.name.length + 1 }, userEvent: "input.complete" });
      },
    },
    f.ret,
  );
}

function routineOption(r: { name: string; args: string; returns?: string }): Completion {
  return mkOpt(
    {
      label: `${r.name}(${r.args})`,
      type: "function",
      boost: 12,
      apply: (view, _c, fr, to) => {
        view.dispatch({ changes: { from: fr, to, insert: `${r.name}()` }, selection: { anchor: fr + r.name.length + 1 }, userEvent: "input.complete" });
      },
    },
    r.returns,
  );
}

const TABLE_WORDS = new Set(["from", "join", "update", "into", "table", "truncate", "references", "only", "view"]);

function tokenBefore(toks: Token[], pos: number): number {
  let lo = 0;
  let hi = toks.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].to <= pos) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function completionSource(ctx: CompletionContext): CompletionResult | null {
  const state = ctx.state;
  const cfg = state.field(configField);
  const idx = cfg.index;
  const a = docAnalysis(state.doc, cfg.dialect);
  const toks = a.tokens;

  const word = ctx.matchBefore(/[\p{L}\p{N}_$]*/u);
  const from = word ? word.from : ctx.pos;
  const prefix = word ? word.text : "";

  // not inside strings, comments or quoted identifiers
  const ti = tokenBefore(toks, ctx.pos);
  const inTok = toks.find((t, i) => i >= Math.max(0, ti - 1) && t.from < ctx.pos && ctx.pos <= t.to);
  if (inTok && (inTok.kind === "string" || inTok.kind === "comment" || inTok.kind === "qident")) {
    const text = a.text.slice(inTok.from, inTok.to);
    const closed = inTok.kind === "comment" ? /^--|#/.test(text) || text.endsWith("*/") : text.length > 1 && text.endsWith(text[0]);
    if (!closed || ctx.pos < inTok.to) return null;
  }

  // Ctrl+J: only the live templates, typing filters them
  if (state.field(templateListField)) return { from, options: templateOptions(), validFor: /^[\p{L}\p{N}_$]*$/u };

  const dotBefore = from > 0 && a.text[from - 1] === ".";
  if (!dotBefore && prefix === "" && !ctx.explicit) return null;
  if (!dotBefore && /^\d/.test(prefix)) return null;

  // statement tokens and scope
  const si = statementIndexAt(a.statements, ctx.pos);
  let scope: Scope | null = null;
  if (si !== null) {
    const st = a.statements[si];
    const stToks = toks.filter((t) => t.from >= st.start && t.from < st.fullEnd);
    scope = analyzeStatement(a.text, stToks, idx, cfg.dialect, cfg.implicit).scope;
  }

  if (!scope && cfg.implicit) scope = analyzeStatement(a.text, [], idx, cfg.dialect, cfg.implicit).scope;
  const options: Completion[] = [];
  const o = { sourceLabel: cfg.sourceLabel, defaultSchema: idx.defaultSchema, dialect: cfg.dialect, database: idx.database };

  if (dotBefore) {
    // qualifier chain before the dot
    const parts: string[] = [];
    let k = tokenBefore(toks, from - 1); // token ending at or before the dot
    // tokens: ... name . [prefix]
    while (k >= 0 && (toks[k].kind === "word" || toks[k].kind === "qident") && toks[k].to <= from - 1) {
      parts.unshift(identName(a.text.slice(toks[k].from, toks[k].to)));
      if (k >= 2 && a.text.slice(toks[k - 1].from, toks[k - 1].to) === "." && toks[k - 1].to === toks[k].from) k -= 2;
      else break;
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) {
      const q = parts[0];
      const ref = scope?.byName.get(q);
      if (ref?.table) {
        options.push(...columnOptions(ref.table, ref.alias ?? ref.table.name));
        // the functions follow the columns, and `cast` is offered everywhere an expression may start
        for (const f of functionsFor(cfg.dialect)) options.push(functionOption(f));
        options.push(mkOpt({ label: "cast", type: "keyword", boost: 8 }, KEYWORD_HINTS.cast));
      } else if (!ref && idx.hasSchema(q)) {
        for (const t of idx.schemas.get(q)?.list ?? []) options.push(tableOption(t, o, false));
        for (const r of idx.schemas.get(q)?.routines ?? []) options.push(routineOption(r));
        options.push(mkOpt({ label: "cast", type: "keyword", boost: 8 }, KEYWORD_HINTS.cast));
      } else if (!ref) {
        const t = idx.findTable([q]);
        if (t) options.push(...columnOptions(t, t.name));
      }
    } else if (parts.length >= 2) {
      const t = idx.findTable(parts.slice(-2));
      if (t) options.push(...columnOptions(t, t.name));
      else if (idx.hasSchema(parts[parts.length - 1])) {
        for (const tt of idx.schemas.get(parts[parts.length - 1])?.list ?? []) options.push(tableOption(tt, o, false));
      }
    }
    if (!options.length) return null;
    options.forEach((opt, i) => {
      opt.boost = (opt.boost ?? 0) - i * 0.0001;
    });
    return { from, options, validFor: /^[\p{L}\p{N}_$]*$/u, filter: true };
  }

  // previous significant token decides table vs expression context
  const pi = tokenBefore(toks, from);
  let prevWord = "";
  let prevPunct = "";
  if (pi >= 0 && toks[pi].kind !== "comment") {
    const t = toks[pi];
    if (t.kind === "word") prevWord = a.text.slice(t.from, t.to).toLowerCase();
    else if (t.kind === "punct") prevPunct = a.text.slice(t.from, t.to);
  }
  // `FROM a, |`: a comma inside a FROM list
  let tableCtx = TABLE_WORDS.has(prevWord);
  if (!tableCtx && prevPunct === ",") {
    for (let k = pi - 1; k >= 0 && k > pi - 40; k--) {
      const t = toks[k];
      if (t.from < (si !== null ? a.statements[si].start : 0)) break;
      if (t.kind === "word") {
        const w = a.text.slice(t.from, t.to).toLowerCase();
        if (w === "from") {
          tableCtx = true;
          break;
        }
        if (["select", "where", "group", "order", "having", "set", "on", "values", "join"].includes(w)) break;
      }
    }
  }
  const upper = prefix !== "" && prefix === prefix.toUpperCase() && /[A-Z]/.test(prefix);

  if (tableCtx) {
    const mult = idx.list.length > 1;
    for (const s of idx.list) {
      for (const t of s.list) {
        const qualify = mult && !!idx.defaultSchema && s.name.toLowerCase() !== idx.defaultSchema.toLowerCase();
        options.push(tableOption(t, o, qualify));
      }
      if (mult) options.push(mkOpt({ label: s.name, type: "schema", boost: 20, apply: quoteIdent(s.name, cfg.dialect) + "." }, cfg.sourceLabel));
    }
    // routines (table functions) and the built-in `cast`, after the tables and sequences like DataGrip
    for (const s of idx.list) for (const r of s.routines) options.push(routineOption(r));
    options.push(mkOpt({ label: "cast", type: "keyword", boost: 8 }, KEYWORD_HINTS.cast));
    if (scope) for (const c of scope.ctes) options.push({ label: c, type: "table", boost: 35 });
  } else {
    // expression position: columns of the tables in scope, functions, keywords
    const seen = new Set<string>();
    if (scope) {
      for (const r of scope.refs) {
        if (!r.table) continue;
        const label = r.alias ?? r.table.name;
        for (const opt of columnOptions(r.table, label)) {
          const key = `${opt.label}|${label}`;
          if (!seen.has(key)) {
            seen.add(key);
            options.push(opt);
          }
        }
      }
      // qualifiers (aliases / tables of the statement)
      for (const r of scope.refs) {
        const q = r.aliasText ?? (r.table ? r.table.name : undefined);
        if (q) options.push(mkOpt({ label: q, type: r.table?.kind === "view" ? "view" : "table", boost: 20, detail: r.alias && r.table ? ` (${r.table.name})` : undefined }, cfg.sourceLabel));
      }
    }
    for (const s of idx.list) for (const r of s.routines) options.push(routineOption(r));
    for (const f of functionsFor(cfg.dialect)) options.push(functionOption(f));
    const first = si === null ? true : a.statements[si].start >= from - 0;
    for (const k of keywordList(cfg.dialect)) {
      const text = upper ? k.toUpperCase() : k;
      options.push(mkOpt({ label: text, type: "keyword", boost: first ? 8 : -5 }, KEYWORD_HINTS[k]));
    }
    // the live templates: only for a typed prefix (Tab expands the exact abbreviation)
    if (prefix !== "" && !cfg.noTemplates) options.push(...templateOptions());
  }
  if (!options.length) return null;
  // keep the listing order for equal matches (CM would sort alphabetically); `Sort by name` drops the ranking
  options.forEach((opt, i) => {
    opt.boost = completionPrefs.sortByName ? 0 : (opt.boost ?? 0) - i * 0.0001;
  });
  return { from, options, validFor: /^[\p{L}\p{N}_$]*$/u };
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Tab replaces the identifier after the caret, Enter inserts (the footer text says so). */
function tabReplace(view: EditorView): boolean {
  if (completionStatus(view.state) !== "active") return false;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const rest = line.text.slice(head - line.from);
  const m = /^[\p{L}\p{N}_$]+/u.exec(rest);
  if (m) view.dispatch({ changes: { from: head, to: head + m[0].length } });
  return acceptCompletion(view);
}

/** `⋮` in the footer of the popup: `Sort by name` / `Show types`. Added to the popup's DOM once it is open. */
const footerMenu = ViewPlugin.fromClass(
  class {
    raf = 0;
    constructor(readonly view: EditorView) {}
    update(u: { startState: EditorView["state"]; state: EditorView["state"] }): void {
      if (completionStatus(u.state) !== "active") return;
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.attach());
    }
    attach(): void {
      const tip = document.querySelector<HTMLElement>(".cm-tooltip.cm-tooltip-autocomplete");
      if (!tip || tip.querySelector(".cm-comp-more")) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cm-comp-more";
      b.title = "More options";
      b.tabIndex = -1;
      b.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="3.5" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="12.5" r="1.2" fill="currentColor"/></svg>';
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const view = this.view;
        const items: MenuItem[] = [
          { label: "Sort by name", checked: completionPrefs.sortByName, run: () => { completionPrefs.sortByName = !completionPrefs.sortByName; savePrefs(); startCompletion(view); } },
          { label: "Show types", checked: completionPrefs.showTypes, run: () => { completionPrefs.showTypes = !completionPrefs.showTypes; savePrefs(); } },
        ];
        const r = b.getBoundingClientRect();
        void import("../ui/Menu").then((m) => m.openMenu(items, { x: r.left, y: r.bottom + 2, compact: true, minWidth: 160, onClose: () => view.focus() }));
      });
      tip.append(b);
    }
    destroy(): void {
      cancelAnimationFrame(this.raf);
    }
  },
);

export function sqlCompletion(): Extension {
  return [
    templateListField,
    templateListWatcher(),
    footerMenu,
    autocompletion({
      override: [completionSource],
      tooltipClass: (state) => (state.field(templateListField) ? "cm-comp-templates" : ""),
      icons: false,
      defaultKeymap: false,
      maxRenderedOptions: 200,
      activateOnTyping: true,
      activateOnTypingDelay: 40,
      selectOnOpen: true,
      closeOnBlur: true,
      optionClass: (c) => `cm-opt-${c.type ?? "keyword"}`,
      addToOptions: [
        {
          position: 20,
          render: (c) => el("span", `dg-icon dg-icon-${c.type ?? "keyword"}`),
        },
        {
          position: 90,
          render: (c) => {
            const h = hints.get(c) ?? templateDescriptions.get(c);
            return el("span", "cm-completionHint", h ?? "");
          },
        },
      ],
    }),
    Prec.highest(
      keymap.of([
        { key: "Ctrl-Space", run: startCompletion },
        { key: "Mod-j", run: insertLiveTemplate, preventDefault: true },
        { key: "Tab", run: expandTemplate },
        { key: "Tab", run: tabReplace },
        { key: "Tab", run: nextTemplateField },
        ...completionKeymap.filter((k) => k.key !== "Ctrl-Space" && k.key !== "Alt-`"),
      ]),
    ),
  ];
}
